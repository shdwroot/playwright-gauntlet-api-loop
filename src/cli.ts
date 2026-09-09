#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverOnly, generateOnly, runGauntlet } from './gauntlet.js';
import { loadConfig } from './config.js';
import { loadContract } from './openapi.js';
import { errorMessage } from './utils.js';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): void {
  console.log(`Playwright API Gauntlet

Usage:
  api-gauntlet doctor [--config path]
  api-gauntlet discover [--config path]
  api-gauntlet generate [--config path]
  api-gauntlet run [--config path] [--inject-stale-data]
  api-gauntlet report <run-id-or-directory> [--config path]

Exit codes: 0 passed, 1 failed, 2 blocked/stalled, 3 framework/config error.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'help';
  const configPath = option(args, '--config');
  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }
  if (command === 'doctor') {
    const { config } = await loadConfig(configPath);
    const contract = await loadContract(config.spec);
    console.log(JSON.stringify({ ok: true, project: config.projectName, target: config.baseUrl, specHash: contract.specHash, operations: contract.operations.length, workflows: contract.workflows.length }, null, 2));
    return;
  }
  if (command === 'discover') {
    console.log(JSON.stringify(await discoverOnly(configPath), null, 2));
    return;
  }
  if (command === 'generate') {
    console.log(JSON.stringify(await generateOnly(configPath), null, 2));
    return;
  }
  if (command === 'run' || command === 'loop') {
    const result = await runGauntlet({ ...(configPath ? { configPath } : {}), injectStaleData: args.includes('--inject-stale-data') });
    console.log(JSON.stringify({ status: result.status, runId: result.runId, iterations: result.iterations, score: result.finalScore, runDir: result.runDir, hardFindings: result.findings.filter((finding) => finding.severity === 'blocking').map((finding) => finding.code) }, null, 2));
    if (result.status === 'FAILED') process.exitCode = 1;
    if (result.status === 'BLOCKED' || result.status === 'STALLED') process.exitCode = 2;
    return;
  }
  if (command === 'report') {
    const target = args[1];
    if (!target) throw new Error('REPORT_ID_REQUIRED');
    const { config } = await loadConfig(configPath);
    const runDir = target.includes(path.sep) ? path.resolve(target) : path.join(config.artifactsDir, target);
    console.log(await readFile(path.join(runDir, 'result.json'), 'utf8'));
    return;
  }
  throw new Error(`UNKNOWN_COMMAND: ${command}`);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 3;
});
