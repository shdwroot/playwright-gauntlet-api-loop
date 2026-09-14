import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BuilderAgent, HealerAgent, LeadAgent, createAgentProvider, type AgentProvider, type LeadAction } from './agents.js';
import { CriticAgent } from './critic.js';
import { discoverScenarios } from './discovery.js';
import { auditedAgentProvider, newRunId, RunLedger } from './evidence.js';
import { generateArtifacts, verifyGeneratedArtifacts } from './generator.js';
import { healGeneratedArtifacts, injectStaleGeneratedData } from './healer.js';
import { loadContract } from './openapi.js';
import { runPlaywright } from './runner.js';
import type { CriticFinding, CriticVerdict, ExecutionSummary, GauntletConfig, HealAudit, RunResult, TestPlan } from './types.js';
import { errorMessage, sha256, stableStringify } from './utils.js';

export async function runAgenticGauntlet(config: GauntletConfig, options: { runId?: string; injectStaleData?: boolean; agentProvider?: AgentProvider } = {}): Promise<RunResult> {
  const underlying = options.agentProvider ?? createAgentProvider(config.agents);
  const contract = await loadContract(config.spec);
  const ledger = new RunLedger(options.runId ?? newRunId(), config);
  await ledger.initialize(contract.specHash);
  const provider = auditedAgentProvider(underlying, ledger);
  const heals: HealAudit[] = [];
  const history: Array<{ action: string; reason: string }> = [];
  let plan: TestPlan | undefined;
  let execution: ExecutionSummary | undefined;
  let verdict: CriticVerdict | undefined;
  let iterations = 0;
  let requests = 0;
  let latestError: string | undefined;
  const seenFailures = new Set<string>();
  const lead = new LeadAgent(provider);
  const builder = new BuilderAgent(provider);
  const healer = new HealerAgent(provider);
  const critic = new CriticAgent(provider);
  const finish = async (status: RunResult['status'], reason: string): Promise<RunResult> => {
    await ledger.record(status, iterations, reason);
    const findings: CriticFinding[] = [...(verdict?.findings ?? [])];
    if (status !== 'PASSED') findings.push({ code: `AGENT_${status}`, severity: 'blocking', message: reason, evidence: [latestError ?? reason] });
    const result: RunResult = { runId: ledger.runId, status, iterations, runDir: ledger.runDir, finalScore: verdict?.score ?? 0, findings, events: ledger.events, heals };
    await ledger.finalize(result);
    return result;
  };
  try {
    await ledger.record('DISCOVER', 0, 'Discovery agent analyzing source text and API semantics');
    const discovery = await discoverScenarios(contract, config, provider);
    await ledger.write('discovery/report.json', discovery);
    let allowedActions: LeadAction[] = ['build', 'block'];
    // Execution iterations and model decisions are separate bounded budgets.
    for (let turn = 1; turn <= config.maxIterations * 4 + 2; turn += 1) {
      const decision = await lead.decide(config, {
        discovery, plan, execution, verdict, history, latestError,
        remainingExecutions: config.maxIterations - iterations,
        remainingRequests: config.safety.maxRequestsPerRun - requests,
      }, allowedActions);
      await ledger.write(`agents/lead-${turn}.json`, decision.invocation);
      history.push({ action: decision.action, reason: decision.reason });
      if (decision.action === 'block') return finish('BLOCKED', decision.reason);
      if (decision.action === 'accept') {
        if (verdict?.decision !== 'pass') return finish('BLOCKED', 'Lead attempted acceptance without passing execution gates.');
        return finish('PASSED', decision.reason);
      }
      if (decision.action === 'build') {
        await ledger.record('PLAN', iterations, decision.reason);
        try {
          const feedback: CriticFinding[] = [...(verdict?.findings ?? []),
            { code: 'LEAD_TASK', severity: 'info', message: decision.reason, evidence: [] },
            ...(latestError ? [{ code: 'PREVIOUS_PROPOSAL_REJECTED', severity: 'warning' as const, message: latestError, evidence: [] }] : []),
          ];
          const built = await builder.build(contract, config, feedback, discovery, plan);
          await ledger.write(`agents/builder-${turn}.json`, built.invocation);
          const changed = !plan || stableStringify({ cases: built.plan.cases, workflows: built.plan.workflows }) !== stableStringify({ cases: plan.cases, workflows: plan.workflows });
          if (!changed && verdict) return finish(verdict.decision === 'pass' ? 'STALLED' : 'FAILED', 'Builder supplied no executable changes after the previous execution.');
          if (!changed && latestError) return finish('STALLED', 'Builder made no changes after rejected output.');
          plan = built.plan;
          await ledger.write(`plans/turn-${turn}.json`, plan);
          await ledger.write('plan.json', plan);
          await generateArtifacts(plan, config);
          if (options.injectStaleData && iterations === 0 && !execution) {
            await injectStaleGeneratedData(config);
            options.injectStaleData = false;
          }
          verdict = undefined;
          latestError = undefined;
          allowedActions = ['execute', 'build', 'block'];
        } catch (error) {
          latestError = errorMessage(error);
          await ledger.write(`agents/builder-${turn}-rejected.json`, { error: latestError });
          allowedActions = ['build', 'block'];
        }
        continue;
      }
      if (!plan) return finish('BLOCKED', 'No validated test implementation exists.');
      if (decision.action === 'heal') {
        await ledger.record('HEAL', iterations, decision.reason);
        try {
          const repaired = await healer.repair(contract, config, plan, { execution, verdict, latestError, history });
          await ledger.write(`agents/healer-${turn}.json`, repaired.invocation);
          const beforeHash = sha256(stableStringify(plan));
          const afterHash = sha256(stableStringify(repaired.plan));
          const changed = stableStringify({ cases: plan.cases, workflows: plan.workflows }) !== stableStringify({ cases: repaired.plan.cases, workflows: repaired.plan.workflows });
          const diffPath = await ledger.write(`repairs/turn-${turn}.json`, { hypothesis: repaired.hypothesis, before: plan, after: repaired.plan });
          const audit: HealAudit = { iteration: iterations, classification: repaired.classification,
            policyDecision: changed ? 'auto' : 'denied', hypothesis: repaired.hypothesis,
            changedFiles: changed ? ['plan.generated.json', 'manifest.json'] : [], beforeHashes: { plan: beforeHash }, afterHashes: { plan: afterHash }, diffPath, rollback: false };
          heals.push(audit);
          await ledger.write(`attempts/${iterations}/heal.json`, audit);
          if (!changed) return finish(repaired.classification === 'infrastructure' ? 'BLOCKED' : 'FAILED', repaired.hypothesis);
          plan = repaired.plan;
          await ledger.write('plan.json', plan);
          await generateArtifacts(plan, config);
          verdict = undefined;
          latestError = undefined;
          allowedActions = ['execute', 'block'];
        } catch (error) {
          latestError = errorMessage(error);
          await ledger.write(`agents/healer-${turn}-rejected.json`, { error: latestError });
          allowedActions = ['heal', 'block'];
        }
        continue;
      }
      if (iterations >= config.maxIterations) return finish('FAILED', 'Execution iteration budget exhausted.');
      const requestCount = plan.cases.length + plan.workflows.reduce((count, workflow) => count + workflow.steps.length, 0);
      if (requests + requestCount > config.safety.maxRequestsPerRun) return finish('BLOCKED', 'Cumulative request budget exhausted before the next full regression.');
      requests += requestCount;
      iterations += 1;
      const integrity = await verifyGeneratedArtifacts(config).catch(() => ({ valid: false }));
      const candidateContents = await readFile(path.join(config.generatedDir, 'plan.generated.json'), 'utf8').catch(() => '');
      if (!integrity.valid || candidateContents !== stableStringify(plan)) {
        const audit = await healGeneratedArtifacts(plan, config, iterations, ledger.runDir);
        heals.push(audit);
        await ledger.write(`attempts/${iterations}/integrity-repair.json`, audit);
      }
      await ledger.record('EXECUTE', iterations, decision.reason);
      execution = await runPlaywright(config, ledger.runId, path.join(ledger.runDir, 'attempts', String(iterations)));
      await ledger.write(`attempts/${iterations}/execution.json`, execution);
      const manifest = (await verifyGeneratedArtifacts(config)).manifest;
      await ledger.record('CRITIQUE', iterations, 'Independent critic inspecting authored tests and actual execution evidence');
      verdict = await critic.review(contract, plan, manifest, execution, config);
      await ledger.write(`attempts/${iterations}/critic.json`, verdict);
      if (verdict.decision !== 'pass') {
        const fingerprint = sha256(stableStringify({ cases: plan.cases, workflows: plan.workflows, failures: execution.failureFingerprints, hardFailures: verdict.hardFailures }));
        if (seenFailures.has(fingerprint)) return finish('STALLED', 'Same test implementation and failure evidence repeated.');
        seenFailures.add(fingerprint);
      }
      allowedActions = verdict.decision === 'pass' ? ['accept', 'build', 'block'] : ['heal', 'build', 'block'];
    }
    return finish('STALLED', 'Agent decision budget exhausted without acceptance.');
  } catch (error) {
    latestError = errorMessage(error);
    await ledger.write('agents/error.json', { error: latestError });
    return finish('BLOCKED', latestError);
  }
}
