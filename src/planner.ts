import type {
  GauntletConfig,
  JsonSchema,
  NormalizedContract,
  NormalizedOperation,
  TestCasePlan,
  TestPlan,
  WorkflowPlan,
} from './types.js';
import { shortId } from './utils.js';

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
      const selected = keys.filter((property) => required.has(property) || mode !== 'invalid');
      const result = Object.fromEntries(selected.map((property) => [property, sampleFromSchema(properties[property]!, seed, `${key}.${property}`, mode)]));
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
      if (schema.format === 'uuid') return `${shortId(`${seed}-${key}`)}-0000-4000-8000-000000000000`.slice(0, 36);
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

function makeCase(
  operation: NormalizedOperation,
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
  };
}

function allowed(operation: NormalizedOperation, config: GauntletConfig): string | undefined {
  if (!config.safety.allowedMethods.includes(operation.method)) return `Method ${operation.method} is denied by safety.allowedMethods`;
  if (operation.destructive && !config.safety.allowDestructive) return `Destructive operation ${operation.method} requires safety.allowDestructive=true`;
  return undefined;
}

export function buildPlan(contract: NormalizedContract, config: GauntletConfig): TestPlan {
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
    add(makeCase(operation, config.seed, 'positive', success, 'valid', 'Valid schema-derived request must satisfy a declared success contract'));

    const validation = operation.responses.find((response) => response.status === 422)
      ?? operation.responses.find((response) => response.status === 400);
    const hasConstraint = Boolean(operation.requestBody?.schema.required?.length)
      || operation.parameters.some((parameter) => parameter.required || parameter.schema.minimum !== undefined || parameter.schema.maximum !== undefined);
    if (validation && hasConstraint) {
      add(makeCase(operation, config.seed, 'validation', [validation.status], 'invalid', 'Malformed or incomplete required input must satisfy the declared validation contract'));
    }
    if (operation.requestBody && (operation.requestBody.schema.maxLength !== undefined || operation.requestBody.schema.properties)) {
      add(makeCase(operation, config.seed, 'boundary', success, 'boundary', 'Constraint boundary values must remain valid'));
    }
    if (operation.secured) {
      const unauthorized = operation.responses.find((response) => response.status === 401);
      if (unauthorized) add(makeCase(operation, config.seed, 'authorization', [401], 'valid', 'Missing credentials must be rejected by the declared security contract'));
    }
    const notFound = operation.responses.find((response) => response.status === 404);
    if (notFound && operation.parameters.some((parameter) => parameter.in === 'path')) {
      const notFoundCase = makeCase(operation, config.seed, 'not-found', [404], 'valid', 'Unknown resource identity must satisfy the declared not-found contract');
      for (const parameter of operation.parameters.filter((candidate) => candidate.in === 'path')) {
        notFoundCase.pathParams[parameter.name] = parameter.schema.type === 'integer' ? 999_999 : `missing-${shortId(parameter.name)}`;
      }
      add(notFoundCase);
    }
    const conflict = operation.responses.find((response) => response.status === 409);
    if (conflict && operation.requestBody) {
      add(makeCase(operation, config.seed, 'conflict', [409], 'conflict', 'Known duplicate input must satisfy the declared conflict contract'));
    }
  }

  const workflows: WorkflowPlan[] = contract.workflows.map((definition) => {
    const steps = definition.steps.map((step, index) => {
      const operation = contract.operations.find((candidate) => candidate.operationId === step.operationId)!;
      const denied = allowed(operation, config);
      if (denied) throw new Error(`WORKFLOW_DENIED: ${definition.id}/${operation.operationId}: ${denied}`);
      const success = operation.responses.filter((response) => response.status >= 200 && response.status < 300).map((response) => response.status);
      const planned = makeCase(operation, config.seed, 'positive', success, 'valid', `Workflow step ${index + 1} preserves the declared state transition`, `${definition.id}-${index}`);
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
  };
}
