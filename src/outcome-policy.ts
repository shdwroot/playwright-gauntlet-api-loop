import type {DiscoveryCandidate, NormalizedOperation, ResponseAssertion, TestCasePlan} from './types.js';
import {explicitStatuses} from './requirement-oracles.js';

// These policies come from the recorded source/scenario, never from the status
// the API happened to return. Unclear prose cannot authorize a wider oracle.
export function outcomeStatuses(candidate: DiscoveryCandidate, operation: NormalizedOperation): number[] | undefined {
  if (candidate.operationId !== operation.operationId && !candidate.operationIds?.includes(operation.operationId)) return undefined;
  const text = (candidate.scenario as {expectedBehavior?:unknown} | undefined)?.expectedBehavior;
  if (typeof text !== 'string' || !/\bor\b/i.test(text) || /\b(?:not|never|neither)\b[^.]{0,100}(?:\beither\b|\b4xx\b|\breturns?\b)/i.test(text)) return undefined;
  const rejectOrIgnore = /\b4xx\b[^.]{0,100}\bor\s+ignor(?:e|es|ed)\b/i.test(text);
  const rejectOrValid = /\beither\s+reject\b[^.]{0,500}\bor\s+return\b[^.]{0,200}(?:schema.valid|conforms? to (?:its |the )?declared)/i.test(text);
  const literalAlternatives = /\b(?:returns?|receives?|responds? with)\s+[1-5]\d{2}(?:\s+or\s+[1-5]\d{2})+/i.exec(text);
  const explicit = literalAlternatives ? explicitStatuses(literalAlternatives[0]) : [];
  const statuses = operation.responses.filter(r => rejectOrIgnore || rejectOrValid
    ? r.status >= 200 && r.status < 300 || r.status >= 400 && r.status < 500
    : explicit.includes(r.status)).map(r=>r.status);
  return statuses.length > 1 ? [...new Set(statuses)].sort((a,b)=>a-b) : undefined;
}

export function applyOutcomePolicy(test: TestCasePlan, candidate: DiscoveryCandidate, operation: NormalizedOperation): void {
  const statuses = outcomeStatuses(candidate,operation);
  if (!statuses || test.expected.statuses.some(s=>!statuses.includes(s))) throw new Error('AGENT_OUTCOME_POLICY_DENIED: recorded source must explicitly permit the alternative outcomes for this operation');
  test.expected = {statuses,variants:statuses.map(status=>{
    const response=operation.responses.find(r=>r.status===status)!;
    return {status,...(response.schema?{schema:response.schema}:{}),...(response.contentType?{contentType:response.contentType}:{})};
  })};
  for (const response of operation.responses.filter(r=>statuses.includes(r.status))) {
    if (!test.oracleProvenance.some(p=>p.sourcePointer === response.sourcePointer)) test.oracleProvenance.push({authority:response.authority ?? 'openapi',specHash:test.oracleProvenance[0]!.specHash,sourcePointer:response.sourcePointer});
  }
  for (const assertion of test.assertions ?? []) {
    // A field cited from the 200 response is asserted when the 200 branch is
    // taken. Fixture invariants remain unconditional across every outcome.
    if (assertion.target === 'fixture' || assertion.target === 'parallel') continue;
    const match=/\/responses\/([1-5]\d{2})(?:\/|$)/.exec(assertion.sourcePointer);
    if (match) {
      const status=Number(match[1]);
      if (!statuses.includes(status)) throw new Error('AGENT_OUTCOME_ASSERTION_DENIED: cited response is not an allowed outcome');
      assertion.whenStatuses=[status];
    }
  }
}

export function assertionRunsFor(assertion: ResponseAssertion, status: number): boolean {
  return !assertion.whenStatuses || assertion.whenStatuses.includes(status);
}
