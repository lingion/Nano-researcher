import type { SearchDiscoveryRecord } from './types.js';

export interface OfficialPolicyEntrance {
  source: string;
  searchUrl: string;
}

export const OFFICIAL_POLICY_ENTRANCES: OfficialPolicyEntrance[] = [
  {
    source: 'gov-cn-policy-library-search',
    searchUrl: 'https://sousuo.www.gov.cn/zcwjk/policyDocumentLibrary',
  },
  {
    source: 'ndrc-policy-search',
    searchUrl: 'https://www.ndrc.gov.cn/xxgk/wjk/index.html',
  },
  {
    source: 'miit-policy-search',
    searchUrl: 'https://www.miit.gov.cn/search/',
  },
];

interface TextResponseLike {
  text(): Promise<string>;
}

interface EntranceFetchOptions {
  fetchImpl?: (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal }) => Promise<TextResponseLike>;
}

function collectSnippetParts(part: unknown): string[] {
  if (typeof part === 'string') {
    return part.trim() === '' ? [] : [part];
  }

  if (typeof part === 'number' || typeof part === 'bigint') {
    return [String(part)];
  }

  if (Array.isArray(part)) {
    return part.flatMap((nestedPart) => collectSnippetParts(nestedPart));
  }

  return [];
}

function buildSnippet(parts: unknown[]): string {
  return parts.flatMap((part) => collectSnippetParts(part)).join(' | ');
}

function absolutizeUrl(url: string, base: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  return new URL(url, base).toString();
}

export function createNdrcPolicySearchProvider(options: EntranceFetchOptions): (query: string, signal?: AbortSignal) => Promise<SearchDiscoveryRecord[]> {
  return async (query: string, signal?: AbortSignal) => {
    if (typeof options.fetchImpl !== 'function') {
      throw new Error('NDRC provider requires fetchImpl.');
    }

    const params = new URLSearchParams({
      qt: query,
      tab: 'all',
      page: '1',
      pageSize: '20',
      siteCode: 'bm04000fgk',
      key: 'CAB549A94CF659904A7D6B0E8FC8A7E9',
      startDateStr: '',
      endDateStr: '',
      timeOption: '0',
      sort: 'dateDesc',
    });

    const response = await options.fetchImpl(`https://fwfx.ndrc.gov.cn/api/query?${params.toString()}`, {
      headers: {
        'user-agent': 'Mozilla/5.0',
        accept: 'application/json,text/plain,*/*',
        referer: `https://www.ndrc.gov.cn/xxgk/wjk/index.html?tab=all&qt=${encodeURIComponent(query)}`,
      },
      signal,
    });

    const payload = JSON.parse(await response.text()) as {
      data?: { resultList?: Array<{ title?: string; url?: string; summary?: string; docDate?: string }> };
    };

    return (payload.data?.resultList ?? [])
      .filter((item) => item.url)
      .map((item) => ({
        query,
        title: item.title ?? 'Untitled result',
        url: item.url as string,
        snippet: buildSnippet([item.docDate, item.summary]),
        source: 'ndrc-policy-search',
      }));
  };
}

export function createMiitPolicySearchProvider(options: EntranceFetchOptions): (query: string, signal?: AbortSignal) => Promise<SearchDiscoveryRecord[]> {
  return async (query: string, signal?: AbortSignal) => {
    if (typeof options.fetchImpl !== 'function') {
      throw new Error('MIIT provider requires fetchImpl.');
    }

    const params = new URLSearchParams({
      websiteid: '110000000000000',
      searchid: '1',
      q: query,
      pg: '10',
      cateid: '47',
      pos: 'title_text,titlepy,infocontent,filenumbername,keyword,contentdescribe',
      pq: '',
      oq: '',
      eq: '',
      begin: '',
      end: '',
      dateField: 'deploytime',
      selectFields: 'title,content,deploytime,_index,url,cdate,infoextends,infocontentattribute,picpath,columnname,themename,publishgroupname,publishtime,metaid,bexxgk,webid,columnid',
      group: 'distinct',
      highlightConfigs: '[{"field":"infocontent","numberOfFragments":2,"fragmentOffset":0,"fragmentSize":30,"noMatchSize":50}]',
      highlightFields: 'title_text,infocontent',
      level: '6',
      sortFields: '[{"name":"deploytime","type":"desc"}]',
      p: '1',
    });

    const response = await options.fetchImpl(`https://www.miit.gov.cn/search-front-server/api/search/info?${params.toString()}`, {
      headers: {
        'user-agent': 'Mozilla/5.0',
        accept: 'application/json,text/plain,*/*',
        referer: `https://www.miit.gov.cn/search/?websiteid=110000000000000&q=${encodeURIComponent(query)}`,
      },
      signal,
    });

    const payload = JSON.parse(await response.text()) as {
      data?: {
        searchResult?: {
          dataResults?: Array<{
            groupData?: Array<{
              data?: {
                title_text?: string;
                title?: string;
                url?: string;
                content?: string;
                deploytime?: string;
              };
            }>;
          }>;
        };
      };
    };

    return (payload.data?.searchResult?.dataResults ?? [])
      .map((item) => item.groupData?.[0]?.data)
      .filter((item): item is { title_text?: string; title?: string; url?: string; content?: string; deploytime?: string } => Boolean(item?.url))
      .map((item) => ({
        query,
        title: item.title_text ?? item.title ?? 'Untitled result',
        url: absolutizeUrl(item.url as string, 'https://www.miit.gov.cn/'),
        snippet: buildSnippet([item.deploytime, item.content]),
        source: 'miit-policy-search',
      }));
  };
}

export function createGovCnPolicyLibraryProvider(options: EntranceFetchOptions): (query: string, signal?: AbortSignal) => Promise<SearchDiscoveryRecord[]> {
  return async (query: string, signal?: AbortSignal) => {
    if (typeof options.fetchImpl !== 'function') {
      throw new Error('gov.cn provider requires fetchImpl.');
    }

    const payload = {
      code: '17da70961a7',
      codes: '',
      configCode: '',
      dataTypeId: '107',
      orderBy: 'related',
      searchBy: 'all',
      appendixType: '',
      granularity: 'ALL',
      trackTotalHits: true,
      isSearchForced: 0,
      filters: [],
      pageNo: 1,
      pageSize: 10,
      customFilter: { operator: 'and', properties: [] },
      searchWord: query,
    };

    const response = await options.fetchImpl(
      'https://sousuoht.www.gov.cn/athena/forward/2B22E8E39E850E17F95A016A74FCB6B673336FA8B6FEC0E2955907EF9AEE06BE',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: {
          'user-agent': 'Mozilla/5.0',
          accept: 'application/json,text/plain,*/*',
          'content-type': 'application/json',
          referer: `https://sousuo.www.gov.cn/wap/search-result?code=17da70961a7&dataTypeId=107&searchWord=${encodeURIComponent(query)}`,
          athenaAppKey: 'Qpu2aqbLGFQobXIa%2FSsLKHdZONHDx983JQ1FbjIsNbQZVq0JvOgqLo1utbIX%2Bq6lG9yxHXXLljvVBCGD7cwlCkXz3FPifE7n6xBuuJHA%2BQIerhvyL4zifYOYFWz3aoweOfx%2BDGJTF0q54dWzzQVAWxG4N0POYQNBTihkSsmODp4%3D',
          athenaAppName: '%E5%9B%BD%E7%BD%91%E6%90%9C%E7%B4%A2',
        },
        signal,
      },
    );

    const body = await response.text();
    const parsed = JSON.parse(body) as {
      result?: {
        data?: {
          middle?: {
            list?: Array<{
              title?: string;
              title_no_tag?: string;
              url?: string;
              summary?: unknown;
              pubcode?: unknown;
              time?: unknown;
            }>;
          };
        };
      };
    };

    return (parsed.result?.data?.middle?.list ?? [])
      .filter((item) => item.url)
      .map((item) => ({
        query,
        title: item.title_no_tag ?? item.title ?? 'Untitled result',
        url: item.url as string,
        snippet: buildSnippet([item.pubcode, item.time, item.summary]),
        source: 'gov-cn-policy-library-search',
      }));
  };
}

export function buildOfficialPolicyEntranceResults(query: string): SearchDiscoveryRecord[] {
  return OFFICIAL_POLICY_ENTRANCES.map((entrance) => ({
    query,
    title: `${entrance.source} search for ${query}`,
    url: `${entrance.searchUrl}?q=${encodeURIComponent(query)}`,
    snippet: `Official nationwide policy entrance for ${query}`,
    source: entrance.source,
  }));
}
