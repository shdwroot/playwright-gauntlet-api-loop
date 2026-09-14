// Runs actual configured models against an isolated local sample API.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../dist/src/config.js';
import { runGauntlet } from '../dist/src/gauntlet.js';

const { config: selected } = await loadConfig();
if (selected.agents.provider !== 'openai') throw new Error('LIVE_VERIFICATION_REQUIRES_OPENAI_PROVIDER');
const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const root = path.resolve('.gauntlet', `live-agentic-${Date.now()}`);
await mkdir(root, { recursive: true });
await cp('specs/sample-api.yaml', path.join(root, 'spec.yaml'));
await cp('context', path.join(root, 'context'), { recursive: true });
const config = {
  projectName: 'luna-local-acceptance', spec: 'spec.yaml', baseUrl: `http://127.0.0.1:${port}`,
  generatedDir: 'generated', artifactsDir: 'runs', seed: 42, maxIterations: 3, timeoutMs: 30000,
  headersFromEnv: { 'x-api-key': 'SAMPLE_API_KEY' },
  discovery: { enabled: true, required: true, sources: ['context'] },
  safety: { allowedHosts: ['127.0.0.1'], allowedMethods: ['GET', 'POST', 'DELETE'], allowDestructive: true, allowProduction: false, maxRequestsPerRun: 150, maxResponseBytes: 65536 },
  agents: selected.agents, quality: { minimumScore: 95, minimumOperationCoverage: 1 },
};
const configPath = path.join(root, 'gauntlet.config.json');
await writeFile(configPath, JSON.stringify(config, null, 2));
process.env.SAMPLE_API_KEY ||= 'gauntlet-local-key';
const fixture = spawn(process.execPath, ['fixtures/sample-api.mjs'], { env: { ...process.env, FIXTURE_PORT: String(port) }, stdio: ['ignore', 'ignore', 'inherit'] });
const closed = once(fixture, 'close');
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${config.baseUrl}/health`)).ok) { ready = true; break; } } catch { /* wait for fixture */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!ready) throw new Error('LOCAL_FIXTURE_STARTUP_FAILED');
  console.error(`Live ${selected.agents.builderModel} verification; isolated fixture ${config.baseUrl}; evidence ${root}`);
  const result = await runGauntlet({ configPath });
  console.log(JSON.stringify({ status: result.status, iterations: result.iterations, score: result.finalScore, runDir: result.runDir, findings: result.findings, heals: result.heals }, null, 2));
  if (result.status !== 'PASSED') process.exitCode = 1;
} finally {
  fixture.kill('SIGTERM');
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
}
