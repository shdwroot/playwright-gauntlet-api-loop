import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {request,type TestInfo} from '@playwright/test';
import {loadConfig} from '../../src/config.js';
import {loadContract} from '../../src/openapi.js';
import {buildPlan} from '../../src/planner.js';
import {applyAgentPlan} from '../../src/agent-plan.js';
import {executeGeneratedWorkflow} from '../../src/generated-runtime.js';
import {outcomeStatuses} from '../../src/outcome-policy.js';

test('source-permitted outcomes enforce each response schema and state invariants on an unrelated settings API',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'gauntlet-outcomes-'));
  const file=path.join(dir,'openapi.json');
  const response=(field:string)=>({description:'response',content:{'application/json':{schema:{type:'object',required:[field],properties:{[field]:{type:'string'}}}}}});
  await writeFile(file,JSON.stringify({openapi:'3.1.0',info:{title:'Settings',version:'1'},paths:{'/settings':{
    patch:{operationId:'updateSettings',responses:{200:response('mode'),400:response('error'),500:response('error')}},
    get:{operationId:'getSettings',responses:{200:response('mode')}}
  }}}));
  const {config}=await loadConfig('gauntlet.offline.config.json');config.safety.allowDestructive=true;config.safety.allowedMethods.push('PATCH');
  const contract=await loadContract(file);const baseline=buildPlan(contract,config);
  const candidate={id:'immutable-mode',origin:'requirement' as const,signal:'semantic-scenario' as const,operationId:'updateSettings',confidence:1,disposition:'report-only' as const,reason:'Immutable mode',evidence:[],contractPointers:[],scenario:{expectedBehavior:'Attempts to change mode return a controlled 4xx or ignore those fields. Mode remains reader.'}};
  baseline.discovery={formatVersion:1,specHash:baseline.specHash,discoveryHash:'',sourceCount:0,totalBytes:0,sources:[],warnings:[],redactionCount:0,candidates:[candidate]};
  const change={id:'change',operationId:'updateSettings',status:400,request:{body:{mode:'writer'}},rationale:'Mode cannot change',discoveryIds:[candidate.id],assertions:[{path:'$.mode',operator:'equals',value:'reader',sourcePointer:'/paths/~1settings/patch/responses/200'}]};
  const follow={id:'read',operationId:'getSettings',status:200,request:{},rationale:'Stored state unchanged',assertions:[{path:'$.mode',operator:'equals',value:'reader',sourcePointer:'/paths/~1settings/get/responses/200'}]};
  const original=applyAgentPlan(baseline,{workflows:[{id:'settings',title:'Immutable settings',steps:[change,follow]}]},contract,config);
  const id=original.workflows.at(-1)!.steps[0]!.id;
  const repair={outcomeRepairs:[{caseId:id,candidateId:candidate.id,rationale:'Source permits rejection or ignoring'}]};
  const built=applyAgentPlan(original,repair,contract,config,true);
  const workflow=built.workflows.at(-1)!;
  assert.deepEqual(workflow.steps[0]!.expected.statuses,[200,400]);
  assert.deepEqual(workflow.steps[0]!.body,original.workflows.at(-1)!.steps[0]!.body);
  assert.deepEqual(workflow.steps[0]!.assertions![0]!.whenStatuses,[200]);
  assert.equal(workflow.steps[0]!.assertions![0]!.value,'reader');
  assert.equal(original.workflows.at(-1)!.steps[0]!.expected.statuses.length,1);
  assert.throws(()=>applyAgentPlan(original,repair,contract,config),/OUTCOME_REPAIR_DENIED/);
  const fixedBaseline=structuredClone(original);delete fixedBaseline.workflows.at(-1)!.steps[0]!.oracleOrigin;
  assert.throws(()=>applyAgentPlan(fixedBaseline,repair,contract,config,true),/OUTCOME_REPAIR_DENIED/);
  assert.throws(()=>applyAgentPlan(baseline,{cases:[{...change,outcomePolicyId:candidate.id,discoveryIds:[]}]},contract,config),/OUTCOME_POLICY_DENIED/);
  const operation=contract.operations.find(o=>o.operationId==='updateSettings')!;
  assert.equal(outcomeStatuses({...candidate,scenario:{expectedBehavior:'Must return 400. A 200 or 500 is a defect.'}},operation),undefined);
  assert.deepEqual(outcomeStatuses({...candidate,scenario:{expectedBehavior:'Returns 200 or 400. A 500 is a defect.'}},operation),[200,400]);
  assert.equal(outcomeStatuses({...candidate,scenario:{expectedBehavior:'Either reject a request or return a dangerous response.'}},operation),undefined);
  let mode='ignore';let stored='reader';
  const server=createServer((req,res)=>{
    let status=200;let body:unknown={mode:stored};
    if(req.method==='PATCH'){
      if(mode==='reject'){status=400;body={error:'immutable'};}
      if(mode==='malformed'){status=400;body={error:42};}
      if(mode==='mutate'){stored='writer';body={mode:stored};}
      if(mode==='hidden-mutation'){stored='writer';body={mode:'reader'};}
      if(mode==='server-error'){status=500;body={error:'oops'};}
    }
    res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const client=await request.newContext({baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}`});
  const info={attach:async()=>{}} as unknown as TestInfo;
  try{
    for(mode of ['ignore','reject']){stored='reader';await executeGeneratedWorkflow(client,info,workflow);}
    for(mode of ['malformed','mutate','hidden-mutation','server-error']){stored='reader';await assert.rejects(executeGeneratedWorkflow(client,info,workflow));}
  }finally{await client.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
