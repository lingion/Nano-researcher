import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ResearchTask } from '../agent/types.ts';

/**
 * Resolved domain configuration. The systemPrompt is the only mandatory output;
 * everything else is an optional mechanical override the caller may apply to the
 * task before the agent loop runs.
 */
export interface ResolvedDomain {
  /** Domain slug, or "general" when no domain was requested. */
  domain: string;
  /** System prompt text loaded from the domain document body. */
  systemPrompt: string;
  /** Optional engine scope parsed from frontmatter; never undefined-but-empty. */
  engineScope?: string[];
  /** Optional completion defaults parsed from frontmatter. */
  defaults?: DomainDefaults;
}

export interface DomainDefaults {
  completionMode?: 'target_results' | 'rounds';
  targetResultCount?: number;
  evidenceRequired?: boolean;
  minFetchedPages?: number;
}

export interface DomainResolver {
  resolve(domain: string | undefined): Promise<ResolvedDomain>;
  /** List available domain slugs, excluding the implicit "general" fallback. */
  list(): Promise<string[]>;
}

interface DomainFrontmatter {
  engineScope?: string[];
  completionMode?: 'target_results' | 'rounds';
  targetResultCount?: number;
  evidenceRequired?: boolean;
  minFetchedPages?: number;
}

/**
 * Parsed domain document. The body is used verbatim as the system prompt; the
 * frontmatter holds optional mechanical overrides the caller may apply.
 */
export interface ParsedDomainDocument {
  frontmatter: DomainFrontmatter;
  body: string;
}

const GENERAL_SYSTEM_PROMPT = 'You are a general research agent. Use search and fetch to answer the question with source-backed facts.';

/**
 * Parses a domain document of the form:
 *
 *   ---
 *   engineScope: [baidu, sogou]
 *   completionMode: target_results
 *   targetResultCount: 10
 *   evidenceRequired: true
 *   ---
 *   <markdown body, used verbatim as the system prompt>
 *
 * The frontmatter is optional and parsed with a tiny hand-rolled scanner so no
 * runtime dependency is added. Unknown frontmatter keys are ignored — domains
 * stay forward-compatible. The body is the authoritative system prompt.
 */
export function parseDomainDocument(text: string): ParsedDomainDocument {
  const trimmed = text.replace(/^\uFEFF/, '');
  const fence = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fence) return { frontmatter: {}, body: trimmed.trim() };
  return { frontmatter: parseFrontmatter(fence[1]), body: trimmed.slice(fence[0].length).trim() };
}

function parseFrontmatter(raw: string): DomainFrontmatter {
  const result: DomainFrontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const entry = line.match(/^\s*([a-zA-Z][a-zA-Z0-9]*)\s*:\s*(.*?)\s*$/);
    if (!entry) continue;
    const [, key, valueRaw] = entry;
    const value = parseScalar(valueRaw);
    if (value === undefined) continue;
    applyFrontmatterField(result, key, value);
  }
  return result;
}

function applyFrontmatterField(result: DomainFrontmatter, key: string, value: string | number | boolean | string[]): void {
  switch (key) {
    case 'engineScope':
      if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string') && value.length > 0) result.engineScope = value;
      break;
    case 'completionMode':
      if (value === 'target_results' || value === 'rounds') result.completionMode = value;
      break;
    case 'targetResultCount':
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100) result.targetResultCount = value;
      break;
    case 'evidenceRequired':
      if (typeof value === 'boolean') result.evidenceRequired = value;
      break;
    case 'minFetchedPages':
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100) result.minFetchedPages = value;
      break;
    default:
      break;
  }
}

function parseScalar(raw: string): string | number | boolean | string[] | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (/^\[.*\]$/.test(value)) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return undefined;
    return inner.split(',').map((item) => item.trim().replace(/^["']|["']$/g, '')).filter((item) => item.length > 0);
  }
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return value.replace(/^["']|["']$/g, '');
}

function toDomainDefaults(frontmatter: DomainFrontmatter): DomainDefaults | undefined {
  const defaults: DomainDefaults = {};
  if (frontmatter.completionMode) defaults.completionMode = frontmatter.completionMode;
  if (typeof frontmatter.targetResultCount === 'number') defaults.targetResultCount = frontmatter.targetResultCount;
  if (typeof frontmatter.evidenceRequired === 'boolean') defaults.evidenceRequired = frontmatter.evidenceRequired;
  if (typeof frontmatter.minFetchedPages === 'number') defaults.minFetchedPages = frontmatter.minFetchedPages;
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function listDomainSlugs(root: string): Promise<string[]> {
  return readdir(root, { withFileTypes: true })
    .then((entries) => entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -3))
      .filter((entry) => /^[a-z0-9][a-z0-9-]*$/i.test(entry))
      .sort((a, b) => a.localeCompare(b)))
    .catch(() => []);
}

/**
 * Filesystem-backed resolver. Reads `<root>/<domain>.md`. An absent domain (or
 * the literal "general") resolves to the generic default prompt with no engine
 * scope and no defaults, so the generic path stays domain-agnostic.
 */
export function createFileDomainResolver(root: string, fallbackPrompt: string = GENERAL_SYSTEM_PROMPT): DomainResolver {
  return {
    async resolve(domain: string | undefined): Promise<ResolvedDomain> {
      const slug = domain?.trim();
      if (!slug || slug === 'general') {
        return { domain: 'general', systemPrompt: fallbackPrompt };
      }
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
        throw new Error(`invalid_domain: ${slug} is not a lowercase alphanumeric slug`);
      }
      const file = path.join(root, `${slug}.md`);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        throw new Error(`unknown_domain: no document found for "${slug}" at ${file}`);
      }
      const { frontmatter, body } = parseDomainDocument(text);
      const defaults = toDomainDefaults(frontmatter);
      return {
        domain: slug,
        systemPrompt: body || fallbackPrompt,
        ...(frontmatter.engineScope ? { engineScope: frontmatter.engineScope } : {}),
        ...(defaults ? { defaults } : {}),
      };
    },
    list: () => listDomainSlugs(root),
  };
}

/**
 * Applies domain defaults to a task's options. Explicit caller values always
 * win — defaults only fill gaps, so a per-request override is never silently
 * dropped. This is mechanical gap-filling, not business inference.
 */
export function applyDomainDefaults(task: ResearchTask, defaults: DomainDefaults): ResearchTask {
  const options = { ...(task.options ?? {}) };
  if (options.completionMode === undefined && defaults.completionMode !== undefined) options.completionMode = defaults.completionMode;
  if (options.targetResultCount === undefined && defaults.targetResultCount !== undefined) options.targetResultCount = defaults.targetResultCount;
  if (options.evidenceRequired === undefined && defaults.evidenceRequired !== undefined) options.evidenceRequired = defaults.evidenceRequired;
  if (options.minFetchedPages === undefined && defaults.minFetchedPages !== undefined) options.minFetchedPages = defaults.minFetchedPages;
  return { ...task, options };
}

export const GENERAL_DOMAIN_PROMPT = GENERAL_SYSTEM_PROMPT;
