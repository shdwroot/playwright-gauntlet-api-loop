import type { GauntletConfig, NormalizedContract, ResponseAssertion, TestCasePlan, TestPlan, WorkflowPlan } from './types.js';
import { allowed, makeCase } from './planner.js';
import { sha256, stableStringify } from './utils.js';

export const PLAN_PROTOCOL = `Return JSON with cases (new standalone tests), workflows (new ordered tests), repairs (request changes to an existing generated caseId), coverageLinks, and riskNotes.
A case is {id,title,operationId,status,rationale,request:{pathParams?,query?,headers?,body?,rawBody?,useAuth?},discoveryIds?:string[],assertions?:[{path:"$.bodyField",operator:"equals|not-equals|length-equals|contains|gte|lte",value:any,sourcePointer:"operation, nested contract pointer or referenced component pointer"}]}.
A workflow is {id,title,steps:[case with optional capture:{variable:"$.responseField"}],cleanupSteps:[case]}. cleanupSteps execute in finally even after a failed assertion; put resource deletion there. Use capture:{wholeBody:"$"} to capture an entire response for comparison on a subsequent step.
assertionAdditions is [{caseId,assertions:[assertion]}] and appends assertions to existing tests without removing or weakening any.
All tests may use the built-in \${runId}. Workflow request values may additionally use \${variable} from earlier captures or \${runId}. Each step must have an explicit id, unique within its workflow; standalone and workflow IDs must be unique. Captures are scoped to a workflow. Example: a create step with capture:{createdUserId:"$.id"}, then a read step with request:{pathParams:{id:"\${createdUserId}"}}. Capture keys are the variable names; step IDs do not automatically create variables. Use a DIFFERENT capture name for each created record. The read step status and operationId still must be specified.
A repair is {caseId,request:{...},rationale,setupSteps?:[case with optional capture]}. setupSteps inserts validated preparation steps immediately before the existing case; a standalone case is moved intact into a setup workflow. Use this to establish fixture state without changing assertions. For example, put resetFixture with its required guard header before a list test that intentionally expects the single initial record. The original case and all its assertions still execute. You may repair request data in baseline and agent-authored generated cases, while preserving their test intent and all existing response assertions. No code, shell commands, URLs, deletions, assertion changes, or config changes.
Use only declared operationId/status pairs. The executor supplies response schemas from the contract. Add concrete response assertions to test scenario-specific behavior, citing its operation or nested contract pointer. Assertions are immutable during healing. In workflows their values may reference earlier captures. Do not claim that an inferred business expectation is explicitly documented; describe inference in rationale.
Request maps REPLACE that map, body REPLACES the body; omitted fields preserve existing values. Supply synthetic values.
Preserve baseline coverage. Do not reinterpret a failed scenario or change its intended outcome to make it pass.
Keep scenarios requiring unavailable business-rule oracles as riskNotes. Create workflows for setup, captures, checks, cleanup.
coverageLinks is [{caseId,discoveryIds:[candidateId],rationale}]. caseId can identify a case or an entire workflow; generated IDs have an agent- prefix, and IDs declared in this proposal may also be used without that prefix. Use it when an EXISTING case or workflow already implements a discovered scenario; explain how its actual requests/assertions establish that scenario. Do not duplicate existing tests just to attach discovery IDs, and never link a scenario the existing test does not verify. Links are operation-checked and require a fresh execution/critique; they do not themselves prove semantic completeness.
Only attach discoveryIds whose confidence meets minimumDiscoveryConfidence. Lower-confidence proposals remain report-only; do not guess an eligibility threshold.
Use unique emails/data and workflow runId to avoid collisions. No raw credentials: useAuth=true loads configured environment credentials. To test a missing credential useAuth=false with no credential header. To test an invalid credential useAuth=false, expected 401/403, and a credential header with a dummy value; the runtime replaces it with a synthetic invalid credential.`;

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`AGENT_OUTPUT_INVALID: ${label} must be an object`);
  return value as Record<string, unknown>;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new Error(`AGENT_OUTPUT_INVALID: ${label} must be a bounded nonempty string`);
  return value;
}
function keys(value: Record<string, unknown>, supported: string[], label: string): void {
  const unsupported = Object.keys(value).filter((key) => !supported.includes(key));
  if (unsupported.length) throw new Error(`AGENT_OUTPUT_INVALID: unsupported ${label} fields: ${unsupported.join(', ')}`);
}
function list(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`AGENT_OUTPUT_INVALID: ${label} must be an array`);
  return value;
}

export function applyRequest(testCase: TestCasePlan, value: unknown, config: GauntletConfig, repair = false): void {
  const request = record(value, 'request');
  keys(request, ['pathParams', 'query', 'headers', 'body', 'rawBody', 'useAuth'], 'request');
  if (stableStringify(request).length > 65_536) throw new Error('AGENT_REQUEST_LIMIT');
  for (const field of ['pathParams', 'query', 'headers'] as const) {
    if (request[field] === undefined) continue;
    const map = { ...record(request[field], field) };
    if (field === 'headers') {
      for (const [key, value] of Object.entries(map)) {
        if (typeof value !== 'string' || /[\r\n]/.test(value) || /[\r\n]/.test(key) || /^(host|proxy-authorization|content-length|transfer-encoding)$/i.test(key)) throw new Error(`AGENT_HEADER_DENIED: ${key}`);
        const credentialHeader = /^(authorization|cookie)$/i.test(key) || Object.keys(config.headersFromEnv).some((header) => header.toLowerCase() === key.toLowerCase());
        if (credentialHeader) {
          if (request.useAuth !== false || !testCase.expected.statuses.every((status) => status === 401 || status === 403)) throw new Error(`AGENT_HEADER_DENIED: credential header ${key}; use useAuth=true for valid environment credentials, or useAuth=false with expected 401/403 for a synthetic invalid-credential test`);
          map[key] = key.toLowerCase() === 'authorization' ? 'Bearer gauntlet-invalid-credential' : 'gauntlet-invalid-credential';
        }
      }
      testCase.headers = map as Record<string, string>;
    } else {
      if (Object.values(map).some((value) => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) throw new Error(`AGENT_OUTPUT_INVALID: ${field} values must be scalar`);
      testCase[field] = map;
    }
  }
  if ('body' in request && 'rawBody' in request) throw new Error('AGENT_OUTPUT_INVALID: choose body or rawBody');
  if ('body' in request) { testCase.body = request.body; delete testCase.rawBody; }
  if ('rawBody' in request) {
    if (typeof request.rawBody !== 'string') throw new Error('AGENT_OUTPUT_INVALID: rawBody must be a string');
    testCase.rawBody = request.rawBody; delete testCase.body;
  }
  if ('useAuth' in request) {
    if (typeof request.useAuth !== 'boolean') throw new Error('AGENT_OUTPUT_INVALID: useAuth must be boolean');
    if (repair && request.useAuth !== testCase.useAuth) throw new Error('AGENT_REPAIR_ORACLE_CHANGE: authentication intent is fixed');
    testCase.useAuth = request.useAuth;
  }
  for (const match of testCase.path.matchAll(/\{([^}]+)\}/g)) {
    if (!(match[1]! in testCase.pathParams)) throw new Error(`AGENT_PATH_PARAMETER_MISSING: ${match[1]}`);
  }
}

function pointerValue(document: unknown, pointer: string, depth = 0): unknown {
  if (depth > 40) throw new Error('AGENT_ASSERTION_PROVENANCE_INVALID: reference cycle');
  let value = document;
  for (const part of pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (value && typeof value === 'object' && !Object.hasOwn(value, part)) {
      const reference = (value as Record<string, unknown>).$ref;
      if (typeof reference === 'string' && reference.startsWith('#/')) value = pointerValue(document, reference.slice(1), depth + 1);
    }
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) throw new Error(`AGENT_ASSERTION_PROVENANCE_INVALID: pointer does not exist: ${pointer}; use the operation sourcePointer or the actual referenced component pointer`);
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function assertionPointers(contract: NormalizedContract, operationPointer: string): string[] {
  const allowed = new Set([operationPointer]);
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const reference = (node as Record<string, unknown>).$ref;
    if (typeof reference === 'string' && reference.startsWith('#/') && !allowed.has(reference.slice(1))) {
      allowed.add(reference.slice(1)); visit(pointerValue(contract.document, reference.slice(1)));
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(pointerValue(contract.document, operationPointer));
  const pathPointer = operationPointer.slice(0, operationPointer.lastIndexOf('/'));
  const pathItem = pointerValue(contract.document, pathPointer) as Record<string, unknown>;
  if (pathItem.parameters) { allowed.add(`${pathPointer}/parameters`); visit(pathItem.parameters); }
  return [...allowed];
}

function compileCase(value: unknown, contract: NormalizedContract, config: GauntletConfig, plan: TestPlan, relatedOperations: unknown[] = []): TestCasePlan {
  const proposal = record(value, 'case');
  keys(proposal, ['id', 'title', 'operationId', 'status', 'rationale', 'request', 'capture', 'discoveryIds', 'assertions'], 'case');
  const id = string(proposal.id, 'id');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('AGENT_OUTPUT_INVALID: id must be 1-80 alphanumeric, underscore or hyphen characters');
  const operation = contract.operations.find((item) => item.operationId === proposal.operationId);
  if (!operation) throw new Error(`AGENT_OPERATION_UNKNOWN: ${proposal.operationId}`);
  if (allowed(operation, config)) throw new Error(`AGENT_OPERATION_DENIED: ${operation.operationId}`);
  if (typeof proposal.status !== 'number' || !operation.responses.some((response) => response.status === proposal.status)) throw new Error(`AGENT_ORACLE_UNDECLARED: ${operation.operationId}`);
  const testCase = makeCase(operation, contract.specHash, config.seed, 'discovered', [proposal.status], 'valid', string(proposal.rationale ?? proposal.title ?? `${operation.operationId}: ${id}`, 'rationale'), id);
  testCase.id = `agent-${id}`;
  testCase.title = string(proposal.title ?? `${operation.operationId}: ${id}`, 'title');
  testCase.authoredBy = 'agent';
  applyRequest(testCase, proposal.request, config);
  const assertions = list(proposal.assertions, 'assertions');
  if (assertions.length > 20) throw new Error('AGENT_ASSERTION_LIMIT');
  if (assertions.length) testCase.assertions = assertions.map((value) => {
    const assertion = { ...record(value, 'assertion') };
    keys(assertion, ['path', 'operator', 'value', 'sourcePointer'], 'assertion');
    if (typeof assertion.path === 'string') assertion.path = assertion.path.replace(/\[(\d+)\]/g, '.$1');
    if (typeof assertion.path !== 'string' || !/^\$(?:\.[a-zA-Z0-9_-]+)*$/.test(assertion.path)) throw new Error('AGENT_ASSERTION_PATH_INVALID');
    const operators = ['equals', 'not-equals', 'length-equals', 'contains', 'gte', 'lte'];
    if (!operators.includes(String(assertion.operator)) || !('value' in assertion)) throw new Error('AGENT_ASSERTION_INVALID');
    const pointer = string(assertion.sourcePointer, 'assertion sourcePointer').replace(/^#/, '');
    const context = [...new Set([operation, ...contract.operations.filter((item) => relatedOperations.includes(item.operationId))].flatMap((item) => assertionPointers(contract, item.sourcePointer)))];
    if (!context.some((base) => pointer === base || pointer.startsWith(`${base}/`))) throw new Error(`AGENT_ASSERTION_PROVENANCE_INVALID: ${testCase.id} cannot cite ${pointer}; cite ${operation.sourcePointer} or a component referenced by that operation`);
    pointerValue(contract.document, pointer);
    if (['length-equals', 'gte', 'lte'].includes(String(assertion.operator)) && typeof assertion.value !== 'number'
      && !(typeof assertion.value === 'string' && /^\$\{[^}]+\}$/.test(assertion.value))) throw new Error(`AGENT_ASSERTION_VALUE_INVALID: ${testCase.id} ${assertion.operator} requires a number or captured numeric value`);
    return { path: assertion.path, operator: assertion.operator as ResponseAssertion['operator'], value: assertion.value, sourcePointer: pointer };
  });
  const ids = list(proposal.discoveryIds, 'discoveryIds');
  if (ids.length) {
    const candidates = ids.map((id) => {
      const candidate = plan.discovery?.candidates.find((item) => item.id === id);
      if (!candidate || !candidate.operationId || (candidate.operationId !== operation.operationId && !(candidate.signal === 'semantic-scenario' && relatedOperations.includes(candidate.operationId))) || candidate.disposition === 'reject') throw new Error(`AGENT_DISCOVERY_REFERENCE_INVALID: ${id}`);
      if (candidate.confidence < config.discovery.minimumConfidence) throw new Error(`AGENT_DISCOVERY_CONFIDENCE: ${id} has confidence ${candidate.confidence}, below required ${config.discovery.minimumConfidence}; leave it report-only and do not attach its ID`);
      return candidate;
    });
    testCase.discovery = { signal: candidates[0]!.signal, candidateIds: candidates.map((item) => item.id), evidence: candidates.flatMap((item) => item.evidence) };
  }
  return testCase;
}

export function applyAgentPlan(base: TestPlan, output: unknown, contract: NormalizedContract, config: GauntletConfig, allowRepairs = false): TestPlan {
  const proposal = record(output, 'plan');
  keys(proposal, ['cases', 'workflows', 'repairs', 'coverageLinks', 'assertionAdditions', 'riskNotes'], 'plan');
  const plan = structuredClone(base);
  const all = () => [...plan.cases, ...plan.workflows.flatMap((workflow) => [...workflow.steps, ...(workflow.cleanupSteps ?? [])])];
  const usedIds = new Set([...all().map((item) => item.id), ...plan.workflows.map((item) => item.id)]);
  const reserve = (id: string): void => {
    if (usedIds.has(id)) throw new Error(`AGENT_DUPLICATE_ID: ${id}`);
    usedIds.add(id);
  };
  for (const value of list(proposal.cases, 'cases')) {
    const standalone = record(value, 'case');
    for (const match of JSON.stringify([standalone.request, standalone.assertions]).matchAll(/\$\{([^}]+)\}/g)) {
      if (match[1] !== 'runId') throw new Error(`AGENT_CAPTURE_UNBOUND: standalone tests support only runId, got ${match[1]}`);
    }
    const testCase = compileCase(value, contract, config, plan);
    reserve(testCase.id); plan.cases.push(testCase);
  }
  for (const value of list(proposal.workflows, 'workflows')) {
    const workflow = record(value, 'workflow');
    keys(workflow, ['id', 'title', 'steps', 'cleanupSteps'], 'workflow');
    const id = `agent-${string(workflow.id, 'workflow id')}`;
    reserve(id);
    const variables = new Set(['runId']);
    const compiled: WorkflowPlan = { id, title: string(workflow.title, 'workflow title'), steps: [] };
    const mainSteps = list(workflow.steps, 'steps');
    const rawSteps = [...mainSteps, ...list(workflow.cleanupSteps, 'cleanupSteps')];
    const relatedOperations = rawSteps.map((step) => record(step, 'step').operationId);
    for (const rawStep of rawSteps) {
      const step = record(rawStep, 'step');
      for (const match of JSON.stringify([step.request, step.assertions]).matchAll(/\$\{([^}]+)\}/g)) {
        if (!variables.has(match[1]!)) throw new Error(`AGENT_CAPTURE_UNBOUND: ${match[1]}`);
      }
      const testCase = compileCase(step, contract, config, plan, relatedOperations);
      testCase.id = `${id}-${testCase.id}`;
      reserve(testCase.id);
      const capture = record(step.capture ?? {}, 'capture');
      for (const [name, expression] of Object.entries(capture)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(name) || variables.has(name) || typeof expression !== 'string' || !/^\$(?:\.[a-zA-Z0-9_-]+)*$/.test(expression)) throw new Error('AGENT_CAPTURE_INVALID');
        variables.add(name);
      }
      const destination = mainSteps.includes(rawStep) ? compiled.steps : (compiled.cleanupSteps ??= []);
      destination.push({ ...testCase, capture: capture as Record<string, string> });
    }
    if (!compiled.steps.length) throw new Error('AGENT_WORKFLOW_EMPTY');
    plan.workflows.push(compiled);
  }
  const repaired = new Set<string>();
  for (const value of list(proposal.repairs, 'repairs')) {
    const repair = record(value, 'repair');
    keys(repair, ['caseId', 'request', 'rationale', 'setupSteps'], 'repair');
    const target = all().find((item) => item.id === repair.caseId);
    if (!allowRepairs || !target || repaired.has(target.id)) throw new Error(`AGENT_REPAIR_DENIED: ${repair.caseId}`);
    string(repair.rationale, 'repair rationale');
    const beforeRequest = stableStringify(target);
    applyRequest(target, repair.request, config, true);
    if (stableStringify(target) !== beforeRequest) target.authoredBy = 'agent';
    const setup = list(repair.setupSteps, 'setupSteps').map((value) => {
      const raw = record(value, 'setup step');
      const step = compileCase(raw, contract, config, plan);
      step.id = `setup-${target.id}-${step.id}`;
      reserve(step.id);
      return { ...step, capture: record(raw.capture ?? {}, 'capture') as Record<string, string> };
    });
    if (setup.length) {
      const workflow = plan.workflows.find((item) => [...item.steps, ...(item.cleanupSteps ?? [])].some((step) => step.id === target.id));
      if (workflow) {
        const sequence = workflow.steps.some(step => step.id === target.id) ? workflow.steps : workflow.cleanupSteps!;
        sequence.splice(sequence.findIndex((step) => step.id === target.id), 0, ...setup);
      }
      else {
        const id = `setup-${target.id}`;
        reserve(id);
        plan.cases = plan.cases.filter((item) => item.id !== target.id);
        plan.workflows.push({ id, title: target.title, steps: [...setup, { ...target, capture: {} }] });
      }
    }
    repaired.add(target.id);
  }
  for (const value of list(proposal.assertionAdditions, 'assertionAdditions')) {
    const addition = record(value, 'assertion addition');
    keys(addition, ['caseId', 'assertions'], 'assertion addition');
    const target = all().find(t => t.id === addition.caseId);
    if (!target) throw new Error('AGENT_ASSERTION_TARGET_UNKNOWN');
    const checked = compileCase({ id: 'assertion-validation', operationId: target.operationId, status: target.expected.statuses[0], request: {}, rationale: target.title, assertions: addition.assertions }, contract, config, plan);
    target.assertions = [...new Map([...(target.assertions ?? []), ...(checked.assertions ?? [])].map(a => [stableStringify(a), a])).values()];
    if (target.assertions.length > 20) throw new Error('AGENT_ASSERTION_LIMIT');
  }
  for (const note of list(proposal.riskNotes, 'riskNotes')) {
    if (typeof note === 'string') { plan.warnings.push(`Agent risk: ${string(note, 'risk note')}`); continue; }
    const item = record(note, 'riskNote');
    plan.warnings.push(`Agent risk for ${typeof item.operationId === 'string' && item.operationId.trim() ? item.operationId : 'unmapped scenario'}: ${string(item.note, 'risk note')}`);
  }
  for (const value of list(proposal.coverageLinks, 'coverageLinks')) {
    const link = record(value, 'coverage link');
    keys(link, ['caseId', 'discoveryIds', 'rationale'], 'coverage link');
    const matches = (id: string) => id === link.caseId || id === `agent-${link.caseId}`;
    const target = all().find(item => matches(item.id));
    const workflow = plan.workflows.find(item => matches(item.id));
    const targets = target ? [target] : workflow?.steps ?? [];
    if (!targets.length) throw new Error(`AGENT_COVERAGE_TARGET_UNKNOWN: ${link.caseId}; use an exact case or workflow ID from currentPlan`);
    const rationale = string(link.rationale, 'coverage rationale');
    for (const target of targets) {
      const related = plan.workflows.find(workflow => workflow.steps.some(step => step.id === target.id))?.steps.map(step => step.operationId) ?? [];
      const validated = compileCase({ id: 'coverage-validation', operationId: target.operationId,
        status: target.expected.statuses[0], request: {}, discoveryIds: link.discoveryIds, rationale }, contract, config, plan, related);
      if (!validated.discovery) throw new Error('AGENT_COVERAGE_IDS_REQUIRED');
      if (validated.discovery.candidateIds.every(id => target.discovery?.candidateIds.includes(id))) continue;
      target.discovery = { signal: target.discovery?.signal ?? validated.discovery.signal,
        candidateIds: [...new Set([...(target.discovery?.candidateIds ?? []), ...validated.discovery.candidateIds])],
        evidence: [...new Map([...(target.discovery?.evidence ?? []), ...validated.discovery.evidence].map(item => [stableStringify(item), item])).values()],
        linkRationale: rationale };
    }
  }
  // Recheck standalone assertions appended after initial compilation too.
  for (const item of plan.cases) {
    const inputs = { pathParams: item.pathParams, query: item.query, body: item.body, rawBody: item.rawBody, headers: item.headers, assertions: item.assertions };
    for (const match of JSON.stringify(inputs).matchAll(/\$\{([^}]+)\}/g)) {
      if (match[1] !== 'runId') throw new Error(`AGENT_CAPTURE_UNBOUND: ${item.id} references ${match[1]}`);
    }
  }
  // Recheck dependency scope after repairs as well as initial construction.
  for (const workflow of plan.workflows) {
    const variables = new Set(['runId']);
    for (const step of [...workflow.steps, ...(workflow.cleanupSteps ?? [])]) {
      const inputs = { pathParams: step.pathParams, query: step.query, body: step.body, rawBody: step.rawBody, headers: step.headers, assertions: step.assertions };
      for (const match of JSON.stringify(inputs).matchAll(/\$\{([^}]+)\}/g)) {
        if (!variables.has(match[1]!)) throw new Error(`AGENT_CAPTURE_UNBOUND: ${step.id} references ${match[1]}`);
      }
      for (const [name, expression] of Object.entries(step.capture)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(name) || variables.has(name) || typeof expression !== 'string' || !/^\$(?:\.[a-zA-Z0-9_-]+)*$/.test(expression)) throw new Error(`AGENT_CAPTURE_INVALID: ${step.id} capture ${name}`);
        variables.add(name);
      }
    }
  }
  for (const operation of contract.operations) {
    if (all().filter((item) => item.authoredBy === 'agent' && item.operationId === operation.operationId).length > config.discovery.maxCandidatesPerOperation) throw new Error(`AGENT_OPERATION_BUDGET_EXCEEDED: ${operation.operationId}`);
  }
  if (config.isolation) {
    const operation = contract.operations.find(o => o.operationId === config.isolation!.operationId);
    const status = operation?.responses.find(r => typeof r.status === 'number' && r.status >= 200 && r.status < 300)?.status;
    if (!status) throw new Error('ISOLATION_OPERATION_REQUIRES_SUCCESS_RESPONSE');
    const hook = compileCase({ id: 'isolation-reset', operationId: operation!.operationId, status, request: config.isolation.request, rationale: 'Configured test environment reset' }, contract, config, plan);
    if (/\$\{/.test(stableStringify(hook))) throw new Error('ISOLATION_HOOK_VARIABLES_DENIED');
    plan.isolation = { beforeEach: [{ ...hook, capture: {} }], afterEach: [{ ...hook, capture: {} }] };
  }
  if (plannedRequestCount(plan) > config.safety.maxRequestsPerRun) throw new Error('AGENT_REQUEST_BUDGET_EXCEEDED');
  for (const coverage of plan.operations) {
    coverage.coveredBy = [...new Set([
      ...coverage.coveredBy,
      ...plan.cases.filter((item) => item.operationId === coverage.operationId).map((item) => item.id),
      ...plan.workflows.filter((workflow) => workflow.steps.some((item) => item.operationId === coverage.operationId)).map((workflow) => `workflow:${workflow.id}`),
    ])];
  }
  if (plan.discovery) {
    for (const testCase of all()) {
      for (const id of testCase.discovery?.candidateIds ?? []) {
        const candidate = plan.discovery.candidates.find((item) => item.id === id)!;
        if (candidate.disposition === 'report-only' && candidate.signal === 'semantic-scenario') {
          candidate.disposition = 'generate'; candidate.reason = `Implemented by agent case ${testCase.id}; response oracle is contract-derived.`;
        }
      }
    }
    const { discoveryHash: _, ...unsigned } = plan.discovery;
    plan.discovery.discoveryHash = sha256(stableStringify(unsigned));
  }
  return plan;
}

export function plannedRequestCount(plan: TestPlan): number {
  return plan.cases.length + plan.workflows.reduce((n, w) => n + w.steps.length + (w.cleanupSteps?.length ?? 0), 0) + (plan.cases.length + plan.workflows.length) * ((plan.isolation?.beforeEach.length ?? 0) + (plan.isolation?.afterEach.length ?? 0));
}
