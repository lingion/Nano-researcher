import { parseQuery } from "./query/query-parser.js";

const TRACKING_PARAMETERS = /^(utm_|gclid$|fbclid$|mc_cid$|mc_eid$)/i;
const DEFAULT_RRF_K = 60;

function emptyRejected() {
  return { invalid: 0, wrapper: 0, quality: 0, constraint: 0, relevance: 0, duplicate: 0 };
}

function hasExplicitSourceProvenance(candidate) {
  return Boolean(candidate?.sourceProvenance && typeof candidate.sourceProvenance === "object" && Object.keys(candidate.sourceProvenance).length > 0);
}

function lexicalChunks(value) {
  const normalized = String(value ?? "").toLocaleLowerCase();
  return normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? [];
}

function normalizeCjkFormatting(value) {
  return String(value ?? "")
    .toLocaleLowerCase()
    .replace(/(?<!\p{Script=Han})(?:\p{Script=Han}\s+){2,}\p{Script=Han}(?!\p{Script=Han})/gu, (match) => match.replace(/\s+/g, ""));
}

function tokenize(value) {
  return lexicalChunks(value).flatMap((chunk) => /^\p{Script=Han}+$/u.test(chunk) ? Array.from(chunk) : [chunk]);
}

function tokenizeForRanking(value) {
  return lexicalChunks(value).flatMap((chunk) => {
    if (!/^\p{Script=Han}+$/u.test(chunk)) return [chunk];
    const characters = Array.from(chunk);
    if (characters.length < 2) return characters;
    return [
      chunk,
      ...characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`),
    ];
  });
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
  if (candidate.unresolvedWrapper === true) return true;
  if (candidate.resolvedUrl) return false;
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if ((host === "www.sogou.com" || host === "sogou.com" || host === "wap.sogou.com" || host === "m.sogou.com") && parsed.pathname.startsWith("/link")) return true;
  if ((host === "www.baidu.com" || host === "baidu.com" || host === "m.baidu.com") &&
      (parsed.pathname.startsWith("/link") || parsed.pathname.startsWith("/baidu.php"))) return true;
  return candidate.provider === "bing" && host.endsWith("bing.com") &&
    (parsed.pathname.startsWith("/ck/") || parsed.pathname.startsWith("/aclick"));
}

function contains(value, needle) {
  const normalizedValue = normalizeCjkFormatting(value);
  const normalizedNeedle = normalizeCjkFormatting(needle);
  if (normalizedValue.includes(normalizedNeedle)) return true;
  if (!/^\p{Script=Han}{2,}$/u.test(normalizedNeedle)) return false;
  const spacedPattern = Array.from(normalizedNeedle)
    .map((character) => character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join("\\s*");
  return new RegExp(spacedPattern, "u").test(String(value ?? ""));
}

function matchesTerm(text, tokens, term) {
  const normalized = String(term).toLocaleLowerCase();
  return normalized.includes(" ") ? contains(text, normalized) : tokens.includes(normalized) || contains(text, normalized);
}

function bm25(queryTokens, fieldTokens, boost, idfByToken, averageFieldLength, documentCount) {
  if (!queryTokens.length || !fieldTokens.length) return 0;
  const counts = new Map();
  for (const token of fieldTokens) counts.set(token, (counts.get(token) || 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  const norm = 1 - b + b * (fieldTokens.length / Math.max(1, averageFieldLength));
  let score = 0;
  for (const term of queryTokens) {
    const frequency = counts.get(term) || 0;
    if (!frequency) continue;
    const documentFrequency = idfByToken.get(term) || 0;
    const idf = documentFrequency
      ? Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5))
      : Math.log(1 + (documentCount + 0.5) / 0.5);
    score += boost * idf * ((frequency * (k1 + 1)) / (frequency + k1 * norm));
  }
  return score;
}

function buildTermStatistics(items) {
  const documents = new Map();
  for (const item of items) {
    if (documents.has(item.candidate.url)) continue;
    documents.set(item.candidate.url, item);
  }
  const documentFrequency = new Map();
  for (const item of documents.values()) {
    for (const token of new Set(tokenizeForRanking(item.text))) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  const corpus = [...documents.values()];
  const averageFieldLength = (field) => {
    if (!corpus.length) return 1;
    return corpus.reduce((total, item) => total + tokenizeForRanking(field(item)).length, 0) / corpus.length;
  };
  return {
    documentCount: Math.max(1, corpus.length),
    documentFrequency,
    averageFieldLength: {
      title: averageFieldLength((item) => item.candidate.title),
      snippet: averageFieldLength((item) => item.candidate.snippet),
      url: averageFieldLength((item) => item.candidate.displayUrl || item.candidate.url),
    },
  };
}

function validDate(year, month, day) {
  const value = Date.UTC(year, month - 1, day);
  const date = new Date(value);
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
    ? value
    : null;
}

function monthEnd(year, month) {
  const nextMonth = month === 12 ? validDate(year + 1, 1, 1) : validDate(year, month + 1, 1);
  return nextMonth === null ? null : nextMonth - 1;
}

function queryDateRange(query, nowMs) {
  if (query.filters?.after || query.filters?.before) return null;
  const matches = [...String(query.text ?? '').matchAll(/(20\d{2})年(\d{1,2})月(?:(\d{1,2})日)?/gu)]
    .map((match) => ({ year: Number(match[1]), month: Number(match[2]), day: match[3] ? Number(match[3]) : 1 }));
  if (!matches.length) return null;
  const first = matches[0];
  const start = validDate(first.year, first.month, first.day);
  if (start === null) return null;
  const last = matches.length > 1 ? matches[1] : first;
  let end = matches.length > 1 && last.day !== 1
    ? validDate(last.year, last.month, last.day)
    : monthEnd(last.year, last.month);
  if (/(?:至今|到现在|截至当前|当前)/u.test(query.text)) {
    const now = new Date(nowMs);
    end = validDate(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
    if (end !== null) end += 86_400_000 - 1;
  }
  return end === null || end < start ? null : { start, end };
}

function createDateRange(start, end, precision, source) {
  return { start, end, precision, source };
}

function monthRange(year, month, source) {
  const start = validDate(year, month, 1);
  const end = monthEnd(year, month);
  return start === null || end === null ? null : createDateRange(start, end, "month", source);
}

function yearRange(year, source) {
  const start = validDate(year, 1, 1);
  const end = validDate(year + 1, 1, 1);
  return start === null || end === null
    ? null
    : createDateRange(start, end - 1, "year", source);
}

function extractCandidateDateEvidence(candidate) {
  const structuredFields = ["publishedAt", "updatedAt"];
  for (const field of structuredFields) {
    const timestamp = Date.parse(String(candidate[field] || ""));
    if (Number.isFinite(timestamp)) {
      return {
        ranges: [createDateRange(timestamp, timestamp, "exact", field)],
        primary: timestamp,
      };
    }
  }

  const ranges = [];
  const addRange = (range) => {
    if (!range || ranges.some((existing) => existing.start === range.start && existing.end === range.end && existing.precision === range.precision)) return;
    ranges.push(range);
  };
  const sources = [
    ["title", String(candidate.title || "")],
    ["snippet", String(candidate.snippet || "")],
    ["url", String(candidate.displayUrl || candidate.url || "")],
  ];
  const numericPattern = /(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/g;
  const chinesePattern = /(20\d{2})\u5e74(\d{1,2})\u6708(\d{1,2})(?:\u65e5)?/g;
  const monthPattern = /(20\d{2})\u5e74(\d{1,2})\u6708/g;

  for (const [source, value] of sources) {
    for (const match of value.matchAll(numericPattern)) {
      const timestamp = validDate(Number(match[1]), Number(match[2]), Number(match[3]));
      if (timestamp !== null) addRange(createDateRange(timestamp, timestamp, "exact", source));
    }
    for (const match of value.matchAll(chinesePattern)) {
      const timestamp = validDate(Number(match[1]), Number(match[2]), Number(match[3]));
      if (timestamp !== null) addRange(createDateRange(timestamp, timestamp, "exact", source));
    }
    for (const match of value.matchAll(monthPattern)) {
      addRange(monthRange(Number(match[1]), Number(match[2]), source));
    }
  }

  // A year without a month is only a broad context signal. It must not be
  // treated as an exact publication date or hard-filter a month query.
  for (const [source, value] of sources.filter(([name]) => name === "title" || name === "url")) {
    for (const match of value.matchAll(/\b(20\d{2})\b/g)) {
      addRange(yearRange(Number(match[1]), source));
    }
  }

  if (!ranges.length) return null;
  const exactOrMonth = ranges.filter(({ precision }) => precision === "exact" || precision === "month");
  const primaryRange = exactOrMonth[0] || ranges[0];
  return { ranges, primary: primaryRange.start };
}

function rangesOverlap(left, right) {
  return left.start <= right.end && right.start <= left.end;
}

function hasActionableDateOutsideWindow(evidence, requestedRange) {
  if (!evidence) return false;
  const actionable = evidence.ranges.filter(({ precision, source }) =>
    (precision === "exact" || precision === "month") && source !== "snippet");
  return actionable.length > 0 && actionable.every((range) => !rangesOverlap(range, requestedRange));
}

function dateEvidenceMatchesWindow(evidence, requestedRange) {
  return Boolean(evidence?.ranges
    .filter(({ precision, source }) =>
      (precision === "exact" || precision === "month") && source !== "snippet")
    .some((range) => rangesOverlap(range, requestedRange)));
}

function contentDateEvidenceMatchesWindow(evidence, requestedRange) {
  return Boolean(evidence?.ranges
    .filter(({ precision, source }) =>
      (precision === "exact" || precision === "month") && source === "snippet")
    .some((range) => rangesOverlap(range, requestedRange)));
}

function contentDateEvidenceOutsideWindow(evidence, requestedRange) {
  const contentDates = evidence?.ranges.filter(({ precision, source }) =>
    (precision === "exact" || precision === "month") && source === "snippet") ?? [];
  return contentDates.length > 0 && contentDates.every((range) => !rangesOverlap(range, requestedRange));
}

function broadDateEvidenceMatchesWindow(evidence, requestedRange) {
  return Boolean(evidence?.ranges.some((range) => rangesOverlap(range, requestedRange)));
}

function hasFreshnessSignal(query) {
  return /(?:\blatest\b|\brecent(?:ly)?\b|\btoday\b|\bnow\b|\u6700\u65b0|\u6700\u8fd1|\u8fd1\u671f|\u4eca\u65e5|\u521a\u521a|\u5f53\u524d|\u76ee\u524d)/iu.test(query.text);
}

function pageShape(candidate) {
  try {
    const pathname = new URL(candidate.url).pathname.toLowerCase().replace(/\/+$/, "");
    const segments = pathname.split("/").filter(Boolean);
    const last = segments.at(-1) || "";
    if (!segments.length) return "home";
    if (/(?:^|[-_])(tag|tags|topic|topics|category|categories|channel|channels|column|columns|user|users|search)(?:$|[-_])/u.test(last) ||
        /\/(?:tag|tags|topic|topics|category|categories|channel|channels|column|columns|user|users|search)(?:\/|$)/u.test(pathname)) {
      if (/\/(?:user|users)(?:\/|$)/u.test(pathname) || /(?:^|[-_])users?(?:$|[-_])/u.test(last)) return "user";
      if (/\/(?:tag|tags)(?:\/|$)/u.test(pathname) || /(?:^|[-_])tags?(?:$|[-_])/u.test(last)) return "tag";
      if (/\/(?:topic|topics)(?:\/|$)/u.test(pathname) || /(?:^|[-_])topics?(?:$|[-_])/u.test(last)) return "topic";
      if (/\/(?:category|categories)(?:\/|$)/u.test(pathname) || /(?:^|[-_])categories?(?:$|[-_])/u.test(last)) return "category";
      if (/\/(?:column|columns)(?:\/|$)/u.test(pathname) || /(?:^|[-_])columns?(?:$|[-_])/u.test(last)) return "column";
      if (/\/(?:channel|channels)(?:\/|$)/u.test(pathname) || /(?:^|[-_])channels?(?:$|[-_])/u.test(last)) return "channel";
      return "search";
    }
    if (/\/(?:index|list|news|home|default)(?:\.[a-z0-9]+)?$/u.test(pathname)) return "list";
    return "detail";
  } catch {
    return "unknown";
  }
}

function pageShapeScore(candidate) {
  switch (pageShape(candidate)) {
    case "user": return -3.5;
    case "tag":
    case "topic":
    case "category":
    case "channel":
    case "column":
    case "search": return -3;
    case "list":
    case "home": return -2;
    default: return 0;
  }
}

function freshnessScore(query, candidate, dateEvidence, nowMs) {
  const requestedRange = queryDateRange(query, nowMs);
  if (requestedRange) {
    if (!dateEvidence) return -0.5;
    if (hasActionableDateOutsideWindow(dateEvidence, requestedRange)) return -4;
    if (dateEvidenceMatchesWindow(dateEvidence, requestedRange)) return 1.5;
    if (contentDateEvidenceMatchesWindow(dateEvidence, requestedRange)) return 0.5;
    if (contentDateEvidenceOutsideWindow(dateEvidence, requestedRange)) return -0.5;
    if (broadDateEvidenceMatchesWindow(dateEvidence, requestedRange)) return 0;
    return -0.25;
  }
  if (!hasFreshnessSignal(query)) return 0;
  const candidateDate = dateEvidence?.primary ?? null;
  let score = candidateDate === null
    ? -0.75
    : 2 - Math.max(0, (nowMs - candidateDate) / 86_400_000) / 90;
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

function passesConstraints(candidate, query, text, tokens, dateEvidence, nowMs) {
  if (query.diagnostics?.some(({ code }) => code === "invalid_date" || code === "empty_filter")) return false;
  if (query.phrases.some((phrase) => !contains(text, phrase))) return false;
  if (query.required.some((term) => !matchesTerm(text, tokens, term))) return false;
  if (query.anyOf?.some((group) => !group.some((term) => matchesTerm(text, tokens, term)))) return false;
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
  if ((afterDate !== null || beforeDate !== null) && !dateEvidence) return false;
  const requestedFilterRange = afterDate !== null || beforeDate !== null
    ? { start: afterDate ?? Number.NEGATIVE_INFINITY, end: beforeDate ?? Number.POSITIVE_INFINITY }
    : null;
  if (requestedFilterRange && !dateEvidenceMatchesWindow(dateEvidence, requestedFilterRange)) return false;
  const requestedRange = queryDateRange(query, nowMs);
  if (requestedRange && hasActionableDateOutsideWindow(dateEvidence, requestedRange)) return false;
  return true;
}

function scoreCandidate(candidate, query, text, dateEvidence, nowMs, queryTokens, termStatistics) {
  const titleTokens = tokenizeForRanking(candidate.title);
  const snippetTokens = tokenizeForRanking(candidate.snippet);
  const urlTokens = tokenizeForRanking(candidate.displayUrl || candidate.url);
  const allTokens = new Set([...titleTokens, ...snippetTokens, ...urlTokens]);
  const totalQueryWeight = queryTokens.reduce((total, token) => {
    const documentFrequency = termStatistics.documentFrequency.get(token) || 0;
    const idf = documentFrequency
      ? Math.log(1 + (termStatistics.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5))
      : Math.log(1 + (termStatistics.documentCount + 0.5) / 0.5);
    return total + idf;
  }, 0);
  const matchedQueryWeight = queryTokens.reduce((total, token) => {
    if (!allTokens.has(token)) return total;
    const documentFrequency = termStatistics.documentFrequency.get(token) || 0;
    const idf = documentFrequency
      ? Math.log(1 + (termStatistics.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5))
      : Math.log(1 + (termStatistics.documentCount + 0.5) / 0.5);
    return total + idf;
  }, 0);
  const coverage = totalQueryWeight ? matchedQueryWeight / totalQueryWeight : 0;
  const lexical = bm25(queryTokens, titleTokens, 3.2, termStatistics.documentFrequency, termStatistics.averageFieldLength.title, termStatistics.documentCount) +
    bm25(queryTokens, snippetTokens, 1.2, termStatistics.documentFrequency, termStatistics.averageFieldLength.snippet, termStatistics.documentCount) +
    bm25(queryTokens, urlTokens, 0.2, termStatistics.documentFrequency, termStatistics.averageFieldLength.url, termStatistics.documentCount);
  const explicitPhraseMatches = [...query.phrases, ...query.required.filter((term) => term.includes(" "))]
    .filter((term) => contains(text, term)).length * 4;
  const explicitPhraseTerms = new Set([
    ...query.phrases,
    ...query.required.filter((term) => term.includes(" ")),
  ].map((term) => String(term).toLocaleLowerCase()));
  const contiguousCjkTermMatches = lexicalChunks(query.text)
    .filter((term) => /^\p{Script=Han}{2,}$/u.test(term))
    .filter((term) => !explicitPhraseTerms.has(term))
    .filter((term) => contains(text, term)).length * 3;
  const phrase = explicitPhraseMatches + contiguousCjkTermMatches;
  const sourceAuthority = candidate.sourceProvenance?.authorityScore ?? candidate.authorityScore;
  const authority = Math.max(0, Math.min(1, Number(sourceAuthority) || 0)) * 2;
  const freshness = freshnessScore(query, candidate, dateEvidence, nowMs);
  const pageShapeType = pageShape(candidate);
  const pageShapePenalty = pageShapeScore(candidate);
  // Provider rank is fused once below. Keeping it out of the representative's
  // lexical score prevents the same signal from being counted twice.
  const baseScore = lexical + phrase + coverage * 1.5 + authority + freshness + pageShapePenalty;
  return {
    score: baseScore,
    baseScore,
    scoreBreakdown: { lexical, phrase, coverage: coverage * 1.5, authority, freshness, pageShape: pageShapePenalty, pageShapeType }
  };
}

function reciprocalRankFusion(occurrences, k) {
  const bestRankByProvider = new Map();
  for (const [index, occurrence] of occurrences.entries()) {
    const provider = String(occurrence.provider || occurrence.sourceFamily || `anonymous-${index}`).trim();
    const parsedRank = Number(occurrence.providerRank);
    const rank = Number.isFinite(parsedRank) && parsedRank > 0 ? parsedRank : 1;
    const previous = bestRankByProvider.get(provider);
    if (previous === undefined || rank < previous) bestRankByProvider.set(provider, rank);
  }
  const providerRanks = Object.fromEntries([...bestRankByProvider.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const rrfScore = [...bestRankByProvider.values()].reduce((score, rank) => score + 1 / (k + rank), 0);
  return { rrfScore, providerRanks, providerCount: bestRankByProvider.size };
}

export function rankCandidates(inputCandidates, rawQuery, options = {}) {
  const query = typeof rawQuery === "string" ? parseQuery(rawQuery) : rawQuery;
  const requestedNow = Date.parse(String(options.now || ""));
  const nowMs = Number.isFinite(requestedNow) ? requestedNow : Date.now();
  const requestedRrfK = Number(options.rrfK);
  const rrfK = Number.isFinite(requestedRrfK) && requestedRrfK > 0 ? requestedRrfK : DEFAULT_RRF_K;
  const rejected = emptyRejected();
  const groups = new Map();
  const pending = [];
  const queryTokens = [...new Set(tokenizeForRanking(query.text))];
  const sourceCandidates = Array.isArray(inputCandidates) ? inputCandidates : [];
  const inputExplicitProvenanceCount = sourceCandidates.filter(hasExplicitSourceProvenance).length;

  for (const [index, input] of sourceCandidates.entries()) {
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
    const candidate = {
      ...input,
      url,
      title,
      snippet,
      displayUrl: input.displayUrl || url
    };
    const text = `${title} ${snippet} ${candidate.displayUrl}`.toLocaleLowerCase();
    const tokens = tokenize(text);
    const dateEvidence = extractCandidateDateEvidence(candidate);
    if (!passesConstraints(candidate, query, text, tokens, dateEvidence, nowMs)) {
      rejected.constraint += 1;
      continue;
    }
    const occurrence = {
      provider: candidate.provider,
      sourceFamily: candidate.sourceFamily,
      providerRank: candidate.providerRank ?? candidate.rank ?? index + 1,
    };
    pending.push({ candidate, text, dateEvidence, index, occurrence });
  }

  const termStatistics = buildTermStatistics(pending);
  for (const item of pending) {
    const { candidate, text, dateEvidence, index, occurrence } = item;
    const scored = { ...candidate, ...scoreCandidate(candidate, query, text, dateEvidence, nowMs, queryTokens, termStatistics), _index: index };
    const coreRelevance = scored.baseScore - (Number(scored.scoreBreakdown?.pageShape) || 0);
    if (queryTokens.length > 0 && coreRelevance <= 0) {
      rejected.relevance += 1;
      continue;
    }
    const existing = groups.get(candidate.url);
    if (!existing) {
      groups.set(candidate.url, { representative: scored, occurrences: [occurrence] });
      continue;
    }
    rejected.duplicate += 1;
    existing.occurrences.push(occurrence);
    if (scored.baseScore > existing.representative.baseScore) existing.representative = scored;
  }

  const accepted = [...groups.values()].map(({ representative, occurrences }) => {
    const fusion = reciprocalRankFusion(occurrences, rrfK);
    return {
      ...representative,
      score: representative.baseScore + fusion.rrfScore,
      scoreBreakdown: {
        ...representative.scoreBreakdown,
        fusion: fusion.rrfScore,
        rrf: fusion.rrfScore,
      },
      metadata: {
        ...(representative.metadata && typeof representative.metadata === 'object' ? representative.metadata : {}),
        fusion: {
          rrfK,
          rrfScore: fusion.rrfScore,
          providerCount: fusion.providerCount,
          providerRanks: fusion.providerRanks,
        },
      },
    };
  });
  accepted.sort((left, right) => right.score - left.score || right.baseScore - left.baseScore || left.url.localeCompare(right.url));
  const results = accepted.map(({ _index, baseScore, ...candidate }) => candidate);
  return {
    query,
    results,
    rejected,
    candidateQuality: {
      inputCount: sourceCandidates.length,
      uniqueResultCount: results.length,
      rejectionCounts: {
        invalidUrl: rejected.invalid,
        unresolvedWrapper: rejected.wrapper,
        missingText: rejected.quality,
        queryConstraint: rejected.constraint,
        lowRelevance: rejected.relevance,
        duplicateUrl: rejected.duplicate,
      },
      inputExplicitProvenanceCount,
      uniqueExplicitProvenanceCount: results.filter(hasExplicitSourceProvenance).length,
    }
  };
}

export { canonicalizeUrl, similarTitle, titleFingerprint, tokenize };
