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
import { parseAgentFindings } from '../../src/critic.js';
import type { GauntletConfig } from '../../src/types.js';

async function tempConfig(): Promise<GauntletConfig> {
  const { config } = await loadConfig();
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
