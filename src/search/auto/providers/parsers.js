const DEFAULT_LIMIT = 10;

function boundedLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(0, Math.min(50, Math.floor(value)));
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);?/gi, (_, code) => {
      const number = Number.parseInt(code, 16);
      return Number.isInteger(number) && number >= 0 && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : _;
    })
    .replace(/&#([0-9]+);?/g, (_, code) => {
      const number = Number.parseInt(code, 10);
      return Number.isInteger(number) && number >= 0 && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : _;
    })
    .replace(/&(?:amp|#38);/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

function textContent(value) {
  return decodeHtml(String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([\\s\\S]*?)"|'([\\s\\S]*?)'|([^\\s>]+))`, "i");
  const match = String(tag ?? "").match(pattern);
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function firstMatch(source, pattern) {
  const match = String(source ?? "").match(pattern);
  return match?.[0] ?? "";
}

function firstAnchor(card, pattern = /<a\b[^>]*>[\s\S]*?<\/a>/i) {
  return firstMatch(card, pattern);
}

function hrefFromAnchor(anchor) {
  const href = attribute(anchor, "href");
  return href.trim();
}

function directHttpUrl(value) {
  const url = decodeHtml(value).trim();
  return /^https?:\/\//i.test(url) ? url : "";
}

function decodeWrappedUrl(value, base) {
  try {
    const parsed = new URL(decodeHtml(String(value || "")), base);
    for (const key of ["url", "target", "u", "ru"]) {
      const target = parsed.searchParams.get(key);
      if (/^https?:\/\//i.test(target || "")) return target;
    }
    return parsed.toString();
  } catch { return value; }
}

function parseGenericLinks(html, limit, base, blockedHosts = []) {
  const output = [];
  const seen = new Set();
  const re = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(re)) {
    if (output.length >= boundedLimit(limit) * 3) break;
    const raw = match[1] || match[2] || match[3] || "";
    const url = decodeWrappedUrl(raw, base);
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { continue; }
    const title = textContent(match[4]);
    if (!/^https?:\/\//i.test(url) || !title || title.length < 2 || blockedHosts.some((item) => host === item || host.endsWith(`.${item}`)) || seen.has(url)) continue;
    seen.add(url);
    output.push(result(title, url, ""));
  }
  return uniqueResults(output, limit);
}

function isBaiduWrapper(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return (host === "baidu.com" || host.endsWith(".baidu.com")) &&
      /^\/(?:link|baidu\.php)(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function result(title, url, snippet, extra = {}) {
  const value = {
    title: textContent(title),
    url: directHttpUrl(url),
    snippet: textContent(snippet),
    ...extra
  };
  return value.title && value.url ? value : null;
}

function cardsByClass(html, tagName, className) {
  const tag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const classValue = `(?:["'][^"']*\\b${className}\\b[^"']*["']|[^\\s>]*\\b${className}\\b[^\\s>]*)`;
  const classPattern = `<${tag}\\b[^>]*\\bclass\\s*=\\s*${classValue}[^>]*>`;
  const openTag = new RegExp(classPattern, "gi");
  const tagPattern = new RegExp(`</?${tag}\\b[^>]*>`, "gi");
  const source = String(html ?? "");
  const cards = [];
  let match;
  while ((match = openTag.exec(source))) {
    const start = match.index;
    let depth = 0;
    let tagMatch;
    tagPattern.lastIndex = start;
    while ((tagMatch = tagPattern.exec(source))) {
      const rawTag = tagMatch[0];
      if (/^<\//.test(rawTag)) {
        depth -= 1;
      } else if (!/\/\s*>$/.test(rawTag)) {
        depth += 1;
      }
      if (depth === 0) {
        cards.push(source.slice(start, tagPattern.lastIndex));
        break;
      }
    }
    if (depth !== 0) break;
  }
  return cards;
}

function uniqueResults(results, limit) {
  const maxResults = boundedLimit(limit);
  if (maxResults === 0) return [];
  const seen = new Set();
  const output = [];
  for (const item of results) {
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    output.push(item);
    if (output.length >= maxResults) break;
  }
  return output;
}

function parseBingCard(card) {
  const titleAnchor = firstAnchor(card, /<h2\b[^>]*>[\s\S]*?<a\b[^>]*>[\s\S]*?<\/a>[\s\S]*?<\/h2>/i);
  const anchor = titleAnchor || firstAnchor(card);
  const url = hrefFromAnchor(anchor);
  if (/^https?:\/\/(?:www\.)?bing\.com\//i.test(url)) return null;
  const title = firstMatch(card, /<h2\b[^>]*>[\s\S]*?<\/h2>/i);
  const caption = firstMatch(card, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bb_caption\b[^"']*["'][^>]*>[\s\S]*?<\/div>/i);
  const snippet = caption || firstMatch(card, /<p\b[^>]*>[\s\S]*?<\/p>/i);
  return result(title || anchor, url, snippet);
}

function baiduTarget(anchor) {
  const direct = directHttpUrl(attribute(anchor, "rl-link-data-url"));
  if (direct) return direct;

  const dataLog = attribute(anchor, "data-log");
  if (dataLog) {
    try {
      const parsed = JSON.parse(dataLog);
      const loggedUrl = directHttpUrl(parsed?.mu);
      if (loggedUrl) return loggedUrl;
    } catch {
      const match = dataLog.match(/(?:["']?mu["']?)\s*:\s*["'](https?:\/\/[^"']+)/i);
      if (match) return directHttpUrl(match[1]);
    }
  }

  return directHttpUrl(attribute(anchor, "href"));
}

function parseBaiduCard(card) {
  const titleBlock = firstMatch(card, /<h3\b[^>]*>[\s\S]*?<\/h3>/i) || firstAnchor(card);
  const anchor = firstAnchor(titleBlock) || firstAnchor(card);
  const url = baiduTarget(anchor);
  const snippet = firstMatch(card, /<(?:div|p)\b[^>]*\bclass\s*=\s*["'][^"']*(?:c-abstract|content-right|c-span-last)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|p)>/i);
  return result(titleBlock || anchor, url, snippet);
}

function parseSogouCard(card) {
  const titleBlock = firstMatch(card, /<h3\b[^>]*\bclass\s*=\s*(?:["'][^"']*\b(?:vr-title|vr-tit)\b[^"']*["']|[^\s>]*\b(?:vr-title|vr-tit)\b[^\s>]*).*?>[\s\S]*?<\/h3>/i) || firstMatch(card, /<h3\b[^>]*>[\s\S]*?<\/h3>/i);
  const titleAnchor = firstAnchor(titleBlock) || firstAnchor(card);
  const citeAnchor = firstAnchor(card, /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bciteLinkClass\b[^"']*["'][^>]*>[\s\S]*?<\/a>/i);
  const citeUrl = resolveSogouHref(attribute(citeAnchor, "data-url") || hrefFromAnchor(citeAnchor));
  const titleUrl = resolveSogouHref(attribute(titleAnchor, "data-url") || hrefFromAnchor(titleAnchor));
  const url = citeUrl || titleUrl;
  if (isSogouNavigationUrl(url)) return null;
  const unresolvedWrapper = isSogouWrapperUrl(url);
  const snippet = firstMatch(card, /<p\b[^>]*>[\s\S]*?<\/p>/i) ||
    firstMatch(card, /<(?:a|div|p)\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:txt-summary|c-abstract|result-snippet)\b[^"']*["'][^>]*>[\s\S]*?<\/(?:a|div|p)>/i);
  return result(titleBlock || titleAnchor, url, snippet, {
    ...(isSogouVideoUrl(url) ? { resultType: "video" } : {}),
    ...(unresolvedWrapper ? { unresolvedWrapper: true } : {})
  });
}

function isSogouNavigationUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (host === "fanyi.sogou.com" || host === "pic.sogou.com") return true;
    return /^(?:sogou\.com|www\.sogou\.com|wap\.sogou\.com|m\.sogou\.com)$/.test(host) && /^\/(?:web|sogou|aimode|searchList\.jsp)(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isSogouWrapperUrl(value) {
  try {
    const parsed = new URL(value);
    return /^(?:sogou\.com|www\.sogou\.com|wap\.sogou\.com|m\.sogou\.com)$/.test(parsed.hostname.toLowerCase()) &&
      /^\/link(?:[/?]|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function resolveSogouHref(value) {
  const raw = String(value || "").trim();
  return raw ? decodeWrappedUrl(raw, "https://wap.sogou.com") : "";
}

function isSogouVideoUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return host === "tv.sohu.com" || host.endsWith(".tv.sohu.com") ||
      host === "v.qq.com" || host.endsWith(".v.qq.com") ||
      host === "v.youku.com" || host.endsWith(".youku.com") ||
      host === "video.weibo.com" || host === "bilibili.com" ||
      host.endsWith(".bilibili.com") || host === "haokan.baidu.com" ||
      host === "video.baidu.com" || host === "youtube.com" ||
      host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

export function parseBingHtml(html, limit = DEFAULT_LIMIT) {
  return uniqueResults(cardsByClass(html, "li", "b_algo").map(parseBingCard), limit);
}

export function parseBaiduHtml(html, limit = DEFAULT_LIMIT) {
  const cards = [
    ...cardsByClass(html, "div", "c-result"),
    ...cardsByClass(html, "div", "c-container")
  ];
  return uniqueResults(cards.map(parseBaiduCard), limit);
}

export function parseBaiduJson(data, limit = DEFAULT_LIMIT) {
  const entries = Array.isArray(data?.feed?.entry) ? data.feed.entry : [];
  const records = entries.map((entry) => {
    const title = entry?.title || entry?.name || "";
    const url = entry?.url || entry?.link || "";
    const snippet = entry?.abs || entry?.desc || entry?.description || "";
    if (isBaiduWrapper(url)) return null;
    return result(title, url, snippet);
  });
  return uniqueResults(records, limit);
}

export function parseSogouHtml(html, limit = DEFAULT_LIMIT, options = {}) {
  const allowVideo = options.allowVideo === true;
  const cards = [
    ...cardsByClass(html, "div", "vrwrap"),
    ...cardsByClass(html, "div", "vrResult")
  ];
  const records = cards
    .map(parseSogouCard)
    .filter((record) => Boolean(record?.snippet))
    .filter((record) => allowVideo || record?.resultType !== "video");
  const structured = uniqueResults(records, limit);
  return structured.length
    ? structured
    : parseGenericLinks(html, limit, "https://www.sogou.com", ["sogou.com"]).filter((record) => record.snippet);
}

function timestampToIso(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  const milliseconds = numeric < 1e12 ? numeric * 1000 : numeric;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return "";
  }
}

function isQuarkNavigationUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return host === "sm.cn" || host.endsWith(".sm.cn");
  } catch {
    return false;
  }
}

function quarkText(value) {
  if (Array.isArray(value)) return textContent(value.map((item) => quarkText(item)).join(" | "));
  if (value && typeof value === "object") return quarkText(value.content ?? value.text ?? value.value ?? "");
  return textContent(value);
}

function quarkRecord(data, resultType = "web") {
  const title = quarkText(data?.titleProps?.content ?? data?.title?.content ?? data?.title);
  const url = data?.sourceProps?.dest_url || data?.source?.dest_url || data?.title_url || data?.normal_url || data?.url;
  const snippet = quarkText(
    data?.summaryProps?.content ??
    data?.message?.replyContent ??
    data?.show_body ??
    data?.desc ??
    data?.message?.content_text ??
    data?.summary ??
    data?.content
  );
  const publishedAt = timestampToIso(data?.sourceProps?.time ?? data?.source?.time ?? data?.publish_time);
  if (isQuarkNavigationUrl(url)) return null;
  return result(title, url, snippet, {
    ...(publishedAt ? { publishedAt } : {}),
    ...(resultType !== "web" ? { resultType } : {})
  });
}

const QUARK_RESULT_TYPES = {
  addition: "web",
  ai_page: "web",
  baike_sc: "knowledge",
  finance_shuidi: "finance",
  kk_yidian_all: "news",
  life_show_general_image: "image",
  med_struct: "medical",
  music_new_song: "music",
  nature_result: "web",
  news_uchq: "news",
  ss_note: "web",
  ss_doc: "web",
  ss_kv: "web",
  ss_pic: "image",
  ss_text: "web",
  ss_video: "video",
  baike: "knowledge",
  structure_web_novel: "web",
  travel_dest_overview: "travel",
  travel_ranking_list: "travel"
};

function quarkItems(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of ["list", "feed", "image", "hit3"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [data];
}

function parseQuarkCategory(data, sourceCategory) {
  const resultType = QUARK_RESULT_TYPES[sourceCategory];
  if (!resultType) return [];
  return quarkItems(data).map((item) => quarkRecord(item, resultType)).filter(Boolean);
}

export function parseQuarkHtml(html, limit = DEFAULT_LIMIT) {
  const scripts = String(html || "").match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  const records = [];
  for (const script of scripts) {
    if (!/type\s*=\s*["']application\/json["']/i.test(script) ||
      !/id\s*=\s*["']s-data-[^"']+["']/i.test(script) ||
      !/data-used-by\s*=\s*["']hydrate["']/i.test(script)) continue;
    const body = script.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    try {
      const payload = JSON.parse(body);
      records.push(...parseQuarkCategory(payload?.data?.initialData, payload?.extraData?.sc));
    } catch {
      // One malformed hydration block must not discard later valid blocks.
    }
  }
  return uniqueResults(records, limit);
}

export function parseBaiduGenericHtml(html, limit = DEFAULT_LIMIT) {
  return parseGenericLinks(html, limit, "https://www.baidu.com", ["baidu.com"]);
}

export { decodeHtml, textContent };
