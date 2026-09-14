import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { loadContract } from '../../src/openapi.js';
import { buildPlan } from '../../src/planner.js';
import { generateArtifacts } from '../../src/generator.js';
import { healGeneratedArtifacts, injectStaleGeneratedData } from '../../src/healer.js';
import { summarizePlaywrightReport } from '../../src/runner.js';
import { CriticAgent, parseAgentFindings } from '../../src/critic.js';
import { sha256, stableStringify } from '../../src/utils.js';
import type { GauntletConfig } from '../../src/types.js';

async function tempConfig(): Promise<GauntletConfig> {
  const { config } = await loadConfig('gauntlet.offline.config.json');
  const root = await mkdtemp(path.join(tmpdir(), 'api-gauntlet-unit-'));
  await cp(config.spec, path.join(root, 'spec.yaml'));
  return { ...config, spec: path.join(root, 'spec.yaml'), generatedDir: path.join(root, 'generated'), artifactsDir: path.join(root, 'runs') };
}

test('healer repairs signed generated drift but refuses a matching product candidate', async () => {
  const config = await tempConfig();
  const contract = await loadContract(config.spec);
  const plan = buildPlan(contract, config);
  await generateArtifacts(plan, config);
  await mkdir(config.artifactsDir, { recursive: true });
  const denied = await healGeneratedArtifacts(plan, config, 1, config.artifactsDir);
  assert.equal(denied.policyDecision, 'denied');
  assert.deepEqual(denied.changedFiles, []);

  await injectStaleGeneratedData(config);
  const repaired = await healGeneratedArtifacts(plan, config, 2, config.artifactsDir);
  assert.equal(repaired.policyDecision, 'auto');
  assert.ok(repaired.changedFiles.includes('plan.generated.json'));
  assert.ok(repaired.changedFiles.every((file) => file === 'plan.generated.json' || file === 'manifest.json' || file === 'api.generated.spec.mjs'));
});

test('runner distinguishes product failures, infrastructure failures, and zero-test framework failures', () => {
  const paths = { reportPath: '/run/report.json', stdoutPath: '/run/stdout', stderrPath: '/run/stderr' };
  const report = { suites: [{ specs: [{ tests: [{ results: [{ status: 'failed', error: { message: 'schema mismatch' } }] }] }] }] };
  assert.equal(summarizePlaywrightReport(report, 1, 'assertion failed', paths, 10).status, 'test-failed');
  assert.equal(summarizePlaywrightReport(report, 1, 'TARGET_UNREACHABLE ECONNREFUSED', paths, 10).status, 'infrastructure-failed');
  assert.equal(summarizePlaywrightReport({}, 1, 'collection error', paths, 10).status, 'framework-failed');
});

test('AI critic findings cannot invent a blocking gate without deterministic corroboration', () => {
  const output = {
    findings: [
      { code: 'MODEL_ONLY_CONCERN', severity: 'blocking', message: 'The compact evidence may omit a detail.', evidence: ['model inference'] },
      { code: 'COVERAGE_GAP', severity: 'blocking', message: 'The configured coverage gate failed.', evidence: ['deterministic finding'] },
    ],
  };
  const findings = parseAgentFindings(output, new Set(['COVERAGE_GAP']));
  assert.equal(findings[0]?.severity, 'warning');
  assert.equal(findings[1]?.severity, 'blocking');
});

test('an otherwise green suite cannot pass with an unimplemented confident semantic scenario', async () => {
  const config = await tempConfig(); config.quality.minimumScenarioCoverage = 1;
  const contract = await loadContract(config.spec); const plan = buildPlan(contract, config);
  const unsigned = { formatVersion: 1 as const, specHash: contract.specHash, sourceCount: 0, totalBytes: 0,
    sources: [], warnings: [], redactionCount: 0, candidates: [{ id: 'missing-business-rule', origin: 'llm' as const,
      signal: 'semantic-scenario' as const, title: 'Enforce case-insensitive uniqueness', confidence: 0.99,
      disposition: 'report-only' as const, reason: 'Not implemented', evidence: [], contractPointers: [] }] };
  plan.discovery = { ...unsigned, discoveryHash: sha256(stableStringify(unsigned)) };
  const manifest = await generateArtifacts(plan, config);
  const critic = new CriticAgent({ async invoke() { return { agentId: 'test', model: 'test', promptHash: '', responseHash: '', output: { decision: 'pass', findings: [] } }; } });
  const verdict = await critic.review(contract, plan, manifest, { exitCode: 0, status: 'passed', tests: plan.cases.length + plan.workflows.length,
    passed: plan.cases.length + plan.workflows.length, failed: 0, skipped: 0, durationMs: 1,
    reportPath: '', stdoutPath: '', stderrPath: '', failureFingerprints: [] }, config);
  assert.equal(verdict.decision, 'fix');
  assert.ok(verdict.hardFailures.includes('SCENARIO_COVERAGE_GAP'));
});

test('healer evidence retains successful state-changing requests before a later failure', () => {
  const exchange = { request: { method: 'DELETE', url: '/users/usr_0001', headers: { authorization: 'Bearer private-key' } }, response: { status: 204 } };
  const report = { suites: [{ specs: [
    { title: 'delete seed', tests: [{ results: [{ status: 'passed', startTime: '2026-09-14T00:00:00Z', attachments: [{ name: 'delete-exchange.json', body: Buffer.from(JSON.stringify(exchange)).toString('base64') }] }] }] },
    { title: 'duplicate', tests: [{ results: [{ status: 'failed', startTime: '2026-09-14T00:00:01Z', error: { message: 'expected 409 actual 201' } }] }] },
  ] }] };
  const summary = summarizePlaywrightReport(report, 1, '', { reportPath: '', stdoutPath: '', stderrPath: '' }, 1);
  assert.equal(summary.observations?.[0]?.status, 'passed');
  assert.match(JSON.stringify(summary.observations), /DELETE/);
  assert.doesNotMatch(JSON.stringify(summary.observations), /private-key/);
  assert.equal(summary.failures?.[0]?.title, 'duplicate');
});
