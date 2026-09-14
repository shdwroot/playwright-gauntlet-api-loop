import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { loadContract } from '../../src/openapi.js';
import { buildPlan, sampleFromSchema } from '../../src/planner.js';
import { loadConfig } from '../../src/config.js';
import { stableStringify } from '../../src/utils.js';
import type { JsonSchema } from '../../src/types.js';

test('API target environment override takes precedence and still enforces the host policy', async () => {
  const previous = process.env.GAUNTLET_BASE_URL;
  try {
    process.env.GAUNTLET_BASE_URL = ' http://localhost:4567 ';
    assert.equal((await loadConfig('gauntlet.offline.config.json')).config.baseUrl, 'http://localhost:4567');
    process.env.GAUNTLET_BASE_URL = 'https://unapproved.example.test';
    await assert.rejects(loadConfig('gauntlet.offline.config.json'), /TARGET_DENIED/);
    process.env.GAUNTLET_BASE_URL = '';
    assert.equal((await loadConfig('gauntlet.offline.config.json')).config.baseUrl, 'http://127.0.0.1:4010');
  } finally {
    if (previous === undefined) delete process.env.GAUNTLET_BASE_URL;
    else process.env.GAUNTLET_BASE_URL = previous;
  }
});

test('normalizes the sample contract with stable traceability', async () => {
  const contract = await loadContract(path.resolve('specs/sample-api.yaml'));
  assert.equal(contract.operations.length, 6);
  assert.equal(contract.workflows.length, 1);
  assert.deepEqual(contract.operations.map((operation) => operation.operationId), [
    'resetFixture', 'getHealth', 'listUsers', 'createUser', 'getUser', 'deleteUser',
  ]);
  assert.ok(contract.operations.every((operation) => operation.sourcePointer.startsWith('/paths/')));
});

test('produces byte-stable cases, boundaries, auth negatives, and a workflow', async () => {
  const { config } = await loadConfig('gauntlet.offline.config.json');
  const contract = await loadContract(config.spec);
  const first = buildPlan(contract, config);
  const second = buildPlan(contract, config);
  assert.equal(stableStringify(first), stableStringify(second));
  assert.equal(first.cases.length, 16);
  assert.equal(first.workflows.length, 1);
  assert.ok(first.cases.some((candidate) => candidate.kind === 'authorization'));
  assert.ok(first.cases.some((candidate) => candidate.kind === 'boundary'));
  assert.ok(first.cases.some((candidate) => candidate.kind === 'validation'));
  assert.ok(first.cases.some((candidate) => candidate.kind === 'conflict'));
  assert.ok(first.operations.every((operation) => operation.coveredBy.length > 0));
});

test('schema data generation honors constraints and invalid modes', () => {
  const schema = { type: 'integer', minimum: 1, maximum: 10 } as const;
  assert.equal(sampleFromSchema(schema, 42, 'limit', 'valid'), 1);
  assert.equal(sampleFromSchema(schema, 42, 'limit', 'boundary'), 10);
  assert.equal(sampleFromSchema(schema, 42, 'limit', 'invalid'), 0);
});

test('schema data generation keeps state-changing valid and boundary identities distinct', () => {
  const schema: JsonSchema = {
    type: 'object',
    required: ['email'],
    properties: { email: { type: 'string', format: 'email' } },
  };
  const valid = sampleFromSchema(schema, 42, 'createUser.body', 'valid') as { email: string };
  const boundary = sampleFromSchema(schema, 42, 'createUser.body', 'boundary') as { email: string };
  assert.notEqual(valid.email, boundary.email);
});

test('schema data generation omits optional valid fields and emits valid UUID boundaries', () => {
  const schema: JsonSchema = {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 2 },
      optionalId: { type: 'string', format: 'uuid' },
    },
  };
  const valid = sampleFromSchema(schema, 42, 'request', 'valid') as Record<string, unknown>;
  const boundary = sampleFromSchema(schema, 42, 'request', 'boundary') as Record<string, unknown>;
  assert.deepEqual(Object.keys(valid), ['name']);
  assert.match(String(boundary.optionalId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u);
});
