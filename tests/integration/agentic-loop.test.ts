import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runGauntlet } from '../../src/gauntlet.js';
import type { TestPlan } from '../../src/types.js';

async function runFixture(defect = false) {
  const calls: string[] = [];
  let leadCount = 0;
  let healerEvidence: unknown;
  const model = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      const input = JSON.parse(payload.input.slice('Return only valid JSON.\n'.length));
      const system: string = payload.instructions;
      let output: unknown;
      if (system.startsWith('Analyze the complete')) {
        calls.push('discovery');
        assert.match(JSON.stringify(input.documents), /smallest valid page size/);
        output = { scenarios: [{ title: 'End-of-collection pagination', rationale: 'Prose calls for a valid small page at a distant offset.', operationId: 'listUsers', confidence: 0.99,
          scenario: { steps: ['Request the smallest valid page size at the largest supported offset.'] }, citations: [{ sourceIndex: 0, lineStart: 1, lineEnd: 1 }] }] };
      } else if (system.startsWith('You manage')) {
        calls.push('lead'); leadCount++;
        const action = leadCount === 1 ? 'build' : leadCount === 2 ? 'execute' : leadCount === 3 ? 'heal' : leadCount === 4 ? 'execute' : 'accept';
        assert.ok(input.allowedActions.includes(action));
        output = { action, reason: `Delegate ${action} based on current run evidence.` };
      } else if (system.startsWith('You implement')) {
        calls.push('builder');
        const candidateId = input.discovery.candidates.find((item: { signal: string }) => item.signal === 'semantic-scenario').id;
        output = { cases: [{ id: 'last-page', title: 'Valid smallest page at distant offset', operationId: 'listUsers', status: 200,
          rationale: 'Valid pagination should return an empty page.', assertions: [{ path: '$.data', operator: 'length-equals', value: 0, sourcePointer: '/paths/~1users/get' }], request: { query: { limit: defect ? 1 : 0, offset: 10000 } }, discoveryIds: [candidateId] }],
          workflows: [{ id: 'read-created', title: 'Create, read and remove a user', steps: [
            { id: 'create-new', title: 'Create user', operationId: 'createUser', status: 201, rationale: 'Set up unique test data', request: { body: { name: 'Agent User', email: 'agent-${runId}@example.test' } }, capture: { userId: '$.id', createdBody: '$' } },
            { id: 'read-new', title: 'Read captured user', operationId: 'getUser', status: 200, rationale: 'Read newly created record', request: { pathParams: { id: '${userId}' } }, assertions: [{ path: '$', operator: 'equals', value: '${createdBody}', sourcePointer: '/paths/~1users~1{id}/get' }] },
            { id: 'delete-new', title: 'Remove test user', operationId: 'deleteUser', status: 204, rationale: 'Clean up created record', request: { pathParams: { id: '${userId}' } } },
          ] }], repairs: [], riskNotes: [] };
      } else if (system.startsWith('Independently verify')) {
        calls.push('verifier');
        output = { assessments: input.obligations.map((o: { id: string }) => ({ obligationId: o.id, verdict: 'verified', reason: 'Checks empty data at a valid distant offset.', proofs: [{ testId: 'agent-last-page', assertionPointers: ['/assertions/0'] }] })),
          isolation: [...input.plan.cases, ...input.plan.workflows].map((u: { id: string }) => ({ unitId: u.id, verdict: 'isolated', reason: 'Controlled regression fixture.' })) };
      } else if (system.startsWith('Investigate actual')) {
        calls.push('healer'); healerEvidence = input.evidence;
        assert.ok(input.evidence.execution.failures.length);
        if (!defect) {
          assert.match(JSON.stringify(input.evidence.execution.failures), /agent-last-page/);
          assert.ok(input.evidence.execution.failures.some((failure: { exchanges: unknown[] }) => failure.exchanges.length > 0), 'healer receives actual HTTP exchange evidence');
        }
        output = { classification: defect ? 'product-defect' : 'test-implementation', hypothesis: defect ? 'Health response violates its declared schema.' : 'The authored test used zero as a page size; the declared minimum is one. Preserve the expected 200 and fix the test input.',
          changes: defect ? {} : { repairs: [{ caseId: 'agent-last-page', request: { query: { limit: 1, offset: 10000 } }, rationale: 'Restore the intended smallest valid page size.' }] } };
      } else {
        calls.push('critic'); output = { decision: 'pass', findings: [] };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Private reasoning is not the structured answer.' }] }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }));
    } catch (error) {
      res.writeHead(500); res.end(String(error));
    }
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const modelPort = (model.address() as { port: number }).port;
  const port = defect ? 4121 : 4120;
  const server = spawn(process.execPath, ['fixtures/sample-api.mjs'], { env: { ...process.env, FIXTURE_PORT: String(port), SAMPLE_API_KEY: 'gauntlet-local-key', ...(defect ? { FIXTURE_DEFECT: 'health-schema' } : {}) }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* startup */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const root = await mkdtemp(path.join(tmpdir(), 'gauntlet-agentic-e2e-'));
    await cp('specs/sample-api.yaml', path.join(root, 'spec.yaml'));
    await writeFile(path.join(root, 'context.md'), 'Pagination should handle the smallest valid page size at an offset beyond the available collection.\n');
    const original = JSON.parse(await readFile('gauntlet.config.json', 'utf8'));
    const config = { ...original, spec: 'spec.yaml', baseUrl: `http://127.0.0.1:${port}`, discovery: { enabled: true, required: true, sources: ['context.md'] },
      agents: { provider: 'openai', builderModel: 'mock-model', criticModel: 'mock-model', apiKeyEnv: 'GAUNTLET_TEST_MODEL_KEY', openaiBaseUrl: `http://127.0.0.1:${modelPort}` } };
    process.env.GAUNTLET_TEST_MODEL_KEY = 'test-only-model-key';
    process.env.SAMPLE_API_KEY = 'gauntlet-local-key';
    const configPath = path.join(root, 'gauntlet.config.json');
    await writeFile(configPath, JSON.stringify(config));
    const result = await runGauntlet({ configPath });
    return { result, calls, healerEvidence, plan: JSON.parse(await readFile(path.join(result.runDir, 'plan.json'), 'utf8')) as TestPlan };
  } finally {
    server.kill('SIGTERM');
    await once(server, 'close');
    model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
  }
}

test('agentic HTTP provider discovers prose, implements cases/workflows, repairs a real failing test and passes a full rerun', { timeout: 240_000 }, async () => {
  const { result, calls, plan } = await runFixture();
  assert.equal(result.status, 'PASSED', JSON.stringify(result.findings));
  assert.equal(result.iterations, 2);
  assert.deepEqual(calls, ['discovery', 'lead', 'builder', 'lead', 'verifier', 'critic', 'lead', 'healer', 'lead', 'verifier', 'critic', 'lead']);
  assert.equal(result.heals[0]?.classification, 'test-implementation');
  assert.equal(result.heals[0]?.policyDecision, 'auto');
  assert.deepEqual(plan.cases.find((item) => item.id === 'agent-last-page')?.expected.statuses, [200]);
  assert.equal(plan.cases.find((item) => item.id === 'agent-last-page')?.query.limit, 1);
  assert.equal(plan.workflows.find((item) => item.id === 'agent-read-created')?.steps.length, 3);
  const report = JSON.parse(await readFile(path.join(result.runDir, 'analysis.json'), 'utf8'));
  assert.equal(report.attempts.length, 2);
  assert.equal(report.attempts[0].execution.failed > 0, true);
  assert.equal(report.attempts[1].execution.failed, 0);
  assert.equal(report.scenarios.find((item: { origin: string }) => item.origin === 'llm').disposition, 'implemented');
});

test('agent healer leaves a genuine API schema defect red even when model critic says pass', { timeout: 240_000 }, async () => {
  const { result, calls } = await runFixture(true);
  assert.equal(result.status, 'FAILED', JSON.stringify(result.findings));
  assert.equal(result.heals[0]?.classification, 'product-defect');
  assert.equal(result.heals[0]?.policyDecision, 'denied');
  assert.ok(calls.includes('healer'));
  assert.ok(result.findings.some((item) => item.code === 'CONTRACT_ASSERTION_FAILED'));
});
