import type {
  AgentFetchAction,
  AgentSearchAction,
  PolicyAgentDecision,
} from '../policy-task/output-schema.js';

export const DECISIONS = [
  'continue_search',
  'continue_fetch',
  'finalize',
  'stop',
  'summarize_and_stop',
] as const;

export type ProtocolErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_ENVELOPE'
  | 'MISSING_DECISION'
  | 'UNKNOWN_DECISION'
  | 'INVALID_ACTIONS';

export interface ProtocolError {
  scope: 'envelope' | 'decision' | 'action';
  code: ProtocolErrorCode | 'INVALID_ACTION';
  message: string;
  actionType?: 'search' | 'fetch';
  actionIndex?: number;
}

export interface DecisionEnvelope {
  ok: true;
  decision: PolicyAgentDecision;
  envelope: Record<string, unknown>;
  actionErrors?: ProtocolError[];
}

export interface FailedDecisionEnvelope {
  ok: false;
  error: ProtocolError;
}

export type DecisionParseResult = DecisionEnvelope | FailedDecisionEnvelope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function parseActions<T extends AgentSearchAction | AgentFetchAction>(
  value: unknown,
  kind: 'search' | 'fetch',
  errors: ProtocolError[],
): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push({ scope: 'action', code: 'INVALID_ACTION', message: `${kind}Actions must be an array`, actionType: kind });
    return [];
  }

  return value.flatMap((item, index) => {
    if (!isRecord(item)) {
      errors.push({ scope: 'action', code: 'INVALID_ACTION', message: `${kind} action must be an object`, actionType: kind, actionIndex: index });
      return [];
    }
    const why = stringField(item.why);
    const field = kind === 'search' ? stringField(item.query) : stringField(item.url);
    if (!field || (kind === 'fetch' && (() => { try { new URL(field); return false; } catch { return true; } })())) {
      errors.push({ scope: 'action', code: 'INVALID_ACTION', message: `${kind} action requires a valid ${kind === 'search' ? 'query' : 'URL'}`, actionType: kind, actionIndex: index });
      return [];
    }
    return [{ [kind === 'search' ? 'query' : 'url']: field, ...(why ? { why } : {}) }] as T[];
  });
}

export function parseDecisionEnvelope(raw: string): DecisionParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { scope: 'envelope', code: 'INVALID_JSON', message: 'Decision output is not valid JSON' } };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: { scope: 'envelope', code: 'INVALID_ENVELOPE', message: 'Decision output must be a JSON object' } };
  }

  const decisionValue = parsed.decision;
  if (decisionValue === undefined || decisionValue === null || decisionValue === '') {
    return { ok: false, error: { scope: 'decision', code: 'MISSING_DECISION', message: 'Decision is required' } };
  }
  if (typeof decisionValue !== 'string' || !(DECISIONS as readonly string[]).includes(decisionValue)) {
    return { ok: false, error: { scope: 'decision', code: 'UNKNOWN_DECISION', message: `Unknown decision: ${String(decisionValue)}` } };
  }

  if (parsed.searchActions !== undefined && !Array.isArray(parsed.searchActions)) {
    return { ok: false, error: { scope: 'envelope', code: 'INVALID_ACTIONS', message: 'searchActions must be an array' } };
  }
  if (parsed.fetchActions !== undefined && !Array.isArray(parsed.fetchActions)) {
    return { ok: false, error: { scope: 'envelope', code: 'INVALID_ACTIONS', message: 'fetchActions must be an array' } };
  }

  const actionErrors: ProtocolError[] = [];
  const searchActions = parseActions<AgentSearchAction>(parsed.searchActions, 'search', actionErrors);
  const fetchActions = parseActions<AgentFetchAction>(parsed.fetchActions, 'fetch', actionErrors);
  const result: PolicyAgentDecision = {
    decision: decisionValue as PolicyAgentDecision['decision'],
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    searchActions,
    fetchActions,
    evidenceAssessments: Array.isArray(parsed.evidenceAssessments) ? parsed.evidenceAssessments as PolicyAgentDecision['evidenceAssessments'] : [],
    finalPackage: Object.prototype.hasOwnProperty.call(parsed, 'final_package') ? parsed.final_package : undefined,
    uncertainties: Array.isArray(parsed.uncertainties) ? parsed.uncertainties.filter((item): item is string => typeof item === 'string') : [],
    discardedLeads: Array.isArray(parsed.discardedLeads) ? parsed.discardedLeads.filter((item): item is string => typeof item === 'string') : [],
  };

  return actionErrors.length > 0 ? { ok: true, decision: result, envelope: parsed, actionErrors } : { ok: true, decision: result, envelope: parsed };
}
