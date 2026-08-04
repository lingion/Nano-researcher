import {
  DEFAULT_ANDROID_UA,
  DEFAULT_DESKTOP_UA,
  fetchJson,
  fetchText
} from "./http.js";
import { attemptDiagnostic, diagnoseHtml, prepareProviderQuery, providerFailure, providerLimit, providerSuccess } from "./result.js";
import { parseBaiduGenericHtml, parseBaiduHtml, parseBaiduJson } from "./parsers.js";

const BAIDU_MOBILE_URL = "https://m.baidu.com/s";
const BAIDU_JSON_URL = "https://www.baidu.com/s";
const BAIDU_DESKTOP_URL = "https://www.baidu.com/s";

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

export async function searchBaidu(rawQuery, context = {}) {
  const { text } = prepareProviderQuery(rawQuery);
  const limit = providerLimit(context.limit);
  const started = Date.now();
  const mobileUrl = new URL(BAIDU_MOBILE_URL);
  mobileUrl.searchParams.set("word", text);
  mobileUrl.searchParams.set("pn", "0");
  mobileUrl.searchParams.set("rn", String(limit));

  const jsonUrl = new URL(BAIDU_JSON_URL);
  jsonUrl.searchParams.set("wd", text);
  jsonUrl.searchParams.set("tn", "json");
  jsonUrl.searchParams.set("rn", String(limit));
  jsonUrl.searchParams.set("pn", "0");

  const desktopUrl = new URL(BAIDU_DESKTOP_URL);
  desktopUrl.searchParams.set("wd", text);
  desktopUrl.searchParams.set("rn", String(limit));

  const attempts = [
    {
      url: mobileUrl.toString(),
      type: "html",
      headers: {
        accept: "text/html,*/*",
        "accept-language": "zh-CN,zh;q=0.9",
        "user-agent": DEFAULT_ANDROID_UA
      }
    },
    {
      url: jsonUrl.toString(),
      type: "json",
      headers: {
        accept: "application/json,text/plain,*/*",
        "accept-language": "zh-CN,zh;q=0.9",
        "user-agent": DEFAULT_DESKTOP_UA
      }
    },
    {
      url: desktopUrl.toString(),
      type: "html",
      headers: {
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9",
        "user-agent": DEFAULT_DESKTOP_UA
      }
    },
    {
      url: `https://m.baidu.com/s?word=${encodeURIComponent(text)}&pn=0&rn=${limit}&sa=searchresult`,
      type: "html",
      headers: {
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9",
        "user-agent": DEFAULT_ANDROID_UA,
        referer: "https://m.baidu.com/"
      }
    }
  ];

  let last;
  const attemptDiagnostics = [];
  for (const attempt of attempts) {
    try {
      if (attempt.type === "json") {
        const { data, response, retryCount } = await fetchJson(attempt.url, requestOptions(context, attempt.headers));
        const records = parseBaiduJson(data, limit);
        attemptDiagnostics.push(attemptDiagnostic({ url: attempt.url, response, records, retryCount }));
        last = providerSuccess({
          provider: "baidu",
          sourceFamily: "cn-web",
          resultType: "web",
          records,
          response,
          url: attempt.url,
          diagnostics: {
            parserVersion: "json-v1",
            durationMs: Date.now() - started,
            parseFailures: records.length === 0 ? 1 : 0,
            markupFound: true,
            requestCount: attemptDiagnostics.length,
            retryCount,
            attempts: attemptDiagnostics
          }
        });
        if (records.length) return last;
        continue;
      }

      const { text: html, response, retryCount } = await fetchText(attempt.url, requestOptions(context, attempt.headers));
      let records = parseBaiduHtml(html, limit);
      if (!records.length) records = parseBaiduGenericHtml(html, limit);
      const diagnostics = diagnoseHtml({
        provider: "baidu",
        html,
        responseUrl: response.url || attempt.url,
        recordCount: records.length
      });
      attemptDiagnostics.push(attemptDiagnostic({ url: attempt.url, response, records, diagnostics, retryCount }));
      last = providerSuccess({
        provider: "baidu",
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
      last = providerFailure({ provider: "baidu", url: attempt.url, error, diagnostics: { durationMs: Date.now() - started, requestCount: attemptDiagnostics.length, attempts: attemptDiagnostics } });
    }
  }

  return last || providerFailure({
    provider: "baidu",
    url: mobileUrl.toString(),
    error: new Error("Baidu returned no usable response"),
    diagnostics: { durationMs: Date.now() - started }
  });
}
