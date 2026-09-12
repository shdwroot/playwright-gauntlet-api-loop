import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 4030;
const TOKEN = 'witness-local-token';
const AUTHORIZATION = `Bearer ${TOKEN}`;
const NOW = '2030-01-02T03:04:05.000Z';
const EXPIRES_AT = '2030-01-03T03:04:05.000Z';
const PURPOSES = new Set(['self_check', 'dating_safety', 'marketplace_safety', 'subject_authorized', 'professional_investigation']);
const LOOKUP_TYPES = new Set(['phone', 'email', 'username', 'image', 'vin', 'domain', 'ip', 'business']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const MAX_BODY_BYTES = 1_048_576;

let sessionActive = true;
const users = new Map([
  ['existing@example.test', {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'existing@example.test',
    displayName: 'Existing Witness',
    createdAt: NOW,
    password: 'correct-horse-battery-staple',
  }],
]);
const lookups = new Map();
const cases = new Map();

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(payload);
}

function sendEmpty(response, status) {
  response.writeHead(status, { 'cache-control': 'no-store' });
  response.end();
}

function sendError(response, status, error, message) {
  sendJson(response, status, { error, message });
}

function isAuthorized(request) {
  return sessionActive && request.headers.authorization === AUTHORIZATION;
}

function requireAuth(request, response) {
  if (isAuthorized(request)) return true;
  sendError(response, 401, 'invalid_authentication', 'Sign in to continue.');
  return false;
}

async function readJson(request) {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('content-type must be application/json'), { status: 415 });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error('request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { status: 400 });
  }
}

function exactObject(value, allowed) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function authUser(user = users.get('existing@example.test')) {
  const { password: _password, ...publicUser } = user;
  return publicUser;
}

function authToken(user) {
  return { user: authUser(user), expiresAt: EXPIRES_AT, token: TOKEN };
}

function validSignup(body) {
  return exactObject(body, new Set(['email', 'password', 'displayName', 'previewSession']))
    && typeof body.email === 'string' && body.email.length >= 3 && body.email.length <= 254 && EMAIL.test(body.email)
    && typeof body.password === 'string' && body.password.length >= 12 && body.password.length <= 128
    && typeof body.displayName === 'string' && body.displayName.trim().length >= 2 && body.displayName.trim().length <= 80
    && (body.previewSession === undefined || UUID.test(body.previewSession));
}

function validLogin(body) {
  return exactObject(body, new Set(['email', 'password', 'previewSession']))
    && typeof body.email === 'string' && EMAIL.test(body.email)
    && typeof body.password === 'string' && body.password.length >= 1 && body.password.length <= 128
    && (body.previewSession === undefined || UUID.test(body.previewSession));
}

function validLookup(body) {
  return exactObject(body, new Set(['type', 'value', 'purpose', 'authorizationConfirmed', 'caseId']))
    && LOOKUP_TYPES.has(body.type)
    && typeof body.value === 'string' && body.value.trim().length >= 2 && body.value.trim().length <= 2_048
    && PURPOSES.has(body.purpose)
    && body.authorizationConfirmed === true
    && (body.caseId === undefined || UUID.test(body.caseId));
}

function validCreateCase(body) {
  return exactObject(body, new Set(['title', 'purpose']))
    && typeof body.title === 'string' && body.title.trim().length >= 3 && body.title.trim().length <= 120
    && (body.purpose === undefined || PURPOSES.has(body.purpose));
}

function validUpdateCase(body) {
  return exactObject(body, new Set(['title', 'status']))
    && (body.title !== undefined || body.status !== undefined)
    && (body.title === undefined || (typeof body.title === 'string' && body.title.trim().length >= 3 && body.title.trim().length <= 120))
    && (body.status === undefined || body.status === 'open' || body.status === 'archived');
}

function lookupListItem(lookup) {
  return {
    id: lookup.id,
    caseId: lookup.caseId ?? null,
    type: lookup.type,
    maskedQuery: lookup.maskedQuery,
    purpose: lookup.purpose,
    status: 'complete',
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    report: null,
  };
}

function caseSummary(item) {
  const lookupCount = [...lookups.values()].filter((lookup) => lookup.caseId === item.id).length;
  return {
    id: item.id,
    referenceId: `CASE-${item.id.slice(0, 8).toUpperCase()}`,
    title: item.title,
    purpose: item.purpose,
    status: item.status,
    lookupCount,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastLookupAt: lookupCount > 0 ? NOW : null,
  };
}

function match(pathname, pattern) {
  const names = [];
  const source = pattern.replace(/:[A-Za-z][A-Za-z0-9]*/g, (token) => {
    names.push(token.slice(1));
    return '([^/]+)';
  });
  const matched = new RegExp(`^${source}$`, 'u').exec(pathname);
  if (!matched) return undefined;
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(matched[index + 1])]));
}

async function bodyOrError(request, response) {
  try {
    return await readJson(request);
  } catch (error) {
    sendError(response, error.status ?? 400, 'invalid_request', error.message);
    return undefined;
  }
}

async function handle(request, response) {
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { status: 'ok', service: 'api', version: 'contract-lab', timestamp: NOW });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/ready') {
    sendJson(response, 200, { status: 'ok', service: 'api', version: 'contract-lab', timestamp: NOW, checks: { database: 'up', redis: 'up' } });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/auth/signup') {
    const body = await bodyOrError(request, response);
    if (body === undefined) return;
    if (!validSignup(body)) {
      sendError(response, 400, 'invalid_signup', 'Check the account details and try again.');
      return;
    }
    const email = body.email.trim().toLowerCase();
    if (users.has(email)) {
      sendError(response, 409, 'account_exists', 'An account already exists for this email. Sign in instead.');
      return;
    }
    const user = { id: randomUUID(), email, displayName: body.displayName.trim(), createdAt: NOW, password: body.password };
    users.set(email, user);
    sendJson(response, 201, authToken(user));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/auth/login') {
    const body = await bodyOrError(request, response);
    if (body === undefined) return;
    if (!validLogin(body)) {
      sendError(response, 400, 'invalid_login', 'The login request is invalid.');
      return;
    }
    const user = users.get(body.email.toLowerCase());
    if (!user || user.password !== body.password) {
      sendError(response, 401, 'invalid_authentication', 'Email or password is incorrect.');
      return;
    }
    sessionActive = true;
    sendJson(response, 200, authToken(user));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/auth/session') {
    if (!requireAuth(request, response)) return;
    sendJson(response, 200, { user: authUser(), expiresAt: EXPIRES_AT });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/auth/logout') {
    if (!requireAuth(request, response)) return;
    sessionActive = false;
    sendEmpty(response, 204);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/auth/oauth/providers') {
    sendJson(response, 200, { google: false, github: false });
    return;
  }
  const oauthStart = match(url.pathname, '/v1/auth/oauth/:provider/start');
  if (request.method === 'POST' && oauthStart) {
    const body = await bodyOrError(request, response);
    if (body === undefined) return;
    if (!['google', 'github'].includes(oauthStart.provider) || !exactObject(body, new Set(['intent', 'previewSession', 'nextPath', 'lookupId']))) {
      sendError(response, 400, 'invalid_oauth_request', 'The sign-in request is invalid.');
      return;
    }
    sendJson(response, 200, { provider: oauthStart.provider, authorizationUrl: `https://provider.invalid/${oauthStart.provider}/authorize` });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/lookups') {
    const body = await bodyOrError(request, response);
    if (body === undefined) return;
    if (!validLookup(body)) {
      sendError(response, 400, 'invalid_lookup', 'The lookup request is invalid.');
      return;
    }
    if (body.caseId && !isAuthorized(request)) {
      sendError(response, 401, 'authentication_required', 'Sign in before filing an observation in a case.');
      return;
    }
    if (body.caseId && !cases.has(body.caseId)) {
      sendError(response, 404, 'case_not_found', 'The selected open case could not be found.');
      return;
    }
    const id = randomUUID();
    lookups.set(id, { id, type: body.type, maskedQuery: '***synthetic***', purpose: body.purpose, caseId: body.caseId ?? null });
    sendJson(response, 202, { id, status: 'queued', stage: 'observe' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/lookups') {
    if (!requireAuth(request, response)) return;
    const parsedLimit = Number.parseInt(url.searchParams.get('limit') ?? '8', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 25) : 8;
    sendJson(response, 200, { items: [...lookups.values()].slice(0, limit).map(lookupListItem) });
    return;
  }
  const lookupEmail = match(url.pathname, '/v1/lookups/:lookupId/email');
  if (request.method === 'POST' && lookupEmail) {
    if (!requireAuth(request, response)) return;
    if (!UUID.test(lookupEmail.lookupId)) {
      sendError(response, 400, 'invalid_lookup_id', 'The lookup identifier is invalid.');
      return;
    }
    if (!lookups.has(lookupEmail.lookupId)) {
      sendError(response, 404, 'lookup_not_found', 'The lookup could not be found.');
      return;
    }
    sendJson(response, 200, { delivered: true, recipient: 'existing@example.test' });
    return;
  }
  const lookupRead = match(url.pathname, '/v1/lookups/:lookupId');
  if (request.method === 'GET' && lookupRead) {
    if (!requireAuth(request, response)) return;
    if (!UUID.test(lookupRead.lookupId)) {
      sendError(response, 400, 'invalid_lookup_id', 'The lookup identifier is invalid.');
      return;
    }
    const lookup = lookups.get(lookupRead.lookupId);
    if (!lookup) {
      sendError(response, 404, 'lookup_not_found', 'The lookup could not be found.');
      return;
    }
    sendJson(response, 200, { ...lookupListItem(lookup), evidence: [] });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/cases') {
    if (!requireAuth(request, response)) return;
    sendJson(response, 200, { items: [...cases.values()].map(caseSummary) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/cases') {
    if (!requireAuth(request, response)) return;
    const body = await bodyOrError(request, response);
    if (body === undefined) return;
    if (!validCreateCase(body)) {
      sendError(response, 400, 'invalid_case', 'The case details are invalid.');
      return;
    }
    const id = randomUUID();
    const item = { id, title: body.title.trim(), purpose: body.purpose ?? 'professional_investigation', status: 'open', createdAt: NOW, updatedAt: NOW };
    cases.set(id, item);
    sendJson(response, 201, caseSummary(item));
    return;
  }
  const caseEmail = match(url.pathname, '/v1/cases/:caseId/email');
  if (request.method === 'POST' && caseEmail) {
    if (!requireAuth(request, response)) return;
    if (!UUID.test(caseEmail.caseId)) {
      sendError(response, 400, 'invalid_case_id', 'The case identifier is invalid.');
      return;
    }
    if (!cases.has(caseEmail.caseId)) {
      sendError(response, 404, 'case_not_found', 'The case could not be found.');
      return;
    }
    sendJson(response, 200, { delivered: true, recipient: 'existing@example.test', version: 1 });
    return;
  }
  const caseAttach = match(url.pathname, '/v1/cases/:caseId/lookups/:lookupId');
  if (request.method === 'POST' && caseAttach) {
    if (!requireAuth(request, response)) return;
    if (!UUID.test(caseAttach.caseId) || !UUID.test(caseAttach.lookupId)) {
      sendError(response, 400, 'invalid_case_link', 'The case or lookup identifier is invalid.');
      return;
    }
    const lookup = lookups.get(caseAttach.lookupId);
    if (!cases.has(caseAttach.caseId) || !lookup || lookup.caseId) {
      sendError(response, 409, 'case_link_not_available', 'The report could not be attached.');
      return;
    }
    lookup.caseId = caseAttach.caseId;
    sendJson(response, 200, { attached: true, analysisQueued: true, caseId: caseAttach.caseId, lookupId: caseAttach.lookupId });
    return;
  }
  const caseAnalyse = match(url.pathname, '/v1/cases/:caseId/analyse');
  if (request.method === 'POST' && caseAnalyse) {
    if (!requireAuth(request, response)) return;
    if (!UUID.test(caseAnalyse.caseId)) {
      sendError(response, 400, 'invalid_case_id', 'The case identifier is invalid.');
      return;
    }
    if (!cases.has(caseAnalyse.caseId)) {
      sendError(response, 404, 'case_not_found', 'The case could not be found.');
      return;
    }
    sendJson(response, 202, { caseId: caseAnalyse.caseId, status: 'queued' });
    return;
  }
  const caseItem = match(url.pathname, '/v1/cases/:caseId');
  if (caseItem && request.method === 'GET') {
    if (!requireAuth(request, response)) return;
    if (!UUID.test(caseItem.caseId)) {
      sendError(response, 400, 'invalid_case_id', 'The case identifier is invalid.');
      return;
    }
    const item = cases.get(caseItem.caseId);
    if (!item) {
      sendError(response, 404, 'case_not_found', 'The case could not be found.');
      return;
    }
    const caseLookups = [...lookups.values()].filter((lookup) => lookup.caseId === item.id).map(lookupListItem);
    sendJson(response, 200, { ...caseSummary(item), lookups: caseLookups, latestReport: null, reportHistory: [] });
    return;
  }
  if (caseItem && request.method === 'PATCH') {
    if (!requireAuth(request, response)) return;
    const body = await bodyOrError(request, response);
    if (body === undefined) return;
    if (!UUID.test(caseItem.caseId) || !validUpdateCase(body)) {
      sendError(response, 400, 'invalid_case_update', 'The case update is invalid.');
      return;
    }
    const item = cases.get(caseItem.caseId);
    if (!item) {
      sendError(response, 404, 'case_not_found', 'The case could not be found.');
      return;
    }
    if (body.title !== undefined) item.title = body.title.trim();
    if (body.status !== undefined) item.status = body.status;
    item.updatedAt = NOW;
    sendJson(response, 200, caseSummary(item));
    return;
  }

  sendError(response, 404, 'route_not_found', 'No synthetic Witness route matched the request.');
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    sendError(response, 500, 'fixture_error', error instanceof Error ? error.message : String(error));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Witness contract lab listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
