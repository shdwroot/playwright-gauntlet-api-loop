import { loadPrompt } from './prompts.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentProvider } from './agents.js';
import type {
  CriticFinding,
  CriticVerdict,
  ExecutionSummary,
  GauntletConfig,
  GeneratedManifest,
  NormalizedContract,
  TestPlan,
} from './types.js';
import { ensureWithin, sha256, stableStringify } from './utils.js';
import { verifyGeneratedArtifacts } from './generator.js';
import { scenarioLedger } from './analysis-report.js';
import { validOraclePointer } from './requirement-oracles.js';

function finding(code: string, message: string, evidence: string[], repair: CriticFinding['repair'] = 'none'): CriticFinding {
  return { code, severity: 'blocking', message, evidence, repair };
}

export function parseAgentFindings(output: unknown, deterministicBlockingCodes: ReadonlySet<string> = new Set()): CriticFinding[] {
  if (!output || typeof output !== 'object') return [];
  const raw = (output as Record<string, unknown>).findings;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): CriticFinding[] => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.code !== 'string' || typeof record.message !== 'string') return [];
    const requestedSeverity = record.severity === 'info' ? 'info' : record.severity === 'warning' ? 'warning' : 'blocking';
    const severity = requestedSeverity === 'blocking' && !deterministicBlockingCodes.has(record.code) ? 'warning' : requestedSeverity;
    return [{
      code: `AI_${record.code}`,
      severity,
      message: record.message.slice(0, 500),
      evidence: Array.isArray(record.evidence) ? record.evidence.map(String).slice(0, 10) : [],
      repair: 'none',
    }];
  });
}

export class CriticAgent {
  constructor(private readonly provider: AgentProvider) {}

  async review(
    contract: NormalizedContract,
    plan: TestPlan,
    manifest: GeneratedManifest,
    execution: ExecutionSummary,
    config: GauntletConfig,
    coverageFindings: CriticFinding[] = [],
  ): Promise<CriticVerdict> {
    const findings: CriticFinding[] = [...coverageFindings];
    const integrity = await verifyGeneratedArtifacts(config);
    if (!integrity.valid) findings.push(finding('ARTIFACT_INTEGRITY_FAILED', 'Generated artifacts do not match their signed manifest.', integrity.mismatches, 'regenerate-artifacts'));
    if (manifest.specHash !== contract.specHash || plan.specHash !== contract.specHash) {
      findings.push(finding('SPEC_HASH_MISMATCH', 'Candidate artifacts were not generated from the active contract.', [contract.specHash, manifest.specHash], 'regenerate-artifacts'));
    }
    const covered = plan.operations.filter((operation) => operation.coveredBy.length > 0).length;
    const coverage = plan.operations.length === 0 ? 0 : covered / plan.operations.length;
    if (coverage < config.quality.minimumOperationCoverage) {
      const missing = plan.operations.filter((operation) => operation.coveredBy.length === 0).map((operation) => `${operation.operationId}: ${operation.blockedReason ?? 'no cases'}`);
      findings.push(finding('COVERAGE_GAP', `Operation coverage ${(coverage * 100).toFixed(1)}% is below the required ${(config.quality.minimumOperationCoverage * 100).toFixed(1)}%.`, missing));
    }
    const expectedTests = plan.cases.length + plan.workflows.length;
    const semanticScenarios = scenarioLedger(plan.discovery, plan).filter(item => (item.origin === 'llm' || item.origin === 'requirement')
      && item.confidence >= config.discovery.minimumConfidence && item.disposition !== 'rejected');
    const unimplemented = semanticScenarios.filter(item => item.tests.length === 0);
    const scenarioCoverage = semanticScenarios.length ? 1 - unimplemented.length / semanticScenarios.length : 1;
    if (scenarioCoverage < (config.quality.minimumScenarioCoverage ?? (config.agents.provider !== 'deterministic' ? 1 : 0))) {
      findings.push(finding('SCENARIO_COVERAGE_GAP', 'Confident AI-discovered scenarios remain unimplemented. Passing existing tests is insufficient.',
        unimplemented.map(item => `${item.candidateId}: ${item.title}: ${item.reason}`)));
    }
    if (execution.tests === 0) findings.push(finding('ZERO_TESTS_EXECUTED', 'A zero-test run can never pass.', [execution.reportPath]));
    if (execution.tests !== expectedTests) findings.push(finding('EXECUTION_PLAN_MISMATCH', `Executed ${execution.tests} tests but the signed plan contains ${expectedTests}.`, [manifest.planHash]));
    if (execution.skipped > 0) findings.push(finding('SKIPPED_TESTS', `${execution.skipped} generated tests were skipped.`, [execution.reportPath]));
    if (execution.status === 'infrastructure-failed') findings.push(finding('TARGET_UNREACHABLE', 'The target environment was unreachable; assertions must not be changed.', [execution.stderrPath, execution.stdoutPath]));
    else if (execution.status === 'framework-failed') findings.push(finding('FRAMEWORK_FAILURE', 'The Playwright suite did not execute successfully.', [execution.stderrPath, execution.stdoutPath], 'regenerate-artifacts'));
    else if (execution.status === 'test-failed' || execution.failed > 0) findings.push(finding('CONTRACT_ASSERTION_FAILED', `${execution.failed} tests failed against the immutable contract.`, [execution.reportPath, ...execution.failureFingerprints], 'regenerate-artifacts'));

    const generatedSource = await readFile(path.join(config.generatedDir, 'api.generated.spec.mjs'), 'utf8');
    if (/\btest\.(?:skip|only|fixme)\s*\(/.test(generatedSource)) {
      findings.push(finding('FORBIDDEN_TEST_CONTROL', 'Generated tests contain skip, only, or fixme controls.', ['api.generated.spec.mjs'], 'regenerate-artifacts'));
    }
    if (plan.cases.some((testCase) => !contract.operations.some(o => o.sourcePointer === testCase.sourcePointer))) {
      findings.push(finding('TRACEABILITY_INVALID', 'At least one case lacks an OpenAPI source pointer.', ['plan.generated.json'], 'regenerate-artifacts'));
    }
    const invalidOracle = [...plan.cases, ...plan.workflows.flatMap((workflow) => [...workflow.steps, ...(workflow.cleanupSteps ?? [])])].filter((testCase) =>
      testCase.oracleProvenance.length === 0
      || testCase.oracleProvenance.some((oracle) => oracle.specHash !== contract.specHash || !validOraclePointer(contract, oracle.authority, oracle.sourcePointer)),
    );
    if (invalidOracle.length) {
      findings.push(finding('ORACLE_PROVENANCE_INVALID', 'Every executable assertion must cite the active OpenAPI contract.', invalidOracle.map((item) => item.id), 'regenerate-artifacts'));
    }
    const undeclaredExpectations = [...plan.cases, ...plan.workflows.flatMap((workflow) => [...workflow.steps, ...(workflow.cleanupSteps ?? [])])].filter((testCase) => {
      const operation = contract.operations.find((item) => item.operationId === testCase.operationId);
      return !operation || testCase.expected.statuses.some((status) => !operation.responses.some((response) => response.status === status));
    });
    if (undeclaredExpectations.length) {
      findings.push(finding('ORACLE_EXPECTATION_UNDECLARED', 'At least one executable expected status is absent from its OpenAPI operation.', undeclaredExpectations.map((item) => item.id), 'regenerate-artifacts'));
    }
    if (plan.discovery) {
      const { discoveryHash: _signedDiscoveryHash, ...unsignedDiscovery } = plan.discovery;
      const recomputedDiscoveryHash = sha256(stableStringify(unsignedDiscovery));
      if (recomputedDiscoveryHash !== plan.discovery.discoveryHash) {
        findings.push(finding('DISCOVERY_REPORT_INTEGRITY_FAILED', 'Discovery content does not match its signed hash.', [plan.discovery.discoveryHash, recomputedDiscoveryHash], 'regenerate-artifacts'));
      }
      if (manifest.discoveryHash !== plan.discovery.discoveryHash) {
        findings.push(finding('DISCOVERY_HASH_MISMATCH', 'The manifest does not sign the active discovery report.', [String(manifest.discoveryHash), plan.discovery.discoveryHash], 'regenerate-artifacts'));
      }
      const sourceLineCounts = new Map<string, number>();
      for (const source of plan.discovery.sources) {
        try {
          const sourcePath = ensureWithin(config.projectRoot, path.resolve(config.projectRoot, source.sourcePath));
          const contents = await readFile(sourcePath);
          const actual = sha256(contents);
          if (actual !== source.sourceHash) findings.push(finding('SOURCE_CHANGED', `Discovery source changed after planning: ${source.sourcePath}`, [source.sourceHash, actual]));
          sourceLineCounts.set(source.id, contents.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).length);
        } catch {
          findings.push(finding('SOURCE_MISSING', `Discovery source is unavailable after planning: ${source.sourcePath}`, [source.sourceHash]));
        }
      }
      const snapshots = new Map(plan.discovery.sources.map((source) => [source.id, source]));
      const executableCandidateIds = new Set([...plan.cases, ...plan.workflows.flatMap((workflow) => [...workflow.steps, ...(workflow.cleanupSteps ?? [])])].flatMap((testCase) => testCase.discovery?.candidateIds ?? []));
      for (const candidate of plan.discovery.candidates) {
        if ((candidate.disposition === 'generate' || candidate.disposition === 'merge') && candidate.evidence.length === 0 && !(candidate.origin === 'llm' && candidate.contractPointers.length > 0)) {
          findings.push(finding('DISCOVERY_CITATION_MISSING', `Executable discovery candidate ${candidate.id} lacks evidence.`, [candidate.id], 'regenerate-artifacts'));
        }
        if ((candidate.disposition === 'generate' || candidate.disposition === 'merge') && !candidate.operationId) {
          findings.push(finding('DISCOVERY_OPERATION_UNMATCHED', `Executable discovery candidate ${candidate.id} lacks an exact operation mapping.`, [candidate.id], 'regenerate-artifacts'));
        }
        if ((candidate.disposition === 'generate' || candidate.disposition === 'merge') && !executableCandidateIds.has(candidate.id)) {
          findings.push(finding('DISCOVERY_PLAN_GAP', `Accepted discovery candidate ${candidate.id} is absent from the executable plan.`, [candidate.id], 'regenerate-artifacts'));
        }
        for (const evidence of candidate.evidence) {
          const source = snapshots.get(evidence.sourceId);
          const lines = sourceLineCounts.get(evidence.sourceId) ?? 0;
          if (!source || source.sourcePath !== evidence.sourcePath || source.sourceHash !== evidence.sourceHash
            || evidence.lineStart < 1 || evidence.lineEnd < evidence.lineStart || evidence.lineEnd > lines) {
            findings.push(finding('INVALID_SOURCE_CITATION', `Discovery citation for ${candidate.id} cannot be verified.`, [evidence.sourceId, evidence.sourcePath, `${evidence.lineStart}-${evidence.lineEnd}`], 'regenerate-artifacts'));
          }
        }
      }
      const leaked = stableStringify(plan.discovery).match(/Bearer\s+(?!\[REDACTED_TOKEN\])[A-Za-z0-9._~+\/-]{8,}|(?:api[_-]?key|password|client[_-]?secret)\s*[:=]\s*(?!\[REDACTED\])\S+/i);
      if (leaked) findings.push(finding('DISCOVERY_SECRET_LEAK', 'A discovery artifact appears to contain an unredacted credential.', [leaked[0]]));
    }

    const deterministicScore = Math.round(
      (execution.status === 'passed' && execution.failed === 0 ? 40 : 0)
      + coverage * 25
      + (execution.tests === expectedTests && execution.tests > 0 && execution.skipped === 0 ? 15 : 0)
      + (integrity.valid && manifest.specHash === contract.specHash ? 10 : 0)
      + (!findings.some((item) => ['FORBIDDEN_TEST_CONTROL', 'TRACEABILITY_INVALID', 'ORACLE_PROVENANCE_INVALID', 'ORACLE_EXPECTATION_UNDECLARED', 'DISCOVERY_HASH_MISMATCH', 'DISCOVERY_SECRET_LEAK', 'INVALID_SOURCE_CITATION'].includes(item.code)) ? 10 : 0),
    );
    const criticInput = {
      immutableTarget: {
        specHash: contract.specHash,
        operations: contract.operations.map((operation) => ({ operationId: operation.operationId, sourcePointer: operation.sourcePointer, statuses: operation.responses.map((response) => response.status) })),
        hardGates: ['all tests execute', 'no skips', 'complete traceability', 'artifact integrity', 'contract-derived assertions', 'no forbidden healing'],
      },
      configuredPolicy: {
        minimumScore: config.quality.minimumScore,
        minimumOperationCoverage: config.quality.minimumOperationCoverage,
        scenarioCoverage,
        aiBlockingRule: 'A model finding is blocking only when it reuses an exact code from deterministicFindings. New model concerns are advisory warnings.',
      },
      anonymousCandidate: {
        manifest,
        coverage,
        execution,
        plan: { ...plan, discovery: undefined },
        deterministicFindings: findings.map(({ code, severity, message }) => ({ code, severity, message })),
        verifiedFacts: {
          artifactIntegrity: integrity.valid,
          specHashAligned: manifest.specHash === contract.specHash && plan.specHash === contract.specHash,
          executionMatchesPlan: execution.tests === expectedTests,
          oracleProvenanceChecked: !findings.some((item) => ['TRACEABILITY_INVALID', 'ORACLE_PROVENANCE_INVALID', 'ORACLE_EXPECTATION_UNDECLARED'].includes(item.code)),
        },
      },
    };
    const invocation = await this.provider.invoke(
      'critic',
      config.agents.criticModel,
      loadPrompt('critic'),
      criticInput,
    );
    const deterministicBlockingCodes = new Set(findings.filter((item) => item.severity === 'blocking').map((item) => item.code));
    findings.push(...parseAgentFindings(invocation.output, deterministicBlockingCodes));
    const hardFailures = findings.filter((item) => item.severity === 'blocking').map((item) => item.code);
    const score = Math.max(0, deterministicScore - findings.filter((item) => item.code.startsWith('AI_') && item.severity === 'blocking').length * 10);
    const infrastructureBlocked = hardFailures.includes('TARGET_UNREACHABLE');
    const pass = hardFailures.length === 0 && score >= config.quality.minimumScore;
    return {
      decision: pass ? 'pass' : infrastructureBlocked ? 'block' : 'fix',
      score,
      hardFailures,
      findings,
      criticId: invocation.agentId,
      evidenceHash: sha256(stableStringify(criticInput)),
      invocation,
    };
  }
}
