/** Azure OpenAI v1 Responses API; model names are deployment names. */
export function azureResponsesUrl(endpoint: unknown): string {
  if (typeof endpoint !== 'string' || !endpoint.trim()) throw new Error('CONFIG_INVALID: Azure requires AZURE_OPENAI_ENDPOINT or agents.azureEndpoint');
  let url: URL;
  try { url = new URL(endpoint.trim()); } catch { throw new Error('CONFIG_INVALID: invalid Azure endpoint URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) throw new Error('CONFIG_INVALID: Azure endpoint must use HTTPS without credentials, query or fragment (loopback HTTP is supported for tests)');
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!['', '/openai/v1', '/openai/v1/responses'].includes(pathname)) throw new Error('CONFIG_INVALID: use an Azure resource endpoint or its /openai/v1 base URL');
  url.pathname = '/openai/v1/responses';
  return url.toString();
}
