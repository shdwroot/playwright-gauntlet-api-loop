import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { discoverScenarios } from '../../src/discovery.js';
import { loadContract } from '../../src/openapi.js';
import { buildPlan } from '../../src/planner.js';
import type { GauntletConfig } from '../../src/types.js';
import { stableStringify } from '../../src/utils.js';

async function base(): Promise<{ config: GauntletConfig; contract: Awaited<ReturnType<typeof loadContract>> }> {
  const { config } = await loadConfig();
  return { config, contract: await loadContract(config.spec) };
}

test('discovers, redacts, corroborates, and deterministically deduplicates logs and documents', async () => {
  const { config, contract } = await base();
  const first = await discoverScenarios(contract, config);
  const second = await discoverScenarios(contract, config);
  assert.equal(stableStringify(first), stableStringify(second));
  assert.equal(first.sourceCount, 2);
  assert.equal(first.candidates.length, 11);
  assert.ok(first.redactionCount >= 5);
  assert.ok(first.warnings.some((warning) => warning.includes('UNTRUSTED_INSTRUCTION_TEXT')));
  const serialized = stableStringify(first);
  assert.doesNotMatch(serialized, /sample-super-secret|private@example\.test|customer_837492/);
  assert.ok(first.candidates.some((candidate) => candidate.signal === 'contract-violation' && candidate.disposition === 'report-only'));
  assert.ok(first.candidates.some((candidate) => candidate.observedPath === '/admin/restart' && candidate.disposition === 'report-only'));
});

test('adds only constructible, OpenAPI-corroborated scenarios and merges baseline duplicates', async () => {
  const { config, contract } = await base();
  const report = await discoverScenarios(contract, config);
  const plan = buildPlan(contract, config, report);
  assert.equal(plan.cases.length, 20);
  assert.deepEqual(plan.cases.filter((candidate) => candidate.kind === 'discovered').map((candidate) => candidate.discovery?.signal).sort(), [
    'malformed-json', 'query-boundary', 'unsupported-media-type', 'whitespace-validation',
  ]);
  assert.ok(plan.cases.every((candidate) => candidate.oracleProvenance.every((oracle) => oracle.authority === 'openapi' && oracle.specHash === contract.specHash)));
  assert.ok(plan.discovery?.candidates.every((candidate) => candidate.disposition !== 'generate' || plan.cases.some((item) => item.discovery?.candidateIds.includes(candidate.id))));
});

test('keeps discovery disabled behavior byte-identical to contract-only planning', async () => {
  const { config, contract } = await base();
  const disabled = { ...config, discovery: { ...config.discovery, enabled: false, required: false, sources: [] } };
  const report = await discoverScenarios(contract, disabled);
  assert.equal(report.sourceCount, 0);
  assert.equal(report.candidates.length, 0);
  assert.equal(buildPlan(contract, disabled).cases.length, 16);
});

test('fails closed when a configured source is missing', async () => {
  const { config, contract } = await base();
  const root = await mkdtemp(path.join(tmpdir(), 'gauntlet-discovery-missing-'));
  const configured = {
    ...config,
    projectRoot: root,
    discovery: { ...config.discovery, enabled: true, required: true, sources: [{ id: 'missing', path: path.join(root, 'missing.log'), kind: 'log' as const }] },
  };
  await assert.rejects(discoverScenarios(contract, configured), /DISCOVERY_SOURCE_MISSING/);
});

test('rejects symlink escapes before reading external bytes', async () => {
  const { config, contract } = await base();
  const root = await mkdtemp(path.join(tmpdir(), 'gauntlet-discovery-link-'));
  const outside = path.join(tmpdir(), `gauntlet-outside-${process.pid}.log`);
  await writeFile(outside, 'GET /health status=200');
  await symlink(outside, path.join(root, 'escape.log'));
  const configured = {
    ...config,
    projectRoot: root,
    discovery: { ...config.discovery, enabled: true, required: true, sources: [{ id: 'escape', path: path.join(root, 'escape.log'), kind: 'log' as const }] },
  };
  await assert.rejects(discoverScenarios(contract, configured), /DISCOVERY_SYMLINK_REJECTED/);
});

test('enforces source byte limits without partial discovery', async () => {
  const { config, contract } = await base();
  const root = await mkdtemp(path.join(tmpdir(), 'gauntlet-discovery-size-'));
  await mkdir(path.join(root, 'context'));
  const file = path.join(root, 'context', 'large.log');
  await writeFile(file, 'GET /health status=200\n');
  const configured = {
    ...config,
    projectRoot: root,
    discovery: { ...config.discovery, enabled: true, required: true, maxFileBytes: 4, sources: [{ id: 'large', path: file, kind: 'log' as const }] },
  };
  await assert.rejects(discoverScenarios(contract, configured), /DISCOVERY_FILE_SIZE_LIMIT/);
});

test('deduplicates repeated semantic evidence while retaining every citation', async () => {
  const { config, contract } = await base();
  const root = await mkdtemp(path.join(tmpdir(), 'gauntlet-discovery-dedup-'));
  const file = path.join(root, 'events.log');
  await writeFile(file, 'GET /users/usr_9999 status=404\nGET /users/usr_8888 status=404\n');
  const configured = {
    ...config,
    projectRoot: root,
    discovery: { ...config.discovery, enabled: true, required: true, sources: [{ id: 'events', path: file, kind: 'log' as const }] },
  };
  const report = await discoverScenarios(contract, configured);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0]?.evidence.length, 2);
});
