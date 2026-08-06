import type { AgentDecision, AgentDecisionType } from './types.ts';
import { RESEARCH_DECISION_FIELDS, RESEARCH_FETCH_ACTION_FIELDS, RESEARCH_SEARCH_ACTION_FIELDS } from './decision-response-schema.ts';

const DECISIONS = new Set<AgentDecisionType>(['search', 'fetch', 'review', 'finish']);
const TOP_LEVEL_FIELDS = new Set<string>(RESEARCH_DECISION_FIELDS);
const REQUIRED_TOP_LEVEL_FIELDS = RESEARCH_DECISION_FIELDS;
const MAX_ACTIONS_PER_DECISION = 8;
const MAX_EVIDENCE_URLS = 100;
const MAX_FINDINGS = 100;

export type DecisionParseResult =
  | { ok: true; decision: AgentDecision }
  | { ok: false; error: { code: string; scope: 'json' | 'decision' | 'action'; message: string } };

type DecisionErrorScope = 'json' | 'decision' | 'action';
function error(scope: DecisionErrorScope, code: string, message: string): DecisionParseResult {
  return { ok: false, error: { scope, code, message } };
}

function normalizeFinalAnswer(value: string): string {
  // Some gateways double-escape line breaks inside tool arguments. Decode only
  // the presentation text; action URLs and evidence claims remain untouched.
  return value.replaceAll('\\r\\n', '\r\n').replaceAll('\\n', '\n').replaceAll('\\r', '\r');
}

export function parseAgentDecision(raw: string): DecisionParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    return error('json', 'INVALID_JSON', 'Model output is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return error('json', 'INVALID_ENVELOPE', 'Model output must be a JSON object.');
  }
  const input = value as Record<string, unknown>;
  const unexpectedTopLevelField = Object.keys(input).find((field) => !TOP_LEVEL_FIELDS.has(field));
  if (unexpectedTopLevelField) return error('decision', 'UNEXPECTED_FIELD', `Unexpected top-level field: ${unexpectedTopLevelField}.`);
  const missingTopLevelField = REQUIRED_TOP_LEVEL_FIELDS.find((field) => !Object.prototype.hasOwnProperty.call(input, field));
  if (missingTopLevelField) return error('decision', 'MISSING_FIELD', `Missing required field: ${missingTopLevelField}.`);
  if (typeof input.decision !== 'string' || !DECISIONS.has(input.decision as AgentDecisionType)) {
    return error('decision', 'UNKNOWN_DECISION', 'decision must be search, fetch, review, or finish.');
  }
  if (input.searchActions !== undefined && !Array.isArray(input.searchActions)) {
    return error('action', 'INVALID_ACTIONS', 'searchActions must be an array.');
  }
  if (input.fetchActions !== undefined && !Array.isArray(input.fetchActions)) {
    return error('action', 'INVALID_ACTIONS', 'fetchActions must be an array.');
  }
  const rawSearchActions = input.searchActions as unknown[];
  const rawFetchActions = input.fetchActions as unknown[];
  if (rawSearchActions.length > MAX_ACTIONS_PER_DECISION || rawFetchActions.length > MAX_ACTIONS_PER_DECISION) {
    return error('action', 'ACTION_LIMIT_EXCEEDED', `Each action array is limited to ${MAX_ACTIONS_PER_DECISION} items.`);
  }
  const searchActions: Array<{ query: string; retry?: boolean }> = [];
  for (const action of rawSearchActions) {
    const record = action && typeof action === 'object' ? action as Record<string, unknown> : undefined;
    const unexpectedActionField = record && Object.keys(record).find((field) => !RESEARCH_SEARCH_ACTION_FIELDS.includes(field as typeof RESEARCH_SEARCH_ACTION_FIELDS[number]));
    if (unexpectedActionField) return error('action', 'UNEXPECTED_FIELD', `Unexpected search action field: ${unexpectedActionField}.`);
    if (!record || typeof record.query !== 'string' || !record.query.trim()) {
      return error('action', 'INVALID_SEARCH_ACTION', 'Each search action requires a non-empty query.');
    }
    if (record.query.length > 500) return error('action', 'INVALID_SEARCH_ACTION', 'Search query must be at most 500 characters.');
    const retry = record?.retry;
    if (!Object.prototype.hasOwnProperty.call(record, 'retry')) return error('action', 'MISSING_FIELD', 'Each search action requires retry.');
    if (typeof retry !== 'boolean') return error('action', 'INVALID_RETRY', 'Action retry must be a boolean.');
    const query = record.query.trim();
    if (searchActions.some((item) => item.query === query)) return error('action', 'DUPLICATE_ACTION', 'A decision cannot repeat the same search query.');
    searchActions.push({ query, ...(retry === true ? { retry: true } : {}) });
  }
  const fetchActions: Array<{ url: string; retry?: boolean }> = [];
  for (const action of rawFetchActions) {
    const record = action && typeof action === 'object' ? action as Record<string, unknown> : undefined;
    const unexpectedActionField = record && Object.keys(record).find((field) => !RESEARCH_FETCH_ACTION_FIELDS.includes(field as typeof RESEARCH_FETCH_ACTION_FIELDS[number]));
    if (unexpectedActionField) return error('action', 'UNEXPECTED_FIELD', `Unexpected fetch action field: ${unexpectedActionField}.`);
    const url = record?.url;
    if (typeof url !== 'string' || !url.trim()) return error('action', 'INVALID_FETCH_ACTION', 'Each fetch action requires a URL.');
    if (url.length > 2_048) return error('action', 'INVALID_FETCH_ACTION', 'Fetch URL must be at most 2048 characters.');
    const retry = record?.retry;
    if (!record || !Object.prototype.hasOwnProperty.call(record, 'retry')) return error('action', 'MISSING_FIELD', 'Each fetch action requires retry.');
    if (typeof retry !== 'boolean') return error('action', 'INVALID_RETRY', 'Action retry must be a boolean.');
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
      const normalizedUrl = parsed.toString();
      if (fetchActions.some((item) => item.url === normalizedUrl)) return error('action', 'DUPLICATE_ACTION', 'A decision cannot repeat the same fetch URL.');
      fetchActions.push({ url: normalizedUrl, ...(retry === true ? { retry: true } : {}) });
    } catch {
      return error('action', 'INVALID_FETCH_ACTION', 'Each fetch action requires an HTTP or HTTPS URL.');
    }
  }
  const finalDecision = input.decision as AgentDecisionType;
  if (finalDecision === 'search' && (searchActions.length === 0 || fetchActions.length > 0)) return error('decision', 'INVALID_ACTIONS', 'search requires searchActions and no fetchActions.');
  if (finalDecision === 'fetch' && (fetchActions.length === 0 || searchActions.length > 0)) return error('decision', 'INVALID_ACTIONS', 'fetch requires fetchActions and no searchActions.');
  if (finalDecision === 'review' && (searchActions.length > 0 || fetchActions.length > 0)) return error('decision', 'INVALID_ACTIONS', 'review cannot contain actions.');
  if (finalDecision === 'finish' && (searchActions.length > 0 || fetchActions.length > 0)) return error('decision', 'INVALID_ACTIONS', 'finish cannot contain actions.');
  if (!Array.isArray(input.uncertainties) || input.uncertainties.length > 16 || input.uncertainties.some((item) => typeof item !== 'string' || item.length > 500)) return error('action', 'INVALID_UNCERTAINTIES', 'uncertainties must contain at most 16 strings of at most 500 characters.');
  if (finalDecision === 'finish' && (typeof input.finalAnswer !== 'string' || !input.finalAnswer.trim())) {
    return error('decision', 'MISSING_FINAL_ANSWER', 'finish requires a non-empty finalAnswer.');
  }
  if (typeof input.finalAnswer === 'string' && input.finalAnswer.length > 12_000) return error('decision', 'INVALID_FINAL_ANSWER', 'finalAnswer must be at most 12000 characters.');
  if (finalDecision !== 'finish' && input.finalAnswer !== null) return error('decision', 'INVALID_FINAL_ANSWER', 'Only finish may include a finalAnswer.');
  if (input.evidenceUrls !== undefined && (!Array.isArray(input.evidenceUrls) || input.evidenceUrls.length > MAX_EVIDENCE_URLS)) {
    return error('action', 'INVALID_EVIDENCE_URLS', `evidenceUrls must be an array with at most ${MAX_EVIDENCE_URLS} items.`);
  }
  const evidenceUrls: string[] = [];
  for (const rawUrl of input.evidenceUrls ?? []) {
    if (typeof rawUrl !== 'string') return error('action', 'INVALID_EVIDENCE_URL', 'Each evidence URL must be an HTTP or HTTPS URL.');
    if (rawUrl.length > 2_048) return error('action', 'INVALID_EVIDENCE_URL', 'Each evidence URL must be at most 2048 characters.');
    try {
      const parsed = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
      if (!evidenceUrls.includes(parsed.toString())) evidenceUrls.push(parsed.toString());
    } catch {
      return error('action', 'INVALID_EVIDENCE_URL', 'Each evidence URL must be an HTTP or HTTPS URL.');
    }
  }
  if (finalDecision !== 'finish' && evidenceUrls.length > 0) return error('decision', 'INVALID_EVIDENCE_URLS', 'Only finish may cite evidenceUrls.');
  if (input.findings !== undefined && (!Array.isArray(input.findings) || input.findings.length > MAX_FINDINGS)) {
    return error('action', 'INVALID_FINDINGS', `findings must be an array with at most ${MAX_FINDINGS} items.`);
  }
  const findings: NonNullable<AgentDecision['findings']> = [];
  for (const rawFinding of input.findings ?? []) {
    const finding = rawFinding && typeof rawFinding === 'object' && !Array.isArray(rawFinding) ? rawFinding as Record<string, unknown> : undefined;
    const unexpectedFindingField = finding && Object.keys(finding).find((field) => !['id', 'claim', 'disposition', 'evidenceUrls'].includes(field));
    if (unexpectedFindingField) return error('action', 'UNEXPECTED_FIELD', `Unexpected finding field: ${unexpectedFindingField}.`);
    if (!finding || typeof finding.id !== 'string' || !finding.id.trim() || finding.id.length > 100) return error('action', 'INVALID_FINDING', 'Each finding requires an id of at most 100 characters.');
    if (typeof finding.claim !== 'string' || !finding.claim.trim() || finding.claim.length > 2_000) return error('action', 'INVALID_FINDING', 'Each finding requires a claim of at most 2000 characters.');
    if (finding.disposition !== 'confirmed' && finding.disposition !== 'uncertain' && finding.disposition !== 'excluded') return error('action', 'INVALID_FINDING_DISPOSITION', 'Each finding disposition must be confirmed, uncertain, or excluded.');
    if (!Array.isArray(finding.evidenceUrls) || finding.evidenceUrls.length > 20) return error('action', 'INVALID_FINDING', 'Each finding requires an evidenceUrls array with at most 20 items.');
    const findingEvidenceUrls: string[] = [];
    for (const rawUrl of finding.evidenceUrls) {
      if (typeof rawUrl !== 'string') return error('action', 'INVALID_EVIDENCE_URL', 'Each finding evidence URL must be HTTP or HTTPS.');
      if (rawUrl.length > 2_048) return error('action', 'INVALID_EVIDENCE_URL', 'Each finding evidence URL must be at most 2048 characters.');
      try {
        const parsed = new URL(rawUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
        if (!findingEvidenceUrls.includes(parsed.toString())) findingEvidenceUrls.push(parsed.toString());
      } catch {
        return error('action', 'INVALID_EVIDENCE_URL', 'Each finding evidence URL must be HTTP or HTTPS.');
      }
    }
    const id = finding.id.trim();
    const claim = finding.claim.trim();
    if (findings.some((item) => item.id === id || item.claim === claim)) return error('decision', 'DUPLICATE_FINDING', 'Finding ids and exact claims must be unique.');
    findings.push({ id, claim, disposition: finding.disposition, evidenceUrls: findingEvidenceUrls });
  }
  if (finalDecision !== 'finish' && findings.length > 0) return error('decision', 'INVALID_FINDINGS', 'Only finish may include findings.');
  // Finding-level citations are the source of truth. The top-level field stays
  // validated for wire compatibility, but is derived below so duplicated long
  // URLs cannot drift between two model-generated copies.
  const boundEvidenceUrls = finalDecision === 'finish'
    ? [...new Set(findings.flatMap((finding) => finding.evidenceUrls))]
    : [];
  const uncertainties = input.uncertainties as string[];
  return {
    ok: true,
    decision: {
      decision: finalDecision,
      searchActions,
      fetchActions,
      uncertainties,
      ...(finalDecision === 'finish' ? { finalAnswer: normalizeFinalAnswer(input.finalAnswer as string) } : {}),
      ...(boundEvidenceUrls.length > 0 ? { evidenceUrls: boundEvidenceUrls } : {}),
      ...(findings.length > 0 ? { findings } : {}),
    },
  };
}
