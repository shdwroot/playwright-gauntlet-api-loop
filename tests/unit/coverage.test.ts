import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileCoverage, verifyCoverage } from '../../src/coverage.js';
import { loadConfig } from '../../src/config.js';
import { loadContract } from '../../src/openapi.js';
import { buildPlan } from '../../src/planner.js';
import type { DiscoveryReport, ExecutionSummary } from '../../src/types.js';
import type { AgentProvider } from '../../src/agents.js';

function discovery(): DiscoveryReport { return { formatVersion: 1, specHash: 'a', discoveryHash: '', sourceCount: 0, totalBytes: 0, sources: [], warnings: [], redactionCount: 0,
  candidates: [{ id: 'semantic-1', origin: 'llm', signal: 'semantic-scenario', confidence: 1, disposition: 'report-only', reason: '', evidence: [], contractPointers: [] }] }; }

test('unlinked criteria remain blocking without requesting redundant model gap assessments', async () => {
  const {config} = await loadConfig('gauntlet.offline.config.json');config.quality.requireSemanticVerification=true;
  const plan = buildPlan(await loadContract(config.spec),config);
  const backlog = reconcileCoverage(discovery());
  const provider: AgentProvider = {async invoke(_role,_model,_system,input) {
    const state = input as {obligations:unknown[];unverifiedObligations:Array<{id:string}>};
    assert.deepEqual(state.obligations,[]);
    assert.equal(state.unverifiedObligations[0]?.id,'semantic-1');
    return {agentId:'test',model:'test',promptHash:'',responseHash:'',output:{assessments:[]}};
  }};
  const review = await verifyCoverage(provider,config,plan,{observations:[]} as unknown as ExecutionSummary,backlog);
  assert.equal(review.findings[0]?.code,'SEMANTIC_COVERAGE_GAP');
  assert.equal(backlog.obligations[0]?.status,'gap');
  assert.match(backlog.obligations[0]!.reason,/No linked passing test/);
});

test('cleanup proof requires a passing complete workflow, including cleanup',async()=>{
  const {config}=await loadConfig('gauntlet.offline.config.json');config.quality.requireSemanticVerification=true;
  const plan=buildPlan(await loadContract(config.spec),config);const cleanup={...plan.cases[0]!,id:'cleanup-step',capture:{},discovery:{signal:'semantic-scenario' as const,candidateIds:['semantic-1'],evidence:[]}};
  plan.workflows.push({id:'with-cleanup',title:'cleanup proof',steps:[{...plan.cases[1]!,capture:{}}],cleanupSteps:[cleanup]});
  const provider:AgentProvider={async invoke(){return{agentId:'test',model:'test',promptHash:'',responseHash:'',output:{assessments:[{obligationId:'semantic-1',verdict:'verified',reason:'Cleanup response assertion passed',proofs:[{testId:'cleanup-step',assertionPointers:['/expected/statuses']}]}]}};}};
  const execution={observations:[{title:'[workflow:with-cleanup] cleanup proof',status:'passed',exchanges:[]}]} as unknown as ExecutionSummary;
  assert.equal((await verifyCoverage(provider,config,plan,execution,reconcileCoverage(discovery()))).findings.length,0);
  execution.observations![0]!.status='failed';
  assert.equal((await verifyCoverage(provider,config,plan,execution,reconcileCoverage(discovery()))).findings[0]?.code,'SEMANTIC_COVERAGE_GAP');
});

test('backlog retains omitted discoveries and never carries verification across runs or source changes', () => {
  const old = reconcileCoverage(discovery()); old.obligations[0]!.status = 'verified';
  const fresh = discovery(); fresh.candidates = [];
  assert.equal(reconcileCoverage(fresh, old).obligations[0]!.status, 'unimplemented');
  const changed = discovery(); changed.candidates = []; changed.specHash = 'b';
  const stale = reconcileCoverage(changed, old);
  assert.equal(stale.obligations[0]!.status, 'needs-review');
  assert.equal(reconcileCoverage(changed, stale).obligations[0]!.status, 'needs-review');
});

test('semantic gate rejects invented assertions, missing execution, missing review, and model-approved failures', async () => {
  const { config } = await loadConfig('gauntlet.offline.config.json');
  config.quality.requireSemanticVerification = true;
  const plan = buildPlan(await loadContract(config.spec), config);
  const t = plan.cases[0]!;
  t.discovery = { signal: 'semantic-scenario', candidateIds: ['semantic-1'], evidence: [] };
  const execution = { observations: [{ title: `[${t.id}] test`, status: 'passed', exchanges: [] }] } as unknown as ExecutionSummary;
  let pointer = '/expected/statuses';
  let omit = false;
  const provider: AgentProvider = { async invoke() { return { agentId: 'test', model: 'test', promptHash: '', responseHash: '', output: { assessments: omit ? [] : [{ obligationId: 'semantic-1', verdict: 'verified', reason: 'Status scenario', proofs: [{ testId: t.id, assertionPointers: [pointer] }] }] } }; } };
  assert.equal((await verifyCoverage(provider, config, plan, execution, reconcileCoverage(discovery()))).findings.length, 0);
  pointer = '/assertions/999';
  assert.equal((await verifyCoverage(provider, config, plan, execution, reconcileCoverage(discovery()))).findings[0]?.code, 'SEMANTIC_COVERAGE_GAP');
  t.expected.schema = { type: 'object', description: 'Metadata is not an executable assertion' };
  pointer = '/expected/schema/description';
  assert.equal((await verifyCoverage(provider, config, plan, execution, reconcileCoverage(discovery()))).findings.length, 1);
  pointer = '/expected/statuses'; execution.observations![0]!.title = `[other] spoof [${t.id}] test`;
  assert.equal((await verifyCoverage(provider, config, plan, execution, reconcileCoverage(discovery()))).findings.length, 1);
  execution.observations![0]!.title = `[${t.id}] test`; execution.observations![0]!.status = 'failed';
  assert.equal((await verifyCoverage(provider, config, plan, execution, reconcileCoverage(discovery()))).findings.length, 1);
  execution.observations = []; omit = true;
  assert.equal((await verifyCoverage(provider, config, plan, execution, reconcileCoverage(discovery()))).findings.length, 1);
});

test('changed obligations require a reviewed mapping to freshly verified replacements', async () => {
  const { config } = await loadConfig('gauntlet.offline.config.json'); config.quality.requireSemanticVerification = true;
  const plan = buildPlan(await loadContract(config.spec), config); const t = plan.cases[0]!;
  const old = reconcileCoverage(discovery());
  const current = discovery(); current.specHash = 'changed'; current.candidates[0]!.id = 'replacement';
  t.discovery = { signal: 'semantic-scenario', candidateIds: ['replacement'], evidence: [] };
  let replacement = 'invented';
  const provider: AgentProvider = { async invoke() { return { agentId: 'test', model: 'test', promptHash: '', responseHash: '', output: {
    assessments: [{ obligationId: 'replacement', verdict: 'verified', reason: 'Preserves status check', proofs: [{ testId: t.id, assertionPointers: ['/expected/statuses'] }] }],
    reconciliations: [{ obligationId: 'semantic-1', replacementIds: [replacement], reason: 'Same behavior preserved in updated requirement' }],
  } }; } };
  const execution = { observations: [{ title: `[${t.id}] test`, status: 'passed', exchanges: [] }] } as unknown as ExecutionSummary;
  assert.equal((await verifyCoverage(provider, config, plan, execution, reconcileCoverage(structuredClone(current), old))).findings.length, 1);
  replacement = 'replacement'; const backlog = reconcileCoverage(structuredClone(current), old);
  assert.equal((await verifyCoverage(provider, config, plan, execution, backlog)).findings.length, 0);
  assert.deepEqual(backlog.obligations.find(o => o.id === 'semantic-1')?.replacedBy, ['replacement']);
});

test('rediscovery cannot lower confidence or reject an outstanding obligation to bypass coverage', () => {
  const previous = reconcileCoverage(discovery());
  const fresh = discovery(); fresh.candidates[0]!.confidence = 0.1; fresh.candidates[0]!.disposition = 'reject';
  const backlog = reconcileCoverage(fresh, previous);
  assert.equal(backlog.obligations.length, 1);
  assert.equal(backlog.obligations[0]?.candidate.confidence, 1);
  assert.notEqual(backlog.obligations[0]?.candidate.disposition, 'reject');
});

test('verifier transport requires one keyed review per obligation and decodes keys into exact IDs', async () => {
  const { agentOutputSchema, decodeAgentOutput } = await import('../../src/agent-protocol.js');
  const schema = agentOutputSchema('verifier', { obligations: [{ id: 'one' }, { id: 'two' }], plan: { cases: [{ id: 'case-a' }], workflows: [] } }) as any;
  assert.deepEqual(schema.properties.assessments.required, ['one', 'two']);
  assert.equal(schema.properties.assessments.additionalProperties, false);
  const decoded = decodeAgentOutput({ assessments: { one: { verdict: 'gap', reason: 'missing', proofs: [] } }, isolation: { 'case-a': { verdict: 'isolated', reason: 'stateless' } } }) as any;
  assert.equal(decoded.assessments[0].obligationId, 'one');
  assert.equal(decoded.isolation[0].unitId, 'case-a');
});

test('builder transport excludes low-confidence IDs and invented provenance before a live call', async () => {
  const { agentOutputSchema } = await import('../../src/agent-protocol.js');
  const schema = agentOutputSchema('builder', { minimumDiscoveryConfidence: 0.85,
    discovery: { candidates: [{id:'accepted',confidence:1,disposition:'report-only',operationId:'orders'},{id:'uncertain',confidence:0.8,disposition:'report-only',operationId:'orders'},{id:'unmapped',confidence:1,disposition:'report-only'}] },
    contract: {operations:[{sourcePointer:'/paths/~1orders/get'}]} }) as any;
  const authored = schema.properties.cases.items.properties;
  assert.equal(authored.discoveryIds.items.$ref, '#/$defs/eligibleDiscoveryId');
  assert.deepEqual(schema.$defs.eligibleDiscoveryId.enum, ['accepted']);
  assert.equal(authored.assertions.items.properties.sourcePointer.$ref, '#/$defs/oracleSourcePointer');
  assert.deepEqual(schema.$defs.oracleSourcePointer.enum, ['/paths/~1orders/get']);
  assert.ok(authored.assertions.items.properties.value);
  assert.equal(authored.assertions.items.properties.valueJson,undefined);
  assert.ok(authored.request.properties.bodyJson);
  assert.equal(authored.requestJson,undefined);
  assert.deepEqual(authored.parallelGroup.enum,['']);
  assert.equal(schema.properties.workflows.items.properties.steps.minItems,1);
  const {decodeAgentOutput}=await import('../../src/agent-protocol.js');
  assert.deepEqual(decodeAgentOutput({value:'${captured}'}),{value:'${captured}'});
  const lead = agentOutputSchema('lead', {allowedActions:['execute']}) as any;
  assert.deepEqual(lead.properties.action.enum, ['execute']);
});

test('typed request envelopes keep payload fields inside body and distinguish omitted from cleared maps', async()=>{
  const {decodeAgentOutput}=await import('../../src/agent-protocol.js');
  const envelope={pathParams:null,query:null,headers:null,bodyJson:'{"username":"sample","password":"synthetic"}',rawBody:null,useAuth:null};
  assert.deepEqual(decodeAgentOutput({request:envelope}),{request:{body:{username:'sample',password:'synthetic'}}});
  assert.deepEqual(decodeAgentOutput({request:{...envelope,bodyJson:null,query:[],headers:[{name:'authorization',value:'Bearer ${customerAToken}'}],useAuth:false}}),{request:{query:{},headers:{authorization:'Bearer ${customerAToken}'},useAuth:false}});
  assert.throws(()=>decodeAgentOutput({request:{...envelope,bodyJson:'{invalid'}}),/bodyJson contains invalid JSON/);
  assert.throws(()=>decodeAgentOutput({request:{...envelope,headers:[{name:'x',value:'a'},{name:'x',value:'b'}]}}),/map entries/);
  assert.throws(()=>decodeAgentOutput({request:{...envelope,username:'lost'}}),/unsupported request envelope/);
  assert.deepEqual(decodeAgentOutput({requestJson:'{"body":{"username":"legacy"}}'}),{request:{body:{username:'legacy'}}});
});

test('conditional assertions and response schemas prove only branches observed in a passing execution',async()=>{
  const {config}=await loadConfig('gauntlet.offline.config.json');config.quality.requireSemanticVerification=true;
  const plan=buildPlan(await loadContract(config.spec),config);const item=plan.cases[0]!;
  item.discovery={signal:'semantic-scenario',candidateIds:['semantic-1'],evidence:[]};
  item.expected={statuses:[200,400],variants:[{status:200,schema:{type:'object'}},{status:400,schema:{type:'string'}}]};
  item.assertions=[{path:'$.mode',operator:'equals',value:'reader',sourcePointer:'/response',whenStatuses:[200]}];
  let pointer='/assertions/0';
  const provider:AgentProvider={async invoke(){return{agentId:'test',model:'test',promptHash:'',responseHash:'',output:{assessments:[{obligationId:'semantic-1',verdict:'verified',reason:'branch checked',proofs:[{testId:item.id,assertionPointers:[pointer]}]}]}};}};
  const execution={observations:[{title:`[${item.id}] test`,status:'passed',exchanges:[{request:{caseId:item.id},response:{status:400}}]}]} as unknown as ExecutionSummary;
  const review=()=>verifyCoverage(provider,config,plan,execution,reconcileCoverage(discovery()));
  assert.equal((await review()).findings.length,1);
  pointer='/expected/variants/0/schema/type';assert.equal((await review()).findings.length,1);
  pointer='/expected/variants/1/schema/type';assert.equal((await review()).findings.length,0);
  execution.observations!.push({title:`[${item.id}] test`,status:'failed',exchanges:[{request:{caseId:item.id},response:{status:200}}]} as never);
  pointer='/assertions/0';assert.equal((await review()).findings.length,1);
  execution.observations![0]!.exchanges=[{request:{caseId:item.id},response:{status:200}}];
  assert.equal((await review()).findings.length,0);
  execution.observations![0]!.exchanges=[];assert.equal((await review()).findings.length,1);
});
