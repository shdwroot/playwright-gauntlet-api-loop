// Real Luna acceptance of persistence and automatic context-change reruns.
// This deliberately uses a small health contract; it does not certify REST/SOAP completeness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { loadConfig } from '../dist/src/config.js';
import { runGauntlet } from '../dist/src/gauntlet.js';
import { snapshotContext, watchRevisions } from '../dist/src/maintenance.js';

const { config: selected } = await loadConfig();
assert.equal(selected.agents.provider, 'openai', 'This acceptance check requires real model calls');
const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const root = path.resolve('.gauntlet', `maintenance-live-${Date.now()}`);
await mkdir(root, { recursive: true });
const original = YAML.parse(await readFile('specs/sample-api.yaml', 'utf8'));
const spec = { openapi: original.openapi, info: original.info, paths: { '/health': original.paths['/health'] },
  components: { schemas: { Health: original.components.schemas.Health } } };
await writeFile(path.join(root, 'spec.json'), JSON.stringify(spec));
const contextFile = path.join(root, 'requirements.md');
await writeFile(contextFile, 'GET /health must return HTTP 200 and a JSON response matching the Health schema.\n');
const configPath = path.join(root, 'gauntlet.config.json');
await writeFile(configPath, JSON.stringify({ projectName: 'live-maintenance-acceptance', spec: 'spec.json',
  baseUrl: `http://127.0.0.1:${port}`, generatedDir: 'generated', artifactsDir: 'runs', seed: 42,
  maxIterations: 3, timeoutMs: 30000, headersFromEnv: {},
  discovery: { enabled: true, required: true, sources: ['requirements.md'] },
  safety: { allowedHosts: ['127.0.0.1'], allowedMethods: ['GET'], allowDestructive: false, allowProduction: false, maxRequestsPerRun: 40, maxResponseBytes: 65536 },
  agents: selected.agents, quality: { minimumScore: 95, minimumOperationCoverage: 1, minimumScenarioCoverage: 1 },
}, null, 2));
const fixture = spawn(process.execPath, ['fixtures/sample-api.mjs'], { env: { ...process.env, FIXTURE_PORT: String(port) }, stdio: 'ignore' });
const closed = once(fixture, 'close');
const results = [];
const execute = async () => {
  const result = await runGauntlet({ configPath }); results.push(result);
  console.error(`Live maintenance run ${results.length}: ${result.status}, ${result.runDir}`);
  assert.equal(result.status, 'PASSED', JSON.stringify(result.findings));
  return JSON.parse(await readFile(path.join(result.runDir, 'context.json'), 'utf8'));
};
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, 'fixture starts');
  console.error(`Real ${selected.agents.builderModel} maintenance verification: ${root}`);
  const initial = await execute();
  const controller = new AbortController(); let watched = 0;
  await watchRevisions({ signal: controller.signal, intervalMs: 25,
    revision: async () => { const { config } = await loadConfig(configPath); return (await snapshotContext(config, configPath)).revision; },
    execute: async () => {
      try {
        const metadata = await execute(); watched++;
        if (watched === 1) {
          assert.equal(metadata.reusedValidatedPlan, true);
          await writeFile(contextFile, 'GET /health must return HTTP 200 and a JSON response matching the Health schema.\nExplicit requirement: the response status field equals "ok".\n');
        } else {
          assert.notEqual(metadata.revision, initial.revision);
          assert.equal(metadata.reusedValidatedPlan, false);
          assert.deepEqual(metadata.changes.changed, ['requirements.md']);
          controller.abort();
        }
      } catch (error) { controller.abort(); throw error; }
    }, onError: error => { controller.abort(); throw error; },
  });
  assert.equal(results.length, 3);
  await writeFile(path.join(root, 'acceptance.json'), JSON.stringify({ status: 'PASSED', model: selected.agents.builderModel,
    checks: ['live loop', 'validated plan reuse with fresh execution', 'watch-triggered context revision and report'],
    runs: results.map(result => ({ runId: result.runId, status: result.status, report: path.join(result.runDir, 'analysis.md') })) }, null, 2));
  console.log(`Acceptance evidence: ${path.join(root, 'acceptance.json')}`);
} finally {
  fixture.kill('SIGTERM');
  await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2000))]);
}
