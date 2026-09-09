import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { loadContract } from '../../src/openapi.js';
import { buildPlan, sampleFromSchema } from '../../src/planner.js';
import { loadConfig } from '../../src/config.js';
import { stableStringify } from '../../src/utils.js';

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
  const { config } = await loadConfig();
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
