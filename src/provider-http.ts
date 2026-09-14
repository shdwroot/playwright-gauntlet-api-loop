const quotaCodes = new Set(['credit_balance_exhausted', 'insufficient_quota', 'billing_hard_limit_reached']);

// Never put a provider's free-form error body into logs or model feedback.
async function quotaFailure(response: Response): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  let text = '';
  const decoder = new TextDecoder();
  try {
    while (text.length <= 8192) {
      const {value, done} = await reader.read();
      if (done) break;
      text += decoder.decode(value, {stream: true});
    }
    if (text.length > 8192) return false;
    const payload = JSON.parse(text) as {error?: {code?: unknown; type?: unknown}};
    return [payload?.error?.code, payload?.error?.type].some(code => typeof code === 'string' && quotaCodes.has(code));
  } catch { return false; }
  finally { await reader.cancel().catch(() => {}); }
}

export async function fetchAgentResponse(url: string, init: RequestInit, timeoutMs: number, role: string): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs);
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {...init, signal});
    if (response.ok) return response;
    if (response.status !== 429) {
      await response.body?.cancel();
      throw new Error(`AGENT_PROVIDER_FAILED: ${role} returned HTTP ${response.status}`);
    }
    if (await quotaFailure(response)) throw new Error(`AGENT_PROVIDER_QUOTA_EXHAUSTED: ${role} returned HTTP 429; restore provider credits before resuming. No offline agent was substituted.`);
    const header = response.headers.get('retry-after');
    const seconds = header === null ? NaN : Number(header);
    const parsed = header === null ? NaN : Date.parse(header);
    const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
      : Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : 1000 * (attempt + 1);
    if (attempt >= 2 || delay >= deadline - Date.now()) throw new Error(`AGENT_PROVIDER_RATE_LIMITED: ${role} returned HTTP 429; bounded retries exhausted or Retry-After exceeds the call deadline.`);
    console.error(`[${role}] provider rate limited; retry ${attempt + 1}/2 in ${Math.round(delay)}ms`);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) abort();
    });
  }
}
