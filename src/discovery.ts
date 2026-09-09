import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  DiscoveryCandidate,
  DiscoveryEvidence,
  DiscoveryReport,
  DiscoverySourceConfig,
  DiscoverySourceSnapshot,
  DiscoverySignal,
  GauntletConfig,
  HttpMethod,
  NormalizedContract,
  NormalizedOperation,
} from './types.js';
import { ensureWithin, sha256, stableStringify } from './utils.js';

const PARSER_VERSION = 'discovery-v1';
const METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const IGNORED_DIRECTORIES = new Set(['.git', '.gauntlet', 'node_modules']);

interface SourceFile {
  config: DiscoverySourceConfig;
  absolutePath: string;
  relativePath: string;
}

interface ExtractedSignal {
  method?: HttpMethod;
  observedPath?: string;
  observedStatus?: number;
  signal: DiscoverySignal;
  confidence: number;
  evidence: DiscoveryEvidence;
}

function redactText(input: string): { text: string; count: number } {
  let count = 0;
  const replace = (pattern: RegExp, replacer: string | ((...args: string[]) => string)): void => {
    input = input.replace(pattern, (...args) => {
      count += 1;
      return typeof replacer === 'string' ? replacer : replacer(...(args as string[]));
    });
  };
  replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]');
  replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [REDACTED_TOKEN]');
  replace(/\b(authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*([^\s,;]+)/gi, (_all, key) => `${key}=[REDACTED]`);
  replace(/\b(api[_-]?key|client[_-]?secret|password|token)\s*[:=]\s*["']?([^\s,"'}]+)/gi, (_all, key) => `${key}=[REDACTED]`);
  replace(/([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&#\s]+/gi, (_all, prefix) => `${prefix}[REDACTED]`);
  replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');
  replace(/\b(?:usr|customer|cust)[_-][A-Za-z0-9_-]{3,}\b/gi, '[REDACTED_ID]');
  return { text: input, count };
}

function sourceKind(configured: DiscoverySourceConfig, extension: string): 'log' | 'document' {
  if (configured.kind !== 'auto') return configured.kind;
  return ['.md', '.txt'].includes(extension) ? 'document' : 'log';
}

async function enumerate(config: GauntletConfig): Promise<SourceFile[]> {
  const discovered: SourceFile[] = [];
  const seen = new Set<string>();
  const canonicalRoot = await realpath(config.projectRoot);
  const walk = async (configured: DiscoverySourceConfig, candidate: string, depth: number): Promise<void> => {
    if (depth > 20) throw new Error(`DISCOVERY_DEPTH_LIMIT: ${configured.id}`);
    let metadata;
    try { metadata = await lstat(candidate); } catch { throw new Error(`DISCOVERY_SOURCE_MISSING: ${configured.id}: ${candidate}`); }
    if (metadata.isSymbolicLink()) throw new Error(`DISCOVERY_SYMLINK_REJECTED: ${configured.id}: ${candidate}`);
    const canonical = await realpath(candidate);
    ensureWithin(canonicalRoot, canonical);
    if (metadata.isDirectory()) {
      const entries = (await readdir(candidate, { withFileTypes: true }))
        .filter((entry) => !IGNORED_DIRECTORIES.has(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) await walk(configured, path.join(candidate, entry.name), depth + 1);
      return;
    }
    if (!metadata.isFile()) throw new Error(`DISCOVERY_NON_REGULAR_FILE: ${configured.id}: ${candidate}`);
    const extension = path.extname(candidate).toLowerCase();
    if (!config.discovery.allowedExtensions.includes(extension)) throw new Error(`DISCOVERY_EXTENSION_REJECTED: ${configured.id}: ${extension || '(none)'}`);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    discovered.push({ config: configured, absolutePath: canonical, relativePath: path.relative(canonicalRoot, canonical).replaceAll(path.sep, '/') });
  };
  for (const configured of [...config.discovery.sources].sort((a, b) => a.id.localeCompare(b.id))) {
    await walk(configured, configured.path, 0);
  }
  discovered.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  if (discovered.length > config.discovery.maxFiles) throw new Error(`DISCOVERY_FILE_LIMIT: found ${discovered.length}, limit ${config.discovery.maxFiles}`);
  if (discovered.length === 0 && config.discovery.required) throw new Error('NO_DISCOVERY_SOURCES_MATCHED');
  return discovered;
}

function signalFor(line: string, status?: number): DiscoverySignal {
  const lowered = line.toLowerCase();
  if (status === 415 || /unsupported media|content[- ]type/.test(lowered)) return 'unsupported-media-type';
  if (status === 413 || /payload too large|oversized/.test(lowered)) return 'oversized-payload';
  if (status === 401 || /missing (?:auth|authorization)|without authorization/.test(lowered)) return 'missing-auth';
  if (status === 404 || /not[- ]found|missing resource/.test(lowered)) return 'not-found';
  if (status === 409 || /conflict|duplicate/.test(lowered)) return 'conflict';
  if ((status === 400 || status === 422) && /malformed json|invalid json|json parse/.test(lowered)) return 'malformed-json';
  if ((status === 400 || status === 422) && /whitespace|blank string|spaces only/.test(lowered)) return 'whitespace-validation';
  if ((status === 400 || status === 422) && /[?&][a-z0-9_-]+=|query|boundary|minimum|maximum/.test(lowered)) return 'query-boundary';
  if (status !== undefined && status >= 500) return 'contract-violation';
  return 'unclassified';
}

function extractLine(line: string, evidence: DiscoveryEvidence): ExtractedSignal | undefined {
  const methodMatch = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i.exec(line);
  const pathMatch = /(?:https?:\/\/[^\s/]+)?(\/[A-Za-z0-9._~%!$&'()*+,;=:@\-/{}\[\]?=&]*)/.exec(line);
  const statusMatches = [...line.matchAll(/\b([1-5][0-9]{2})\b/g)];
  const method = methodMatch?.[1]?.toUpperCase() as HttpMethod | undefined;
  const observedPath = pathMatch?.[1];
  const observedStatus = statusMatches.length ? Number(statusMatches.at(-1)![1]) : undefined;
  if (!method && !observedPath && observedStatus === undefined) return undefined;
  return {
    ...(method && METHODS.has(method) ? { method } : {}),
    ...(observedPath ? { observedPath } : {}),
    ...(observedStatus !== undefined ? { observedStatus } : {}),
    signal: signalFor(line, observedStatus),
    confidence: method && observedPath ? (observedStatus === undefined ? 0.86 : 0.98) : 0.45,
    evidence,
  };
}

function pathMatches(template: string, observed: string): boolean {
  const templateParts = template.split('/').filter(Boolean);
  const observedParts = observed.split('?')[0]!.split('/').filter(Boolean);
  if (templateParts.length !== observedParts.length) return false;
  return templateParts.every((part, index) => part.startsWith('{') && part.endsWith('}') || part === observedParts[index]);
}

function mapOperation(contract: NormalizedContract, extracted: ExtractedSignal): { operation?: NormalizedOperation; ambiguous: boolean } {
  if (!extracted.method || !extracted.observedPath) return { ambiguous: false };
  const matches = contract.operations.filter((operation) => operation.method === extracted.method && pathMatches(operation.path, extracted.observedPath!));
  return { ...(matches.length === 1 ? { operation: matches[0]! } : {}), ambiguous: matches.length > 1 };
}

function preliminaryDisposition(signal: DiscoverySignal): DiscoveryCandidate['disposition'] {
  if (['missing-auth', 'not-found', 'conflict'].includes(signal)) return 'merge';
  if (['malformed-json', 'unsupported-media-type', 'query-boundary', 'whitespace-validation'].includes(signal)) return 'generate';
  return 'report-only';
}

function candidateKey(candidate: Omit<DiscoveryCandidate, 'id'>): string {
  return stableStringify({ operationId: candidate.operationId, method: candidate.method, path: candidate.observedPath?.split('?')[0], signal: candidate.signal, status: candidate.observedStatus });
}

export async function discoverScenarios(contract: NormalizedContract, config: GauntletConfig): Promise<DiscoveryReport> {
  if (!config.discovery.enabled) {
    const disabled = { formatVersion: 1 as const, specHash: contract.specHash, sourceCount: 0, totalBytes: 0, sources: [], candidates: [], warnings: ['Discovery is disabled; the plan is contract-only.'], redactionCount: 0 };
    return { ...disabled, discoveryHash: sha256(stableStringify(disabled)) };
  }
  const files = await enumerate(config);
  const sources: DiscoverySourceSnapshot[] = [];
  const extracted: ExtractedSignal[] = [];
  const warnings: string[] = [];
  let redactionCount = 0;
  let totalBytes = 0;
  for (const file of files) {
    const before = await stat(file.absolutePath);
    if (before.size > config.discovery.maxFileBytes) throw new Error(`DISCOVERY_FILE_SIZE_LIMIT: ${file.relativePath}: ${before.size}`);
    totalBytes += before.size;
    if (totalBytes > config.discovery.maxTotalBytes) throw new Error(`DISCOVERY_TOTAL_SIZE_LIMIT: ${totalBytes}`);
    const buffer = await readFile(file.absolutePath);
    const after = await stat(file.absolutePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`SOURCE_MUTATED_DURING_READ: ${file.relativePath}`);
    if (buffer.includes(0)) throw new Error(`UNSUPPORTED_BINARY_SOURCE: ${file.relativePath}`);
    let raw: string;
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new Error(`DISCOVERY_INVALID_UTF8: ${file.relativePath}`); }
    const sourceHash = sha256(buffer);
    const snapshotId = `${file.config.id}:${sha256(file.relativePath).slice(0, 12)}`;
    const kind = sourceKind(file.config, path.extname(file.absolutePath).toLowerCase());
    const findings: string[] = [];
    if (raw.trim() === '') findings.push('EMPTY_SOURCE');
    const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const redacted = redactText(lines[index]!);
      redactionCount += redacted.count;
      const excerpt = redacted.text.length > config.discovery.maxExcerptCharacters
        ? `${redacted.text.slice(0, config.discovery.maxExcerptCharacters)}...[TRUNCATED]`
        : redacted.text;
      if (/ignore (?:the|all) (?:openapi|contract)|reveal environment|evil\.example|disable auth/i.test(redacted.text)) {
        findings.push(`UNTRUSTED_INSTRUCTION_TEXT:${index + 1}`);
        continue;
      }
      const evidence: DiscoveryEvidence = {
        sourceId: snapshotId,
        sourcePath: file.relativePath,
        sourceHash,
        lineStart: index + 1,
        lineEnd: index + 1,
        excerpt,
      };
      const item = extractLine(redacted.text, evidence);
      if (item) extracted.push(item);
    }
    sources.push({
      id: snapshotId,
      configuredPath: path.relative(config.projectRoot, file.config.path).replaceAll(path.sep, '/'),
      sourcePath: file.relativePath,
      sourceHash,
      bytes: buffer.byteLength,
      kind,
      parserVersion: PARSER_VERSION,
      status: findings.length ? 'warning' : 'parsed',
      findings: [...new Set(findings)].sort(),
    });
  }
  if (extracted.length > config.discovery.maxCandidates) throw new Error(`DISCOVERY_CANDIDATE_LIMIT: ${extracted.length}`);
  const byKey = new Map<string, DiscoveryCandidate>();
  for (const item of extracted) {
    const mapped = mapOperation(contract, item);
    let disposition = preliminaryDisposition(item.signal);
    let reason = 'Exact method/path mapping; executable expectations remain OpenAPI-derived.';
    if (!item.method || !item.observedPath) {
      disposition = 'report-only';
      reason = 'Incomplete method/path evidence cannot identify an operation safely.';
    } else if (mapped.ambiguous) {
      disposition = 'reject';
      reason = 'Multiple OpenAPI operations match this evidence.';
    } else if (!mapped.operation) {
      disposition = 'report-only';
      reason = 'No exact OpenAPI operation matches; retained as a contract-gap finding.';
    } else if (item.confidence < config.discovery.minimumConfidence) {
      disposition = 'report-only';
      reason = `Confidence ${item.confidence} is below the configured threshold ${config.discovery.minimumConfidence}.`;
    } else if (item.observedStatus !== undefined && !mapped.operation.responses.some((response) => response.status === item.observedStatus)) {
      disposition = 'report-only';
      reason = `Observed status ${item.observedStatus} is not declared by OpenAPI and cannot become an oracle.`;
    }
    const candidateWithoutId: Omit<DiscoveryCandidate, 'id'> = {
      signal: item.signal,
      ...(item.method ? { method: item.method } : {}),
      ...(item.observedPath ? { observedPath: item.observedPath } : {}),
      ...(item.observedStatus !== undefined ? { observedStatus: item.observedStatus } : {}),
      ...(mapped.operation ? { operationId: mapped.operation.operationId } : {}),
      confidence: item.confidence,
      disposition,
      reason,
      contractPointers: mapped.operation ? [mapped.operation.sourcePointer, ...mapped.operation.responses.filter((response) => response.status === item.observedStatus).map((response) => response.sourcePointer)] : [],
      evidence: [item.evidence],
    };
    const key = candidateKey(candidateWithoutId);
    const existing = byKey.get(key);
    if (existing) {
      existing.evidence.push(item.evidence);
      existing.evidence.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.lineStart - b.lineStart);
      continue;
    }
    byKey.set(key, { id: `discovery-${sha256(key).slice(0, 12)}`, ...candidateWithoutId });
  }
  const candidates = [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id));
  const perOperation = new Map<string, number>();
  for (const candidate of candidates.filter((item) => item.disposition === 'generate')) {
    const count = (perOperation.get(candidate.operationId!) ?? 0) + 1;
    perOperation.set(candidate.operationId!, count);
    if (count > config.discovery.maxCandidatesPerOperation) throw new Error(`DISCOVERY_OPERATION_CANDIDATE_LIMIT: ${candidate.operationId}`);
  }
  if (files.length === 0) warnings.push('Discovery enabled but no source files matched.');
  for (const source of sources) warnings.push(...source.findings.map((finding) => `${source.sourcePath}:${finding}`));
  const unsigned = { formatVersion: 1 as const, specHash: contract.specHash, sourceCount: sources.length, totalBytes, sources, candidates, warnings: warnings.sort(), redactionCount };
  return { ...unsigned, discoveryHash: sha256(stableStringify(unsigned)) };
}
