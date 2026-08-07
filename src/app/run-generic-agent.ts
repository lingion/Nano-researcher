import 'dotenv/config';

import { runAgent } from './run-agent.ts';
import { createGenericDomainResolver, createGenericFetchProvider, createGenericLlmProvider, createGenericSearchProvider } from './create-generic-dependencies.ts';
import type { ResearchTask } from '../agent/types.ts';
import { validateResearchTask } from '../agent/task-validation.ts';
import { parseResearchRunTimeoutMs } from './research-deadline.ts';

function integerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, maximum: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  return value;
}

function booleanEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new Error(`${name} must be one of 1, 0, true, or false.`);
}

export function parseGenericCliRun(env: NodeJS.ProcessEnv = process.env): { task: ResearchTask; timeoutMs: number } {
  const question = env.RESEARCH_QUESTION;
  if (!question?.trim()) throw new Error('RESEARCH_QUESTION is required.');
  const domain = env.RESEARCH_DOMAIN?.trim();
  if (domain && !/^[a-z0-9][a-z0-9-]*$/i.test(domain)) throw new Error('RESEARCH_DOMAIN must be a lowercase alphanumeric slug (dashes allowed), e.g. "policy" or "medical".');
  const mode = env.RESEARCH_COMPLETION_MODE;
  if (mode !== undefined && mode !== 'target_results' && mode !== 'rounds') throw new Error('RESEARCH_COMPLETION_MODE must be target_results or rounds.');
  const completionMode: 'target_results' | 'rounds' | undefined = mode;
  const maxIterations = integerEnv(env, 'RESEARCH_MAX_ITERATIONS', 100, 100);
  const targetResultCount = integerEnv(env, 'RESEARCH_TARGET_RESULTS', 10, 100);
  const evidenceRequired = booleanEnv(env, 'RESEARCH_EVIDENCE_REQUIRED', completionMode === 'target_results');
  const minFetchedPages = integerEnv(env, 'RESEARCH_MIN_FETCHED_PAGES', targetResultCount, 100);
  const outputFormat = env.RESEARCH_OUTPUT_FORMAT;
  if (outputFormat !== undefined && outputFormat !== 'json' && outputFormat !== 'markdown') throw new Error('RESEARCH_OUTPUT_FORMAT must be json or markdown.');
  const task: ResearchTask = {
    question: question.trim(),
    ...(domain ? { domain } : {}),
    options: {
      maxIterations,
      ...(completionMode ? { completionMode } : {}),
      ...(completionMode === 'target_results' ? { targetResultCount } : {}),
      evidenceRequired,
      ...(evidenceRequired ? { minFetchedPages } : {}),
      maxSearchActionsPerTurn: integerEnv(env, 'RESEARCH_MAX_SEARCH_ACTIONS', 8, 8),
      maxFetchActionsPerTurn: integerEnv(env, 'RESEARCH_MAX_FETCH_ACTIONS', 8, 8),
      ...(env.RESEARCH_LOCALE?.trim() ? { locale: env.RESEARCH_LOCALE.trim() } : {}),
      ...(outputFormat ? { outputFormat } : {}),
    },
  };
  validateResearchTask(task);
  return { task, timeoutMs: parseResearchRunTimeoutMs(env) };
}

export async function main(): Promise<void> {
  const { task, timeoutMs } = parseGenericCliRun();
  const controller = new AbortController();
  const fetchProvider = createGenericFetchProvider();
  const timeout = setTimeout(() => controller.abort(new Error(`Research run timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const result = await runAgent(task, {
      llm: createGenericLlmProvider(),
      search: createGenericSearchProvider(),
      fetch: fetchProvider,
    }, { signal: controller.signal, domainResolver: createGenericDomainResolver() });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    clearTimeout(timeout);
    await fetchProvider.close?.();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
