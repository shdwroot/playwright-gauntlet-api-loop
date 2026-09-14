import assert from 'node:assert/strict';
import {createServer, type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {request,type TestInfo} from '@playwright/test';
import {loadConfig} from '../../src/config.js';
import {loadContract} from '../../src/openapi.js';
import {buildPlan} from '../../src/planner.js';
import {applyAgentPlan,plannedRequestCount} from '../../src/agent-plan.js';
import {executeGeneratedWorkflow} from '../../src/generated-runtime.js';

test('parallel races enforce one success, per-status schemas, request budgets and cleanup after all requests settle', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(),'gauntlet-race-'));
  const spec = path.join(directory,'openapi.json');
  const response = (schema:unknown) => ({description:'response',content:{'application/json':{schema}}});
  await writeFile(spec,JSON.stringify({openapi:'3.1.0',info:{title:'Race',version:'1'},paths:{
    '/race':{post:{operationId:'redeem',responses:{200:response({type:'object',required:['ok'],properties:{ok:{type:'boolean',const:true}}}),409:response({type:'object',required:['error'],properties:{error:{type:'string'}}})}}},
    '/cleanup':{delete:{operationId:'cleanup',responses:{204:{description:'clean'}}}},
  }}));
  const {config} = await loadConfig('gauntlet.offline.config.json');config.safety.allowDestructive=true;
  const contract = await loadContract(spec);const baseline=buildPlan(contract,config);
  const step = {id:'first',title:'redeem',operationId:'redeem',status:200,alternativeStatuses:[409],parallelGroup:'coupon',request:{},rationale:'Single use under simultaneous requests',capture:{},assertions:[{target:'parallel',path:'$.successCount',operator:'equals',value:1,sourcePointer:'/paths/~1race/post'}]};
  const proposal = {workflows:[{id:'race',title:'Coupon race',steps:[step,{...step,id:'second',assertions:[]}],cleanupSteps:[{id:'clean',operationId:'cleanup',status:204,request:{},rationale:'Cleanup after the whole race'}]}]};
  const built = applyAgentPlan(baseline,proposal,contract,config);
  assert.equal(plannedRequestCount(built)-plannedRequestCount(baseline),3);
  assert.throws(()=>applyAgentPlan(baseline,{cases:[step]},contract,config),/PARALLEL_DENIED/);
  assert.throws(()=>applyAgentPlan(baseline,{workflows:[{...proposal.workflows[0],steps:[step]}]},contract,config),/PARALLEL_GROUP_INVALID/);
  assert.throws(()=>applyAgentPlan(baseline,{workflows:[{...proposal.workflows[0],steps:[{...step,capture:{token:'$.ok'}},{...step,id:'second',assertions:[]}]}]},contract,config),/PARALLEL_GROUP_INVALID/);
  assert.throws(()=>applyAgentPlan(baseline,{workflows:[{...proposal.workflows[0],steps:[{...step,alternativeStatuses:[599]},{...step,id:'second',assertions:[]}]}]},contract,config),/ORACLE_UNDECLARED/);
  const pending:ServerResponse[]=[];let cleanup=0;let doubleSuccess=false;let malformedConflict=false;
  const server=createServer((req,res)=>{
    if(req.url==='/cleanup'){assert.equal(pending.length,0);cleanup++;res.writeHead(204);res.end();return;}
    pending.push(res);
    if(pending.length===2){const pair=pending.splice(0);pair.forEach((r,i)=>{const success=i===0||doubleSuccess;r.writeHead(success?200:409,{'content-type':'application/json'});r.end(JSON.stringify(success?{ok:true}:malformedConflict?{error:42}:{error:'used'}));});}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const client=await request.newContext({baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}`,timeout:2000});
  const info={attach:async()=>{}} as unknown as TestInfo;
  try {
    await executeGeneratedWorkflow(client,info,built.workflows.at(-1)!);assert.equal(cleanup,1);
    doubleSuccess=true;await assert.rejects(executeGeneratedWorkflow(client,info,built.workflows.at(-1)!));assert.equal(cleanup,2);
    doubleSuccess=false;malformedConflict=true;await assert.rejects(executeGeneratedWorkflow(client,info,built.workflows.at(-1)!));assert.equal(cleanup,3);
    const original=structuredClone(built.workflows.at(-1)!.steps[0]!.expected);
    const repaired=applyAgentPlan(built,{repairs:[{caseId:built.workflows.at(-1)!.steps[0]!.id,request:{body:{retry:true}},rationale:'Input repair'}]},contract,config,true);
    assert.deepEqual(repaired.workflows.at(-1)!.steps[0]!.expected,original);
  }finally{await client.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
