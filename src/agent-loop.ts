import { plannedRequestCount } from './agent-plan.js';
import { reconcileCoverage, verifyCoverage, type CoverageBacklog } from './coverage.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BuilderAgent, HealerAgent, LeadAgent, compactDiscovery, compactFindings, coverageWorklist, createAgentProvider, type AgentProvider, type LeadAction } from './agents.js';
import { CriticAgent } from './critic.js';
import { discoverScenarios } from './discovery.js';
import { auditedAgentProvider, newRunId, RunLedger } from './evidence.js';
import { generateArtifacts, verifyGeneratedArtifacts } from './generator.js';
import { healGeneratedArtifacts, injectStaleGeneratedData } from './healer.js';
import { loadContract } from './openapi.js';
import { runPlaywright } from './runner.js';
import type { CriticFinding, CriticVerdict, ExecutionSummary, GauntletConfig, HealAudit, RunResult, TestPlan } from './types.js';
import { errorMessage, sha256, stableStringify } from './utils.js';
import { repairSource } from './source-repair.js';
import { addRequirementOracles } from './requirement-oracles.js';

export async function runAgenticGauntlet(config: GauntletConfig, options: { runId?: string; injectStaleData?: boolean; agentProvider?: AgentProvider; previousBacklog?: CoverageBacklog; previousPlan?: TestPlan } = {}): Promise<RunResult> {
  const underlying = options.agentProvider ?? createAgentProvider(config.agents);
  let contract = await loadContract(config.spec);
  const ledger = new RunLedger(options.runId ?? newRunId(), config);
  await ledger.initialize(contract.specHash);
  const provider = auditedAgentProvider(underlying, ledger);
  const heals: HealAudit[] = [];
  const history: Array<{ action: string; reason: string }> = [];
  let backlog: CoverageBacklog | undefined;
  let plan: TestPlan | undefined;
  let execution: ExecutionSummary | undefined;
  let verdict: CriticVerdict | undefined;
  let iterations = 0;
  let requests = 0;
  let buildsSinceExecution = 0;
  let latestError: string | undefined;
  const seenFailures = new Set<string>();
  const rejectedProposals = new Map<string, number>();
  const repeatedRejection = (error: string) => {
    const count = (rejectedProposals.get(error) ?? 0) + 1;
    rejectedProposals.set(error, count);
    return count >= 3;
  };
  const lead = new LeadAgent(provider);
  const builder = new BuilderAgent(provider);
  const healer = new HealerAgent(provider);
  const critic = new CriticAgent(provider);
  const finish = async (status: RunResult['status'], reason: string): Promise<RunResult> => {
    await ledger.record(status, iterations, reason);
    const findings: CriticFinding[] = [...(verdict?.findings ?? [])];
    if (status !== 'PASSED') findings.push({ code: `AGENT_${status}`, severity: 'blocking', message: reason, evidence: [latestError ?? reason] });
    const result: RunResult = { runId: ledger.runId, status, iterations, runDir: ledger.runDir, finalScore: verdict?.score ?? 0, findings, events: ledger.events, heals, ...(backlog ? { coverage: backlog } : {}) };
    if (backlog) await ledger.write('coverage-backlog.json', backlog);
    await ledger.finalize(result);
    return result;
  };
  try {
    await ledger.record('DISCOVER', 0, 'Discovery agent analyzing source text and API semantics');
    const discovery = await discoverScenarios(contract, config, provider);
    contract = addRequirementOracles(contract, discovery);
    await ledger.write('requirement-oracles.json', contract.document['x-gauntlet-requirement-oracles'] ?? {});
    backlog = reconcileCoverage(discovery, options.previousBacklog);
    await ledger.write('discovery/report.json', discovery);
    let allowedActions: LeadAction[] = ['build', 'block'];
    // Execution iterations and model decisions are separate bounded budgets.
    for (let turn = 1; turn <= config.maxIterations * 6 + 2; turn += 1) {
      const decision = await lead.decide(config, {
        discovery: compactDiscovery(discovery),
        backlog: backlog?.obligations.map(({ id, status, reason }) => ({ id, status, reason })),
        plan: plan ? { operations: plan.operations, cases: plan.cases.map(c => ({ id: c.id, operationId: c.operationId, title: c.title })),
          workflows: plan.workflows.map(w => ({ id: w.id, title: w.title, steps: w.steps.map(s => ({ id: s.id, operationId: s.operationId })) })) } : undefined,
        execution: execution ? { ...execution, observations: undefined, failures: execution.failures?.map(({ title, messages }) => ({ title, messages })) } : undefined,
        verdict: verdict ? { ...verdict, invocation: undefined, findings: compactFindings(verdict.findings) } : undefined,
        coverageWorklist: plan ? coverageWorklist(plan, config.discovery.minimumConfidence) : undefined,
        history, latestError,
        remainingExecutions: config.maxIterations - iterations,
        remainingRequests: config.safety.maxRequestsPerRun - requests,
        sourceRepair: config.workflow === 'source-repair' && config.sourceRepair ? { available: true, remainingAttempts: config.sourceRepair.maxAttempts - heals.filter(h => h.classification === 'product-defect').length,
          instruction: 'Choose heal for evidenced product defects: a developer agent can patch API implementation, validate, restart and rerun the unchanged plan.' } : { available: false },
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
          const built = await builder.build(contract, config, feedback, discovery, plan ?? options.previousPlan);
          await ledger.write(`agents/builder-${turn}.json`, built.invocation);
          if (built.rejections?.length) await ledger.write(`agents/builder-${turn}-validation.json`, {rejections:built.rejections,policy:'Valid independent units retained; rejected units remain unimplemented.'});
          const changed = !plan || stableStringify({ cases: built.plan.cases, workflows: built.plan.workflows }) !== stableStringify({ cases: plan.cases, workflows: plan.workflows });
          if (!changed && buildsSinceExecution > 0) {
            latestError = built.rejections?.join('\n') || latestError;
            await ledger.record('PLAN', iterations, 'No further valid additions in this batch; executing the previously retained unexecuted plan. Rejected work remains in the backlog.');
            allowedActions = ['execute'];
            continue;
          }
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
          latestError = built.rejections?.length ? built.rejections.join('\n') : undefined;
          rejectedProposals.clear();
          buildsSinceExecution = changed ? buildsSinceExecution + 1 : 3;
          // Larger requirement sets need several bounded builder batches before
          // spending a full regression iteration. Small APIs retain one build.
          allowedActions = coverageWorklist(plan, config.discovery.minimumConfidence).remaining >= 12 && buildsSinceExecution < 3
            ? ['build', 'block'] : buildsSinceExecution >= 3 ? ['execute', 'block'] : ['execute', 'build', 'block'];
        } catch (error) {
          latestError = errorMessage(error);
          await ledger.write(`agents/builder-${turn}-rejected.json`, { error: latestError });
          if (repeatedRejection(latestError)) return finish('STALLED', `The same proposal validation error recurred three times: ${latestError}`);
          allowedActions = ['build', 'block'];
        }
        continue;
      }
      if (!plan) return finish('BLOCKED', 'No validated test implementation exists.');
      if (decision.action === 'heal') {
        await ledger.record('HEAL', iterations, decision.reason);
        try {
          const repaired = await healer.repair(contract, config, plan, { execution,
            verdict: verdict ? { ...verdict, invocation: undefined, findings: verdict.findings.map(({ code, severity, message }) => ({ code, severity, message })) } : undefined,
            latestError, history });
          await ledger.write(`agents/healer-${turn}.json`, repaired.invocation);
          if (repaired.classification === 'product-defect' && config.workflow === 'source-repair' && config.sourceRepair && execution
            && iterations < config.maxIterations
            && heals.filter(h => h.classification === 'product-defect').length < config.sourceRepair.maxAttempts) {
            await ledger.record('HEAL', iterations, 'Developer agent repairing API source; test expectations remain unchanged.');
            const audit = await repairSource(provider, config, contract, plan, execution, iterations, path.join(ledger.runDir, 'source-repairs', String(turn)), { latestError, diagnosis:repaired.hypothesis });
            heals.push(audit);
            await ledger.write(`attempts/${iterations}/source-heal.json`, audit);
            if (audit.policyDecision !== 'auto' || audit.rollback) return finish('FAILED', audit.hypothesis);
            // Do not regenerate or reinterpret a test after a product repair.
            // Only fresh execution of the unchanged plan can prove the fix.
            verdict = undefined; latestError = undefined;
            allowedActions = ['execute'];
            continue;
          }
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
          rejectedProposals.clear();
          allowedActions = ['execute', 'block'];
        } catch (error) {
          latestError = errorMessage(error);
          await ledger.write(`agents/healer-${turn}-rejected.json`, { error: latestError });
          if (repeatedRejection(latestError)) return finish('STALLED', `The same proposal validation error recurred three times: ${latestError}`);
          allowedActions = ['heal', 'block'];
        }
        continue;
      }
      if (iterations >= config.maxIterations) return finish('FAILED', 'Execution iteration budget exhausted.');
      const requestCount = plannedRequestCount(plan);
      if (requests + requestCount > config.safety.maxRequestsPerRun) return finish('BLOCKED', 'Cumulative request budget exhausted before the next full regression.');
      requests += requestCount;
      buildsSinceExecution = 0;
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
      console.error(`[execution] Attempt ${iterations}: ${execution.passed} passed, ${execution.failed} failed, ${execution.skipped} skipped`);
      await ledger.write(`attempts/${iterations}/execution.json`, execution);
      const manifest = (await verifyGeneratedArtifacts(config)).manifest;
      await ledger.record('CRITIQUE', iterations, 'Independent critic inspecting authored tests and actual execution evidence');
      const verification = await verifyCoverage(provider, config, plan, execution, backlog);
      const obligations = backlog.obligations.filter(o => o.status !== 'superseded' && o.candidate.confidence >= config.discovery.minimumConfidence);
      console.error(`[coverage] ${obligations.filter(o => o.status === 'verified').length}/${obligations.length} required obligations verified`);
      await ledger.write(`attempts/${iterations}/verification.json`, verification);
      verdict = await critic.review(contract, plan, manifest, execution, config, verification.findings);
      await ledger.write(`attempts/${iterations}/critic.json`, verdict);
      if (verdict.decision !== 'pass') {
        const fingerprint = sha256(stableStringify({ cases: plan.cases, workflows: plan.workflows, failures: execution.failureFingerprints, hardFailures: verdict.hardFailures }));
        if (seenFailures.has(fingerprint)) return finish('STALLED', 'Same test implementation and failure evidence repeated.');
        seenFailures.add(fingerprint);
      }
      allowedActions = verdict.decision === 'pass' ? ['accept', 'build', 'block']
        : execution.status === 'passed' && execution.failed === 0 ? ['build', 'block'] : ['heal', 'build', 'block'];
    }
    return finish('STALLED', 'Agent decision budget exhausted without acceptance.');
  } catch (error) {
    latestError = errorMessage(error);
    await ledger.write('agents/error.json', { error: latestError });
    return finish('BLOCKED', latestError);
  }
}
