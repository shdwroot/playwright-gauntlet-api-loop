// Preserve structural identifiers and hashes so model citations remain verifiable.
export function redactAgentText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, (match) => '[REDACTED_PRIVATE_KEY]' + '\n'.repeat((match.match(/\n/g) ?? []).length))
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\b(authorization|cookie|set-cookie|x-api-key|api[_-]?key|client[_-]?secret|password|access[_-]?token)\s*["']?\s*[:=]\s*["']?[^\s,"'};]+/gi, '$1=[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&#\s]+/gi, '$1[REDACTED]');
}
export function redactAgentData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAgentData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key,
    key === 'capture' && nested && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).map(([name, pointer]) => [name, typeof pointer === 'string' && /^\$(?:\.[A-Za-z0-9_-]+)*$/.test(pointer) ? pointer : '[REDACTED]']))
      : /^(authorization|cookie|set-cookie|x-api-key|api[_-]?key|client[_-]?secret|password|access[_-]?token)$/i.test(key) && typeof nested === 'string'
      ? (/^(?:Bearer )?\$\{[A-Za-z][A-Za-z0-9_]*\}$/.test(nested)
        || (key.toLowerCase() === 'password' && /^gauntlet-\$\{runId\}[A-Za-z0-9!_-]{0,24}$/i.test(nested)) ? nested : '[REDACTED]') : redactAgentData(nested)]));
  return typeof value === 'string' ? redactAgentText(value) : value;
}
