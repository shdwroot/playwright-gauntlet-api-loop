import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runGauntlet } from '../../dist/src/gauntlet.js';

const fixturePath = fileURLToPath(new URL('./witness-api.mjs', import.meta.url));
const configPath = fileURLToPath(new URL('./gauntlet.config.json', import.meta.url));
process.env.WITNESS_AUTHORIZATION ??= 'Bearer witness-local-token';

async function waitForFixture(child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Witness contract fixture exited before becoming ready');
    try {
      if ((await fetch('http://127.0.0.1:4030/health')).ok) return;
    } catch {
      // Bounded retry while the loopback server starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Witness contract fixture did not become ready on http://127.0.0.1:4030');
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required; the demo never writes it to disk');
  }
  const fixture = spawn(process.execPath, [fixturePath], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let fixtureError = '';
  fixture.stderr.on('data', (chunk) => { fixtureError += chunk.toString(); });
  try {
    await waitForFixture(fixture);
    const result = await runGauntlet({ configPath, injectStaleData: true });
    console.log(JSON.stringify({
      example: 'the-witness-contract-lab',
      status: result.status,
      iterations: result.iterations,
      score: result.finalScore,
      runDir: result.runDir,
      healDecisions: result.heals.map((heal) => ({
        iteration: heal.iteration,
        classification: heal.classification,
        decision: heal.policyDecision,
        changedFiles: heal.changedFiles,
      })),
      hardFindings: result.findings.filter((finding) => finding.severity === 'blocking').map((finding) => finding.code),
    }, null, 2));
    if (result.status !== 'PASSED') process.exitCode = 1;
  } finally {
    if (fixture.exitCode === null) fixture.kill('SIGTERM');
    await Promise.race([once(fixture, 'close'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (fixtureError) console.error(fixtureError);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
