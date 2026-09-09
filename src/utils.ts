import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

export function stableStringify(value: unknown, space = 2): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return input;
  };
  return `${JSON.stringify(normalize(value), null, space)}\n`;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  return sha256(await readFile(filePath));
}

export async function atomicWrite(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, filePath);
}

export function ensureWithin(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`PATH_OUTSIDE_ALLOWED_ROOT: ${resolvedCandidate}`);
  }
  return resolvedCandidate;
}

const secretKey = /authorization|api[-_]?key|token|secret|password|cookie/i;
const tokenLike = /\b(?:bearer\s+)?[A-Za-z0-9_-]{24,}\b/gi;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        secretKey.test(key) ? '[REDACTED]' : redact(nested),
      ]),
    );
  }
  return typeof value === 'string' ? value.replace(tokenLike, '[REDACTED]') : value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function jsonPointerEscape(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function shortId(value: string): string {
  return sha256(value).slice(0, 12);
}
