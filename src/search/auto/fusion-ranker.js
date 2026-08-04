import { parseQuery } from "./query/query-parser.js";

const TRACKING_PARAMETERS = /^(utm_|gclid$|fbclid$|mc_cid$|mc_eid$)/i;

function emptyRejected() {
  return { invalid: 0, wrapper: 0, quality: 0, constraint: 0, duplicate: 0 };
}

function tokenize(value) {
  const chunks = String(value ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return chunks.flatMap((chunk) => /^\p{Script=Han}+$/u.test(chunk) ? Array.from(chunk) : [chunk]);
}

function titleFingerprint(value) {
  return tokenize(value).join("");
}

function similarTitle(left, right) {
  const first = titleFingerprint(left);
  const second = titleFingerprint(right);
  if (!first || !second) return false;
  const exactLongTitle = first === second && first.length >= 8;
  const exactChineseTitle = first === second && first.length >= 4 && /\p{Script=Han}/u.test(left);
  if (exactLongTitle || exactChineseTitle) return true;
  if (first.length < 8 || second.length < 8) return false;
  const shorter = first.length <= second.length ? first : second;
  const longer = first.length <= second.length ? second : first;
  if (shorter.length / longer.length < 0.8) return false;
  let overlap = 0;
  for (const character of new Set(shorter)) {
    if (longer.includes(character)) overlap += 1;
  }
  return overlap / new Set(shorter).size >= 0.92;
}

function canonicalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.test(key)) url.searchParams.delete(key);
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function isUnresolvedWrapper(url, candidate) {
  if (candidate.resolvedUrl) return false;
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if ((host === "www.sogou.com" || host === "sogou.com") && parsed.pathname.startsWith("/link")) return true;
  if ((host === "www.baidu.com" || host === "baidu.com") &&
      (parsed.pathname.startsWith("/link") || parsed.pathname.startsWith("/baidu.php"))) return true;
  return candidate.provider === "bing" && host.endsWith("bing.com") &&
    (parsed.pathname.startsWith("/ck/") || parsed.pathname.startsWith("/aclick"));
}

function contains(value, needle) {
  return String(value ?? "").toLocaleLowerCase().includes(String(needle).toLocaleLowerCase());
}

function matchesTerm(text, tokens, term) {
  return term.includes(" ") ? contains(text, term) : tokens.includes(term.toLocaleLowerCase());
}

function bm25(queryTokens, fieldTokens, boost) {
  if (!queryTokens.length || !fieldTokens.length) return 0;
  const counts = new Map();
  for (const token of fieldTokens) counts.set(token, (counts.get(token) || 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  const norm = 1 - b + b * (fieldTokens.length / 12);
  let score = 0;
  for (const term of queryTokens) {
    const frequency = counts.get(term) || 0;
    if (!frequency) continue;
    score += boost * ((frequency * (k1 + 1)) / (frequency + k1 * norm));
  }
  return score;
}

function validDate(year, month, day) {
  const value = Date.UTC(year, month - 1, day);
  const date = new Date(value);
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
    ? value
    : null;
}

function extractCandidateDate(candidate) {
  const publishedAt = Date.parse(String(candidate.publishedAt || ""));
  if (Number.isFinite(publishedAt)) return publishedAt;

  const fullText = `${candidate.title} ${candidate.snippet} ${candidate.displayUrl || candidate.url}`;
  const fullDates = [];
  const numericPattern = /(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/g;
  const chinesePattern = /(20\d{2})\u5e74(\d{1,2})\u6708(\d{1,2})(?:\u65e5)?/g;
  for (const match of fullText.matchAll(numericPattern)) {
    const timestamp = validDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (timestamp !== null) fullDates.push(timestamp);
  }
  for (const match of fullText.matchAll(chinesePattern)) {
    const timestamp = validDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (timestamp !== null) fullDates.push(timestamp);
  }
  if (fullDates.length) return Math.max(...fullDates);

  // A year in a title or URL is useful for demoting clearly old references,
  // but years mentioned only in snippets are often future targets or citations.
  const titleAndUrl = `${candidate.title} ${candidate.displayUrl || candidate.url}`;
  const years = [...titleAndUrl.matchAll(/\b(20\d{2})\b/g)]
    .map((match) => validDate(Number(match[1]), 1, 1))
    .filter((timestamp) => timestamp !== null);
  return years.length ? Math.max(...years) : null;
}

function hasFreshnessSignal(query) {
  return /(?:\blatest\b|\brecent(?:ly)?\b|\btoday\b|\bnow\b|\u6700\u65b0|\u6700\u8fd1|\u8fd1\u671f|\u4eca\u65e5|\u521a\u521a|\u5f53\u524d|\u76ee\u524d)/iu.test(query.text);
}

function isSectionPage(candidate) {
  try {
    const pathname = new URL(candidate.url).pathname.toLowerCase();
    const shortTitle = tokenize(candidate.title).length <= 8;
    return shortTitle && /(?:^|\/)(?:original|index|news|list|channel|topic|home|default)(?:\.[a-z0-9]+)?\/?$/i.test(pathname);
  } catch {
    return false;
  }
}

function freshnessScore(query, candidate, candidateDate, nowMs) {
  if (!hasFreshnessSignal(query)) return 0;
  let score = candidateDate === null
    ? -0.75
    : 2 - Math.max(0, (nowMs - candidateDate) / 86_400_000) / 90;
  if (isSectionPage(candidate)) score -= 1.5;
  return Math.max(-3, Math.min(2, score));
}

function queryDate(query, value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function parseHostPathConstraint(value) {
  try {
    const parsed = new URL(/^https?:\/\//i.test(String(value)) ? String(value) : `https://${String(value)}`);
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return { host: parsed.hostname.toLowerCase(), path: path === '/' ? '' : path };
  } catch {
    return { host: String(value).toLowerCase(), path: '' };
  }
}

function passesConstraints(candidate, query, text, tokens, candidateDate) {
  if (query.diagnostics?.some(({ code }) => code === "invalid_date" || code === "empty_filter")) return false;
  if (query.phrases.some((phrase) => !contains(text, phrase))) return false;
  if (query.required.some((term) => !matchesTerm(text, tokens, term))) return false;
  if (query.excluded.some((term) => matchesTerm(text, tokens, term))) return false;

  const candidateUrl = new URL(candidate.url);
  const host = candidateUrl.hostname.toLowerCase();
  const { site, domain, filetype, source, type, after, before } = query.filters;
  if (site) {
    const constraint = parseHostPathConstraint(site);
    if (host !== constraint.host && !host.endsWith(`.${constraint.host}`)) return false;
    if (constraint.path && candidateUrl.pathname.toLowerCase() !== constraint.path && !candidateUrl.pathname.toLowerCase().startsWith(`${constraint.path}/`)) return false;
  }
  if (domain && host !== domain.toLowerCase() && !host.endsWith(`.${domain.toLowerCase()}`)) return false;
  if (filetype && !candidateUrl.pathname.toLowerCase().endsWith(`.${filetype.toLowerCase()}`)) return false;
  if (source && candidate.provider !== source && candidate.sourceFamily !== source) return false;
  if (type && candidate.resultType !== type) return false;
  const afterDate = queryDate(query, after);
  const beforeDate = queryDate(query, before);
  if ((after && afterDate === null) || (before && beforeDate === null)) return false;
  if ((afterDate !== null || beforeDate !== null) && candidateDate === null) return false;
  if (afterDate !== null && candidateDate < afterDate) return false;
  if (beforeDate !== null && candidateDate > beforeDate) return false;
  return true;
}

function scoreCandidate(candidate, query, text, tokens, candidateDate, nowMs) {
  const queryTokens = tokenize(query.text);
  const titleTokens = tokenize(candidate.title);
  const snippetTokens = tokenize(candidate.snippet);
  const urlTokens = tokenize(candidate.displayUrl || candidate.url);
  const matched = queryTokens.filter((token) => tokens.includes(token)).length;
  const coverage = queryTokens.length ? matched / queryTokens.length : 0;
  const lexical = bm25(queryTokens, titleTokens, 3.2) +
    bm25(queryTokens, snippetTokens, 1.2) +
    bm25(queryTokens, urlTokens, 0.2);
  const phrase = [...query.phrases, ...query.required.filter((term) => term.includes(" "))]
    .filter((term) => contains(text, term)).length * 4;
  const authority = Math.max(0, Math.min(1, Number(candidate.authorityScore) || 0)) * 2;
  const rankPrior = 0.15 / Math.max(1, Number(candidate.providerRank) || 1);
  const freshness = freshnessScore(query, candidate, candidateDate, nowMs);
  // Reciprocal-rank-style prior is deliberately small; provider order must
  // never dominate textual relevance.
  const fusion = 0.1 / (60 + Math.max(0, Number(candidate.providerRank) || 0));
  const score = lexical + phrase + coverage * 1.5 + authority + rankPrior + fusion + freshness;
  return {
    score,
    scoreBreakdown: { lexical, phrase, coverage: coverage * 1.5, authority, rankPrior, fusion, freshness }
  };
}

export function rankCandidates(inputCandidates, rawQuery, options = {}) {
  const query = typeof rawQuery === "string" ? parseQuery(rawQuery) : rawQuery;
  const requestedNow = Date.parse(String(options.now || ""));
  const nowMs = Number.isFinite(requestedNow) ? requestedNow : Date.now();
  const rejected = emptyRejected();
  const seenUrls = new Set();
  const accepted = [];

  for (const [index, input] of (Array.isArray(inputCandidates) ? inputCandidates : []).entries()) {
    const url = canonicalizeUrl(input?.resolvedUrl || input?.url);
    if (!url) {
      rejected.invalid += 1;
      continue;
    }
    if (isUnresolvedWrapper(url, input)) {
      rejected.wrapper += 1;
      continue;
    }
    const title = String(input.title ?? "").trim();
    const snippet = String(input.snippet ?? "").trim();
    if (!title && !snippet) {
      rejected.quality += 1;
      continue;
    }
    if (seenUrls.has(url)) {
      rejected.duplicate += 1;
      continue;
    }
    const candidate = {
      ...input,
      url,
      title,
      snippet,
      displayUrl: input.displayUrl || url
    };
    const text = `${title} ${snippet} ${candidate.displayUrl}`.toLocaleLowerCase();
    const tokens = tokenize(text);
    const candidateDate = extractCandidateDate(candidate);
    if (!passesConstraints(candidate, query, text, tokens, candidateDate)) {
      rejected.constraint += 1;
      continue;
    }
    seenUrls.add(url);
    accepted.push({ ...candidate, ...scoreCandidate(candidate, query, text, tokens, candidateDate, nowMs), _index: index });
  }

  accepted.sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));
  const uniqueByTitle = [];
  for (const candidate of accepted) {
    if (uniqueByTitle.some((existing) => similarTitle(existing.title, candidate.title))) {
      rejected.duplicate += 1;
      continue;
    }
    uniqueByTitle.push(candidate);
  }
  return {
    query,
    results: uniqueByTitle.map(({ _index, ...candidate }) => candidate),
    rejected
  };
}

export { canonicalizeUrl, similarTitle, titleFingerprint, tokenize };
