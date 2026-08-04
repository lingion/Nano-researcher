const DEFAULT_MAX_BYTES = 1_500_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 120;
// Keep profiles stable per request stage. Random rotation harms diagnosis and
// cannot solve IP, TLS, or browser challenges.
const DEFAULT_DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const DEFAULT_ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36";
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

export class ProviderFetchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProviderFetchError";
    this.code = code;
    Object.assign(this, details);
  }
}

function requestSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timeoutId;
  const abort = () => controller.abort(parentSignal?.reason);

  if (parentSignal) {
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener("abort", abort, { once: true });
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort("deadline"), timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup() {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", abort);
    }
  };
}

async function readBoundedText(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > maxBytes) {
      throw new ProviderFetchError("body_too_large", "Provider response body exceeded the limit", { maxBytes });
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ProviderFetchError("body_too_large", "Provider response body exceeded the limit", { maxBytes });
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock?.();
  }
}

async function fetchAttempt(url, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ProviderFetchError("fetch_unavailable", "No fetch implementation is available", { url });
  }

  const timeout = requestSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: options.method ?? "GET",
      headers: {
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "user-agent": DEFAULT_DESKTOP_UA,
        ...options.headers
      },
      signal: timeout.signal,
      redirect: options.redirect ?? "follow",
      ...(options.body !== undefined ? { body: options.body } : {})
    });

    if (!response || response.status < 200 || response.status >= 300) {
      throw new ProviderFetchError("http_status", `Provider returned HTTP ${response?.status ?? "unknown"}`, {
        status: response?.status ?? null,
        url
      });
    }

    const text = await readBoundedText(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
    return { text, response, retryCount: 0 };
  } catch (error) {
    if (error instanceof ProviderFetchError) throw error;
    if (timeout.signal.aborted) {
      throw new ProviderFetchError("timeout", "Provider request exceeded its deadline", { url });
    }
    throw new ProviderFetchError("network_error", error?.message || "Provider request failed", { url });
  } finally {
    timeout.cleanup();
  }
}

function attachRetryCount(error, retryCount) {
  if (error && typeof error === "object") {
    error.retryCount = retryCount;
    return error;
  }
  return new ProviderFetchError("network_error", String(error || "Provider request failed"), { retryCount });
}

export async function fetchText(url, options = {}) {
  const requestedRetries = Number(options.retries ?? DEFAULT_RETRIES);
  const retries = Number.isFinite(requestedRetries)
    ? Math.max(0, Math.min(2, Math.floor(requestedRetries)))
    : DEFAULT_RETRIES;
  const requestedRetryDelay = Number(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const retryDelayMs = Number.isFinite(requestedRetryDelay)
    ? Math.max(0, requestedRetryDelay)
    : DEFAULT_RETRY_DELAY_MS;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await fetchAttempt(url, options);
      return { ...result, retryCount: attempt };
    } catch (error) {
      lastError = attachRetryCount(error, attempt);
      const retryable = error?.code === "network_error" ||
        (error?.code === "http_status" && RETRYABLE_STATUSES.has(error.status));
      if (!retryable || attempt >= retries) throw lastError;
      if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
  }

  throw lastError;
}

export async function fetchJson(url, options = {}) {
  const { text, response, retryCount } = await fetchText(url, {
    ...options,
    headers: {
      accept: "application/json,text/plain,*/*",
      ...options.headers
    }
  });
  try {
    return { data: JSON.parse(text), response, retryCount };
  } catch (error) {
    throw new ProviderFetchError("invalid_json", "Provider returned invalid JSON", {
      url,
      responseUrl: response?.url || url,
      cause: error?.message || "invalid_json"
    });
  }
}

export {
  DEFAULT_ANDROID_UA,
  DEFAULT_DESKTOP_UA,
  DEFAULT_MAX_BYTES,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY_MS
};
