import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, cp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { runGauntlet } from '../../src/gauntlet.js';

async function waitFor(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* bounded retry */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fixture not ready: ${url}`);
}

async function fixture(port: number, defect?: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['fixtures/sample-api.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, FIXTURE_PORT: String(port), SAMPLE_API_KEY: 'gauntlet-local-key', ...(defect ? { FIXTURE_DEFECT: defect } : {}) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitFor(`http://127.0.0.1:${port}/health`);
  return child;
}

async function configFor(port: number, withDiscovery = false): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'api-gauntlet-e2e-'));
  await cp(path.resolve('specs/sample-api.yaml'), path.join(root, 'spec.yaml'));
  if (withDiscovery) {
    await mkdir(path.join(root, 'context'));
    await cp(path.resolve('context/sample-system.log'), path.join(root, 'context/system.log'));
    await cp(path.resolve('context/scenario-guidance.md'), path.join(root, 'context/guidance.md'));
  }
  const configPath = path.join(root, 'gauntlet.config.json');
  await writeFile(configPath, JSON.stringify({
    projectName: 'e2e-users-api', spec: 'spec.yaml', baseUrl: `http://127.0.0.1:${port}`,
    generatedDir: '.gauntlet/generated', artifactsDir: '.gauntlet/runs', seed: 42, maxIterations: 3, timeoutMs: 30_000,
    headersFromEnv: { 'x-api-key': 'SAMPLE_API_KEY' },
    ...(withDiscovery ? { discovery: {
      enabled: true, required: true,
      sources: [{ id: 'system', path: 'context/system.log', kind: 'log' }, { id: 'guidance', path: 'context/guidance.md', kind: 'document' }],
      maxFiles: 10, maxFileBytes: 100_000, maxTotalBytes: 200_000,
      maxCandidates: 100, maxCandidatesPerOperation: 10, maxExcerptCharacters: 512, minimumConfidence: 0.85,
    } } : {}),
    safety: { allowedHosts: ['127.0.0.1'], allowedMethods: ['GET', 'POST', 'DELETE'], allowDestructive: true, allowProduction: false, maxRequestsPerRun: 100, maxResponseBytes: 65_536 },
    agents: { provider: 'deterministic', builderModel: 'deterministic-v1', criticModel: 'deterministic-v1' },
    quality: { minimumScore: 95, minimumOperationCoverage: 1 },
  }, null, 2));
  return configPath;
}

async function stop(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  await Promise.race([once(child, 'close'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

test('rejects stale generated data, heals it, and passes a full regression', { timeout: 240_000 }, async () => {
  process.env.SAMPLE_API_KEY = 'gauntlet-local-key';
  const port = 4110;
  const server = await fixture(port);
  try {
    const result = await runGauntlet({ configPath: await configFor(port), injectStaleData: true });
    assert.equal(result.status, 'PASSED');
    assert.equal(result.iterations, 2);
    assert.equal(result.heals.length, 1);
    assert.equal(result.heals[0]?.policyDecision, 'auto');
    assert.equal(result.finalScore, 100);
  } finally { await stop(server); }
});

test('refuses to heal a real API schema defect', { timeout: 240_000 }, async () => {
  process.env.SAMPLE_API_KEY = 'gauntlet-local-key';
  const port = 4111;
  const server = await fixture(port, 'health-schema');
  try {
    const result = await runGauntlet({ configPath: await configFor(port) });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.iterations, 1);
    assert.equal(result.heals[0]?.policyDecision, 'denied');
    assert.ok(result.findings.some((finding) => finding.code === 'CONTRACT_ASSERTION_FAILED'));
  } finally { await stop(server); }
});

test('executes corroborated log/document discoveries while quarantining untrusted findings', { timeout: 240_000 }, async () => {
  process.env.SAMPLE_API_KEY = 'gauntlet-local-key';
  const port = 4112;
  const server = await fixture(port);
  try {
    const result = await runGauntlet({ configPath: await configFor(port, true) });
    assert.equal(result.status, 'PASSED');
    assert.equal(result.finalScore, 100);
    const report = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(result.runDir, 'discovery/report.json'), 'utf8')) as { candidates: Array<{ disposition: string; observedPath?: string }>; warnings: string[] };
    assert.ok(report.candidates.some((candidate) => candidate.observedPath === '/admin/restart' && candidate.disposition === 'report-only'));
    assert.ok(report.warnings.some((warning) => warning.includes('UNTRUSTED_INSTRUCTION_TEXT')));
  } finally { await stop(server); }
});
