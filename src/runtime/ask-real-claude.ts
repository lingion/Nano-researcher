import Anthropic from '@anthropic-ai/sdk';

import { buildPolicyPrompt } from '../policy-task/prompt-builder.js';
import type { PolicyAgentState } from '../policy-task/state-schema.js';
import type { AgentFetchAction, PolicyAgentDecision } from '../policy-task/output-schema.js';

export interface DebugEvent {
  type: string;
  payload: Record<string, unknown>;
}

function buildUserState(state: PolicyAgentState): string {
  return JSON.stringify(state, null, 2);
}

function normalizeToken(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[-_\s]+/g, '-')
    : '';
}

const FETCH_ACTION_ALIASES = new Set([
  'fetch',
  'fetch-details',
  'download',
  'visit-url',
  'visit',
  'fetch-page',
  'browse',
  'read-url',
  'open-url',
]);

function isFetchActionToken(value: unknown): boolean {
  return FETCH_ACTION_ALIASES.has(normalizeToken(value));
}

function pickNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
}

function extractSearchActions(
  actions: unknown,
  fallbackWhy: string,
): Array<{ query: string; why: string }> {
  if (!Array.isArray(actions)) {
    return [];
  }

  return actions.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const record = item as Record<string, unknown>;
    const normalizedAction = normalizeToken(record.action ?? record.type);
    if (normalizedAction !== 'search' && normalizedAction !== 'radar-search' && normalizedAction !== 'radar') {
      return [];
    }

    const why = pickNonEmptyString(record.reason, record.why, record.rationale, fallbackWhy) ?? fallbackWhy;

    const directQueryValue = pickNonEmptyString(record.query, record.keyword);
    const directQuery = directQueryValue
      ? [{ query: directQueryValue, why }]
      : [];

    const listedQueries = Array.isArray(record.queries)
      ? record.queries
          .filter((query): query is string => typeof query === 'string' && query.trim() !== '')
          .map((query) => ({ query, why }))
      : [];

    return [...directQuery, ...listedQueries];
  });
}

function extractFetchActions(
  actions: unknown,
  fallbackWhy: string,
): AgentFetchAction[] {
  if (!Array.isArray(actions)) {
    return [];
  }

  return actions.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const record = item as Record<string, unknown>;
    const normalizedAction = normalizeToken(record.action ?? record.type);
    if (!isFetchActionToken(normalizedAction)) {
      return [];
    }

    const url = pickNonEmptyString(record.url);
    if (!url) {
      return [];
    }

    const why = pickNonEmptyString(record.why, record.reason, record.rationale, fallbackWhy) ?? fallbackWhy;
    return [{ url, why }];
  });
}

function extractFetchSearchRevivalActions(
  actions: unknown,
  fallbackWhy: string,
): Array<{ query: string; why: string }> {
  if (!Array.isArray(actions)) {
    return [];
  }

  return actions.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const record = item as Record<string, unknown>;
    const normalizedAction = normalizeToken(record.action ?? record.type);
    if (!isFetchActionToken(normalizedAction)) {
      return [];
    }

    const query = pickNonEmptyString(
      record.contextQuery,
      record.query,
      record.keyword,
      record.policy,
      record.target,
      record.name,
    );
    if (!query) {
      return [];
    }

    const why = pickNonEmptyString(record.why, record.reason, record.rationale, fallbackWhy) ?? fallbackWhy;
    return [{ query, why }];
  });
}

function detectCompositeIntent(payload: Record<string, unknown>): boolean {
  const normalizedStatus = normalizeToken(payload.status);
  const normalizedDecision = normalizeToken(payload.decision);
  const normalizedFinalDecision = normalizeToken(payload.final_decision);

  if (
    normalizedStatus === 'continue-search-and-fetch'
    || normalizedStatus === 'search-and-fetch'
    || normalizedDecision === 'continue-search-and-fetch'
    || normalizedDecision === 'search-and-fetch'
    || normalizedFinalDecision === 'continue-search-and-fetch'
    || normalizedFinalDecision === 'search-and-fetch'
    || normalizedStatus.startsWith('need-fetch')
    || normalizedStatus.startsWith('needs-fetch')
  ) {
    return true;
  }

  const actionContainers = [
    payload.combinedActions,
    payload.next_actions,
    payload.nextActions,
    payload.fetchActions,
    payload.fetch_actions,
  ];

  for (const container of actionContainers) {
    if (!Array.isArray(container)) {
      continue;
    }

    let hasSearch = false;
    let hasFetch = false;

    for (const item of container) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const normalizedAction = normalizeToken((item as Record<string, unknown>).action ?? (item as Record<string, unknown>).type);
      if (normalizedAction === 'search' || normalizedAction === 'radar-search' || normalizedAction === 'radar') {
        hasSearch = true;
      }
      if (isFetchActionToken(normalizedAction)) {
        hasFetch = true;
      }
    }

    if (hasSearch && hasFetch) {
      return true;
    }
  }

  return false;
}

function dedupeSearchActions(actions: Array<{ query: string; why: string }>): Array<{ query: string; why: string }> {
  const seen = new Set<string>();
  const deduped: Array<{ query: string; why: string }> = [];

  for (const action of actions) {
    if (seen.has(action.query)) {
      continue;
    }
    seen.add(action.query);
    deduped.push(action);
  }

  return deduped;
}

function normalizeCompositeDecision(
  payload: Partial<PolicyAgentDecision> & Record<string, unknown>,
  simpleJudgment: string | undefined,
): PolicyAgentDecision {
  const fallbackWhy = simpleJudgment ?? 'Need additional official-source searches before continuing.';

  const requiredSearches = Array.isArray(payload.requiredSearches)
    ? payload.requiredSearches
        .map((item) => {
          if (!item || typeof item !== 'object') {
            return null;
          }

          const record = item as Record<string, unknown>;
          const query = pickNonEmptyString(record.query);
          if (!query) {
            return null;
          }

          return {
            query,
            why: pickNonEmptyString(record.reason, record.why, record.rationale, 'model-required search') ?? 'model-required search',
          };
        })
        .filter((item): item is { query: string; why: string } => item !== null)
    : [];

  const searchActionSources = [
    payload.recommendedNextActions,
    payload.next_actions,
    payload.nextActions,
    payload.radarActions,
    payload.searchActions,
    payload.combinedActions,
  ];
  const fetchActionSources = [
    payload.fetchActions,
    payload.fetch_actions,
    payload.next_actions,
    payload.nextActions,
    payload.combinedActions,
  ];

  const searchActions = dedupeSearchActions([
    ...requiredSearches,
    ...searchActionSources.flatMap((actions) => extractSearchActions(actions, fallbackWhy)),
  ]);
  const fetchActions = fetchActionSources.flatMap((actions) => extractFetchActions(actions, fallbackWhy));

  if (searchActions.length === 0) {
    const revived = dedupeSearchActions(fetchActionSources.flatMap((actions) => extractFetchSearchRevivalActions(actions, fallbackWhy)));
    searchActions.push(...revived.filter((candidate) => !searchActions.some((existing) => existing.query === candidate.query)));
  }

  if (searchActions.length === 0 && fetchActions.length === 0) {
    return {
      decision: 'stop',
      reasoning: simpleJudgment ?? 'No reasoning returned.',
      searchActions: [],
      fetchActions: [],
      finalPackage: payload,
      uncertainties: Array.isArray(payload.uncertainties) ? payload.uncertainties : [],
      discardedLeads: Array.isArray(payload.discardedLeads) ? payload.discardedLeads : [],
      evidenceAssessments: Array.isArray(payload.evidenceAssessments) ? payload.evidenceAssessments as PolicyAgentDecision['evidenceAssessments'] : [],
    };
  }

  return {
    decision: searchActions.length > 0 ? 'continue_search' : 'continue_fetch',
    reasoning: simpleJudgment ?? 'Need additional official-source searches before continuing.',
    searchActions,
    fetchActions,
    evidenceAssessments: Array.isArray(payload.evidenceAssessments) ? payload.evidenceAssessments as PolicyAgentDecision['evidenceAssessments'] : [],
    finalPackage: payload,
    uncertainties: Array.isArray(payload.uncertainties) ? payload.uncertainties : [],
    discardedLeads: Array.isArray(payload.discardedLeads) ? payload.discardedLeads : [],
  };
}

function legacyNormalizeDecision(
  payload: Partial<PolicyAgentDecision> & Record<string, unknown>,
  simpleJudgment: string | undefined,
): PolicyAgentDecision {
  const requiredSearches = Array.isArray(payload.requiredSearches)
    ? payload.requiredSearches
        .map((item) => {
          if (!item || typeof item !== 'object') {
            return null;
          }

          const record = item as Record<string, unknown>;
          const query = pickNonEmptyString(record.query);
          if (!query) {
            return null;
          }

          return {
            query,
            why:
              pickNonEmptyString(record.reason, record.why, record.rationale, 'model-required search')
              ?? 'model-required search',
          };
        })
        .filter((item): item is { query: string; why: string } => item !== null)
    : [];

  const recommendedSearches = extractSearchActions(payload.recommendedNextActions, 'recommended search action');
  const nextActionSearches = extractSearchActions(
    payload.next_actions ?? payload.nextActions,
    'recommended search action',
  );
  const radarSearches = extractSearchActions(payload.radarActions, 'recommended search action');
  const explicitSearchActions = extractSearchActions(payload.searchActions, 'recommended search action');

  const combinedSearches = [
    ...requiredSearches,
    ...recommendedSearches,
    ...nextActionSearches,
    ...radarSearches,
    ...explicitSearchActions,
  ];
  const stopDecision = payload.stopDecision && typeof payload.stopDecision === 'object'
    ? (payload.stopDecision as Record<string, unknown>)
    : null;
  const normalizedStatus = typeof payload.status === 'string'
    ? payload.status.trim().toUpperCase()
    : typeof payload.decision === 'string'
      ? payload.decision.trim().toUpperCase()
      : undefined;
  const normalizedDecision = typeof payload.decision === 'string'
    ? payload.decision.trim().toUpperCase()
    : undefined;
  const indicatesContinueSearch = normalizedStatus === 'NEED_RADAR_SEARCH'
    || normalizedStatus === 'NEEDS_RADAR_SEARCH'
    || normalizedStatus === 'NEEDS_SEARCH'
    || normalizedStatus === 'NEED_SEARCH'
    || normalizedStatus === 'CONTINUE_SEARCH'
    || normalizedStatus === 'CONTINUE'
    || stopDecision?.shouldStop === false;

  const indicatedDecision = pickNonEmptyString(
    typeof payload.decision === 'string' ? payload.decision : undefined,
    typeof payload.status === 'string' ? payload.status : undefined,
  );

  if ((combinedSearches.length > 0 || indicatesContinueSearch) && (!payload.decision || normalizedDecision === 'CONTINUE')) {
    return {
      decision: 'continue_search',
      reasoning: simpleJudgment ?? 'Need additional official-source searches before continuing.',
      searchActions: combinedSearches.length > 0
        ? combinedSearches
        : [
            {
              query: '官方政策页面',
              why: simpleJudgment ?? 'Need additional official-source searches before continuing.',
            },
          ],
      fetchActions: [],
      finalPackage: payload,
      uncertainties: Array.isArray(payload.uncertainties) ? payload.uncertainties : [],
      discardedLeads: [],
    };
  }

  if (simpleJudgment && (!payload.decision || normalizedDecision === 'CONTINUE')) {
    return {
      decision: /证据不足|需要先搜索|先搜索/i.test(simpleJudgment) || normalizedDecision === 'CONTINUE' ? 'continue_search' : 'stop',
      reasoning: simpleJudgment,
      searchActions: /证据不足|需要先搜索|先搜索/i.test(simpleJudgment) || normalizedDecision === 'CONTINUE'
        ? [
            {
              query: '官方政策页面',
              why: simpleJudgment,
            },
          ]
        : [],
      fetchActions: [],
      finalPackage: payload,
      uncertainties: /证据不足/i.test(simpleJudgment) ? [simpleJudgment] : [],
      discardedLeads: [],
    };
  }

  const explicitFetchActions = extractFetchActions(
    Array.isArray(payload.fetchActions)
      ? payload.fetchActions.map((action) => ({ ...(action as Record<string, unknown>), type: 'fetch' }))
      : [],
    'model-provided fetch action',
  );

  return {
    decision: (normalizedDecision === 'CONTINUE' && Array.isArray(payload.searchActions) && payload.searchActions.length > 0)
      ? 'continue_search'
      : (normalizedDecision === 'CONTINUE' && explicitFetchActions.length > 0)
        ? 'continue_fetch'
        : normalizedDecision === 'CONTINUE_FETCH' || normalizedDecision === 'CONTINUE-FETCH'
          ? 'continue_fetch'
          : indicatedDecision ?? 'stop',
    reasoning: payload.reasoning ?? 'No reasoning returned.',
    searchActions: Array.isArray(payload.searchActions) ? payload.searchActions : [],
    fetchActions: explicitFetchActions,
    evidenceAssessments: Array.isArray(payload.evidenceAssessments) ? payload.evidenceAssessments as PolicyAgentDecision['evidenceAssessments'] : [],
    finalPackage: payload.finalPackage ?? payload,
    uncertainties: Array.isArray(payload.uncertainties) ? payload.uncertainties : [],
    discardedLeads: Array.isArray(payload.discardedLeads) ? payload.discardedLeads : [],
  };
}

function normalizeDecision(payload: Partial<PolicyAgentDecision> & Record<string, unknown>): PolicyAgentDecision {
  const explicitDecision = typeof payload.decision === 'string' ? payload.decision.trim() : '';
  if (explicitDecision === 'summarize_and_stop') {
    return {
      decision: 'summarize_and_stop',
      reasoning: pickNonEmptyString(payload.reasoning, payload.reason, payload.message, 'Summarizing and stopping.') ?? 'Summarizing and stopping.',
      searchActions: [],
      fetchActions: [],
      evidenceAssessments: Array.isArray(payload.evidenceAssessments) ? payload.evidenceAssessments as PolicyAgentDecision['evidenceAssessments'] : [],
      finalPackage: payload.finalPackage ?? payload,
      uncertainties: Array.isArray(payload.uncertainties) ? payload.uncertainties : [],
      discardedLeads: Array.isArray(payload.discardedLeads) ? payload.discardedLeads : [],
    };
  }

  const stopDecision = payload.stopDecision && typeof payload.stopDecision === 'object'
    ? (payload.stopDecision as Record<string, unknown>)
    : null;

  const simpleJudgment =
    typeof payload.judgment === 'string'
      ? payload.judgment
      : typeof payload.message === 'string'
        ? payload.message
        : typeof payload.reason === 'string'
          ? payload.reason
          : typeof stopDecision?.reason === 'string'
            ? stopDecision.reason
            : typeof payload.reasoning === 'string'
              ? payload.reasoning
              : typeof payload.rationale === 'string'
                ? payload.rationale
                : typeof payload.judgment === 'object' && payload.judgment && typeof (payload.judgment as Record<string, unknown>).summary === 'string'
                  ? ((payload.judgment as Record<string, unknown>).summary as string)
                  : typeof payload.judgment === 'object' && payload.judgment && typeof (payload.judgment as Record<string, unknown>).conclusion === 'string'
                    ? ((payload.judgment as Record<string, unknown>).conclusion as string)
                    : typeof payload.finalJudgment === 'object' && payload.finalJudgment && typeof (payload.finalJudgment as Record<string, unknown>).conclusion === 'string'
                      ? ((payload.finalJudgment as Record<string, unknown>).conclusion as string)
                      : undefined;

  if (detectCompositeIntent(payload)) {
    return normalizeCompositeDecision(payload, simpleJudgment);
  }

  return legacyNormalizeDecision(payload, simpleJudgment);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    };
  }

  return {
    message: String(error),
  };
}

function resolveRuntimeModel(): string {
  return process.env.ANTHROPIC_MODEL ?? process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? 'claude-opus-4-8';
}

async function defaultCallModel(
  prompt: string,
  options: {
    onDebugEvent?: (event: DebugEvent) => void;
  } = {},
): Promise<string> {
  const model = resolveRuntimeModel();
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL,
  });

  options.onDebugEvent?.({
    type: 'model.config',
    payload: {
      model,
      baseURL: process.env.ANTHROPIC_BASE_URL ?? null,
      transport: 'anthropic-sdk',
    },
  });

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export async function askRealClaudeDecision(
  state: PolicyAgentState,
  options: {
    callModel?: (prompt: string) => Promise<string>;
    onDebugEvent?: (event: DebugEvent) => void;
  } = {},
): Promise<PolicyAgentDecision> {
  const prompt = [buildPolicyPrompt(), '', buildUserState(state)].join('\n');
  options.onDebugEvent?.({
    type: 'model.prompt',
    payload: {
      prompt,
      state,
    },
  });

  if (options.callModel) {
    options.onDebugEvent?.({
      type: 'model.config',
      payload: {
        model: null,
        baseURL: null,
        transport: 'custom-callModel',
      },
    });
  }

  try {
    let rawText: string | undefined;
    rawText = await (options.callModel
      ? options.callModel(prompt)
      : defaultCallModel(prompt, { onDebugEvent: options.onDebugEvent }));
    options.onDebugEvent?.({
      type: 'model.raw_output',
      payload: {
        rawText,
      },
    });

    const parsed = JSON.parse(rawText) as Partial<PolicyAgentDecision>;
    const decision = normalizeDecision(parsed);
    decision.finalPackage = {
      ...(decision.finalPackage && typeof decision.finalPackage === 'object'
        ? (decision.finalPackage as Record<string, unknown>)
        : {}),
      _raw_model_output: rawText,
    };

    if (process.env.LIVE_AUDIT_DEBUG === '1') {
      console.log('[FORENSIC] normalized decision output', JSON.stringify({
        rawStatus: typeof parsed.status === 'string' ? parsed.status : null,
        normalizedDecision: decision.decision,
        searchActionCount: decision.searchActions.length,
        fetchActionCount: decision.fetchActions.length,
        searchQueries: decision.searchActions.map((action) => action.query),
        reasoning: decision.reasoning,
      }));
    }

    options.onDebugEvent?.({
      type: 'model.parsed_decision',
      payload: {
        decision,
      },
    });

    return decision;
  } catch (error) {
    const errorRecord = serializeError(error);
    if (error instanceof SyntaxError) {
      options.onDebugEvent?.({
        type: 'model.parse_failure',
        payload: {
          error: errorRecord,
        },
      });
    }
    options.onDebugEvent?.({
      type: 'model.failure',
      payload: errorRecord,
    });
    throw error;
  }
}
