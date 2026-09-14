import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type {
  HttpMethod,
  JsonSchema,
  NormalizedContract,
  NormalizedOperation,
  NormalizedParameter,
  NormalizedResponse,
  WorkflowDefinition,
} from './types.js';
import { jsonPointerEscape, sha256, stableStringify } from './utils.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`CONTRACT_INVALID: ${context} must be an object`);
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function localRef(document: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith('#/')) throw new Error(`CONTRACT_REF_DENIED: remote reference ${ref}`);
  let current: unknown = document;
  for (const rawPart of ref.slice(2).split('/')) {
    const part = rawPart.replaceAll('~1', '/').replaceAll('~0', '~');
    const record = optionalObject(current);
    if (!record || !(part in record)) throw new Error(`CONTRACT_REF_UNRESOLVED: ${ref}`);
    current = record[part];
  }
  return current;
}

export function dereferenceSchema(document: Record<string, unknown>, schema: unknown, seen = new Set<string>()): JsonSchema {
  const source = object(schema, 'schema');
  if (typeof source.$ref === 'string') {
    if (seen.has(source.$ref)) throw new Error(`CONTRACT_REF_CYCLE: ${source.$ref}`);
    const nextSeen = new Set(seen).add(source.$ref);
    return dereferenceSchema(document, localRef(document, source.$ref), nextSeen);
  }
  const result: JsonSchema = { ...source };
  if (source.properties && typeof source.properties === 'object' && !Array.isArray(source.properties)) {
    result.properties = Object.fromEntries(
      Object.entries(source.properties as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, dereferenceSchema(document, value, seen)]),
    );
  }
  if (source.items) result.items = dereferenceSchema(document, source.items, seen);
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (Array.isArray(source[key])) result[key] = (source[key] as unknown[]).map((entry) => dereferenceSchema(document, entry, seen));
  }
  if (source.additionalProperties && typeof source.additionalProperties === 'object') {
    result.additionalProperties = dereferenceSchema(document, source.additionalProperties, seen);
  }
  return result;
}

function dereferenceObject(document: Record<string, unknown>, value: unknown, context: string): Record<string, unknown> {
  const source = object(value, context);
  return typeof source.$ref === 'string' ? object(localRef(document, source.$ref), source.$ref) : source;
}

function normalizeParameters(
  document: Record<string, unknown>,
  values: unknown[],
  pointer: string,
): NormalizedParameter[] {
  return values.map((value, index) => {
    const parameter = dereferenceObject(document, value, `${pointer}/${index}`);
    const location = parameter.in;
    if (!['path', 'query', 'header', 'cookie'].includes(String(location))) {
      throw new Error(`CONTRACT_INVALID: unsupported parameter location at ${pointer}/${index}`);
    }
    if (typeof parameter.name !== 'string') throw new Error(`CONTRACT_INVALID: missing parameter name at ${pointer}/${index}`);
    const examples = optionalObject(parameter.examples);
    const firstExample = examples
      ? optionalObject(examples[Object.keys(examples).sort()[0]!])?.value
      : undefined;
    return {
      name: parameter.name,
      in: location as NormalizedParameter['in'],
      required: location === 'path' || parameter.required === true,
      schema: dereferenceSchema(document, parameter.schema ?? { type: 'string' }),
      ...(parameter.example !== undefined ? { example: parameter.example } : firstExample !== undefined ? { example: firstExample } : {}),
      sourcePointer: `${pointer}/${index}`,
    };
  });
}

function normalizeResponses(
  document: Record<string, unknown>,
  responsesValue: unknown,
  pointer: string,
  warnings: string[],
): NormalizedResponse[] {
  const responses = object(responsesValue, pointer);
  const normalized: NormalizedResponse[] = [];
  for (const [statusKey, responseValue] of Object.entries(responses).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^\d{3}$/.test(statusKey)) {
      warnings.push(`Unsupported non-numeric response ${pointer}/${statusKey}`);
      continue;
    }
    const response = dereferenceObject(document, responseValue, `${pointer}/${statusKey}`);
    const content = optionalObject(response.content);
    const contentType = content
      ? Object.keys(content).find((key) => key === 'application/json' || key.endsWith('+json')) ?? Object.keys(content)[0]
      : undefined;
    const media = contentType && content ? optionalObject(content[contentType]) : undefined;
    normalized.push({
      status: Number(statusKey),
      ...(contentType ? { contentType } : {}),
      ...(media?.schema ? { schema: dereferenceSchema(document, media.schema) } : {}),
      sourcePointer: `${pointer}/${statusKey}`,
    });
  }
  if (normalized.length === 0) throw new Error(`CONTRACT_INVALID: no numeric responses at ${pointer}`);
  return normalized;
}

function normalizeWorkflows(value: unknown): WorkflowDefinition[] {
  if (value === undefined) return [];
  const entries: Array<[string | undefined, unknown]> = Array.isArray(value)
    ? value.map((entry) => [undefined, entry])
    : Object.entries(object(value, 'x-gauntlet-workflows'));
  return entries.map(([workflowKey, workflowValue], workflowIndex) => {
    const workflow = object(workflowValue, `x-gauntlet-workflows/${workflowIndex}`);
    const workflowId = typeof workflow.id === 'string' ? workflow.id : workflowKey;
    if (!workflowId || !Array.isArray(workflow.steps)) {
      throw new Error(`CONTRACT_INVALID: malformed workflow at x-gauntlet-workflows/${workflowIndex}`);
    }
    return {
      id: workflowId,
      title: typeof workflow.title === 'string' ? workflow.title : typeof workflow.description === 'string' ? workflow.description : workflowId,
      steps: workflow.steps.map((stepValue, stepIndex) => {
        const step = object(stepValue, `x-gauntlet-workflows/${workflowIndex}/steps/${stepIndex}`);
        if (typeof step.operationId !== 'string') throw new Error('CONTRACT_INVALID: workflow step operationId is required');
        const request = optionalObject(step.request);
        const capture = optionalObject(step.capture);
        const parameters = optionalObject(step.parameters);
        const directPathParams = optionalObject(step.pathParams);
        const query = optionalObject(step.query);
        const directBody = optionalObject(step.body);
        const requestBody = request ? optionalObject(request.body) : undefined;
        return {
          operationId: step.operationId,
          ...(capture ? { capture: Object.fromEntries(Object.entries(capture).map(([key, expression]) => {
            const normalized = String(expression).replace(/^\$response\.body#\//, '$.').replaceAll('/', '.');
            return [key, normalized];
          })) } : {}),
          ...(directPathParams ? { pathParams: directPathParams } : parameters ? { pathParams: Object.fromEntries(
            Object.entries(parameters).map(([key, parameterValue]) => [key, typeof parameterValue === 'string'
              ? parameterValue.replace(/^\$\{steps\.[^.]+\.([^}]+)\}$/, '${$1}')
              : parameterValue]),
          ) } : {}),
          ...(query ? { query } : {}),
          ...(directBody ? { body: directBody } : requestBody ? { body: requestBody } : {}),
        };
      }),
    };
  });
}

export async function loadContract(specPath: string): Promise<NormalizedContract> {
  const absolute = path.resolve(specPath);
  const source = await readFile(absolute, 'utf8');
  const parsed = absolute.endsWith('.json') ? JSON.parse(source) : YAML.parse(source);
  const document = object(parsed, 'root');
  if (typeof document.openapi !== 'string' || !document.openapi.startsWith('3.')) {
    throw new Error('CONTRACT_INVALID: only OpenAPI 3.x documents are supported');
  }
  const info = object(document.info, 'info');
  const paths = object(document.paths, 'paths');
  const rootSecurity = Array.isArray(document.security) && document.security.length > 0;
  const warnings: string[] = [];
  const operations: NormalizedOperation[] = [];
  const operationIds = new Map<string, string>();

  for (const [apiPath, pathValue] of Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))) {
    const pathItem = dereferenceObject(document, pathValue, `/paths/${jsonPointerEscape(apiPath)}`);
    const pathPointer = `/paths/${jsonPointerEscape(apiPath)}`;
    const sharedParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of METHODS) {
      if (!pathItem[method]) continue;
      const operation = object(pathItem[method], `${pathPointer}/${method}`);
      if (typeof operation.operationId !== 'string' || operation.operationId.trim() === '') {
        throw new Error(`CONTRACT_INVALID: operationId required at ${pathPointer}/${method}`);
      }
      const previous = operationIds.get(operation.operationId);
      if (previous) throw new Error(`CONTRACT_DUPLICATE_OPERATION_ID: ${operation.operationId} at ${previous} and ${pathPointer}/${method}`);
      operationIds.set(operation.operationId, `${pathPointer}/${method}`);
      const parameters = normalizeParameters(
        document,
        [...sharedParameters, ...(Array.isArray(operation.parameters) ? operation.parameters : [])],
        `${pathPointer}/${method}/parameters`,
      );
      const requestBodyValue = operation.requestBody;
      let requestBody: NormalizedOperation['requestBody'];
      if (requestBodyValue) {
        const request = dereferenceObject(document, requestBodyValue, `${pathPointer}/${method}/requestBody`);
        const content = object(request.content, `${pathPointer}/${method}/requestBody/content`);
        const contentType = Object.keys(content).find((key) => key === 'application/json' || key.endsWith('+json'))
          ?? Object.keys(content).find((key) => key === 'application/x-www-form-urlencoded');
        if (!contentType) warnings.push(`Unsupported request body encoding at ${pathPointer}/${method}`);
        else {
          const media = object(content[contentType], `${pathPointer}/${method}/requestBody/content/${contentType}`);
          requestBody = {
            required: request.required === true,
            contentType,
            schema: dereferenceSchema(document, media.schema ?? {}),
            sourcePointer: `${pathPointer}/${method}/requestBody`,
          };
        }
      }
      const security = operation.security === undefined ? rootSecurity : Array.isArray(operation.security) && operation.security.length > 0;
      operations.push({
        operationId: operation.operationId,
        method: method.toUpperCase() as HttpMethod,
        path: apiPath,
        sourcePointer: `${pathPointer}/${method}`,
        summary: typeof operation.summary === 'string' ? operation.summary.slice(0, 200) : operation.operationId,
        parameters,
        ...(requestBody ? { requestBody } : {}),
        responses: normalizeResponses(document, operation.responses, `${pathPointer}/${method}/responses`, warnings),
        secured: security,
        skipStandalone: operation['x-gauntlet-skip-standalone'] === true,
        destructive: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase()),
      });
    }
  }
  if (operations.length === 0) throw new Error('EMPTY_CONTRACT: no operations found');

  const workflows = normalizeWorkflows(document['x-gauntlet-workflows']);
  for (const workflow of workflows) {
    for (const step of workflow.steps) {
      if (!operationIds.has(step.operationId)) throw new Error(`CONTRACT_INVALID: workflow ${workflow.id} references unknown operation ${step.operationId}`);
    }
  }

  return {
    title: typeof info.title === 'string' ? info.title : 'Untitled API',
    version: typeof info.version === 'string' ? info.version : '0',
    specPath: absolute,
    specHash: sha256(stableStringify(document, 0)),
    document,
    operations,
    workflows,
    warnings,
  };
}
