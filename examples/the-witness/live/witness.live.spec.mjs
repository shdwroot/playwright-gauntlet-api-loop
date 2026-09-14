import { expect, request, test } from '@playwright/test';

import { isUsableLookupStatus } from './lookup-status.mjs';

const baseURL = process.env.WITNESS_BASE_URL ?? 'https://the-witness-api.onrender.com';
const mode = process.env.WITNESS_LIVE_MODE ?? 'safe';
const email = process.env.WITNESS_E2E_EMAIL;
const password = process.env.WITNESS_E2E_PASSWORD;
const displayName = process.env.WITNESS_E2E_DISPLAY_NAME ?? 'Gauntlet Operator';
const allowSignup = process.env.WITNESS_E2E_SIGNUP === 'true';
const expectedConfirmation = mode === 'full'
  ? 'I_AUTHORIZE_FULL_EXTERNAL_ACTIONS'
  : 'I_AUTHORIZE_DISPOSABLE_RECORDS';

let anonymousApi;
let api;
let caseId;
let lookupId;

function requireEnvironment() {
  if (!['safe', 'full'].includes(mode)) {
    throw new Error('WITNESS_LIVE_MODE must be safe or full.');
  }
  if (process.env.WITNESS_LIVE_CONFIRM !== expectedConfirmation) {
    throw new Error(`Set WITNESS_LIVE_CONFIRM=${expectedConfirmation} to run ${mode} mode.`);
  }
  if (!email || !password) {
    throw new Error('WITNESS_E2E_EMAIL and WITNESS_E2E_PASSWORD are required.');
  }
  if (password.length < 12) {
    throw new Error('WITNESS_E2E_PASSWORD must be at least 12 characters.');
  }
  if (mode === 'full' && (!process.env.WITNESS_E2E_LOOKUP_TYPE || !process.env.WITNESS_E2E_LOOKUP_VALUE)) {
    throw new Error('Full mode requires an authorized WITNESS_E2E_LOOKUP_TYPE and WITNESS_E2E_LOOKUP_VALUE.');
  }
}

async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${response.url()} returned non-JSON (${response.status()}): ${text.slice(0, 300)}`);
  }
}

async function authenticate() {
  let response;
  if (allowSignup) {
    response = await anonymousApi.post('/v1/auth/signup', {
      data: { email, password, displayName },
    });
    if (response.status() === 409) {
      response = await anonymousApi.post('/v1/auth/login', { data: { email, password } });
    }
  } else {
    response = await anonymousApi.post('/v1/auth/login', { data: { email, password } });
  }

  const body = await json(response);
  expect(response.ok(), `Authentication failed (${response.status()}): ${JSON.stringify(body)}`).toBeTruthy();
  expect(body.token).toEqual(expect.any(String));
  return body.token;
}

async function waitForLookup() {
  let latest;
  await expect.poll(async () => {
    const response = await api.get(`/v1/lookups/${lookupId}`);
    expect(response.ok()).toBeTruthy();
    latest = await json(response);
    return latest.status;
  }, {
    message: 'lookup to reach a terminal state',
    timeout: Number(process.env.WITNESS_E2E_LOOKUP_TIMEOUT_MS ?? 180_000),
    intervals: [1_000, 2_000, 5_000, 10_000],
  }).toMatch(/^(complete|partial|failed|blocked)$/);

  expect(
    isUsableLookupStatus(latest.status),
    `Lookup ended in ${latest.status}; inspect the retained trace and Render worker logs.`,
  ).toBeTruthy();
  return latest;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  requireEnvironment();
  anonymousApi = await request.newContext({ baseURL });
  const token = await authenticate();
  api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
});

test.afterAll(async () => {
  if (api) {
    await api.post('/v1/auth/logout').catch(() => undefined);
    await api.dispose();
  }
  await anonymousApi?.dispose();
});

test('public health and dependency readiness are live', async () => {
  const health = await anonymousApi.get('/health');
  expect(health.status()).toBe(200);
  await expect(health.json()).resolves.toMatchObject({ status: 'ok', service: 'api' });

  const ready = await anonymousApi.get('/ready');
  expect(ready.status()).toBe(200);
  await expect(ready.json()).resolves.toMatchObject({
    status: 'ok',
    checks: { database: 'up', redis: 'up' },
  });
});

test('OAuth provider availability is readable without starting OAuth', async () => {
  const response = await anonymousApi.get('/v1/auth/oauth/providers');
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    google: expect.any(Boolean),
    github: expect.any(Boolean),
  });
});

test('session is private and the authenticated account is usable', async () => {
  const denied = await anonymousApi.get('/v1/auth/session');
  expect(denied.status()).toBe(401);

  const response = await api.get('/v1/auth/session');
  expect(response.status()).toBe(200);
  const body = await json(response);
  expect(body.user.email.toLowerCase()).toBe(email.toLowerCase());
});

test('create, update, read, and list a disposable case', async () => {
  const suffix = new Date().toISOString();
  const created = await api.post('/v1/cases', {
    data: { title: `Gauntlet live ${mode} ${suffix}`, purpose: 'self_check' },
  });
  expect(created.status()).toBe(201);
  const createdBody = await json(created);
  caseId = createdBody.id;
  expect(caseId).toMatch(/^[0-9a-f-]{36}$/i);

  const updated = await api.patch(`/v1/cases/${caseId}`, {
    data: { title: `Gauntlet verified ${suffix}` },
  });
  expect(updated.status()).toBe(200);

  const detail = await api.get(`/v1/cases/${caseId}`);
  expect(detail.status()).toBe(200);
  await expect(detail.json()).resolves.toMatchObject({ id: caseId, status: 'open' });

  const list = await api.get('/v1/cases');
  expect(list.status()).toBe(200);
  const listBody = await json(list);
  expect(listBody.items.some((item) => item.id === caseId)).toBeTruthy();
});

test('full mode completes an authorized external lookup', async () => {
  test.skip(mode !== 'full', 'Safe mode deliberately skips lookup providers.');

  const queued = await api.post('/v1/lookups', {
    data: {
      type: process.env.WITNESS_E2E_LOOKUP_TYPE,
      value: process.env.WITNESS_E2E_LOOKUP_VALUE,
      purpose: process.env.WITNESS_E2E_LOOKUP_PURPOSE ?? 'self_check',
      authorizationConfirmed: true,
    },
  });
  expect(queued.status()).toBe(202);
  const queuedBody = await json(queued);
  lookupId = queuedBody.id;
  expect(queuedBody).toMatchObject({ status: 'queued', stage: 'observe' });

  const report = await waitForLookup();
  expect(report.evidence).toEqual(expect.any(Array));
});

test('full mode attaches, analyses, and emails real reports', async () => {
  test.skip(mode !== 'full', 'Safe mode deliberately skips analysis and email.');
  expect(caseId).toBeTruthy();
  expect(lookupId).toBeTruthy();

  const attached = await api.post(`/v1/cases/${caseId}/lookups/${lookupId}`);
  expect(attached.status()).toBe(200);
  await expect(attached.json()).resolves.toMatchObject({ attached: true, caseId, lookupId });

  const before = await api.get(`/v1/cases/${caseId}`);
  const beforeBody = await json(before);
  const previousVersions = beforeBody.reportHistory?.length ?? 0;

  const queued = await api.post(`/v1/cases/${caseId}/analyse`);
  expect(queued.status()).toBe(202);

  await expect.poll(async () => {
    const response = await api.get(`/v1/cases/${caseId}`);
    expect(response.ok()).toBeTruthy();
    const body = await json(response);
    return body.reportHistory?.length ?? 0;
  }, {
    message: 'case analysis to create a new report version',
    timeout: Number(process.env.WITNESS_E2E_ANALYSIS_TIMEOUT_MS ?? 180_000),
    intervals: [1_000, 2_000, 5_000, 10_000],
  }).toBeGreaterThan(previousVersions);

  const lookupEmail = await api.post(`/v1/lookups/${lookupId}/email`);
  expect(lookupEmail.status()).toBe(200);
  await expect(lookupEmail.json()).resolves.toMatchObject({ delivered: true });

  const caseEmail = await api.post(`/v1/cases/${caseId}/email`);
  expect(caseEmail.status()).toBe(200);
  await expect(caseEmail.json()).resolves.toMatchObject({ delivered: true });
});

test('archive the disposable case', async () => {
  expect(caseId).toBeTruthy();
  const response = await api.patch(`/v1/cases/${caseId}`, { data: { status: 'archived' } });
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ id: caseId, status: 'archived' });
});
