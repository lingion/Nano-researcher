import { fetchText, ProviderFetchError, DEFAULT_DESKTOP_UA } from './http.js';

// A provider session is a bounded workflow: every network step shares the
// engine signal, deadline and request budget, while cookies survive steps.
export function createProviderSession(context = {}) {
  const started = Date.now();
  const deadlineMs = Math.max(1, Number(context.deadlineMs || context.timeoutMs || 5000));
  const maxRequests = Math.max(1, Math.min(4, Number(context.maxRequests || 3)));
  const cookies = new Map();
  let requestCount = 0;
  let retryCount = 0;
  function remainingMs() { return Math.max(1, deadlineMs - (Date.now() - started)); }
  function captureCookies(response) {
    const values = response?.headers?.getSetCookie?.() || [];
    for (const value of values) {
      const pair = String(value).split(';', 1)[0]; const index = pair.indexOf('=');
      if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const legacy = response?.headers?.get?.('set-cookie');
    if (legacy && !values.length) for (const value of legacy.split(/,(?=[^;,]+=)/)) {
      const pair = value.split(';', 1)[0]; const index = pair.indexOf('=');
      if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
  async function get(url, options = {}) {
    if (requestCount >= maxRequests) throw new ProviderFetchError('request_budget', 'Provider workflow request budget exceeded', { maxRequests });
    if (context.signal?.aborted) throw new ProviderFetchError('cancelled', 'Provider workflow was cancelled', { url });
    requestCount += 1;
    const headers = { 'user-agent': options.userAgent || DEFAULT_DESKTOP_UA, accept: options.accept || 'text/html,application/xhtml+xml,*/*;q=0.8', ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}), ...(options.headers || {}) };
    const result = await fetchText(url, { ...options, headers, signal: context.signal, timeoutMs: Math.min(remainingMs(), options.timeoutMs || remainingMs()), retries: options.retries ?? 0 });
    captureCookies(result.response); retryCount += Number(result.retryCount || 0); return result;
  }
  return { get, remainingMs, get requestCount() { return requestCount; }, get retryCount() { return retryCount; }, cookies };
}
