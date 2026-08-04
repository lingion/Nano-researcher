import { DEFAULT_ANDROID_UA, DEFAULT_DESKTOP_UA, fetchText } from "./http.js";
import { attemptDiagnostic, diagnoseHtml, prepareProviderQuery, providerFailure, providerLimit, providerSuccess } from "./result.js";
import { parseSogouHtml } from "./parsers.js";

const SOGOU_DESKTOP_URL = "https://www.sogou.com/web";
const SOGOU_MOBILE_URL = "https://wap.sogou.com/web/searchList.jsp";

function requestOptions(context, headers) {
  return {
    fetchImpl: context.fetchImpl,
    headers,
    signal: context.signal,
    timeoutMs: context.timeoutMs,
    maxBytes: context.maxBytes,
    retries: context.retries,
    retryDelayMs: context.retryDelayMs,
    redirect: "follow"
  };
}

export async function searchSogou(rawQuery, context = {}) {
  const { query, text } = prepareProviderQuery(rawQuery);
  const limit = providerLimit(context.limit);
  const started = Date.now();
  const allowVideo = query?.filters?.type === "video";
  const desktopUrl = new URL(SOGOU_DESKTOP_URL);
  desktopUrl.searchParams.set("query", text);
  desktopUrl.searchParams.set("num", String(limit));
  const mobileUrl = new URL(SOGOU_MOBILE_URL);
  mobileUrl.searchParams.set("keyword", text);
  mobileUrl.searchParams.set("num", String(limit));

  const attempts = [
    {
      url: desktopUrl.toString(),
      headers: {
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "user-agent": DEFAULT_DESKTOP_UA
      }
    },
    {
      url: mobileUrl.toString(),
      headers: {
        accept: "text/html,*/*",
        "accept-language": "zh-CN,zh;q=0.9",
        "user-agent": DEFAULT_ANDROID_UA
      }
    }
  ];

  let last;
  const attemptDiagnostics = [];
  for (const attempt of attempts) {
    try {
      const { text: html, response, retryCount } = await fetchText(attempt.url, requestOptions(context, attempt.headers));
      const records = parseSogouHtml(html, limit, { allowVideo });
      const diagnostics = diagnoseHtml({
        provider: "sogou",
        html,
        responseUrl: response.url || attempt.url,
        recordCount: records.length
      });
      attemptDiagnostics.push(attemptDiagnostic({ url: attempt.url, response, records, diagnostics, retryCount }));
      last = providerSuccess({
        provider: "sogou",
        sourceFamily: "cn-web",
        resultType: "web",
        records,
        response,
        url: attempt.url,
        diagnostics: {
          ...diagnostics,
          durationMs: Date.now() - started,
          requestCount: attemptDiagnostics.length,
          retryCount,
          attempts: attemptDiagnostics
        }
      });
      if (records.length) return last;
    } catch (error) {
      attemptDiagnostics.push(attemptDiagnostic({ url: attempt.url, error }));
      last = providerFailure({ provider: "sogou", url: attempt.url, error, diagnostics: { durationMs: Date.now() - started, requestCount: attemptDiagnostics.length, attempts: attemptDiagnostics } });
    }
  }

  return last || providerFailure({
    provider: "sogou",
    url: desktopUrl.toString(),
    error: new Error("Sogou returned no usable response"),
    diagnostics: { durationMs: Date.now() - started }
  });
}
