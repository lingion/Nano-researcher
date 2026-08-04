import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicyPrompt } from '../../src/policy-task/prompt-builder.ts';

test('policy prompt exposes target metadata as model-visible context without assigning runtime gate ownership', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /targetHotspotCount/);
  assert.match(prompt, /runtime only executes, records, persists, deduplicates, and renders artifacts/i);
});
test('policy prompt includes non-AI domestic productivity, developer, and enterprise tool betas', () => {
  const prompt = buildPolicyPrompt();
  assert.match(prompt, /non-AI productivity|生产力工具/i);
  assert.match(prompt, /developer tools|开发者工具/i);
  assert.match(prompt, /enterprise SaaS|企业软件/i);
  assert.match(prompt, /2026-04-01/);
});
test('policy prompt routes the radar to latest AI products, beta access, and eligibility evidence', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /AI product and access radar|product and tool radar/i);
  assert.match(prompt, /latest AI products, models, agents, APIs, SDKs, developer tools/i);
  assert.match(prompt, /beta|alpha|preview|experimental|labs/i);
  assert.match(prompt, /early access|waitlist|invite|eligibility/i);
  assert.match(prompt, /Prioritize official product pages, official announcements, official documentation, developer portals, application forms, waitlist pages/i);
  assert.match(prompt, /Do not assume a product announcement means the product is open/i);
});

test('policy prompt limits the radar to mainland China AI products and access programs', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /中国大陆|国内 AI|mainland China/i);
  assert.match(prompt, /百度|阿里云|腾讯云|字节跳动|智谱|月之暗面|DeepSeek|MiniMax/i);
  assert.match(prompt, /国内官方产品页|中国区申请入口|大陆地区资格/i);
  assert.match(prompt, /Do not search, fetch, summarize, or report overseas-only/i);
  assert.match(prompt, /国内域名|\.cn|中国大陆/i);
});

test('policy prompt keeps search and fetch evidence boundaries', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /Search discovers candidate URLs only/i);
  assert.match(prompt, /Fetch extracts page evidence only/i);
  assert.match(prompt, /Search snippets are clues, not proof/i);
  assert.match(prompt, /Only GOLD_STANDARD and SILVER_STANDARD evidence can support the final package/i);
  assert.match(prompt, /After every FETCH, classify every newly fetched page/i);
});

test('policy prompt replaces local policy arsenal with AI access status taxonomy', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /PUBLICLY_RELEASED/);
  assert.match(prompt, /OPEN_REGISTRATION/);
  assert.match(prompt, /WAITLIST/);
  assert.match(prompt, /INVITE_REQUIRED/);
  assert.match(prompt, /DEVELOPER_PREVIEW/);
  assert.match(prompt, /CLOSED_OR_EXPIRED/);
  assert.match(prompt, /NO_PUBLIC_ELIGIBILITY_FOUND/);
  assert.doesNotMatch(prompt, /LOCAL GOVERNMENT SEMANTIC ARSENAL/);
  assert.doesNotMatch(prompt, /Core Funding Terms/);
});

test('policy prompt preserves canonical JSON action contract', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /Return JSON only/i);
  assert.match(prompt, /searchActions/);
  assert.match(prompt, /fetchActions/);
  assert.match(prompt, /evidenceAssessments/);
  assert.match(prompt, /A valid continue_fetch output has one or more executable fetchActions/i);
  assert.match(prompt, /A valid finalize, stop, or summarize_and_stop output has empty searchActions and fetchActions arrays/i);
});

test('policy prompt requires current eligibility and application evidence before stopping', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /publication date, update date, launch date, preview date, application deadline/i);
  assert.match(prompt, /exact official URL, access mechanism, eligibility requirements/i);
  assert.match(prompt, /access_or_application_url/);
  assert.match(prompt, /Stop only when the current evidence is sufficient to answer/i);
  assert.match(prompt, /NO_PUBLIC_ELIGIBILITY_FOUND/);
});
