import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { request, type TestInfo } from '@playwright/test';
import { executeGeneratedWorkflow, executeIsolated } from '../../src/generated-runtime.js';
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
