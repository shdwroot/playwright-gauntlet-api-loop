import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { request, type TestInfo } from '@playwright/test';
import { executeGeneratedCase, executeGeneratedWorkflow, executeIsolated } from '../../src/generated-runtime.js';
import { applyAgentPlan, plannedRequestCount } from '../../src/agent-plan.js';
import { loadConfig } from '../../src/config.js';
import { loadContract } from '../../src/openapi.js';
import { buildPlan } from '../../src/planner.js';

test('real HTTP cleanup receives captures after assertion failure and reset runs after failure', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'created-123' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = await request.newContext({ baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  try {
    const { config } = await loadConfig('gauntlet.offline.config.json');
    const plan = buildPlan(await loadContract(config.spec), config);
    const base = { ...plan.cases[0]!, expected: { statuses: [200] }, useAuth: false, query: {}, pathParams: {}, headers: {}, capture: {} };
    const info = { attach: async () => {} } as unknown as TestInfo;
    await assert.rejects(executeGeneratedWorkflow(client, info, { id: 'cleanup', title: 'cleanup', steps: [
      { ...base, id: 'create', path: '/create', capture: { createdId: '$.id' }, assertions: [{ path: '$.id', operator: 'equals', value: 'deliberately-wrong', sourcePointer: '/test' }] },
    ], cleanupSteps: [{ ...base, id: 'failing-cleanup', path: '/cleanup-failure', expected: { statuses: [204] } }, { ...base, id: 'delete', path: '/delete/{id}', pathParams: { id: '${createdId}' } }] }), /deliberately-wrong/);
    assert.ok(seen.some(url => url.endsWith('/delete/created-123')), 'cleanup uses the capture despite the failed assertion');
    plan.isolation = { beforeEach: [{ ...base, path: '/reset-before' }], afterEach: [{ ...base, path: '/reset-after' }] };
    await assert.rejects(executeIsolated(client, info, plan, async () => { throw new Error('original-failure'); }), /original-failure/);
    assert.ok(seen.some(url => url.endsWith('/reset-before')));
    assert.ok(seen.some(url => url.endsWith('/reset-after')));
  } finally { await client.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('reset hooks are contract-validated and included in request budgets', async () => {
  const { config } = await loadConfig('gauntlet.offline.config.json');
  const contract = await loadContract(config.spec); const plan = buildPlan(contract, config);
  config.isolation = { operationId: 'resetFixture', request: { headers: { 'x-gauntlet-reset': 'allowed' } } };
  config.safety.maxRequestsPerRun = 1000;
  const isolated = applyAgentPlan(plan, {}, contract, config);
  assert.equal(plannedRequestCount(isolated), plannedRequestCount(plan) + 2 * (plan.cases.length + plan.workflows.length));
  config.safety.maxRequestsPerRun = plannedRequestCount(isolated) - 1;
  assert.throws(() => applyAgentPlan(plan, {}, contract, config), /BUDGET/);
  config.isolation.operationId = 'unknown';
  assert.throws(() => applyAgentPlan(plan, {}, contract, config), /ISOLATION/);
});

test('disclosure assertions distinguish absent body fields from exposed response headers', async () => {
  const server = createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json','x-runtime-version':'1.2.3'});res.end(JSON.stringify({name:'fixture'}));});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const client=await request.newContext({baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}`});
  try {
    const {config}=await loadConfig('gauntlet.offline.config.json');
    const base=buildPlan(await loadContract(config.spec),config).cases[0]!;
    const planned={...base,path:'/',pathParams:{},query:{},headers:{},useAuth:false,expected:{statuses:[200]},assertions:[
      {path:'$.password',operator:'not-exists' as const,value:true,sourcePointer:base.sourcePointer},
      {path:'$.x-runtime-version',target:'headers' as const,operator:'exists' as const,value:true,sourcePointer:base.sourcePointer},
    ]};
    const info={attach:async()=>{}} as unknown as TestInfo;
    await executeGeneratedCase(client,info,planned);
    await assert.rejects(executeGeneratedCase(client,info,{...planned,assertions:[{...planned.assertions[1]!,operator:'not-exists'}]}),/scenario assertion/);
  } finally {await client.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('malformed array comparisons can be repaired without changing valid assertions or bounds', async () => {
  const {config}=await loadConfig('gauntlet.offline.config.json');
  const contract=await loadContract(config.spec); const plan=buildPlan(contract,config);
  const target=plan.cases[0]!;
  target.expected.schema={type:'array',items:{type:'object'}};
  target.assertions=[{path:'$',operator:'lte',value:100,sourcePointer:target.sourcePointer}];
  const repair={caseId:target.id,assertionIndex:0,operator:'length-lte',rationale:'Count the returned records instead of comparing an array to a number'};
  const fixed=applyAgentPlan(plan,{assertionRepairs:[repair]},contract,config,true);
  assert.deepEqual(fixed.cases[0]!.assertions,[{...target.assertions[0]!,operator:'length-lte'}]);
  assert.deepEqual(fixed.cases[0]!.expected,target.expected);
  assert.throws(()=>applyAgentPlan(fixed,{assertionRepairs:[repair]},contract,config,true),/ASSERTION_REPAIR_DENIED/);
  assert.throws(()=>applyAgentPlan(plan,{assertionRepairs:[{...repair,operator:'length-gte'}]},contract,config,true),/ASSERTION_REPAIR_DENIED/);
  assert.throws(()=>applyAgentPlan(plan,{assertionRepairs:[{...repair,value:1000}]},contract,config,true),/unsupported/);
  target.expected.schema={type:'number'};
  assert.throws(()=>applyAgentPlan(plan,{assertionRepairs:[repair]},contract,config,true),/ASSERTION_REPAIR_DENIED/);
});

test('array size bounds execute as numeric length comparisons', async () => {
  const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('[1,2]');});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const client=await request.newContext({baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}`});
  try {
    const {config}=await loadConfig('gauntlet.offline.config.json');const base=buildPlan(await loadContract(config.spec),config).cases[0]!;
    const planned={...base,path:'/',pathParams:{},query:{},headers:{},useAuth:false,expected:{statuses:[200]},assertions:[{path:'$',operator:'length-lte' as const,value:2,sourcePointer:base.sourcePointer}]};
    const info={attach:async()=>{}} as unknown as TestInfo;
    await executeGeneratedCase(client,info,planned);
    await assert.rejects(executeGeneratedCase(client,info,{...planned,assertions:[{...planned.assertions[0]!,value:1}]}),/scenario assertion/);
  } finally {await client.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('fixture token issuance is counted once per required actor per test unit', async () => {
  const {fixtureTokenActors}=await import('../../src/fixtures.js');
  assert.deepEqual(fixtureTokenActors({first:'${customerAToken}',again:'Bearer ${customerAToken}',forged:'${tamperedSubjectToken}'}),['customerA']);
  const {config}=await loadConfig('gauntlet.offline.config.json');const plan=buildPlan(await loadContract(config.spec),config);
  plan.cases=[{...plan.cases[0]!,headers:{authorization:'Bearer ${customerAToken}'}}];plan.workflows=[];delete plan.isolation;
  const before=plannedRequestCount(plan);plan.fixtureAuthentication=true;
  assert.equal(plannedRequestCount(plan),before+1);
});

test('database observations refresh private reset bindings and never attach their secret values', async () => {
  const server=createServer(async (req,res)=>{let body='';for await(const chunk of req)body+=chunk;
    if(req.url==='/reset')assert.equal(JSON.parse(body).reset_password_code,'4321');
    res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const client=await request.newContext({baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}`});
  const previous=process.env.GAUNTLET_FIXTURES;
  // Transport double for observation handling; live DB/issuer checks run separately.
  process.env.GAUNTLET_FIXTURES=JSON.stringify({adapter:'dvra',command:[process.execPath,'-e',`const action=process.argv[2];console.log(JSON.stringify(action==='prepare'?{runId:process.argv[3],fixtureResetCode:'7241'}:action==='observe'?{actors:{customerA:{orders:1}},_bindings:{fixtureResetCode:'4321'}}:{retainedReferencedMenuIds:[]}));`]});
  const attachments:string[]=[];
  try {
    const {config}=await loadConfig('gauntlet.offline.config.json');const plan=buildPlan(await loadContract(config.spec),config);
    const base={...plan.cases[0]!,method:'POST' as const,path:'/',pathParams:{},query:{},headers:{},useAuth:false,expected:{statuses:[200]},capture:{}};
    const workflow={id:'reset',title:'reset',steps:[{...base,id:'initiate',assertions:[{path:'$.actors.customerA.orders',target:'fixture' as const,operator:'equals' as const,value:1,sourcePointer:base.sourcePointer}]},{...base,id:'finish',path:'/reset',body:{reset_password_code:'${fixtureResetCode}'}}]};
    const info={testId:'observation-test',attach:async (_name:string,attachment:{body:Buffer})=>{attachments.push(attachment.body.toString());}} as unknown as TestInfo;
    await executeIsolated(client,info,plan,()=>executeGeneratedWorkflow(client,info,workflow),workflow);
    assert.ok(attachments.some(value=>value.includes('"actors"')));
    assert.ok(attachments.every(value=>!value.includes('4321')&&!value.includes('_bindings')));
  } finally {
    if(previous===undefined)delete process.env.GAUNTLET_FIXTURES;else process.env.GAUNTLET_FIXTURES=previous;
    await client.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
