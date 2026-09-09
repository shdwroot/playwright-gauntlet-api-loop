import path from 'node:path';
import type { CriticFinding, HealAudit, RunResult } from './types.js';
import { loadConfig } from './config.js';
import { loadContract } from './openapi.js';
import { BuilderAgent, createAgentProvider } from './agents.js';
import { CriticAgent } from './critic.js';
import { generateArtifacts, verifyGeneratedArtifacts } from './generator.js';
import { healGeneratedArtifacts, injectStaleGeneratedData } from './healer.js';
import { newRunId, RunLedger } from './evidence.js';
import { runPlaywright } from './runner.js';
import { sha256, stableStringify } from './utils.js';

export interface RunOptions {
  configPath?: string;
  injectStaleData?: boolean;
  runId?: string;
}

export async function runGauntlet(options: RunOptions = {}): Promise<RunResult> {
  const { config } = await loadConfig(options.configPath);
  const contract = await loadContract(config.spec);
  const runId = options.runId ?? newRunId();
  const ledger = new RunLedger(runId, config);
  await ledger.initialize(contract.specHash);
  await ledger.record('DISCOVER', 0, `Loaded ${contract.operations.length} operations from ${contract.title}`);

  const provider = createAgentProvider(config.agents);
  const builder = new BuilderAgent(provider);
  const critic = new CriticAgent(provider);
  await ledger.record('PLAN', 0, 'Builder agent compiling a typed, contract-derived test plan');
  const built = await builder.build(contract, config);
  await ledger.write('agents/builder.json', built.invocation);
  const trustedPlan = built.plan;
  await ledger.write('plan.json', trustedPlan);

  await ledger.record('GENERATE', 0, 'Rendering deterministic Playwright tests and data');
  let manifest = await generateArtifacts(trustedPlan, config);
  await ledger.write('generated-manifest.json', manifest);
  if (options.injectStaleData) {
    const caseId = await injectStaleGeneratedData(config);
    await ledger.record('GENERATE', 0, `Injected a controlled stale data fault into ${caseId} for healing verification`);
  }

  const heals: HealAudit[] = [];
  const seenFingerprints = new Set<string>();
  let lastFindings: CriticFinding[] = [];
  let finalScore = 0;
  for (let iteration = 1; iteration <= config.maxIterations; iteration += 1) {
    await ledger.record('EXECUTE', iteration, 'Executing signed generated tests with Playwright APIRequestContext');
    const integrity = await verifyGeneratedArtifacts(config);
    if (!integrity.valid) {
      await ledger.record('HEAL', iteration, `Pre-execution integrity failure: ${integrity.mismatches.join('; ')}`);
      const audit = await healGeneratedArtifacts(trustedPlan, config, iteration, ledger.runDir);
      heals.push(audit);
      await ledger.write(`attempts/${iteration}/heal.json`, audit);
      if (audit.policyDecision !== 'auto') break;
    }
    const attemptDir = path.join(ledger.runDir, 'attempts', String(iteration));
    const execution = await runPlaywright(config, runId, attemptDir);
    await ledger.write(`attempts/${iteration}/execution.json`, execution);

    manifest = (await verifyGeneratedArtifacts(config)).manifest;
    const plan = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(config.generatedDir, 'plan.generated.json'), 'utf8'));
    await ledger.record('CRITIQUE', iteration, 'Independent critic evaluating the immutable contract and raw Playwright evidence');
    const verdict = await critic.review(contract, plan, manifest, execution, config);
    await ledger.write(`attempts/${iteration}/critic.json`, verdict);
    finalScore = verdict.score;
    lastFindings = verdict.findings;
    if (verdict.decision === 'pass') {
      await ledger.record('PASSED', iteration, `All hard gates passed with critic score ${verdict.score}`);
      const result: RunResult = { runId, status: 'PASSED', iterations: iteration, runDir: ledger.runDir, finalScore, findings: lastFindings, events: ledger.events, heals };
      await ledger.finalize(result);
      return result;
    }
    if (verdict.decision === 'block') {
      await ledger.record('BLOCKED', iteration, verdict.hardFailures.join(', '));
      const result: RunResult = { runId, status: 'BLOCKED', iterations: iteration, runDir: ledger.runDir, finalScore, findings: lastFindings, events: ledger.events, heals };
      await ledger.finalize(result);
      return result;
    }

    const fingerprint = sha256(stableStringify({ planHash: manifest.planHash, failures: execution.failureFingerprints, hardFailures: verdict.hardFailures }));
    if (seenFingerprints.has(fingerprint)) {
      await ledger.record('STALLED', iteration, 'Candidate and failure fingerprint repeated; stopping without false acceptance');
      const result: RunResult = { runId, status: 'STALLED', iterations: iteration, runDir: ledger.runDir, finalScore, findings: lastFindings, events: ledger.events, heals };
      await ledger.finalize(result);
      return result;
    }
    seenFingerprints.add(fingerprint);
    await ledger.record('HEAL', iteration, 'Classifying failure against the bounded generated-artifact repair policy');
    const audit = await healGeneratedArtifacts(trustedPlan, config, iteration, ledger.runDir);
    heals.push(audit);
    await ledger.write(`attempts/${iteration}/heal.json`, audit);
    if (audit.policyDecision !== 'auto' || audit.changedFiles.length === 0) {
      await ledger.record('FAILED', iteration, 'Failure is not safely healable without changing contract-derived expectations or the system under test');
      const result: RunResult = { runId, status: 'FAILED', iterations: iteration, runDir: ledger.runDir, finalScore, findings: lastFindings, events: ledger.events, heals };
      await ledger.finalize(result);
      return result;
    }
  }
  const iterations = config.maxIterations;
  await ledger.record('FAILED', iterations, 'Maximum iteration budget exhausted without meeting every hard gate');
  const result: RunResult = { runId, status: 'FAILED', iterations, runDir: ledger.runDir, finalScore, findings: lastFindings, events: ledger.events, heals };
  await ledger.finalize(result);
  return result;
}

export async function generateOnly(configPath?: string): Promise<{ manifestPath: string; cases: number; workflows: number }> {
  const { config } = await loadConfig(configPath);
  const contract = await loadContract(config.spec);
  const provider = createAgentProvider(config.agents);
  const { plan } = await new BuilderAgent(provider).build(contract, config);
  const manifest = await generateArtifacts(plan, config);
  return { manifestPath: path.join(config.generatedDir, 'manifest.json'), cases: manifest.caseCount, workflows: manifest.workflowCount };
}
