import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {loadConfig} from '../../src/config.js';
import {loadContract} from '../../src/openapi.js';
import {buildPlan} from '../../src/planner.js';
import {verifyCoverage, type CoverageBacklog} from '../../src/coverage.js';
import {measureContext, discoveryContexts, contractContext, shareContextSchemas} from '../../src/agent-context.js';
import {OpenAIResponsesProvider, type AgentProvider} from '../../src/agents.js';
import type {ExecutionSummary} from '../../src/types.js';

async function fixture() {
  const {config}=await loadConfig('gauntlet.offline.config.json');
  config.quality.requireSemanticVerification=true;config.quality.requireIsolationReview=true;
  config.agents.reviewBatchSize=2;config.agents.maxInputCharacters=40_000;
  const contract=await loadContract(config.spec);const plan=buildPlan(contract,config);const base=plan.cases[0]!;
  plan.workflows=[];
  plan.cases=Array.from({length:7},(_,i)=>({...structuredClone(base),id:`test-${i}`,discovery:{signal:'semantic-scenario' as const,candidateIds:[`criterion-${i}`],evidence:[]}}));
  const backlog:CoverageBacklog={formatVersion:1,sourceRevision:'current',obligations:plan.cases.map((t,i)=>({id:`criterion-${i}`,candidate:{id:`criterion-${i}`,origin:'requirement',signal:'semantic-scenario',operationId:t.operationId,confidence:1,disposition:'report-only',reason:'Status is required',contractPointers:[],evidence:[]},status:'implemented',reason:'Await review',proofs:[]}))};
  const execution={status:'passed',tests:7,passed:7,failed:0,skipped:0,failures:[],observations:plan.cases.map(t=>({title:`[${t.id}] test`,status:'passed',exchanges:[{request:{caseId:t.id},response:{status:200,body:'unrelated-body-'.repeat(100_000)}}]}))} as unknown as ExecutionSummary;
  return {config,contract,plan,backlog,execution};
}
function reply(input:any) {
  return {assessments:input.obligations.map((o:any)=>({obligationId:o.id,verdict:'verified',reason:'Assigned status assertion proves this synthetic criterion',proofs:[{testId:input.proofCatalog[o.id][0].testId,assertionPointers:['/expected/statuses']}]})),
    isolation:input.isolationUnitIds.map((unitId:string)=>({unitId,verdict:'isolated',reason:'Independent synthetic fixture'})),reconciliations:[]};
}

test('large raw exchanges are not repeated in bounded proof batches; every criterion and unit is reviewed',async()=>{
  const {config,plan,execution,backlog}=await fixture();const before=JSON.stringify(plan);const seen:string[]=[];const units:string[]=[];
  const provider:AgentProvider={async invoke(role,model,system,input){const state=input as any;
    assert.ok(measureContext(role,system,input).totalCharacters<=config.agents.maxInputCharacters!);
    assert.ok(!JSON.stringify(input).includes('unrelated-body-'));
    seen.push(...state.obligations.map((o:any)=>o.id));units.push(...state.isolationUnitIds);
    return {agentId:'structural-test',model,promptHash:'',responseHash:'',output:reply(state)};
  }};
  const result=await verifyCoverage(provider,config,plan,execution,backlog);
  assert.equal(result.findings.length,0);assert.equal(result.batches.length,4);
  assert.deepEqual(seen,backlog.obligations.map(o=>o.id));assert.equal(new Set(units).size,7);assert.equal(units.length,7);
  assert.ok(backlog.obligations.every(o=>o.status==='verified'));assert.equal(JSON.stringify(plan),before);
});

test('out-of-batch approvals cannot fill a missing assessment; completed batches survive another batch failure',async()=>{
  const {config,plan,execution,backlog}=await fixture();let calls=0;
  const provider:AgentProvider={async invoke(_role,model,_system,input){const state=input as any;calls++;
    if(calls===2)throw new Error('temporary verifier failure');
    const output=reply(state);
    if(calls===1)output.assessments.push({obligationId:'criterion-2',verdict:'verified',reason:'Outside assignment',proofs:[{testId:'test-2',assertionPointers:['/expected/statuses']}]});
    return {agentId:'structural-test',model,promptHash:'',responseHash:'',output};
  }};
  const result=await verifyCoverage(provider,config,plan,execution,backlog);
  assert.equal(backlog.obligations[0]?.status,'verified');assert.equal(backlog.obligations[2]?.status,'gap');
  assert.ok(result.findings.some(f=>f.code==='VERIFIER_BATCH_FAILED'));assert.ok(result.batches.some(b=>b.status==='failed'));
});

test('budget exhaustion halts further review calls and leaves the rest explicitly unverified',async()=>{
  const {config,plan,execution,backlog}=await fixture();let calls=0;
  const provider:AgentProvider={async invoke(_role,model,_system,input){if(++calls===2)throw new Error('AGENT_RUN_BUDGET_EXHAUSTED');return {agentId:'test',model,promptHash:'',responseHash:'',output:reply(input)};}};
  const result=await verifyCoverage(provider,config,plan,execution,backlog);
  assert.equal(calls,2);assert.ok(result.batches.some(b=>b.status==='not-run'));
  assert.equal(backlog.obligations.filter(o=>o.status==='verified').length,2);assert.ok(result.findings.some(f=>f.code==='SEMANTIC_COVERAGE_GAP'));
});

test('an indivisible oversized proof stays blocked without preventing smaller criteria from being reviewed',async()=>{
  const {config,plan,execution,backlog}=await fixture();config.agents.reviewBatchSize=1;
  plan.cases[0]!.expected.schema={type:'string',description:'large indivisible schema '.repeat(4000)};
  const provider:AgentProvider={async invoke(_role,model,_system,input){assert.ok(!(input as any).obligations.some((o:any)=>o.id==='criterion-0'));return {agentId:'test',model,promptHash:'',responseHash:'',output:reply(input)};}};
  const result=await verifyCoverage(provider,config,plan,execution,backlog);
  assert.equal(backlog.obligations[0]?.status,'gap');assert.equal(backlog.obligations[1]?.status,'verified');assert.ok(result.findings.some(f=>f.code==='VERIFIER_CONTEXT_GAP'));
});

test('discovery slices preserve every original source line and reject a line that cannot fit',async()=>{
  const {config,contract}=await fixture();config.agents.maxInputCharacters=160_000;config.discovery.maxAgentInputCharacters=80;
  const docs=[{sourceIndex:3,lines:[{number:10,text:'a'.repeat(60)},{number:11,text:'b'.repeat(60)},{number:12,text:'c'.repeat(60)}]}];
  const parts=discoveryContexts(contract,docs,[],config);
  assert.ok(parts.length>1);assert.deepEqual(parts.flatMap(p=>p.documents.flatMap(d=>d.lines.map(l=>[d.sourceIndex,l.number,l.text]))),docs[0]!.lines.map(l=>[3,l.number,l.text]));
  assert.throws(()=>discoveryContexts(contract,[{sourceIndex:3,lines:[{number:10,text:'x'.repeat(90)}]}],[],config),/DISCOVERY_AGENT_INPUT_LIMIT/);
});

test('context schemas are lossless and focused contracts preserve transitive referenced definitions',async()=>{
  const {contract}=await fixture();const original=structuredClone(contract);
  const focused=contractContext(contract,new Set(['listUsers']));
  assert.ok(focused.document.paths);assert.ok(focused.document.components);
  const input={a:{schema:{type:'object',properties:{value:{type:'integer'}}}},b:{schema:{type:'object',properties:{value:{type:'integer'}}}}};
  const shared=shareContextSchemas(input) as any;assert.equal(Object.keys(shared.contextSchemas).length,1);
  assert.deepEqual(shared.contextSchemas[shared.a.schema.$ref.split('/').at(-1)],input.a.schema);assert.deepEqual(contract,original);
});

test('provider enforces complete-context and cumulative budgets before HTTP and sends an output cap',async()=>{
  let requests=0;let outputCap:unknown;
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests++;outputCap=JSON.parse(body).max_output_tokens;res.setHeader('content-type','application/json');res.end(JSON.stringify({output_text:'{"action":"block","reason":"test"}'}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const prior=process.env.CONTEXT_TEST_KEY;process.env.CONTEXT_TEST_KEY='test-only';
  try {
    const {config}=await loadConfig('gauntlet.offline.config.json');const agents={...config.agents,provider:'openai' as const,apiKeyEnv:'CONTEXT_TEST_KEY',openaiBaseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`,maxCalls:1,maxOutputTokens:100};
    const provider=new OpenAIResponsesProvider(agents);await provider.invoke('lead','test','Select next action',{allowedActions:['block']});
    await assert.rejects(provider.invoke('lead','test','Select next action',{allowedActions:['block']}),/AGENT_RUN_BUDGET_EXHAUSTED/);
    await assert.rejects(new OpenAIResponsesProvider({...agents,maxInputCharacters:100}).invoke('lead','test','x'.repeat(101),{}),/AGENT_INPUT_LIMIT/);
    await assert.rejects(new OpenAIResponsesProvider({...agents,maxRunInputCharacters:1}).invoke('lead','test','Action',{}),/AGENT_RUN_BUDGET_EXHAUSTED/);
    assert.equal(requests,1);assert.equal(outputCap,100);
  } finally {if(prior===undefined)delete process.env.CONTEXT_TEST_KEY;else process.env.CONTEXT_TEST_KEY=prior;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('builder response schema shares large provenance enums without removing allowed citations',async()=>{
  const {agentOutputSchema}=await import('../../src/agent-protocol.js');
  const pointers=Array.from({length:100},(_,i)=>`/paths/~1resource-${i}/get`);
  const input={contract:{operations:pointers.map(sourcePointer=>({sourcePointer,responses:[]}))},discovery:{candidates:[{id:'criterion-a',confidence:1,disposition:'report-only',operationId:'get'}]}};
  const schema=agentOutputSchema('builder',input) as any;
  assert.deepEqual(schema.$defs.oracleSourcePointer.enum,pointers);
  assert.deepEqual(schema.$defs.eligibleDiscoveryId.enum,['criterion-a']);
  assert.equal(JSON.stringify(schema).split(pointers[0]!).length-1,1);
  assert.ok(JSON.stringify(schema).includes('"$ref":"#/$defs/oracleSourcePointer"'));
});

test('focused contracts retain applicable requirement oracles at their original pointer',async()=>{
  const {contract}=await fixture();const operation=contract.operations[0]!;
  contract.document['x-gauntlet-requirement-oracles']={applicable:{method:operation.method,path:operation.path,criteria:['criterion-a'],responses:{}},unrelated:{method:'GET',path:'/outside',criteria:[],responses:{}}};
  const focused=contractContext(contract,new Set([operation.operationId]));
  assert.deepEqual(Object.keys(focused.document['x-gauntlet-requirement-oracles'] as object),['applicable']);
  assert.ok((contract.document['x-gauntlet-requirement-oracles'] as any).unrelated);
});
