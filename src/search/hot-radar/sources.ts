// src/search/hot-radar/sources.ts
//
// 热榜源 fetcher 层 — 1:1 移植自 ~/Documents/hot-radar/scripts/collect.py
// 每个 collector 保持:同一 URL、同一解析路径、同一字段名(title/hot/extra)、limit=10 默认。
// 已知解析怪癖全部保留:
//   - baidu: 必须 platform=pc,content 在单层/双层嵌套间漂移,两种都兼容
//   - tieba: bang_topic 是 dict,条目在 topic_list
//   - zhihu: hot 用 detail_text(如 "512 万热度")
//   - juejin: POST JSON body,title 在 item_info.article_info
//   - RSS: 正则解析 <item><title>/<link>(atom 走 <entry>/<link href>)
// 相对 py 版的增量(接口要求):记录新增 url / source 字段 — url 从同响应载荷中
// 直接读取或按站点规范派生,取不到则为空字符串。

export interface HotRadarRecord {
  title: string;
  url: string;
  hot: string;
  extra: string;
  source: string;
}

export interface HotRadarSource {
  name: string;
  url: string;
  fetch: () => Promise<HotRadarRecord[]>;
}

export interface CollectedSources {
  records: HotRadarRecord[];
  failed: Array<{ source: string; error: string }>;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_LIMIT = 10;

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

async function doFetch(url: string, opts: FetchOptions = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: opts.method,
      headers: {
        'user-agent': UA,
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string, opts: FetchOptions = {}): Promise<any> {
  const res = await doFetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`invalid json from ${url}`);
  }
}

async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const res = await doFetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

function rec(source: string, title: string, url: string, hot: unknown, extra: string): HotRadarRecord {
  return { title, url, hot: String(hot), extra, source };
}

// ---------- 源采集器(与 collect.py 逐函数对应,py 返回 None 的路径这里返回 []) ----------

// py: src_huggingface — HF镜像 trending models — AI趋势锚点
async function srcHuggingface(limit: number = DEFAULT_LIMIT): Promise<HotRadarRecord[]> {
  const d = await fetchJson(`https://hf-mirror.com/api/models?sort=trendingScore&direction=-1&limit=${limit}`);
  if (!Array.isArray(d) || d.length === 0) return [];
  return d.map((m: any) =>
    rec(
      'HuggingFace镜像',
      String(m?.id ?? '?'),
      m?.id ? `https://hf-mirror.com/${m.id}` : '',
      m?.trendingScore ?? '?',
      `dl=${m?.downloads ?? '?'} likes=${m?.likes ?? '?'}`,
    ),
  );
}

// py: src_hn — HN Algolia front page
async function srcHn(limit: number = DEFAULT_LIMIT): Promise<HotRadarRecord[]> {
  const d = await fetchJson(`https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${limit}`);
  const hits = d?.hits ?? [];
  if (!hits.length) return [];
  return hits.map((h: any) =>
    rec(
      'HackerNews',
      String(h?.title ?? '?'),
      h?.url ?? (h?.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : ''),
      h?.points ?? '?',
      `comments=${h?.num_comments ?? '?'}`,
    ),
  );
}

// py: src_baidu — 百度热搜 — 必须platform=pc。content结构在单层/双层嵌套间漂移,两种都兼容
async function srcBaidu(limit: number = DEFAULT_LIMIT): Promise<HotRadarRecord[]> {
  const d = await fetchJson('https://top.baidu.com/api/board?platform=pc&tab=realtime');
  try {
    let content = d.data.cards[0].content;
    // 双层形态: content[0]是dict且含'content'键
    if (content && typeof content[0] === 'object' && content[0] !== null && 'content' in content[0]) {
      content = content[0].content;
    }
    if (!Array.isArray(content)) return [];
    return content.slice(0, limit).map((i: any) =>
      rec('百度热搜', String(i?.word ?? '?'), String(i?.url ?? ''), i?.hotScore ?? '?', ''),
    );
  } catch {
    return [];
  }
}

// py: src_ithome — IT之家 — hitcount/commentcount
async function srcIthome(limit: number = DEFAULT_LIMIT): Promise<HotRadarRecord[]> {
  const d = await fetchJson('https://api.ithome.com/json/newslist/news?r=0');
  const items = d?.newslist ?? [];
  if (!items.length) return [];
  return items.slice(0, limit).map((i: any) =>
    rec(
      'IT之家',
      String(i?.title ?? '?'),
      String(i?.url ?? ''),
      i?.hitcount ?? '?',
      `comments=${i?.commentcount ?? '?'}`,
    ),
  );
}

// py: src_uapis(platform) — uapis.cn 多平台聚合
async function srcUapis(name: string, platform: string, limit: number = DEFAULT_LIMIT): Promise<HotRadarRecord[]> {
  const d = await fetchJson(`https://uapis.cn/api/v1/misc/hotboard?type=${platform}`);
  const items = d !== null && typeof d === 'object' && !Array.isArray(d) ? d.list ?? [] : [];
  if (!items.length) return [];
  return items.slice(0, limit).map((i: any) =>
    rec(name, String(i?.title ?? '?'), String(i?.url ?? ''), i?.hot_value ?? '?', ''),
  );
}

// py: src_github — GitHub 本周新建高star repo — 增量趋势
async function srcGithub(limit: number = DEFAULT_LIMIT): Promise<HotRadarRecord[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const d = await fetchJson(
    `https://api.github.com/search/repositories?q=created:>${since}+stars:>100&sort=stars&order=desc&per_page=${limit}`,
  );
  const items = d?.items ?? [];
  if (!items.length) return [];
  return items.map((i: any) =>
    rec(
      'GitHub本周新星',
      String(i?.full_name ?? '?'),
      String(i?.html_url ?? ''),
      i?.stargazers_count ?? '?',
      String(i?.description ?? '').slice(0, 40),
    ),
  );
}

// py: src_csdn — CSDN热榜
async function srcCsdn(limit: number = DEFAULT_LIMIT): Promise<HotRadarRecord[]> {
  const d = await fetchJson(`https://blog.csdn.net/phoenix/web/blog/hot-rank?page=0&pageSize=${limit}&childType=hot`);
  const items = d?.data ?? [];
  if (!items.length) return [];
  return items.map((i: any) =>
    rec(
      'CSDN热榜',
      String(i?.articleTitle ?? '?'),
      String(i?.url ?? ''),
      i?.hotRankScore ?? '?',
      String(i?.nickName ?? ''),
    ),
  );
}

// py: src_devto — dev.to top articles
async function srcDevto(limit: number = DEFAULT_LIMIT): Promise<HotRadarRecord[]> {
  const d = await fetchJson(`https://dev.to/api/articles?top=7&per_page=${limit}`);
  if (!Array.isArray(d) || d.length === 0) return [];
  return d.map((a: any) =>
    rec(
      'dev.to',
      String(a?.title ?? '?'),
      String(a?.url ?? ''),
      a?.positive_reactions_count ?? '?',
      `comments=${a?.comments_count ?? '?'}`,
    ),
  );
}

// py: src_tieba — 贴吧热搜 — bang_topic是dict,条目在topic_list
async function srcTieba(limit: number = DEFAULT_LIMIT): Promise<HotRadarRecord[]> {
  const d = await fetchJson('https://tieba.baidu.com/hottopic/browse/topicList?ie=utf-8');
  try {
    const items = d.data.bang_topic.topic_list;
    if (!Array.isArray(items)) return [];
    return items.slice(0, limit).map((i: any) =>
      rec('贴吧', String(i?.topic_name ?? '?'), String(i?.topic_url ?? ''), i?.discuss_num ?? '?', ''),
    );
  } catch {
    return [];
  }
}

// py: src_toutiao — 今日头条热榜 — 只有标题(hot 恒为空,与 py 一致)
async function srcToutiao(limit: number = DEFAULT_LIMIT): Promise<HotRadarRecord[]> {
  const d = await fetchJson('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc');
  const items = d?.data ?? [];
  if (!items.length) return [];
  return items.slice(0, limit).map((i: any) =>
    rec('今日头条', String(i?.Title ?? '?'), String(i?.Url ?? ''), '', ''),
  );
}

// py: src_zhihu — 知乎热榜 — detail_text含'512 万热度',hot值优于知乎日报(title-only)
async function srcZhihu(limit: number = DEFAULT_LIMIT): Promise<HotRadarRecord[]> {
  const d = await fetchJson(`https://api.zhihu.com/topstory/hot-list?limit=${limit}`);
  const items = d?.data ?? [];
  if (!items.length) return [];
  return items.map((i: any) =>
    rec(
      '知乎热榜',
      String(i?.target?.title ?? '?'),
      String(i?.target?.url ?? ''),
      String(i?.detail_text ?? ''),
      '',
    ),
  );
}

// py: src_paper — 澎湃hotNews
async function srcPaper(limit: number = DEFAULT_LIMIT): Promise<HotRadarRecord[]> {
  const d = await fetchJson('https://cache.thepaper.cn/contentapi/wwwIndex/rightSidebar');
  try {
    const items = d.data.hotNews;
    if (!Array.isArray(items)) return [];
    return items.slice(0, limit).map((i: any) =>
      rec(
        '澎湃新闻',
        String(i?.name ?? '?'),
        i?.contId ? `https://www.thepaper.cn/newsDetail_forward_${i.contId}` : '',
        '',
        '',
      ),
    );
  } catch {
    return [];
  }
}

// py: src_juejin — 掘金热榜 — POST, title在item_info.article_info
async function srcJuejin(limit: number = DEFAULT_LIMIT): Promise<HotRadarRecord[]> {
  const d = await fetchJson('https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed', {
    method: 'POST',
    body: JSON.stringify({ id_type: 2, client_type: 2608, sort_type: 200, cursor: '0', limit }),
  });
  const items = d?.data ?? [];
  if (!items.length) return [];
  const out: HotRadarRecord[] = [];
  for (const i of items) {
    try {
      out.push(
        rec(
          '掘金热榜',
          String(i.item_info.article_info.title),
          String(i.item_info.article_info.article_url ?? ''),
          '',
          '',
        ),
      );
    } catch {
      continue;
    }
  }
  return out;
}

// py: src_rss(url, limit, atom) — 通用RSS/Atom解析。
// brief 指定用正则解析 <item><title>/<link>(atom 走 <entry> / <link href>),
// 保留 py 版 ET 解析的语义:无 title 的条目跳过,结果截断到 limit。
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function unwrapCdata(s: string): string {
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : s;
}

async function srcRss(url: string, name: string, limit: number = DEFAULT_LIMIT, atom = false): Promise<HotRadarRecord[]> {
  // fetch 失败向上抛,由 collectAllSources 捕获并记入 failed(比 py 版静默 None 的失败信息更可诊断);
  // 解析层语义与 py ET 版一致:无 title 的条目跳过,结果截断到 limit。
  const text = await fetchText(url);
  const entries = text.match(atom ? /<entry[\s\S]*?<\/entry>/g : /<item[\s\S]*?<\/item>/g) ?? [];
  const out: HotRadarRecord[] = [];
  for (const entry of entries) {
    const titleMatch = entry.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
    if (!titleMatch) continue;
    const title = decodeXmlEntities(unwrapCdata(titleMatch[1])).trim();
    if (!title) continue;
    let link = '';
    if (atom) {
      const linkMatch = entry.match(/<link[^>]*\shref="([^"]*)"[^>]*\/?>/i);
      if (linkMatch) link = decodeXmlEntities(linkMatch[1]).trim();
    } else {
      const linkMatch = entry.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
      if (linkMatch) link = decodeXmlEntities(unwrapCdata(linkMatch[1])).trim();
    }
    out.push({ title, url: link, hot: '', extra: '', source: name });
  }
  return out.slice(0, limit);
}

// ---------- 编排(对应 py SOURCES 列表,顺序一致) ----------

export const SOURCES: HotRadarSource[] = [
  { name: 'HuggingFace镜像', url: 'https://hf-mirror.com/api/models', fetch: () => srcHuggingface() },
  { name: 'HackerNews', url: 'https://hn.algolia.com/api/v1/search', fetch: () => srcHn() },
  { name: '百度热搜', url: 'https://top.baidu.com/api/board?platform=pc&tab=realtime', fetch: () => srcBaidu() },
  { name: 'IT之家', url: 'https://api.ithome.com/json/newslist/news?r=0', fetch: () => srcIthome() },
  { name: 'uapis-微博', url: 'https://uapis.cn/api/v1/misc/hotboard?type=weibo', fetch: () => srcUapis('uapis-微博', 'weibo') },
  { name: 'uapis-知乎', url: 'https://uapis.cn/api/v1/misc/hotboard?type=zhihu', fetch: () => srcUapis('uapis-知乎', 'zhihu') },
  { name: 'uapis-抖音', url: 'https://uapis.cn/api/v1/misc/hotboard?type=douyin', fetch: () => srcUapis('uapis-抖音', 'douyin') },
  { name: 'uapis-B站', url: 'https://uapis.cn/api/v1/misc/hotboard?type=bilibili', fetch: () => srcUapis('uapis-B站', 'bilibili') },
  { name: 'uapis-小红书', url: 'https://uapis.cn/api/v1/misc/hotboard?type=xiaohongshu', fetch: () => srcUapis('uapis-小红书', 'xiaohongshu') },
  { name: 'GitHub本周新星', url: 'https://api.github.com/search/repositories', fetch: () => srcGithub() },
  { name: 'CSDN热榜', url: 'https://blog.csdn.net/phoenix/web/blog/hot-rank', fetch: () => srcCsdn() },
  { name: 'dev.to', url: 'https://dev.to/api/articles', fetch: () => srcDevto() },
  { name: '贴吧', url: 'https://tieba.baidu.com/hottopic/browse/topicList?ie=utf-8', fetch: () => srcTieba() },
  { name: '今日头条', url: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', fetch: () => srcToutiao() },
  { name: '知乎热榜', url: 'https://api.zhihu.com/topstory/hot-list', fetch: () => srcZhihu() },
  { name: '澎湃新闻', url: 'https://cache.thepaper.cn/contentapi/wwwIndex/rightSidebar', fetch: () => srcPaper() },
  { name: '掘金热榜', url: 'https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed', fetch: () => srcJuejin() },
  { name: '量子位RSS', url: 'https://www.qbitai.com/feed', fetch: () => srcRss('https://www.qbitai.com/feed', '量子位RSS') },
  { name: 'InfoQ中文', url: 'https://www.infoq.cn/feed', fetch: () => srcRss('https://www.infoq.cn/feed', 'InfoQ中文') },
  { name: 'Solidot', url: 'https://www.solidot.org/index.rss', fetch: () => srcRss('https://www.solidot.org/index.rss', 'Solidot') },
  { name: 'ProductHunt', url: 'https://www.producthunt.com/feed', fetch: () => srcRss('https://www.producthunt.com/feed', 'ProductHunt', DEFAULT_LIMIT, true) },
];

export async function collectAllSources(options: { sources?: HotRadarSource[]; timeoutMs?: number } = {}): Promise<CollectedSources> {
  const sources = options.sources ?? SOURCES;
  const settled = await Promise.all(
    sources.map(async (s) => {
      try {
        return { s, records: await s.fetch(), error: null as string | null };
      } catch (error) {
        return {
          s,
          records: [] as HotRadarRecord[],
          error: `${(error as Error).name}: ${(error as Error).message}`,
        };
      }
    }),
  );
  const records = settled.flatMap((x) => x.records ?? []);
  const failed = settled
    .filter((x) => x.error || !x.records?.length)
    .map((x) => ({ source: x.s.name, error: x.error ?? 'empty response' }));
  return { records, failed };
}
