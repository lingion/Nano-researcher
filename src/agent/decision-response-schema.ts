import type { LlmResponseFormat } from '../llm/provider.ts';

export const RESEARCH_DECISION_FIELDS = ['decision', 'searchActions', 'fetchActions', 'uncertainties', 'finalAnswer', 'evidenceUrls', 'findings'] as const;
export const RESEARCH_SEARCH_ACTION_FIELDS = ['query', 'retry'] as const;
export const RESEARCH_FETCH_ACTION_FIELDS = ['url', 'retry'] as const;

const searchActionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [...RESEARCH_SEARCH_ACTION_FIELDS],
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 500 },
    retry: { type: 'boolean' },
  },
};

const fetchActionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [...RESEARCH_FETCH_ACTION_FIELDS],
  properties: {
    url: { type: 'string', minLength: 1, maxLength: 2048 },
    retry: { type: 'boolean' },
  },
};

const findingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'claim', 'disposition', 'evidenceUrls'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 100 },
    claim: { type: 'string', minLength: 1, maxLength: 2_000 },
    disposition: { type: 'string', enum: ['confirmed', 'uncertain', 'excluded'] },
    evidenceUrls: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 2_048 } },
  },
};

/**
 * The model-to-executor contract. This is deliberately a small action envelope:
 * no free-form reasons, candidate lists, or hidden planning fields are allowed.
 * The parser remains the semantic enforcement point for decision/action coupling.
 */
export const researchDecisionParameters: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [...RESEARCH_DECISION_FIELDS],
  properties: {
    decision: { type: 'string', enum: ['search', 'fetch', 'review', 'finish'] },
    searchActions: { type: 'array', maxItems: 8, items: searchActionSchema },
    fetchActions: { type: 'array', maxItems: 8, items: fetchActionSchema },
    uncertainties: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 500 } },
    finalAnswer: { type: ['string', 'null'], maxLength: 12_000 },
    evidenceUrls: { type: 'array', maxItems: 100, description: 'Compatibility field. For finish, the runtime derives final evidenceUrls from finding-level citations; submit an empty array.', items: { type: 'string', minLength: 1, maxLength: 2_048 } },
    findings: { type: 'array', maxItems: 100, items: findingSchema },
  },
};

export const researchDecisionTool = {
  name: 'submit_research_decision',
  description: 'Submit exactly one research-agent decision for the current turn.',
  parameters: researchDecisionParameters,
};

export const researchDecisionResponseFormat: LlmResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'research_decision',
    strict: true,
    schema: researchDecisionParameters,
  },
};
