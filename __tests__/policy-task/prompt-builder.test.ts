import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicyPrompt } from '../../src/policy-task/prompt-builder.ts';

test('policy prompt encodes search/fetch boundaries and agent-owned business judgment', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /You are the single Local Policy Agent/i);
  assert.match(prompt, /Search discovers candidate URLs only/i);
  assert.match(prompt, /Fetch extracts page evidence only/i);
  assert.match(prompt, /The runtime only executes, records, persists, deduplicates, and renders artifacts/i);
  assert.match(prompt, /You must decide when to search, when to fetch, when evidence is sufficient, and when to finalize/i);
  assert.match(prompt, /Do not assume discovery snippets are equal to fetched evidence/i);
  assert.match(prompt, /Return JSON only/i);
});

test('policy prompt enforces radar-first discovery and forbids stopping on news reprints or portal homepages', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /first round must prioritize radar search/i);
  assert.match(prompt, /search engine results are clues, not final proof/i);
  assert.match(prompt, /policy_grade[^\n]*news_reprint/i);
  assert.match(prompt, /policy_grade[^\n]*portal_homepage/i);
  assert.match(prompt, /must not stop/i);
  assert.match(prompt, /must fetch the suspicious url/i);
});

test('policy prompt enforces official-url pursuit and document-number re-search after fetch clues return', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /potential_official_urls/i);
  assert.match(prompt, /must prioritize fetching .*\.gov\.cn/i);
  assert.match(prompt, /extracted_doc_no/i);
  assert.match(prompt, /use that document number as the only precise query/i);
  assert.match(prompt, /official_text/i);
  assert.match(prompt, /FINAL_ASSERTION_STOP/i);
});


test('policy prompt forces mandatory fetch transition once candidates exist and forbids endless pure search loops', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /MANDATORY FETCH TRANSITION/i);
  assert.match(prompt, /FORBIDDEN from issuing consecutive rounds of pure SEARCH/i);
  assert.match(prompt, /If your `discoveredCandidates` already contains URLs from official government or authority domains/i);
});

test('policy prompt hardens legal input fields legal output schema and forbidden legacy action fields', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /Only use these input fields: `task`, `currentIteration`, `discoveredCandidates`, `fetchedEvidence`, `uncertainties`/i);
  assert.match(prompt, /The incoming JSON uses camelCase state fields, not snake_case aliases/i);
  assert.match(prompt, /Do not ignore `discoveredCandidates` just because it is not named `discovered_candidates`/i);
  assert.match(prompt, /The only legal top-level output fields are: `current_evidence_meta_check`, `decision`, `reasoning`, `searchActions`, `fetchActions`, `uncertainties`, `discardedLeads`/i);
  assert.match(prompt, /`decision` must be exactly one of: `continue_search`, `continue_fetch`, `finalize`, `stop`/i);
  assert.match(prompt, /Never emit legacy fields such as `status`, `type`, `next_actions`, `nextActions`, or `recommendedNextActions`/i);
  assert.match(prompt, /Do not wrap the JSON in markdown or code fences/i);
});

test('policy prompt requires continue_fetch to carry non-empty fetchActions copied from discoveredCandidates URLs', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /A valid `continue_fetch` output must have one or more `fetchActions`/i);
  assert.match(prompt, /If `discoveredCandidates` already contains official URLs, you must copy the exact URL strings into `fetchActions`/i);
  assert.match(prompt, /An empty `fetchActions` array makes `continue_fetch` invalid/i);
  assert.match(prompt, /Never emit `continue_fetch` without at least one executable fetch target/i);
  assert.match(prompt, /Do not use `next_actions`; the runtime consumes only the canonical `fetchActions` array/i);
  assert.match(prompt, /Do not rely on `finalPackage`; every executable fetch target must already appear in `fetchActions`/i);
});

test('policy prompt adds autonomous audit skepticism dynamic prioritization and evidence validity checks', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /AUTONOMOUS AUDIT & SELECTIVITY PROTOCOL/i);
  assert.match(prompt, /Official domains \(gov\.cn\) are NOT default evidence/i);
  assert.match(prompt, /filter out "National Level" or "General Industry" policies/i);
  assert.match(prompt, /Discarding national-level noise/i);
  assert.match(prompt, /issue only 1-2 FETCH actions per round/i);
  assert.match(prompt, /Evidence Validity Check/i);
  assert.match(prompt, /Does this text specifically mention HLJ policies/i);
  assert.match(prompt, /If NO, classify it as 'Irrelevant'/i);
});

test('policy prompt adds provincial query escalation arsenal and negative few-shot guidance', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /PROVINCIAL QUERY ESCALATION & LOCAL ARSENAL PROTOCOL/i);
  assert.match(prompt, /Public search engines automatically prioritize National-level domains/i);
  assert.match(prompt, /LOCAL GOVERNMENT SEMANTIC ARSENAL/i);
  assert.match(prompt, /\[Geographic Anchors\]/i);
  assert.match(prompt, /\[Local Authorities\]/i);
  assert.match(prompt, /\[Core Funding Terms\]/i);
  assert.match(prompt, /REASONING-BEFORE-QUERY REFLECTION/i);
  assert.match(prompt, /CRIMINAL LAZY QUERY/i);
  assert.match(prompt, /EXPERT SURGICAL QUERY/i);
  assert.match(prompt, /黑龙江省 科技厅 高新技术企业 租金减免 办法/i);
  assert.match(prompt, /Every string inside `searchActions\[\]\.query` MUST contain at least one string from \[Geographic Anchors\] and one from \[Core Funding Terms\]/i);
});

test('policy prompt adds local matryoshka forwarding detection and substantive clause closure rules', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /LOCAL MATRYOSHKA FORWARDING DETECTION & SUBSTANTIVE CLAUSE PROTOCOL/i);
  assert.match(prompt, /The "LOCAL FORWARDING" TRAP/i);
  assert.match(prompt, /THREE-TIER SUBSTANTIVE EVIDENCE CHECKLIST/i);
  assert.match(prompt, /Detected local matryoshka forwarding page/i);
  assert.match(prompt, /Rejecting as incomplete evidence, escalating query to seek substantive implementation handbooks/i);
  assert.match(prompt, /You may only output `"decision": "stop"` when your `fetchedEvidence` contains at least ONE genuine, non-forwarding document/i);
});

test('policy prompt requires temporal validity and document type meta-check before decisions', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /STRUCTURAL META-COGNITION BOX & TEMPORAL VALIDITY PROTOCOL/i);
  assert.match(prompt, /current_evidence_meta_check/i);
  assert.match(prompt, /Wednesday, June 3, 2026/i);
  assert.match(prompt, /EXPIRED_OLD_YEAR/i);
  assert.match(prompt, /ACTIVE_IN_2026_OR_CURRENT_EFFECTIVE/i);
  assert.match(prompt, /NEWS_MEETING_DYNAMICS/i);
  assert.match(prompt, /SUBSTANTIVE_REGULATION_GUIDE/i);
  assert.match(prompt, /FORWARDING_MATRYOSHKA/i);
  assert.match(prompt, /exact_matched_assertion/i);
});

test('policy prompt adds slim final package stop-gate with clause traceability and anti-sewing rules', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /TERMINAL CLOSURE: BUSINESS-FOCUSED OUTCOME PACKAGING/i);
  assert.match(prompt, /The only legal top-level output fields are: `current_evidence_meta_check`, `decision`, `reasoning`, `searchActions`, `fetchActions`, `uncertainties`, `discardedLeads`, `final_package`/i);
  assert.match(prompt, /You may ONLY output `"decision": "stop"` if you can satisfy these three conditions/i);
  assert.match(prompt, /substantive_math_clauses/i);
  assert.match(prompt, /source_url/i);
  assert.match(prompt, /If your `final_package` relies on multiple fetched pages/i);
  assert.match(prompt, /When `"decision"` is NOT `"stop"`, set `"final_package": null`/i);
});

test('policy prompt adds local authority prioritization and hard local-first fetch override for industrial park and district tasks', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /LOCAL AUTHORITY PRIORITIZATION STRATEGY/i);
  assert.match(prompt, /When the task is scoped to a specific local administrative zone/i);
  assert.match(prompt, /AUTHORITY PRECEDENCE/i);
  assert.match(prompt, /MINISTRY-LEVEL NOISE SUPPRESSION/i);
  assert.match(prompt, /FALLBACK EXCEPTION/i);
  assert.match(prompt, /Do not fetch them in the early rounds unless you have exhausted all promising local links/i);
  assert.match(prompt, /FETCH DECISION ARCHITECTURE \(MANDATORY LOCAL-FIRST\)/i);
  assert.match(prompt, /LOCAL-FIRST FETCHING/i);
  assert.match(prompt, /PRIORITY OVERRIDE/i);
  assert.match(prompt, /MANDATORY FETCH RESTRAIN/i);
  assert.match(prompt, /PROHIBITED from prioritizing its fetch unless you have already exhausted or verified the top 3 high-probability local-authority-domain links/i);
  assert.match(prompt, /FALLBACK ONLY/i);
});

