// Structured model outputs keep formatting mistakes out of the orchestration loop.
// Arbitrary request bodies travel as JSON strings; request maps use typed entries, then are decoded and
// validated by the same executable-plan validator used for injected test providers.
const text = { type: 'string' };
const integer = { type: 'integer' };
const array = (items: unknown) => ({ type: 'array', items });
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const scalar = {anyOf:['string','number','boolean','null'].map(type=>({type}))};
const nullable = (schema: unknown) => ({anyOf:[schema,{type:'null'}]});
const requestEnvelope = object({pathParams:nullable(array(object({name:text,value:scalar}))),query:nullable(array(object({name:text,value:scalar}))),
  headers:nullable(array(object({name:text,value:text}))),bodyJson:nullable(text),rawBody:nullable(text),useAuth:nullable({type:'boolean'})});
const assertion = object({ path: text, target: {type:'string',enum:['body','headers','fixture','parallel']}, operator: { type: 'string', enum: ['equals', 'json-equals', 'not-equals', 'length-equals', 'length-lte', 'length-gte', 'contains', 'gte', 'lte', 'exists', 'not-exists'] }, value: {anyOf:[...scalar.anyOf,array(scalar)]}, sourcePointer: text });
const testCase = object({ id: text, title: text, operationId: text, status: integer, alternativeStatuses:array(integer), parallelGroup:text, outcomePolicyId:text, rationale: text, request:requestEnvelope, captureBindings: array(object({ name: text, path: text })), assertions: array(assertion), discoveryIds: array(text) });
const plan = object({
  cases: array(testCase), workflows: array(object({ id: text, title: text, steps: array(testCase), cleanupSteps: array(testCase) })),
  repairs: array(object({ caseId: text, rationale: text, request:requestEnvelope, setupSteps: array(testCase) })),
  assertionAdditions: array(object({ caseId: text, assertions: array(assertion) })),
  assertionRepairs: array(object({caseId:text,assertionIndex:integer,operator:{type:'string',enum:['length-lte','length-gte']},rationale:text})),
  outcomeRepairs:array(object({caseId:text,candidateId:text,rationale:text})),
  coverageLinks: array(object({ caseId: text, discoveryIds: array(text), rationale: text })),
  riskNotes: array(object({ operationId: text, note: text })),
});

export const TRANSPORT_INSTRUCTIONS = `Your response must match the supplied JSON schema. request is a typed envelope. pathParams/query/headers are arrays of {name,value}; null preserves or omits that map, [] explicitly clears it. bodyJson is the JSON-encoded API payload (for example the username/password object), or null when omitted. rawBody and useAuth use null when omitted. Never place payload fields directly in request. Do not set bodyJson and rawBody together. Legacy requestJson decoding remains available for saved proposals; captureBindings is an array of {name,path} entries (use [] when unused), converted to the capture map. Assertion value is native JSON: use a number, boolean, null, string, or array of scalars directly; symbolic captured values use a string such as "\${createdId}". For exact object or nested-array comparisons, choose operator json-equals and provide the JSON-encoded object or array in value; the compiler parses and checks it. Do not use ordinary equals with a serialized object string. scenarioJson is a JSON-encoded scenario object. The adapter decodes transport fields before validation. Always provide proposal collection arrays, using [] when empty; request-map null preserves existing values. Use an empty operationId in a risk note or discovery finding that has no declared operation. Do not add unsupported fields.`;

export function agentOutputSchema(role: string, input?: unknown): unknown {
  if (role === 'developer') return object({ hypothesis: text, edits: array(object({ path: text, oldText: text, newText: text, occurrence:{type:'integer',minimum:0} })) });
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
  if (role === 'builder' || role === 'healer') {
    const state = input as { minimumDiscoveryConfidence?: number; fixtures?:unknown; discovery?: { candidates?: Array<{id:string;confidence:number;disposition:string;operationId?:string}> };
      plan?: {discovery?: {candidates?: Array<{id:string;confidence:number;disposition:string;operationId?:string}>}};
      contract?: {operations?: Array<{sourcePointer:string;responses?:Array<{sourcePointer?:string}>}>;document?:Record<string,unknown>} } | undefined;
    const candidates = state?.discovery?.candidates ?? state?.plan?.discovery?.candidates;
    const ids = candidates?.filter(c => Boolean(c.operationId) && c.confidence >= (state?.minimumDiscoveryConfidence ?? 0) && c.disposition !== 'reject').map(c => c.id);
    const pointers = [...new Set(state?.contract?.operations?.flatMap(o => [o.sourcePointer,...(o.responses ?? []).flatMap(r => r.sourcePointer ? [r.sourcePointer] : [])]) ?? [])];
    const document = state?.contract?.document;
    const extension = document?.['x-gauntlet-requirement-oracles'];
    if (extension && typeof extension === 'object') pointers.push(...Object.keys(extension).map(key => `/x-gauntlet-requirement-oracles/${key}`));
    // Bound model choices to existing citations and eligible discovery IDs.
    // The executable compiler still checks operation scope and provenance.
    const bounded = structuredClone(plan) as any;
    const sequential = (node: any) => {
      node.properties.parallelGroup = {type:'string',enum:['']};
      node.properties.alternativeStatuses = {...array(integer),maxItems:0};
    };
    sequential(bounded.properties.cases.items);
    sequential(bounded.properties.workflows.items.properties.cleanupSteps.items);
    sequential(bounded.properties.repairs.items.properties.setupSteps.items);
    bounded.properties.workflows.items.properties.steps.minItems = 1;
    const visit = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (node.properties?.discoveryIds && ids) node.properties.discoveryIds = ids.length ? array({type:'string',enum:ids}) : {...array(text),maxItems:0};
      if (node.properties?.target) node.properties.target = {type:'string',enum:state?.fixtures ? ['body','headers','fixture','parallel'] : ['body','headers','parallel']};
      if (node.properties?.sourcePointer && pointers.length) node.properties.sourcePointer = {type:'string',enum:[...new Set(pointers)]};
      for (const value of Object.values(node)) visit(value);
    };
    visit(bounded);
    return role === 'builder' ? bounded : object({classification:{type:'string',enum:['test-implementation','product-defect','infrastructure','contract-gap']},hypothesis:text,changes:bounded});
  }
  if (role === 'lead') return object({ action: { type: 'string', enum: (input as {allowedActions?:string[]} | undefined)?.allowedActions ?? ['build', 'execute', 'heal', 'accept', 'block'] }, reason: text });
  if (role === 'critic') return object({ decision: { type: 'string', enum: ['pass', 'fix', 'block'] }, findings: array(object({ code: text, severity: { type: 'string', enum: ['blocking', 'warning', 'info'] }, message: text, evidence: array(text) })) });
  const documents = (input as { documents?: Array<{ sourceIndex: number; lines: Array<{ number: number }> }> } | undefined)?.documents ?? [];
  const citations = documents.filter(d => d.lines.length).map(d => {
    const line = { type: 'integer', minimum: 1, maximum: Math.max(...d.lines.map(l => l.number)) };
    return object({ sourceIndex: { type: 'integer', enum: [d.sourceIndex] }, lineStart: line, lineEnd: line });
  });
  return object({ scenarios: array(object({ title: text, rationale: text, operationId: text, confidence: { type: 'number' }, scenarioJson: text,
    citations: citations.length ? array({ anyOf: citations }) : { ...array(object({ sourceIndex: integer, lineStart: integer, lineEnd: integer })), maxItems: 0 } })) });
}

export function decodeAgentOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeAgentOutput);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  const fields: Record<string, string> = { requestJson: 'request', captureJson: 'capture', valueJson: 'value', scenarioJson: 'scenario' };
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'request' && nested && typeof nested === 'object' && Object.hasOwn(nested,'bodyJson')) {
      const envelope = nested as Record<string,unknown>;
      if (Object.keys(envelope).some(key=>!['pathParams','query','headers','bodyJson','rawBody','useAuth'].includes(key))) throw new Error('AGENT_OUTPUT_INVALID: unsupported request envelope fields');
      const request: Record<string,unknown> = {};
      for (const field of ['pathParams','query','headers']) {
        const entries = envelope[field];
        if (entries === null || entries === undefined) continue;
        if (!Array.isArray(entries) || entries.some(e=>!e || typeof e.name !== 'string') || new Set(entries.map(e=>e.name)).size !== entries.length) throw new Error('AGENT_OUTPUT_INVALID: request map entries');
        request[field] = Object.fromEntries(entries.map(e=>[e.name,e.value]));
      }
      if (envelope.bodyJson !== null) {
        if (typeof envelope.bodyJson !== 'string') throw new Error('AGENT_OUTPUT_INVALID: bodyJson must encode JSON');
        try {request.body=JSON.parse(envelope.bodyJson);} catch {throw new Error('AGENT_OUTPUT_INVALID: bodyJson contains invalid JSON');}
      }
      if (envelope.rawBody !== null && envelope.rawBody !== undefined) request.rawBody=envelope.rawBody;
      if (envelope.useAuth !== null && envelope.useAuth !== undefined) request.useAuth=envelope.useAuth;
      result.request=request;
    } else if (key === 'captureBindings') {
      if (!Array.isArray(nested) || nested.some(v => !v || typeof v.name !== 'string' || typeof v.path !== 'string') || new Set(nested.map(v => v.name)).size !== nested.length) throw new Error('AGENT_OUTPUT_INVALID: capture bindings');
      result.capture = Object.fromEntries(nested.map(v => [v.name, v.path]));
    } else if ((key === 'assessments' || key === 'isolation') && nested && typeof nested === 'object' && !Array.isArray(nested)) {
      result[key] = Object.entries(nested).map(([id, assessment]) => ({ ...(decodeAgentOutput(assessment) as Record<string, unknown>), [key === 'assessments' ? 'obligationId' : 'unitId']: id }));
    } else if (fields[key]) {
      if (typeof nested !== 'string') throw new Error(`AGENT_OUTPUT_INVALID: ${key} must encode JSON`);
      try { result[fields[key]!] = JSON.parse(nested); }
      catch { throw new Error(`AGENT_OUTPUT_INVALID: ${key} contains invalid JSON`); }
    } else result[key] = decodeAgentOutput(nested);
  }
  return result;
}
