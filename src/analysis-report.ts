import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { CriticVerdict, DiscoveryReport, ExecutionSummary, RunResult, TestPlan } from './types.js';
import { atomicWrite, sha256, stableStringify } from './utils.js';
import { redactAgentData } from './agent-redaction.js';

export async function optionalJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export function scenarioLedger(discovery: DiscoveryReport | undefined, plan: TestPlan | undefined) {
  const cases = [...(plan?.cases ?? []), ...(plan?.workflows.flatMap(workflow => workflow.steps) ?? [])];
  return (discovery?.candidates ?? []).map(candidate => {
    const tests = cases.filter(item => item.discovery?.candidateIds.includes(candidate.id)).map(item => item.id);
    // Identity is content-derived, not an assertion that differently worded AI proposals are equivalent.
    const identity = { operation: candidate.operationId, signal: candidate.signal,
      title: candidate.title, scenario: candidate.scenario,
      sources: candidate.evidence.map(item => ({ path: item.sourcePath, excerpt: item.excerpt })) };
    return { id: sha256(stableStringify(identity)), candidateId: candidate.id,
      title: candidate.title ?? candidate.signal, operationId: candidate.operationId,
      origin: candidate.origin ?? 'deterministic', confidence: candidate.confidence,
      disposition: tests.length ? 'implemented' : candidate.disposition === 'reject' ? 'rejected' : 'unimplemented',
      reason: candidate.reason, tests, evidence: candidate.evidence };
  });
}

export async function writeAnalysisReport(result: RunResult, context: unknown = {}) {
  const plan = await optionalJson<TestPlan>(path.join(result.runDir, 'plan.json'));
  const discovery = plan?.discovery ?? await optionalJson<DiscoveryReport>(path.join(result.runDir, 'discovery/report.json'));
  const attempts: Array<{ iteration: number; execution?: ExecutionSummary; critic?: CriticVerdict }> = [];
  for (let iteration = 1; iteration <= result.iterations; iteration++) {
    const execution = await optionalJson<ExecutionSummary>(path.join(result.runDir, `attempts/${iteration}/execution.json`));
    const critic = await optionalJson<CriticVerdict>(path.join(result.runDir, `attempts/${iteration}/critic.json`));
    attempts.push({ iteration, ...(execution ? { execution } : {}), ...(critic ? { critic } : {}) });
  }
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, callsWithoutUsage: 0 };
  const callDir = path.join(result.runDir, 'agents/calls');
  const files = await readdir(callDir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of files.filter(name => name.endsWith('-output.json'))) {
    const call = await optionalJson<{ usage?: { inputTokens: number; outputTokens: number }; durationMs?: number }>(path.join(callDir, name));
    usage.calls++; usage.durationMs += call?.durationMs ?? 0;
    if (call?.usage) { usage.inputTokens += call.usage.inputTokens; usage.outputTokens += call.usage.outputTokens; }
    else usage.callsWithoutUsage++;
  }
  const scenarios = scenarioLedger(discovery, plan);
  const gaps = scenarios.filter(item => item.disposition === 'unimplemented');
  const report = redactAgentData({ formatVersion: 1, runId: result.runId, status: result.status,
    executionScore: result.finalScore, context, scenarios, gaps, attempts,
    finalFindings: result.findings, repairs: result.heals, events: result.events, usage,
    limitations: ['Scenario linkage establishes implemented coverage, not proof that an assertion captures every intended business rule.',
      'Scenario identities are content-derived; semantic reconciliation across rewritten requirements is not yet implemented.',
      'This report does not certify that discovery found every requirement.'] });
  await atomicWrite(path.join(result.runDir, 'analysis.json'), stableStringify(report));
  const safe = (value: unknown) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const lines = [`# API Gauntlet analysis: ${result.runId}`, '', `Status: **${result.status}**. Execution score: ${result.finalScore}.`, '',
    `Discovered scenarios: ${scenarios.length}. Implemented: ${scenarios.filter(item => item.tests.length).length}. Unimplemented: ${gaps.length}.`, '',
    'An execution score is not a completeness score. Scenario-to-test links and discovery itself still require semantic verification.', '',
    '## Context revision', '', '```json', stableStringify(context).trim(), '```', '',
    '## Scenario coverage', '', '| Scenario | Disposition | Tests |', '| --- | --- | --- |',
    ...scenarios.map(item => `| ${safe(item.title)} | ${item.disposition} | ${safe(item.tests.join(', '))} |`), '',
    '## Attempts and failures', '', ...attempts.flatMap(attempt => [
      `### Attempt ${attempt.iteration}`, '',
      attempt.execution ? `${attempt.execution.status}: ${attempt.execution.passed} passed, ${attempt.execution.failed} failed, ${attempt.execution.skipped} skipped.` : 'No execution summary available.', '',
      ...(attempt.execution?.failures ?? []).map(failure => `- ${safe(failure.title)}: ${safe(failure.messages.join('; '))}`),
      ...(attempt.critic?.findings ?? []).map(finding => `- ${finding.severity}: ${safe(finding.code)} — ${safe(finding.message)}`), '',
      `[Attempt evidence](attempts/${attempt.iteration}/execution.json)`, '',
    ]), '## Repairs', '', ...result.heals.map(heal => `- ${safe(heal.classification)} (${heal.policyDecision}): ${safe(heal.hypothesis)}`), '',
    '## Final findings', '', ...result.findings.map(finding => `- ${finding.severity}: ${safe(finding.code)} — ${safe(finding.message)}`), '',
    '## Model usage', '', `${usage.calls} completed calls; ${usage.inputTokens} reported input tokens; ${usage.outputTokens} reported output tokens. ${usage.callsWithoutUsage} calls omitted token usage.`, '',
    '[Structured analysis and source citations](analysis.json) · [Final result](result.json)', ''];
  await atomicWrite(path.join(result.runDir, 'analysis.md'), String(redactAgentData(lines.join('\n'))));
  return { scenarios, reportPath: path.join(result.runDir, 'analysis.md') };
}
