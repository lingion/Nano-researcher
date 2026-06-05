export interface AutoWebSearchArgs {
  auto_mode: 'full';
  engines: string[];
}

export interface PolicySearchRoutingContext {
  category_bundle_routed: 'policy' | 'general';
  targeted_official_domains: string[];
}

export interface SearchQualityAssessment {
  status: 'green' | 'yellow' | 'blocked' | 'empty' | 'red' | 'junk' | 'intent_mismatch';
  reason: string;
}

interface SearchSourceDefinition {
  id: string;
  groups: Array<'general' | 'china-web' | 'china-news' | 'reference' | 'research' | 'news' | 'developer' | 'location' | 'knowledge'>;
}

interface SearchLikeResult {
  title?: string;
  url?: string;
  snippet?: string;
  source?: string;
  query?: string;
  policy_grade?: string;
}

const SEARCH_SOURCE_REGISTRY: SearchSourceDefinition[] = [
  { id: 'baidu', groups: ['china-web'] },
  { id: 'sogou', groups: ['china-web'] },
  { id: 'bing', groups: ['general', 'china-web', 'research', 'news', 'developer', 'location', 'knowledge'] },
  { id: 'bing_news', groups: ['china-news', 'news'] },
  { id: 'sina_news', groups: ['china-news'] },
  { id: '163_news', groups: ['china-news'] },
  { id: 'bbc', groups: ['news'] },
  { id: 'google', groups: ['general', 'research', 'news', 'developer', 'location', 'knowledge'] },
  { id: 'yahoo', groups: ['general'] },
  { id: 'duckduckgo', groups: ['general', 'research', 'news', 'developer', 'location', 'knowledge'] },
  { id: 'wikipedia', groups: ['reference', 'research', 'news', 'developer', 'location', 'knowledge'] },
  { id: 'wikidata', groups: ['reference', 'location', 'knowledge'] },
  { id: 'github_repos', groups: ['reference', 'developer'] },
  { id: 'archive', groups: ['reference'] },
  { id: 'arxiv', groups: ['research'] },
  { id: 'crossref', groups: ['research'] },
  { id: 'npm', groups: ['developer'] },
  { id: 'stackoverflow', groups: ['developer'] },
  { id: 'osm', groups: ['location'] },
];

function pickSourcesByGroups(groups: SearchSourceDefinition['groups'][number][]): string[] {
  return SEARCH_SOURCE_REGISTRY
    .filter((source) => source.groups.some((group) => groups.includes(group)))
    .map((source) => source.id);
}

function isPolicyQuery(query: string): boolean {
  return /政策|办法|通知|意见|细则|招商|扶持|政府|gov\.cn|免申即享|补贴|申报|兑现/i.test(query.toLowerCase());
}

export function buildPolicySearchRoutingContext(query: string): PolicySearchRoutingContext {
  if (isPolicyQuery(query)) {
    return {
      category_bundle_routed: 'policy',
      targeted_official_domains: ['gov.cn'],
    };
  }

  return {
    category_bundle_routed: 'general',
    targeted_official_domains: [],
  };
}

export function assessSearchResponseQuality(
  query: string,
  results: SearchLikeResult[],
): SearchQualityAssessment {
  if (results.length === 0) {
    return {
      status: 'empty',
      reason: 'No results were returned for the query.',
    };
  }

  const haystacks = results.map((result) => `${result.title ?? ''} ${result.snippet ?? ''} ${result.url ?? ''}`.toLowerCase());
  const offTopicCount = haystacks.filter((haystack) => /租房|广告|招聘|flights|机票|航班|酒店/.test(haystack)).length;
  const policyLikeCount = haystacks.filter((haystack) => /政策|通知|办法|意见|细则|gov\.cn/.test(haystack)).length;

  if (isPolicyQuery(query) && policyLikeCount === 0 && offTopicCount > 0) {
    return {
      status: 'intent_mismatch',
      reason: 'policy-intent query returned mostly off-topic commercial or travel results.',
    };
  }

  if (offTopicCount === results.length) {
    return {
      status: 'junk',
      reason: 'Result pool is dominated by junk or off-topic pages.',
    };
  }

  return {
    status: 'green',
    reason: 'Search results look usable for the requested query.',
  };
}

export function buildDefaultAutoWebSearchArgs(query: string): AutoWebSearchArgs {
  const normalized = query.toLowerCase();

  if (/biography|profile|who is|founder|ceo|person|company profile/i.test(normalized)) {
    return {
      auto_mode: 'full',
      engines: ['wikidata', 'wikipedia', 'bing', 'google', 'duckduckgo'],
    };
  }

  if (/address|map|maps|location|near me|where is|latitude|longitude/i.test(normalized)) {
    return {
      auto_mode: 'full',
      engines: ['osm', 'wikidata', 'wikipedia', 'bing', 'google', 'duckduckgo'],
    };
  }

  if (/github|repo|repository|npm|package|stackoverflow|library|framework/i.test(normalized)) {
    return {
      auto_mode: 'full',
      engines: ['github_repos', 'npm', 'stackoverflow', 'bing', 'google', 'duckduckgo', 'wikipedia'],
    };
  }

  if (/latest|breaking|news|funding|layoffs|launch|announcement|update/i.test(normalized)) {
    return {
      auto_mode: 'full',
      engines: ['bing_news', 'bbc', 'bing', 'google', 'duckduckgo', 'wikipedia'],
    };
  }

  if (/arxiv|paper|papers|doi|citation|research|study|retrieval augmented generation/i.test(normalized)) {
    return {
      auto_mode: 'full',
      engines: ['arxiv', 'crossref', 'wikipedia', 'bing', 'google', 'duckduckgo'],
    };
  }

  if (isPolicyQuery(normalized)) {
    return {
      auto_mode: 'full',
      engines: ['baidu', 'sogou', 'bing', 'bing_news', 'sina_news', '163_news'],
    };
  }

  return {
    auto_mode: 'full',
    engines: pickSourcesByGroups(['general', 'reference']).filter((source) => source !== 'github_repos' && source !== 'archive' && source !== 'wikidata'),
  };
}
