import http from 'node:http';
import { URL } from 'node:url';

const HOST = '127.0.0.1';
const PORT = Number(process.env.TRAINING_API_PORT ?? 4020);
const API_KEY = process.env.TRAINING_API_KEY ?? 'training-local-key';

let nextItemNumber = 2;
const items = new Map([
  ['itm_0001', { id: 'itm_0001', name: 'Starter Widget', sku: 'starter-001', stock: 10 }],
]);

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function sendError(response, status, code, message) {
  sendJson(response, status, { error: { code, message } });
}

function authorized(request, response) {
  if (request.headers['x-api-key'] === API_KEY) return true;
  sendError(response, 401, 'UNAUTHORIZED', 'A valid x-api-key header is required');
  return false;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function validateItem(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (keys.some((key) => !['name', 'sku', 'stock'].includes(key))) return false;
  if (typeof body.name !== 'string' || body.name.length < 2 || body.name.length > 60) return false;
  if (typeof body.sku !== 'string' || !/^[a-z0-9-]{3,48}$/.test(body.sku)) return false;
  return body.stock === undefined || (Number.isInteger(body.stock) && body.stock >= 0 && body.stock <= 999);
}

function itemId(pathname) {
  const match = /^\/items\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

async function handle(request, response) {
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    const body = process.env.TRAINING_API_DEFECT === 'health-schema' ? { state: 'ok' } : { status: 'ok' };
    sendJson(response, 200, body);
    return;
  }

  if (url.pathname === '/items' || url.pathname.startsWith('/items/')) {
    if (!authorized(request, response)) return;
  }

  if (request.method === 'GET' && url.pathname === '/items') {
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      sendError(response, 400, 'INVALID_QUERY', 'limit must be an integer between 1 and 50');
      return;
    }
    const data = [...items.values()].sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit);
    sendJson(response, 200, { data, total: items.size, limit });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/items') {
    const body = await readJson(request);
    if (!validateItem(body)) {
      sendError(response, 422, 'VALIDATION_ERROR', 'The request body is invalid');
      return;
    }
    if ([...items.values()].some((item) => item.sku === body.sku)) {
      sendError(response, 409, 'SKU_CONFLICT', 'An item with that SKU already exists');
      return;
    }
    const id = `itm_${String(nextItemNumber).padStart(4, '0')}`;
    nextItemNumber += 1;
    const item = { id, name: body.name, sku: body.sku, stock: body.stock ?? 10 };
    items.set(id, item);
    sendJson(response, 201, item);
    return;
  }

  const id = itemId(url.pathname);
  if (request.method === 'GET' && id !== undefined) {
    const item = items.get(id);
    if (!item) {
      sendError(response, 404, 'ITEM_NOT_FOUND', `No item exists with id ${id}`);
      return;
    }
    sendJson(response, 200, item);
    return;
  }

  if (request.method === 'DELETE' && id !== undefined) {
    if (!items.has(id)) {
      sendError(response, 404, 'ITEM_NOT_FOUND', `No item exists with id ${id}`);
      return;
    }
    items.delete(id);
    response.writeHead(204, { 'cache-control': 'no-store' });
    response.end();
    return;
  }

  sendError(response, 404, 'NOT_FOUND', 'No route matches this request');
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) sendError(response, 500, 'INTERNAL_ERROR', 'Unexpected training API failure');
    else response.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Training inventory API listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
