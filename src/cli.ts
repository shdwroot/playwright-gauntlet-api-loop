#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverOnly, generateOnly, runGauntlet } from './gauntlet.js';
import { loadConfig, loadProjectEnvironment } from './config.js';
import { loadContract } from './openapi.js';
import { errorMessage } from './utils.js';
import { snapshotContext, watchRevisions } from './maintenance.js';
import { onboard, refreshOnboardedProject } from './onboarding.js';

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
  api-gauntlet run [--config path] [--watch] [--inject-stale-data]
  api-gauntlet run --url <API-or-OpenAPI-URL> [--context path ...] [--source auto|path] [--project-dir path] [--model model]
  api-gauntlet report <run-id-or-directory> [--config path]

Agentic mode: append --agentic --model <model-id> (or set OPENAI_MODEL). Requires the configured API key (OPENAI_API_KEY by default).
Config agents.provider=openai also enables agentic mode, with separate role models.

One-shot exit codes: 0 passed, 1 failed, 2 blocked/stalled, 3 framework/config error.
Watch mode reports each run; use one-shot run for a CI exit code.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'help';
  let configPath = option(args, '--config');
  loadProjectEnvironment(configPath);
  const url = option(args, '--url');
  if (url) {
    if (configPath) throw new Error('Choose --url or --config, not both');
    if (!['run', 'discover', 'generate', 'doctor'].includes(command)) throw new Error('URL_COMMAND_INVALID');
    configPath = await onboard({ url, context: args.flatMap((value, index) => value === '--context' && args[index + 1] ? [args[index + 1]!] : []),
      directory: option(args, '--project-dir'), model: option(args, '--model'), source: option(args, '--source'), allowProduction: args.includes('--allow-production') });
    // An explicitly supplied target takes precedence over an unrelated .env URL.
    process.env.GAUNTLET_BASE_URL = (JSON.parse(await readFile(configPath, 'utf8')) as { baseUrl: string }).baseUrl;
    process.env.GAUNTLET_AGENT_PROVIDER = 'openai';
  }
  if (args.includes('--agentic')) {
    const model = option(args, '--model') ?? process.env.OPENAI_MODEL;
    if (!model || model.startsWith('--')) throw new Error('AGENT_MODEL_REQUIRED: use --model or set OPENAI_MODEL');
    process.env.GAUNTLET_AGENT_PROVIDER = 'openai';
    process.env.GAUNTLET_AGENT_MODEL = model;
  }
  if (['discover', 'generate', 'run', 'loop'].includes(command)) {
    const { config } = await loadConfig(configPath);
    console.error(config.agents.provider === 'openai'
      ? `AGENTIC: live model calls enabled (discovery, lead, builder, verifier, critic, healer as needed). Model: ${config.agents.builderModel}`
      : 'OFFLINE: deterministic fixture mode; no LLM calls. Use --agentic --model <model-id> for autonomous agents.');
  }
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
    if (args.includes('--watch')) {
      const controller = new AbortController();
      const stop = () => { console.error('Stopping watch after the active run finishes.'); controller.abort(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        await watchRevisions({ signal: controller.signal,
          revision: async () => { const loaded = await loadConfig(configPath); return (await snapshotContext(loaded.config, loaded.configPath)).revision; },
          execute: async () => {
            if (configPath) await refreshOnboardedProject(configPath);
            const result = await runGauntlet(configPath ? { configPath } : {});
            console.log(JSON.stringify({ status: result.status, runId: result.runId, report: path.join(result.runDir, 'analysis.md') }));
          },
          onError: error => console.error(errorMessage(error)),
        });
      } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
      return;
    }
    const result = await runGauntlet({ ...(configPath ? { configPath } : {}), injectStaleData: args.includes('--inject-stale-data') });
    const blockers = result.findings.filter(finding => finding.severity === 'blocking');
    console.log(JSON.stringify({ status: result.status, runId: result.runId, iterations: result.iterations, score: result.finalScore,
      runDir: result.runDir, report: path.join(result.runDir, 'analysis.md'),
      hardFindings: blockers.map(finding => finding.code),
      reasons: [...new Set(blockers.map(finding => finding.message))],
      coverage: result.coverage ? { verified: result.coverage.obligations.filter(o => o.status === 'verified').length,
        outstanding: result.coverage.obligations.filter(o => o.status !== 'verified' && o.status !== 'superseded').length } : undefined,
    }, null, 2));
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
