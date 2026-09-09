import http from "node:http";
import { URL } from "node:url";

const DEFAULT_PORT = 4010;
const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 1_048_576;
const API_KEY = process.env.SAMPLE_API_KEY ?? "gauntlet-local-key";

function readPort(value) {
  if (value === undefined || value === "") return DEFAULT_PORT;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("FIXTURE_PORT must be an integer between 1 and 65535");
  }
  return port;
}

const PORT = readPort(process.env.FIXTURE_PORT);

let nextUserNumber;
let users;

function userId(number) {
  return `usr_${String(number).padStart(4, "0")}`;
}

function createdAt(number) {
  return new Date(Date.UTC(2024, 0, 1, 0, 0, number)).toISOString();
}

function resetUsers() {
  nextUserNumber = 2;
  users = new Map([
    [
      "usr_0001",
      {
        id: "usr_0001",
        name: "Ada Lovelace",
        email: "ada@example.test",
        age: 36,
        role: "admin",
        createdAt: createdAt(1),
      },
    ],
  ]);
}

resetUsers();

function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(payload);
}

function sendEmpty(response, status) {
  response.writeHead(status, { "cache-control": "no-store" });
  response.end();
}

function sendError(response, status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  sendJson(response, status, { error });
}

function isAuthorized(request) {
  return request.headers["x-api-key"] === API_KEY;
}

function requireAuthorization(request, response) {
  if (isAuthorized(request)) return true;

  sendError(response, 401, "UNAUTHORIZED", "A valid x-api-key header is required");
  return false;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text === "" ? undefined : JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON"), { status: 400 }));
      }
    });

    request.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function validateNewUser(value) {
  const issues = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["body must be a JSON object"];
  }

  const allowedFields = new Set(["name", "email", "age", "role"]);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) issues.push(`${field} is not allowed`);
  }

  if (typeof value.name !== "string" || value.name.trim().length < 2 || value.name.trim().length > 50) {
    issues.push("name must contain between 2 and 50 non-whitespace characters");
  }

  const email = typeof value.email === "string" ? value.email.trim() : "";
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    issues.push("email must be a valid address between 3 and 254 characters");
  }

  if (value.age !== undefined && (!Number.isInteger(value.age) || value.age < 18 || value.age > 120)) {
    issues.push("age must be an integer between 18 and 120");
  }

  if (value.role !== undefined && value.role !== "user" && value.role !== "admin") {
    issues.push("role must be either user or admin");
  }

  return issues;
}

function parseBoundedInteger(value, name, minimum, maximum, fallback) {
  if (value === null) return { value: fallback };
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    return { error: `${name} must be an integer between ${minimum} and ${maximum}` };
  }

  const number = Number(value);
  if (number < minimum || number > maximum) {
    return { error: `${name} must be an integer between ${minimum} and ${maximum}` };
  }
  return { value: number };
}

async function handleCreateUser(request, response) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    sendError(response, 415, "UNSUPPORTED_MEDIA_TYPE", "content-type must be application/json");
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    const status = error.status === 413 ? 413 : 400;
    sendError(
      response,
      status,
      status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_JSON",
      error.message,
    );
    return;
  }

  const issues = validateNewUser(body);
  if (issues.length > 0) {
    sendError(response, 422, "VALIDATION_ERROR", "The request body is invalid", issues);
    return;
  }

  const normalizedEmail = body.email.trim().toLowerCase();
  if ([...users.values()].some((user) => user.email.toLowerCase() === normalizedEmail)) {
    sendError(response, 409, "EMAIL_CONFLICT", "A user with that email already exists");
    return;
  }

  const number = nextUserNumber;
  nextUserNumber += 1;
  const id = userId(number);
  const user = {
    id,
    name: body.name.trim(),
    email: normalizedEmail,
    age: body.age,
    role: body.role ?? "user",
    createdAt: createdAt(number),
  };
  if (user.age === undefined) delete user.age;
  users.set(id, user);

  sendJson(response, 201, user, { location: `/users/${id}` });
}

function handleListUsers(url, response) {
  const unknownParameters = [...url.searchParams.keys()].filter(
    (name) => name !== "limit" && name !== "offset",
  );
  if (unknownParameters.length > 0) {
    sendError(
      response,
      400,
      "INVALID_QUERY",
      `Unsupported query parameter: ${unknownParameters[0]}`,
    );
    return;
  }

  const limit = parseBoundedInteger(url.searchParams.get("limit"), "limit", 1, 100, 20);
  const offset = parseBoundedInteger(url.searchParams.get("offset"), "offset", 0, 10_000, 0);
  if (limit.error || offset.error) {
    sendError(response, 400, "INVALID_QUERY", limit.error ?? offset.error);
    return;
  }

  const allUsers = [...users.values()].sort((left, right) => left.id.localeCompare(right.id));
  sendJson(response, 200, {
    data: allUsers.slice(offset.value, offset.value + limit.value),
    total: allUsers.length,
    limit: limit.value,
    offset: offset.value,
  });
}

function extractUserId(pathname) {
  const match = /^\/users\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: process.env.FIXTURE_DEFECT === "health-schema" ? "degraded" : "ok" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__reset") {
    if (request.headers["x-gauntlet-reset"] !== "allowed") {
      sendError(response, 403, "RESET_FORBIDDEN", "x-gauntlet-reset: allowed is required");
      return;
    }
    resetUsers();
    sendJson(response, 200, { reset: true, userCount: users.size });
    return;
  }

  if (url.pathname === "/users" || url.pathname.startsWith("/users/")) {
    if (!requireAuthorization(request, response)) return;
  }

  if (request.method === "GET" && url.pathname === "/users") {
    handleListUsers(url, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/users") {
    await handleCreateUser(request, response);
    return;
  }

  const id = extractUserId(url.pathname);
  if (id !== undefined && request.method === "GET") {
    const user = users.get(id);
    if (!user) {
      sendError(response, 404, "USER_NOT_FOUND", `No user exists with id ${id}`);
      return;
    }
    sendJson(response, 200, user);
    return;
  }

  if (id !== undefined && request.method === "DELETE") {
    if (!users.has(id)) {
      sendError(response, 404, "USER_NOT_FOUND", `No user exists with id ${id}`);
      return;
    }
    users.delete(id);
    sendEmpty(response, 204);
    return;
  }

  sendError(response, 404, "NOT_FOUND", "No route matches this request");
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) {
      sendError(response, 500, "INTERNAL_ERROR", "An unexpected error occurred");
    } else {
      response.destroy();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Sample API fixture listening on http://${HOST}:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
