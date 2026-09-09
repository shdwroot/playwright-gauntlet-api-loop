import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runGauntlet } from './gauntlet.js';

async function waitForFixture(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:4010/health');
      if (response.ok) return;
    } catch { /* retry until bounded deadline */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Fixture did not become ready');
}

async function main(): Promise<void> {
  process.env.SAMPLE_API_KEY = process.env.SAMPLE_API_KEY ?? 'gauntlet-local-key';
  const fixture = spawn(process.execPath, ['fixtures/sample-api.mjs'], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let fixtureError = '';
  fixture.stderr.on('data', (chunk: Buffer) => { fixtureError += chunk.toString(); });
  try {
    await waitForFixture();
    const result = await runGauntlet({ injectStaleData: true });
    console.log(JSON.stringify({ demo: 'stale generated data rejected, safely healed, and regression-tested', status: result.status, iterations: result.iterations, heals: result.heals, runDir: result.runDir }, null, 2));
    if (result.status !== 'PASSED' || result.iterations !== 2 || result.heals.length !== 1) process.exitCode = 1;
  } finally {
    fixture.kill('SIGTERM');
    await Promise.race([once(fixture, 'close'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (fixtureError) console.error(fixtureError);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
