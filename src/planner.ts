import type {
  GauntletConfig,
  DiscoveryCandidate,
  DiscoveryReport,
  JsonSchema,
  NormalizedContract,
  NormalizedOperation,
  TestCasePlan,
  TestPlan,
  WorkflowPlan,
} from './types.js';
import { sha256, shortId, stableStringify } from './utils.js';

type SampleMode = 'valid' | 'boundary' | 'invalid' | 'conflict';

function numericSample(schema: JsonSchema, mode: SampleMode): number {
  if (mode === 'invalid') {
    if (typeof schema.minimum === 'number') return schema.minimum - 1;
    if (typeof schema.maximum === 'number') return schema.maximum + 1;
  }
  if (mode === 'boundary') {
    if (typeof schema.maximum === 'number') return schema.maximum;
    if (typeof schema.minimum === 'number') return schema.minimum;
  }
  if (typeof schema.minimum === 'number') return schema.minimum;
  if (typeof schema.exclusiveMinimum === 'number') return schema.exclusiveMinimum + 1;
  return 1;
}

export function sampleFromSchema(schema: JsonSchema, seed: number, key: string, mode: SampleMode = 'valid'): unknown {
  if (mode === 'conflict' && schema['x-gauntlet-conflict-value'] !== undefined) return schema['x-gauntlet-conflict-value'];
  if (schema.const !== undefined) return schema.const;
  if (schema.example !== undefined && mode === 'valid') return schema.example;
  if (schema.default !== undefined && mode === 'valid') return schema.default;
  if (schema.enum?.length) return schema.enum[mode === 'boundary' ? schema.enum.length - 1 : 0];
  const composite = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (composite) return sampleFromSchema(composite, seed, key, mode);
  if (schema.allOf?.length) {
    return Object.assign({}, ...schema.allOf.map((part, index) => sampleFromSchema(part, seed, `${key}-${index}`, mode)));
  }
  const type = Array.isArray(schema.type) ? schema.type.find((entry) => entry !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const properties = schema.properties ?? {};
      const keys = Object.keys(properties).sort();
      const required = new Set(schema.required ?? []);
      const selected = keys.filter((property) => required.has(property)
        || mode === 'boundary'
        || (mode === 'valid' && properties[property]?.default !== undefined));
      const result = Object.fromEntries(selected.map((property) => [property, sampleFromSchema(properties[property]!, seed, `${key}.${mode}.${property}`, mode)]));
      if (mode === 'invalid' && schema.required?.length) delete result[schema.required[0]!];
      return result;
    }
    case 'array': {
      const count = mode === 'boundary' ? (schema.maxItems ?? schema.minItems ?? 1) : (schema.minItems ?? 1);
      return Array.from({ length: Math.min(count, 10) }, (_, index) => sampleFromSchema(schema.items ?? {}, seed, `${key}.${index}`, mode));
    }
    case 'integer':
      return Math.trunc(numericSample(schema, mode));
    case 'number':
      return numericSample(schema, mode);
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'string':
    default: {
      if (mode === 'conflict' && schema['x-gauntlet-conflict-value'] !== undefined) return schema['x-gauntlet-conflict-value'];
      if (mode === 'invalid') {
        if ((schema.minLength ?? 0) > 0) return '';
        if (schema.format === 'email') return 'not-an-email';
      }
      if (schema.format === 'email') return `gauntlet-${seed}-${shortId(key)}@example.test`;
      if (schema.format === 'uuid') {
        const hash = sha256(`${seed}-${key}`);
        return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      }
      if (schema.format === 'date-time') return '2030-01-02T03:04:05.000Z';
      if (schema.format === 'date') return '2030-01-02';
      const minimum = schema.minLength ?? 1;
      const maximum = schema.maxLength ?? Math.max(minimum, 24);
      const length = mode === 'boundary' ? maximum : Math.max(minimum, Math.min(maximum, 12));
      const basis = `gauntlet-${seed}-${shortId(key)}`;
      return basis.repeat(Math.ceil(length / basis.length)).slice(0, length);
    }
  }
}

function responseFor(operation: NormalizedOperation, statuses: number[]): TestCasePlan['expected'] {
  const statusSet = new Set(statuses);
  const response = operation.responses.find((candidate) => statusSet.has(candidate.status));
  return {
    statuses,
    ...(response?.contentType ? { contentType: response.contentType } : {}),
    ...(response?.schema ? { schema: response.schema } : {}),
  };
}

function buildInputs(operation: NormalizedOperation, seed: number, mode: SampleMode): Pick<TestCasePlan, 'pathParams' | 'query' | 'headers' | 'body'> {
  const pathParams: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  const invalidParameter = mode === 'invalid'
    ? operation.parameters.find((parameter) => parameter.required || parameter.schema.minimum !== undefined || parameter.schema.maximum !== undefined || parameter.schema.minLength !== undefined)
    : undefined;
  for (const parameter of operation.parameters) {
    if (!parameter.required && mode !== 'boundary' && parameter !== invalidParameter) continue;
    const value = mode === 'valid' && parameter.example !== undefined
      ? parameter.example
      : sampleFromSchema(parameter.schema, seed, `${operation.operationId}.${parameter.name}`, mode);
    if (parameter.in === 'path') pathParams[parameter.name] = value;
    if (parameter.in === 'query') query[parameter.name] = value;
    if (parameter.in === 'header') headers[parameter.name] = String(value);
  }
  return {
    pathParams,
    query,
    headers,
    ...(operation.requestBody ? { body: sampleFromSchema(operation.requestBody.schema, seed, `${operation.operationId}.body`, mode) } : {}),
  };
}

function observedPathParams(template: string, observedPath: string | undefined): Record<string, string> {
  if (!observedPath) return {};
  const templateParts = template.split('/').filter(Boolean);
  const observedParts = observedPath.split('?')[0]!.split('/').filter(Boolean);
  if (templateParts.length !== observedParts.length) return {};
  const parameters: Record<string, string> = {};
  for (let index = 0; index < templateParts.length; index += 1) {
    const part = templateParts[index]!;
    if (!part.startsWith('{') || !part.endsWith('}')) continue;
    const observed = decodeURIComponent(observedParts[index]!);
    if (/^\[REDACTED/.test(observed)) continue;
    parameters[part.slice(1, -1)] = observed;
  }
  return parameters;
}

function makeCase(
  operation: NormalizedOperation,
  specHash: string,
  seed: number,
  kind: TestCasePlan['kind'],
  statuses: number[],
  mode: SampleMode,
  rationale: string,
  suffix: string = kind,
): TestCasePlan {
  return {
    id: `${operation.operationId}-${suffix}-${shortId(`${operation.sourcePointer}:${suffix}:${seed}`)}`,
    title: `${operation.operationId} ${kind}`,
    kind,
    operationId: operation.operationId,
    sourcePointer: operation.sourcePointer,
    method: operation.method,
    path: operation.path,
    ...buildInputs(operation, seed, mode),
    useAuth: operation.secured && kind !== 'authorization',
    destructive: operation.destructive,
    expected: responseFor(operation, statuses),
    rationale,
    oracleProvenance: [
      { authority: 'openapi', specHash, sourcePointer: operation.sourcePointer },
      ...operation.responses.filter((response) => statuses.includes(response.status)).map((response) => ({ authority: 'openapi' as const, specHash, sourcePointer: response.sourcePointer })),
    ],
  };
}

function allowed(operation: NormalizedOperation, config: GauntletConfig): string | undefined {
  if (!config.safety.allowedMethods.includes(operation.method)) return `Method ${operation.method} is denied by safety.allowedMethods`;
  if (operation.destructive && !config.safety.allowDestructive) return `Destructive operation ${operation.method} requires safety.allowDestructive=true`;
  return undefined;
}

function discoveryCase(operation: NormalizedOperation, contract: NormalizedContract, config: GauntletConfig, candidate: DiscoveryCandidate): TestCasePlan | undefined {
  if (!['generate', 'merge'].includes(candidate.disposition) || candidate.observedStatus === undefined) return undefined;
  if (!operation.responses.some((response) => response.status === candidate.observedStatus)) return undefined;
  const planned = candidate.signal === 'missing-auth'
    ? makeCase(operation, contract.specHash, config.seed, 'authorization', [candidate.observedStatus], 'valid', 'Additional-source missing-auth signal corroborates the OpenAPI authorization response', candidate.id)
    : candidate.signal === 'not-found'
      ? makeCase(operation, contract.specHash, config.seed, 'not-found', [candidate.observedStatus], 'valid', 'Additional-source not-found signal corroborates the OpenAPI response', candidate.id)
      : candidate.signal === 'conflict' && operation.requestBody
        ? makeCase(operation, contract.specHash, config.seed, 'conflict', [candidate.observedStatus], 'conflict', 'Additional-source conflict signal corroborates the OpenAPI response', candidate.id)
        : makeCase(
          operation,
          contract.specHash,
          config.seed,
          'discovered',
          [candidate.observedStatus],
          'valid',
          `Additional-source signal ${candidate.signal}; status and schema remain OpenAPI-derived`,
          candidate.id,
        );
  planned.discovery = { signal: candidate.signal, candidateIds: [candidate.id], evidence: candidate.evidence };
  if (candidate.signal === 'not-found') {
    const observed = observedPathParams(operation.path, candidate.observedPath);
    for (const parameter of operation.parameters.filter((item) => item.in === 'path')) {
      planned.pathParams[parameter.name] = observed[parameter.name]
        ?? (parameter.schema.type === 'integer' ? 999_999 : sampleFromSchema(parameter.schema, config.seed, `${operation.operationId}.${parameter.name}.not-found`, 'valid'));
    }
  } else if (candidate.signal === 'malformed-json') {
    planned.headers['content-type'] = 'application/json';
    delete planned.body;
    planned.rawBody = '{"broken":';
  } else if (candidate.signal === 'unsupported-media-type') {
    planned.headers['content-type'] = 'text/plain';
    delete planned.body;
    planned.rawBody = 'synthetic-gauntlet-unsupported-body';
  } else if (candidate.signal === 'query-boundary') {
    const parameter = operation.parameters.find((item) => item.in === 'query' && (item.schema.minimum !== undefined || item.schema.maximum !== undefined));
    if (!parameter) return undefined;
    planned.query[parameter.name] = parameter.schema.maximum !== undefined ? parameter.schema.maximum + 1 : (parameter.schema.minimum as number) - 1;
  } else if (candidate.signal === 'whitespace-validation') {
    const property = Object.entries(operation.requestBody?.schema.properties ?? {}).find(([, schema]) => {
      const type = Array.isArray(schema.type) ? schema.type : [schema.type];
      return type.includes('string') && (schema.minLength ?? 0) > 0;
    });
    if (!property || !planned.body || typeof planned.body !== 'object' || Array.isArray(planned.body)) return undefined;
    planned.body = { ...(planned.body as Record<string, unknown>), [property[0]]: '   ' };
  } else {
    return undefined;
  }
  return planned;
}

function requestIdentity(testCase: TestCasePlan): string {
  return JSON.stringify({
    operationId: testCase.operationId,
    method: testCase.method,
    path: testCase.path,
    pathParams: testCase.pathParams,
    query: testCase.query,
    headers: testCase.headers,
    body: testCase.body,
    rawBody: testCase.rawBody,
    useAuth: testCase.useAuth,
    statuses: testCase.expected.statuses,
  });
}

export function buildPlan(contract: NormalizedContract, config: GauntletConfig, discovery?: DiscoveryReport): TestPlan {
  const planDiscovery = discovery ? structuredClone(discovery) : undefined;
  const cases: TestCasePlan[] = [];
  const operationCoverage = new Map<string, string[]>();
  const blocked = new Map<string, string>();
  for (const operation of contract.operations) {
    operationCoverage.set(operation.operationId, []);
    const denied = allowed(operation, config);
    if (denied) {
      blocked.set(operation.operationId, denied);
      continue;
    }
    if (operation.skipStandalone) continue;
    const success = operation.responses.filter((response) => response.status >= 200 && response.status < 300).map((response) => response.status);
    if (success.length === 0) {
      blocked.set(operation.operationId, 'No declared 2xx response; expected behavior is ambiguous');
      continue;
    }
    const add = (testCase: TestCasePlan): void => {
      cases.push(testCase);
      operationCoverage.get(operation.operationId)!.push(testCase.id);
    };
    add(makeCase(operation, contract.specHash, config.seed, 'positive', success, 'valid', 'Valid schema-derived request must satisfy a declared success contract'));

    const validation = operation.responses.find((response) => response.status === 422)
      ?? operation.responses.find((response) => response.status === 400);
    const hasConstraint = Boolean(operation.requestBody?.schema.required?.length)
      || operation.parameters.some((parameter) => parameter.required || parameter.schema.minimum !== undefined || parameter.schema.maximum !== undefined);
    if (validation && hasConstraint) {
      add(makeCase(operation, contract.specHash, config.seed, 'validation', [validation.status], 'invalid', 'Malformed or incomplete required input must satisfy the declared validation contract'));
    }
    if (operation.requestBody && (operation.requestBody.schema.maxLength !== undefined || operation.requestBody.schema.properties)) {
      add(makeCase(operation, contract.specHash, config.seed, 'boundary', success, 'boundary', 'Constraint boundary values must remain valid'));
    }
    if (operation.secured) {
      const unauthorized = operation.responses.find((response) => response.status === 401);
      if (unauthorized) add(makeCase(operation, contract.specHash, config.seed, 'authorization', [401], 'valid', 'Missing credentials must be rejected by the declared security contract'));
    }
    const notFound = operation.responses.find((response) => response.status === 404);
    if (notFound && operation.parameters.some((parameter) => parameter.in === 'path')) {
      const notFoundCase = makeCase(operation, contract.specHash, config.seed, 'not-found', [404], 'valid', 'Unknown resource identity must satisfy the declared not-found contract');
      for (const parameter of operation.parameters.filter((candidate) => candidate.in === 'path')) {
        notFoundCase.pathParams[parameter.name] = parameter.schema.type === 'integer' ? 999_999 : `missing-${shortId(parameter.name)}`;
      }
      add(notFoundCase);
    }
    const conflict = operation.responses.find((response) => response.status === 409);
    if (conflict && operation.requestBody) {
      add(makeCase(operation, contract.specHash, config.seed, 'conflict', [409], 'conflict', 'Known duplicate input must satisfy the declared conflict contract'));
    }
  }

  const workflows: WorkflowPlan[] = contract.workflows.map((definition) => {
    const steps = definition.steps.map((step, index) => {
      const operation = contract.operations.find((candidate) => candidate.operationId === step.operationId)!;
      const denied = allowed(operation, config);
      if (denied) throw new Error(`WORKFLOW_DENIED: ${definition.id}/${operation.operationId}: ${denied}`);
      const success = operation.responses.filter((response) => response.status >= 200 && response.status < 300).map((response) => response.status);
      const planned = makeCase(operation, contract.specHash, config.seed, 'positive', success, 'valid', `Workflow step ${index + 1} preserves the declared state transition`, `${definition.id}-${index}`);
      planned.id = `${definition.id}-${index + 1}-${operation.operationId}`;
      planned.title = `${definition.title}: ${operation.operationId}`;
      if (step.pathParams) planned.pathParams = { ...planned.pathParams, ...step.pathParams };
      if (step.query) planned.query = { ...planned.query, ...step.query };
      if (step.body) planned.body = { ...(planned.body as Record<string, unknown> | undefined), ...step.body };
      operationCoverage.get(operation.operationId)!.push(`${definition.id}/${planned.id}`);
      return { ...planned, capture: step.capture ?? {} };
    });
    return { id: definition.id, title: definition.title, steps };
  });

  if (planDiscovery) {
    for (const candidate of planDiscovery.candidates) {
      if (!candidate.operationId) continue;
      const operation = contract.operations.find((item) => item.operationId === candidate.operationId);
      if (!operation || allowed(operation, config)) {
        if (candidate.disposition === 'generate') {
          candidate.disposition = 'reject';
          candidate.reason = 'Existing safety policy denies this operation.';
        }
        continue;
      }
      const baselineMatch = cases.find((testCase) => testCase.operationId === operation.operationId
        && testCase.expected.statuses.includes(candidate.observedStatus ?? -1)
        && ((candidate.signal === 'missing-auth' && testCase.kind === 'authorization')
          || (candidate.signal === 'not-found' && testCase.kind === 'not-found')
          || (candidate.signal === 'conflict' && testCase.kind === 'conflict')));
      if (baselineMatch) {
        candidate.disposition = 'merge';
        candidate.reason = `Merged with existing contract-derived case ${baselineMatch.id}.`;
        baselineMatch.discovery = {
          signal: candidate.signal,
          candidateIds: [...new Set([...(baselineMatch.discovery?.candidateIds ?? []), candidate.id])].sort(),
          evidence: [...(baselineMatch.discovery?.evidence ?? []), ...candidate.evidence]
            .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.lineStart - b.lineStart),
        };
        continue;
      }
      const proposed = discoveryCase(operation, contract, config, candidate);
      if (!proposed) {
        if (candidate.disposition === 'generate') {
          candidate.disposition = 'report-only';
          candidate.reason = 'The contract does not provide enough structure to synthesize this input deterministically.';
        }
        continue;
      }
      if (candidate.disposition === 'merge') {
        candidate.disposition = 'generate';
        candidate.reason = 'No matching baseline case existed, so a new OpenAPI-corroborated case was generated.';
      }
      const duplicate = cases.find((testCase) => requestIdentity(testCase) === requestIdentity(proposed));
      if (duplicate) {
        candidate.disposition = 'merge';
        candidate.reason = `Semantically merged with existing case ${duplicate.id}.`;
        if (proposed.discovery) duplicate.discovery = proposed.discovery;
      } else {
        cases.push(proposed);
        operationCoverage.get(operation.operationId)!.push(proposed.id);
      }
    }
    const { discoveryHash: _previousHash, ...unsignedDiscovery } = planDiscovery;
    planDiscovery.discoveryHash = sha256(stableStringify(unsignedDiscovery));
  }

  const plannedRequests = cases.length + workflows.reduce((count, workflow) => count + workflow.steps.length, 0);
  if (plannedRequests > config.safety.maxRequestsPerRun) {
    throw new Error(`REQUEST_BUDGET_EXCEEDED: plan requires ${plannedRequests} requests but safety.maxRequestsPerRun is ${config.safety.maxRequestsPerRun}`);
  }

  return {
    formatVersion: 1,
    projectName: config.projectName,
    specPath: contract.specPath,
    specHash: contract.specHash,
    seed: config.seed,
    operations: contract.operations.map((operation) => ({
      operationId: operation.operationId,
      sourcePointer: operation.sourcePointer,
      coveredBy: operationCoverage.get(operation.operationId) ?? [],
      ...(blocked.has(operation.operationId) ? { blockedReason: blocked.get(operation.operationId)! } : {}),
    })),
    cases,
    workflows,
    warnings: [...contract.warnings],
    ...(planDiscovery ? { discovery: planDiscovery } : {}),
  };
}
