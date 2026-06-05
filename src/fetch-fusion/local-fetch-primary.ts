import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

import type { FetchEvidenceClues, FetchedPageRecord } from './types.js';

export function normalizeFetchedPage(input: FetchedPageRecord): FetchedPageRecord {
  const normalized: FetchedPageRecord = {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    title: input.title,
    content: input.content,
    backend: input.backend,
    evidence_clues: input.evidence_clues ?? {
      is_suspected_reprint: false,
      extracted_doc_no: null,
      potential_official_urls: [],
    },
  };

  if (input.kerry_cleaning) {
    normalized.kerry_cleaning = input.kerry_cleaning;
  }

  return normalized;
}

export function normalizeDocumentNumber(rawDocNo: string | null): string | null {
  if (!rawDocNo) {
    return null;
  }

  return rawDocNo
    .replace(/[\s ]+/g, '')
    .replace(/[\[\{\(【]/g, '〔')
    .replace(/[\]\}\)】]/g, '〕');
}

function cleanGovernmentContent(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => !/^(首页导航|登录|注册)$/i.test(line))
    .filter((line) => !/^(首页导航|登录|注册)\b/i.test(line))
    .filter((line) => !/^(首页导航|登录|注册)(\s+|$)/i.test(line))
    .filter((line) => !/(上一篇|下一篇)/i.test(line))
    .filter((line) => !/(热门解读|相关推荐)/i.test(line))
    .join('\n');
}

function extractPotentialOfficialUrls(html: string, url: string): string[] {
  try {
    const dom = new JSDOM(html, { url });
    const urls = Array.from(dom.window.document.querySelectorAll('a[href]'))
      .map((anchor) => anchor.getAttribute('href') ?? '')
      .map((href) => {
        try {
          return new URL(href, url).toString();
        } catch {
          return '';
        }
      })
      .filter((href) => /\.gov\.cn(?=\/|$)/i.test(href));

    return Array.from(new Set(urls));
  } catch {
    return [];
  }
}

function extractDocumentNumber(text: string): string | null {
  const normalizedText = text.replace(/[\s ]+/g, '');
  const match = normalizedText.match(/[一-龥]{1,12}(?:发|规|办发|字|函|通|〔)\[(?:20\d{2})\]\d+号|[一-龥]{1,12}(?:发|规|办发|字|函|通)?〔20\d{2}〕\d+号/u);
  return match?.[0] ?? null;
}

function buildEvidenceClues(args: {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  content: string;
  html?: string;
}): FetchEvidenceClues {
  const combinedText = `${args.title}\n${args.content}`;
  const lowerUrl = `${args.requestedUrl} ${args.finalUrl}`.toLowerCase();
  const isOfficialPage = /\.gov\.cn(?=\/|$)/i.test(args.finalUrl);
  const suspectedReprintByText = /转载|来源[:：]|日报|晚报|新闻网|news/i.test(combinedText);
  const suspectedReprintByUrl = !isOfficialPage && /(news|media|reprint)/i.test(lowerUrl);

  return {
    is_suspected_reprint: suspectedReprintByText || suspectedReprintByUrl,
    extracted_doc_no: normalizeDocumentNumber(extractDocumentNumber(combinedText)),
    potential_official_urls: args.html ? extractPotentialOfficialUrls(args.html, args.finalUrl) : [],
  };
}

function extractMainArticle(html: string, url: string): { title: string; content: string } {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (!article) {
      return { title: '', content: '' };
    }

    const articleDom = new JSDOM(article.content);
    const text = articleDom.window.document.body?.textContent ?? '';

    return {
      title: article.title?.trim() ?? '',
      content: cleanGovernmentContent(text),
    };
  } catch {
    return { title: '', content: '' };
  }
}

export async function fetchWithLocalPrimary(
  url: string,
  maxChars = 20000,
  options: {
    fetchImpl?: (url: string, init?: { headers?: Record<string, string> }) => Promise<{ text: () => Promise<string>; url?: string }>;
  } = {},
): Promise<FetchedPageRecord> {
  const webFetch = (globalThis as {
    WebFetch?: (input: { url: string; prompt: string }) => Promise<{
      content?: string;
      finalUrl?: string;
      title?: string;
    } | string>;
  }).WebFetch;

  const prompt = `Fetch this page and return the main policy text. Limit output to about ${maxChars} characters. Focus on the official body content and skip site chrome, login links, and prev/next navigation.`;

  if (typeof webFetch === 'function') {
    try {
      const response = await webFetch({
        url,
        prompt,
      });

      if (typeof response === 'string') {
        const content = cleanGovernmentContent(response).slice(0, maxChars);
        return normalizeFetchedPage({
          requestedUrl: url,
          finalUrl: url,
          title: '',
          content,
          backend: 'local-fetch-primary',
          evidence_clues: buildEvidenceClues({
            requestedUrl: url,
            finalUrl: url,
            title: '',
            content,
          }),
        });
      }

      const content = cleanGovernmentContent(response.content ?? '').slice(0, maxChars);
      const finalUrl = response.finalUrl ?? url;
      const title = response.title ?? '';

      return normalizeFetchedPage({
        requestedUrl: url,
        finalUrl,
        title,
        content,
        backend: 'local-fetch-primary',
        evidence_clues: buildEvidenceClues({
          requestedUrl: url,
          finalUrl,
          title,
          content,
        }),
      });
    } catch (error) {
      if (typeof options.fetchImpl !== 'function') {
        throw error;
      }
    }
  }

  if (typeof options.fetchImpl !== 'function') {
    throw new Error('WebFetch is not available in this runtime.');
  }

  const fallbackResponse = await options.fetchImpl(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      referer: 'https://www.baidu.com/',
    },
  });
  const fallbackText = await fallbackResponse.text();
  const finalUrl = fallbackResponse.url ?? url;
  const extracted = extractMainArticle(fallbackText, finalUrl);
  const content = (extracted.content || cleanGovernmentContent(fallbackText)).slice(0, maxChars);
  const title = extracted.title || (() => {
    try {
      const dom = new JSDOM(fallbackText, { url: finalUrl });
      return dom.window.document.title?.trim() ?? '';
    } catch {
      return '';
    }
  })();

  return normalizeFetchedPage({
    requestedUrl: url,
    finalUrl,
    title,
    content,
    backend: 'local-fetch-primary',
    evidence_clues: buildEvidenceClues({
      requestedUrl: url,
      finalUrl,
      title,
      content,
      html: fallbackText,
    }),
  });
}
