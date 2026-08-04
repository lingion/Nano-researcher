import { DEFAULT_DESKTOP_UA, fetchText } from "./http.js";
import { attemptDiagnostic, diagnoseHtml, prepareProviderQuery, providerFailure, providerLimit, providerSuccess } from "./result.js";
import { parseBingHtml } from "./parsers.js";

const BING_URLS = ["https://cn.bing.com/search", "https://www.bing.com/search"];

export async function searchBing(rawQuery, context = {}) {
  const { text } = prepareProviderQuery(rawQuery);
  const limit = providerLimit(context.limit);
  const started = Date.now();
  let last;
  const attemptDiagnostics = [];
  for (const baseUrl of BING_URLS) {
    const url = new URL(baseUrl);
    url.searchParams.set("q", text);
    url.searchParams.set("count", String(limit));
    // Keep the request market aligned with the Worker egress region. Without
    // this, Bing may redirect the Worker to its homepage instead of /search.
    url.searchParams.set("setlang", "zh-CN");
    url.searchParams.set("cc", "cn");
    url.searchParams.set("mkt", "zh-CN");
    url.searchParams.set("form", "QBLH");
    try {
      const { text: html, response, retryCount } = await fetchText(url.toString(), {
        fetchImpl: context.fetchImpl,
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          "cache-control": "no-cache",
          referer: "https://www.bing.com/",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "none",
          "upgrade-insecure-requests": "1",
          "user-agent": DEFAULT_DESKTOP_UA
        },
        signal: context.signal,
        timeoutMs: context.timeoutMs,
        maxBytes: context.maxBytes,
        retries: context.retries,
        retryDelayMs: context.retryDelayMs,
        redirect: "follow"
      });
      const records = parseBingHtml(html, limit);
      const responsePath = (() => {
        try { return new URL(response.url || url).pathname; } catch { return ""; }
      })();
      const diagnostics = diagnoseHtml({ provider: "bing", html, responseUrl: response.url, recordCount: records.length });
      if (!records.length && /^https?:\/\/(?:www\.)?bing\.com\/$/i.test(response.url || "") && responsePath === "/") {
        diagnostics.blocked = true;
        diagnostics.blockReason = "redirected_to_homepage";
        diagnostics.parseFailures = 0;
      }
      attemptDiagnostics.push(attemptDiagnostic({ url: url.toString(), response, records, diagnostics, retryCount }));
      last = providerSuccess({
        provider: "bing",
        sourceFamily: "general-web",
        resultType: "web",
        records,
        response,
        url: url.toString(),
        diagnostics: { ...diagnostics, durationMs: Date.now() - started, requestCount: attemptDiagnostics.length, retryCount, attempts: attemptDiagnostics }
      });
      if (records.length || (!diagnostics.blocked && !diagnostics.parseFailures)) return last;
    } catch (error) {
      attemptDiagnostics.push(attemptDiagnostic({ url: url.toString(), error }));
      last = providerFailure({ provider: "bing", url: url.toString(), error, diagnostics: { durationMs: Date.now() - started, requestCount: attemptDiagnostics.length, attempts: attemptDiagnostics } });
    }
  }
  return last || providerFailure({ provider: "bing", url: BING_URLS[0], error: new Error("Bing returned no usable response"), diagnostics: { durationMs: Date.now() - started } });
}
