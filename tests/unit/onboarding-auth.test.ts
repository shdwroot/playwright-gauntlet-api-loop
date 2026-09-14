import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request, type TestInfo } from '@playwright/test';
import { onboard, originalContextFiles, refreshOnboardedProject } from '../../src/onboarding.js';
import { loadConfig } from '../../src/config.js';
import { loadContract } from '../../src/openapi.js';
import { buildPlan } from '../../src/planner.js';
import { applyAgentPlan } from '../../src/agent-plan.js';
import { executeGeneratedWorkflow, executeGeneratedCase } from '../../src/generated-runtime.js';
import { redactAgentData } from '../../src/agent-redaction.js';

test('compiled exact JSON equality detects extra response fields over real HTTP', async () => {
  const {config} = await loadConfig('gauntlet.offline.config.json');
  const contract = await loadContract(config.spec);
  const plan = applyAgentPlan(buildPlan(contract,config), {cases:[{id:'exact-health',operationId:'getHealth',status:200,request:{useAuth:false},rationale:'Exact health payload',assertions:[{path:'$',operator:'json-equals',value:'{"status":"ok"}',sourcePointer:'/paths/~1health/get'}]}]},contract,config);
  let extra = false;
  const server = createServer((_req,res) => {res.setHeader('content-type','application/json');res.setHeader('Server','diagnostic-server');res.end(JSON.stringify(extra ? {status:'ok',unexpected:true} : {status:'ok'}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const client = await request.newContext({baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}`});
  const info = {attach:async()=>{}} as unknown as TestInfo;
  try {
    await executeGeneratedCase(client,info,plan.cases.at(-1)!);
    const headers=applyAgentPlan(buildPlan(contract,config),{cases:[{id:'header-case',operationId:'getHealth',status:200,request:{useAuth:false},rationale:'Server header must be absent regardless of casing',assertions:[{target:'headers',path:'Server',operator:'not-exists',value:true,sourcePointer:'/paths/~1health/get'}]}]},contract,config);
    assert.equal(headers.cases.at(-1)?.assertions?.[0]?.path,'/server');
    await assert.rejects(executeGeneratedCase(client,info,headers.cases.at(-1)!),'uppercase header spelling must not create a false absence pass');
    extra = true;
    await assert.rejects(executeGeneratedCase(client,info,plan.cases.at(-1)!));
  } finally {await client.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('URL onboarding includes all methods and real form login feeds a captured bearer token', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gauntlet-onboard-'));
  const seen: string[] = [];
  const spec = { openapi: '3.1.0', info: { title: 'Auth test', version: '1' }, paths: {
    '/token': { post: { operationId: 'login', requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['username','password'], properties: { username: { type: 'string' }, password: { type: 'string' } } } } } }, responses: { '200': { description: 'token' } } } },
    '/profile': { get: { operationId: 'profile', security: [{ bearer: [] }], responses: { '200': { description: 'profile' } } } },
  } };
  const server = createServer(async (req, res) => {
    if (req.url === '/openapi.json') { res.setHeader('content-type','application/json'); res.end(JSON.stringify(spec)); return; }
    seen.push(req.url!);
    if (req.url === '/token') {
      let body = ''; for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      assert.match(req.headers['content-type'] ?? '', /application\/x-www-form-urlencoded/);
      assert.equal(form.get('password'), 'gauntlet-local-run-A!');
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: 'private-token-value' }));
    } else {
      assert.equal(req.headers.authorization, 'Bearer private-token-value');
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ username: 'customer' }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let client: Awaited<ReturnType<typeof request.newContext>> | undefined;
  const oldTarget = process.env.GAUNTLET_BASE_URL; delete process.env.GAUNTLET_BASE_URL;
  try {
    const context = path.join(directory, 'requirements.md'); await writeFile(context, 'Customers log in and read their own profile.');
    const configPath = await onboard({ url: `${baseUrl}/openapi.json`, directory: path.join(directory,'project'), context: [context] });
    const { config } = await loadConfig(configPath);
    assert.deepEqual(new Set(config.safety.allowedMethods), new Set(['POST','GET']));
    assert.equal(config.safety.allowDestructive, true); assert.equal(config.baseUrl, baseUrl);
    assert.equal(config.agents.provider, 'openai');
    assert.equal(await readFile(path.join(config.projectRoot, 'context/0/requirements.md'), 'utf8'), 'Customers log in and read their own profile.');
    const before = await originalContextFiles(configPath);
    await writeFile(context,'Updated profile requirements.');
    assert.notDeepEqual(await originalContextFiles(configPath),before);
    await refreshOnboardedProject(configPath);
    assert.equal(await readFile(path.join(config.projectRoot,'context/0/requirements.md'),'utf8'),'Updated profile requirements.');
    const contract = await loadContract(config.spec);
    assert.equal(contract.operations.find(o => o.operationId === 'login')?.requestBody?.contentType, 'application/x-www-form-urlencoded');
    const proposal = { workflows: [{ id: 'login-profile', title: 'login and profile', steps: [
      { id: 'login', title: 'login', operationId: 'login', status: 200, request: { body: { username: 'customer', password: 'gauntlet-${runId}-A!' } }, capture: { accessToken: '$.access_token' } },
      { id: 'profile', title: 'profile', operationId: 'profile', status: 200, request: { useAuth: true, headers: { authorization: 'Bearer ${accessToken}' } }, assertions: [{ path: '$.username', operator: 'equals', value: 'customer', sourcePointer: '/paths/~1profile/get' }] },
    ] }] };
    const plan = applyAgentPlan(buildPlan(contract, config), redactAgentData(proposal), contract, config);
    const attachments: unknown[] = [];
    client = await request.newContext({ baseURL: baseUrl });
    await executeGeneratedWorkflow(client, { attach: async (_: string, data: unknown) => { attachments.push(data); } } as unknown as TestInfo, plan.workflows.at(-1)!);
    assert.deepEqual(seen, ['/token','/profile']);
    const serialized = attachments.map(value => {
      const body = (value as { body?: unknown }).body;
      return Buffer.isBuffer(body) ? body.toString('utf8') : JSON.stringify(value);
    }).join('\n');
    assert.ok(!serialized.includes('private-token-value'));
    assert.ok(!serialized.includes('gauntlet-local-run-A!'));
    const broken = structuredClone(proposal); broken.workflows[0]!.steps[1]!.request.headers!.authorization = 'Bearer ${unbound}';
    assert.throws(() => applyAgentPlan(buildPlan(contract, config), broken, contract, config), /CAPTURE_UNBOUND/);
  } finally {
    if (oldTarget === undefined) delete process.env.GAUNTLET_BASE_URL; else process.env.GAUNTLET_BASE_URL = oldTarget;
    await client?.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory,{recursive:true,force:true});
  }
});
