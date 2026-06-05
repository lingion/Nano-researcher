import { normalizePolicyUrl } from './url-normalization.js';

const POLICY_KEYWORDS = ['关于', '通知', '办法', '方案', '规定', '实施', '第', '条', '发文字号', '发布日期', '成文日期'];
const CHROME_BLOCK_PATTERN = /<(header|footer|nav|aside)\b[\s\S]*?<\/\1>/gi;
const CHROME_ATTR_PATTERN = /<([a-z0-9]+)\b(?=[^>]*(?:class|id)\s*=\s*["'][^"']*(?:breadcrumb|share|related|recommend|pagination|comment|login|toolbar|banner|footer|header|position|site-footer|top-nav)[^"']*["'])[^>]*>[\s\S]*?<\/\1>/gi;
const SCRIPT_STYLE_PATTERN = /<(script|style|noscript)\b[\s\S]*?<\/\1>/gi;
const BOILERPLATE_TOKENS = ['登录', '注册', '邮箱', '网站地图', '版权所有', '打印', '收藏', '留言', 'Copyright', 'All rights reserved', '客户端', '微博', '微信', '关闭窗口'];

export function cleanPolicyContent({ html, url, finalUrl, title, contentType = '', maxChars = 12000 }) {
  const sourceHtml = String(html || '');
  const resolvedFinalUrl = finalUrl || url || '';
  const rawText = htmlToText(sourceHtml);
  const metadata = extractPolicyMetadata({ html: sourceHtml, rawText, url, finalUrl: resolvedFinalUrl, title });
  const removedFragments = [];
  let workingHtml = sourceHtml;

  workingHtml = removeBlocks(workingHtml, SCRIPT_STYLE_PATTERN, 'non_content_tag', removedFragments, false);
  workingHtml = removeBlocks(workingHtml, CHROME_BLOCK_PATTERN, 'chrome_block', removedFragments, true);
  workingHtml = removeBlocks(workingHtml, CHROME_ATTR_PATTERN, 'chrome_block', removedFragments, true);

  let cleanedText = htmlToText(workingHtml);
  cleanedText = removeBoilerplateSentences(cleanedText, removedFragments);
  cleanedText = trimLeadingNoise(cleanedText, metadata);
  cleanedText = trimTrailingNoise(cleanedText);
  cleanedText = ensureMetadataAnchors(cleanedText, metadata);

  const cleaningAlerts = buildCleaningAlerts({ rawText, cleanedText, removedFragments });
  if (shouldFallback(rawText, cleanedText, cleaningAlerts)) {
    cleanedText = conservativeClean(rawText);
    cleaningAlerts.push({ code: 'conservative_fallback_applied', sample: cleanedText.slice(0, 160) });
  }

  cleanedText = cleanedText.slice(0, maxChars);

  return {
    raw_text: rawText.slice(0, maxChars),
    cleaned_text: cleanedText,
    metadata,
    removed_fragments: removedFragments.slice(0, 30),
    cleaning_alerts: cleaningAlerts.slice(0, 20),
    cleaning_stats: {
      raw_length: rawText.length,
      cleaned_length: cleanedText.length,
      removed_count: removedFragments.length
    }
  };
}

function removeBlocks(html, pattern, reason, removedFragments, alertOnPolicy) {
  return String(html || '').replace(pattern, (block) => {
    const text = htmlToText(block);
    if (!text) return ' ';
    if (reason === 'chrome_block' && !isLikelyNoiseBlock(block, text)) {
      return block;
    }
    removedFragments.push({ reason, text: text.slice(0, 500), policy_like: alertOnPolicy && hasPolicySignal(text) });
    return ' ';
  });
}

function isLikelyNoiseBlock(html, text) {
  if (!text.trim()) return true;
  const linkCount = (String(html).match(/<a\b/gi) || []).length;
  const tokenHits = BOILERPLATE_TOKENS.filter((token) => text.includes(token)).length;
  if (tokenHits >= 1 && text.length < 260) return true;
  if (linkCount >= 4 && tokenHits >= 1) return true;
  if (/(省政府网站|市政府网站|兄弟开发区|Copyright|网站地图|ICP备|公网安备)/i.test(text)) return true;
  if (/^(首页|中文版|英文版|政务公开|新闻资讯|互动交流|当前位置|分享到)/.test(text) && text.length < 220) return true;
  return false;
}

function removeBoilerplateSentences(text, removedFragments) {
  const chunks = String(text || '').split(/\s{2,}|(?<=。)\s+/).map((part) => part.trim()).filter(Boolean);
  const kept = [];
  for (const chunk of chunks.length ? chunks : [String(text || '').trim()]) {
    if (isBoilerplateChunk(chunk) && !hasPolicySignal(chunk)) {
      removedFragments.push({ reason: 'boilerplate_text', text: chunk.slice(0, 500), policy_like: false });
      continue;
    }
    kept.push(chunk);
  }
  return normalizeSpaces(kept.join(' '));
}

function isBoilerplateChunk(text) {
  if (!text) return false;
  const tokenHits = BOILERPLATE_TOKENS.filter((token) => text.includes(token)).length;
  if (tokenHits >= 2 && text.length < 240) return true;
  if (/(全国人大|全国政协|国务院部门网站|地方政府网站|关于本网|网站声明|联系我们|网站纠错|版权所有|ICP备|公网安备|客户端|小程序|微博|微信)/.test(text) && text.length < 520) return true;
  if (/(省政府网站|市政府网站|兄弟开发区|Copyright|All rights reserved|网站地图|管委会办公邮箱)/i.test(text)) return true;
  return false;
}

function buildCleaningAlerts({ rawText, cleanedText, removedFragments }) {
  const alerts = [];
  for (const fragment of removedFragments) {
    if (fragment.policy_like || hasPolicySignal(fragment.text)) {
      alerts.push({ code: 'policy_significant_removal', reason: fragment.reason, sample: fragment.text.slice(0, 180) });
    }
  }
  if (rawText.length > 0 && cleanedText.length / rawText.length < 0.2) {
    alerts.push({ code: 'high_removal_ratio', sample: cleanedText.slice(0, 180) });
  }
  if (rawText.length > 100 && cleanedText.length < 80) {
    alerts.push({ code: 'cleaned_text_too_short', sample: cleanedText.slice(0, 180) });
  }
  return alerts;
}

function shouldFallback(rawText, cleanedText, alerts) {
  if (!rawText.trim()) return false;
  if (!cleanedText.trim()) return true;
  if (cleanedText.length < 20 && rawText.length > cleanedText.length) return true;
  return alerts.some((alert) => alert.code === 'high_removal_ratio' || alert.code === 'cleaned_text_too_short');
}

function conservativeClean(rawText) {
  const chunks = String(rawText || '').split(/\s+/).filter(Boolean);
  return chunks.filter((chunk) => !isBoilerplateChunk(chunk) || hasPolicySignal(chunk)).join(' ').trim() || String(rawText || '').trim();
}

function ensureMetadataAnchors(text, metadata) {
  const anchors = [metadata.document_number, metadata.issuing_body, metadata.published_at, metadata.effective_at].filter(Boolean);
  let out = String(text || '');
  for (const anchor of anchors) {
    if (anchor && !out.includes(anchor)) out = `${anchor} ${out}`.trim();
  }
  return normalizeSpaces(out);
}

function trimLeadingNoise(text, metadata) {
  let value = String(text || '').trim();
  const anchors = [metadata.document_number, metadata.issuing_body, '索 引 号', '各省', '各市', '国务院办公厅关于', '关于印发《'].filter(Boolean);
  let best = -1;
  for (const anchor of anchors) {
    const index = value.indexOf(anchor);
    if (index > 0 && (best === -1 || index < best)) best = index;
  }
  if (best > 0 && best < 500) value = value.slice(best).trim();
  return value;
}

function trimTrailingNoise(text) {
  const markers = ['登录 注册', '链接： 全国人大', '省政府网站', '市政府网站', 'Copyright©', 'Copyright'];
  let value = String(text || '').trim();
  let cut = -1;
  for (const marker of markers) {
    const index = value.indexOf(marker);
    if (index > 0 && (cut === -1 || index < cut)) cut = index;
  }
  if (cut > 0) value = value.slice(0, cut).trim();
  return value;
}

function extractPolicyMetadata({ html, rawText, url, finalUrl, title }) {
  const resolvedTitle = cleanText(title || matchText(html, /<title[^>]*>([\s\S]*?)<\/title>/i) || '');
  const text = rawText || htmlToText(html);
  return {
    title: resolvedTitle,
    source_domain: safeHostname(finalUrl || url),
    normalized_url: normalizePolicyUrl(finalUrl || url || ''),
    document_number: firstMatch(text, [/发文字号[:：]\s*([^\s]+〔\d{4}〕\d+号)/, /([一-龥]{1,12}〔\d{4}〕\d+号)/]),
    issuing_body: firstMatch(text, [/发文机关[:：]\s*([^\s]+(?:办公厅|委员会|财政厅|政府|部门|单位)?)/, /(国务院办公厅|黑龙江省发展和改革委员会|黑龙江省财政厅)/]),
    published_at: firstMatch(text, [/发布日期[:：]\s*([0-9]{4}年\d{1,2}月\d{1,2}日)/, /发布时间[:：]\s*([0-9]{4}-\d{1,2}-\d{1,2})/]),
    effective_at: firstMatch(text, [/成文日期[:：]\s*([0-9]{4}年\d{1,2}月\d{1,2}日)/])
  };
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match) return cleanText(match[1] || match[0]);
  }
  return '';
}

function matchText(text, pattern) {
  const match = String(text || '').match(pattern);
  return match ? match[1] || '' : '';
}

function hasPolicySignal(text) {
  const value = String(text || '');
  if (/第[一二三四五六七八九十\d]+条/.test(value)) return true;
  if (/[一二三四五六七八九十]、/.test(value) && /(支持|实施|推进|政策|补贴|更新|发展)/.test(value)) return true;
  return POLICY_KEYWORDS.filter((token) => value.includes(token)).length >= 2;
}

function htmlToText(html) {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+([.,;:!?，。；：！？])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value) {
  return htmlToText(String(value || '')).replace(/[\x00-\x1f\x7f]/g, (c) => c === '\n' ? '\n' : c === '\r' ? '' : c === '\t' ? ' ' : '');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;|&ensp;|&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeHostname(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}
