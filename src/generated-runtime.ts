import { expect, test, type APIRequestContext, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JsonSchema, TestCasePlan, TestPlan, WorkflowPlan } from './types.js';
import { redact } from './utils.js';

export { test };

export function loadGeneratedPlan(metaUrl: string): TestPlan {
  const path = fileURLToPath(new URL('./plan.generated.json', metaUrl));
  return JSON.parse(readFileSync(path, 'utf8')) as TestPlan;
}

function substitute(value: unknown, variables: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, substitute(nested, variables)]));
  }
  if (typeof value !== 'string') return value;
  const exact = value.match(/^\$\{([^}]+)\}$/);
  if (exact) return variables[exact[1]!] ?? value;
  return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => String(variables[key] ?? `\${${key}}`));
}

function authHeaders(): Record<string, string> {
  const mapping = JSON.parse(process.env.GAUNTLET_HEADER_ENV_MAP ?? '{}') as Record<string, string>;
  return Object.fromEntries(Object.entries(mapping).map(([header, envName]) => {
    const value = process.env[envName];
    if (!value) throw new Error(`CREDENTIAL_MISSING: ${envName}`);
    return [header, value];
  }));
}

function renderPath(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    if (!(key in params)) throw new Error(`TEST_DATA_INVALID: missing path parameter ${key}`);
    return encodeURIComponent(String(params[key]));
  });
}

function validateSchema(value: unknown, schema: JsonSchema, pointer = '$'): string[] {
  if (value === null && (schema.nullable || (Array.isArray(schema.type) && schema.type.includes('null')))) return [];
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) return [`${pointer} must equal const`];
  if (schema.enum && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) return [`${pointer} must be one of the declared enum values`];
  if (schema.allOf) return schema.allOf.flatMap((part) => validateSchema(value, part, pointer));
  if (schema.anyOf && !schema.anyOf.some((part) => validateSchema(value, part, pointer).length === 0)) return [`${pointer} must match an anyOf branch`];
  if (schema.oneOf && schema.oneOf.filter((part) => validateSchema(value, part, pointer).length === 0).length !== 1) return [`${pointer} must match exactly one oneOf branch`];
  const type = Array.isArray(schema.type) ? schema.type.find((entry) => entry !== 'null') : schema.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${pointer} must be an object`];
    const record = value as Record<string, unknown>;
    const errors = (schema.required ?? []).filter((key) => !(key in record)).map((key) => `${pointer}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) errors.push(...validateSchema(record[key], child, `${pointer}.${key}`));
    }
    if (schema.additionalProperties === false) {
      errors.push(...Object.keys(record).filter((key) => !(key in (schema.properties ?? {}))).map((key) => `${pointer}.${key} is not allowed`));
    }
    return errors;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [`${pointer} must be an array`];
    const errors: string[] = [];
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${pointer} has fewer than minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${pointer} has more than maxItems`);
    value.forEach((entry, index) => errors.push(...validateSchema(entry, schema.items ?? {}, `${pointer}[${index}]`)));
    return errors;
  }
  if (type === 'string') {
    if (typeof value !== 'string') return [`${pointer} must be a string`];
    const errors: string[] = [];
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${pointer} is shorter than minLength`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${pointer} is longer than maxLength`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${pointer} does not match pattern`);
    if (schema.format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) errors.push(`${pointer} is not an email`);
    return errors;
  }
  if (type === 'integer' && (!Number.isInteger(value))) return [`${pointer} must be an integer`];
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number') return [`${pointer} must be a number`];
    const errors: string[] = [];
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${pointer} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${pointer} is above maximum`);
    return errors;
  }
  if (type === 'boolean' && typeof value !== 'boolean') return [`${pointer} must be a boolean`];
  if (type === 'null' && value !== null) return [`${pointer} must be null`];
  return [];
}

function responseBody(text: string, contentType: string): unknown {
  if (!text) return undefined;
  if (contentType.includes('json')) {
    try { return JSON.parse(text); } catch { throw new Error('RESPONSE_MALFORMED_JSON'); }
  }
  return text;
}

export async function executeGeneratedCase(
  request: APIRequestContext,
  testInfo: TestInfo,
  planned: TestCasePlan,
  variables: Record<string, unknown> = { runId: process.env.GAUNTLET_RUN_ID ?? 'local-run' },
): Promise<unknown> {
  const testCase = substitute(planned, variables) as TestCasePlan;
  const url = renderPath(testCase.path, testCase.pathParams);
  const headers = { ...testCase.headers, ...(testCase.useAuth ? authHeaders() : {}) };
  const requestEvidence = redact({ caseId: testCase.id, operationId: testCase.operationId, method: testCase.method, url, headers, query: testCase.query, body: testCase.rawBody ?? testCase.body });
  let response;
  const started = Date.now();
  try {
    response = await request.fetch(url, {
      method: testCase.method,
      params: testCase.query as Record<string, string | number | boolean>,
      headers,
      ...(testCase.rawBody !== undefined ? { data: Buffer.from(testCase.rawBody, 'utf8') } : testCase.body !== undefined ? { data: testCase.body } : {}),
      failOnStatusCode: false,
      maxRedirects: 0,
    });
  } catch (error) {
    await testInfo.attach(`${testCase.id}-request.json`, { body: Buffer.from(JSON.stringify(requestEvidence, null, 2)), contentType: 'application/json' });
    throw new Error(`TARGET_UNREACHABLE: ${error instanceof Error ? error.message : String(error)}`);
  }
  const maxBytes = Number(process.env.GAUNTLET_MAX_RESPONSE_BYTES ?? 65_536);
  const raw = (await response.text()).slice(0, maxBytes);
  const contentType = response.headers()['content-type'] ?? '';
  const body = responseBody(raw, contentType);
  const responseEvidence = redact({ status: response.status(), headers: response.headers(), durationMs: Date.now() - started, body });
  await testInfo.attach(`${testCase.id}-exchange.json`, {
    body: Buffer.from(JSON.stringify({ request: requestEvidence, response: responseEvidence }, null, 2)),
    contentType: 'application/json',
  });
  expect(testCase.expected.statuses, `status for ${testCase.id}: expected one of [${testCase.expected.statuses.join(", ")}], actual ${response.status()}`).toContain(response.status());
  if (testCase.expected.contentType) expect(contentType, `content-type for ${testCase.id}`).toContain(testCase.expected.contentType.split(';')[0]!);
  if (testCase.expected.schema) {
    expect(validateSchema(body, testCase.expected.schema), `response schema for ${testCase.id}`).toEqual([]);
  }
  for (const assertion of testCase.assertions ?? []) {
    const actual = assertion.path === '$' ? body : readCapture(body, assertion.path);
    const label = `scenario assertion ${assertion.path} for ${testCase.id}`;
    expect(actual, `${label} must exist`).not.toBeUndefined();
    switch (assertion.operator) {
      case 'equals': expect(actual, label).toEqual(assertion.value); break;
      case 'not-equals': expect(actual, label).not.toEqual(assertion.value); break;
      case 'length-equals': expect(actual, label).toHaveLength(assertion.value as number); break;
      case 'contains': expect(actual, label).toContain(assertion.value); break;
      case 'gte': expect(actual, label).toBeGreaterThanOrEqual(assertion.value as number); break;
      case 'lte': expect(actual, label).toBeLessThanOrEqual(assertion.value as number); break;
      default: throw new Error('ASSERTION_OPERATOR_UNSUPPORTED');
    }
  }
  if (testCase.kind === 'positive'  && testCase.body && body && typeof testCase.body === 'object' && typeof body === 'object') {
    const sent = testCase.body as Record<string, unknown>;
    const received = body as Record<string, unknown>;
    for (const key of Object.keys(sent).filter((candidate) => candidate in received)) {
      expect(received[key], `round-trip invariant ${key} for ${testCase.id}`).toEqual(sent[key]);
    }
  }
  return body;
}

function readCapture(body: unknown, expression: string): unknown {
  if (!expression.startsWith('$.')) throw new Error(`CAPTURE_UNSUPPORTED: ${expression}`);
  return expression.slice(2).split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, body);
}

export async function executeGeneratedWorkflow(request: APIRequestContext, testInfo: TestInfo, workflow: WorkflowPlan): Promise<void> {
  const variables: Record<string, unknown> = { runId: process.env.GAUNTLET_RUN_ID ?? 'local-run' };
  for (const step of workflow.steps) {
    const body = await executeGeneratedCase(request, testInfo, step, variables);
    for (const [name, expression] of Object.entries(step.capture)) {
      const captured = readCapture(body, expression);
      if (captured === undefined) throw new Error(`CAPTURE_MISSING: ${name} from ${expression}`);
      variables[name] = captured;
    }
  }
}
