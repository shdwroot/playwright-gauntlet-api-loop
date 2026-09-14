// Structured model outputs keep formatting mistakes out of the orchestration loop.
// Arbitrary request bodies/maps travel as JSON strings, then are decoded and
// validated by the same executable-plan validator used for injected test providers.
const text = { type: 'string' };
const integer = { type: 'integer' };
const array = (items: unknown) => ({ type: 'array', items });
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const assertion = object({ path: text, operator: { type: 'string', enum: ['equals', 'not-equals', 'length-equals', 'contains', 'gte', 'lte'] }, valueJson: text, sourcePointer: text });
const testCase = object({ id: text, title: text, operationId: text, status: integer, rationale: text, requestJson: text, captureJson: text, assertions: array(assertion), discoveryIds: array(text) });
const plan = object({
  cases: array(testCase), workflows: array(object({ id: text, title: text, steps: array(testCase), cleanupSteps: array(testCase) })),
  repairs: array(object({ caseId: text, rationale: text, requestJson: text, setupSteps: array(testCase) })),
  assertionAdditions: array(object({ caseId: text, assertions: array(assertion) })),
  coverageLinks: array(object({ caseId: text, discoveryIds: array(text), rationale: text })),
  riskNotes: array(object({ operationId: text, note: text })),
});

export const TRANSPORT_INSTRUCTIONS = `Your response must match the supplied JSON schema. requestJson is a JSON-encoded request object; captureJson is a JSON-encoded capture map (use "{}" when unused); valueJson is a JSON-encoded assertion value (for example "0", "\\\"user\\\"", or "\\\"\\\${createdId}\\\""); scenarioJson is a JSON-encoded scenario object. The adapter decodes these fields to request/capture/value/scenario before validation. Always provide all arrays, using [] when empty. Use an empty operationId in a risk note or discovery finding that has no declared operation. Do not add unsupported fields.`;

export function agentOutputSchema(role: string, input?: unknown): unknown {
  if (role === 'verifier') {
    const state = input as { proofCatalog?: Record<string, Array<{ testId: string; assertionPointers: string[] }>>; obligations?: Array<{ id: string }>; plan?: { cases: Array<{ id: string }>; workflows: Array<{ id: string }> } } | undefined;
    const assessment = (id: string) => {
      const proofs = state?.proofCatalog?.[id] ?? [];
      const variants = proofs.map(proof => object({ testId: { type: 'string', enum: [proof.testId] }, assertionPointers: { ...array({ type: 'string', enum: proof.assertionPointers }), minItems: 1 } }));
      return object({ verdict: { type: 'string', enum: proofs.length ? ['verified', 'gap', 'blocked'] : ['gap', 'blocked'] }, reason: text,
        proofs: variants.length ? array({ anyOf: variants }) : { ...array(object({ testId: text, assertionPointers: array(text) })), maxItems: 0 } });
    };
    const isolation = object({ verdict: { type: 'string', enum: ['isolated', 'risk'] }, reason: text });
    return object({ reconciliations: array(object({ obligationId: text, replacementIds: array(text), reason: text })),
      assessments: object(Object.fromEntries((state?.obligations ?? []).map(o => [o.id, assessment(o.id)]))),
      isolation: object(Object.fromEntries([...(state?.plan?.cases ?? []), ...(state?.plan?.workflows ?? [])].map(u => [u.id, isolation]))) });
  }
  if (role === 'builder') return plan;
  if (role === 'healer') return object({ classification: { type: 'string', enum: ['test-implementation', 'product-defect', 'infrastructure', 'contract-gap'] }, hypothesis: text, changes: plan });
  if (role === 'lead') return object({ action: { type: 'string', enum: ['build', 'execute', 'heal', 'accept', 'block'] }, reason: text });
  if (role === 'critic') return object({ decision: { type: 'string', enum: ['pass', 'fix', 'block'] }, findings: array(object({ code: text, severity: { type: 'string', enum: ['blocking', 'warning', 'info'] }, message: text, evidence: array(text) })) });
  return object({ scenarios: array(object({ title: text, rationale: text, operationId: text, confidence: { type: 'number' }, scenarioJson: text,
    citations: array(object({ sourceIndex: integer, lineStart: integer, lineEnd: integer })) })) });
}

export function decodeAgentOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeAgentOutput);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  const fields: Record<string, string> = { requestJson: 'request', captureJson: 'capture', valueJson: 'value', scenarioJson: 'scenario' };
  for (const [key, nested] of Object.entries(value)) {
    if ((key === 'assessments' || key === 'isolation') && nested && typeof nested === 'object' && !Array.isArray(nested)) {
      result[key] = Object.entries(nested).map(([id, assessment]) => ({ ...(decodeAgentOutput(assessment) as Record<string, unknown>), [key === 'assessments' ? 'obligationId' : 'unitId']: id }));
    } else if (fields[key]) {
      if (typeof nested !== 'string') throw new Error(`AGENT_OUTPUT_INVALID: ${key} must encode JSON`);
      try { result[fields[key]!] = JSON.parse(nested); }
      catch { throw new Error(`AGENT_OUTPUT_INVALID: ${key} contains invalid JSON`); }
    } else result[key] = decodeAgentOutput(nested);
  }
  return result;
}
