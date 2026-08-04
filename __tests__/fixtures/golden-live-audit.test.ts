import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fixtureUrl = new URL('../../fixtures/live-audit/ai-product-access-radar.json', import.meta.url);

test('golden fixture proves AI product access radar output is regression-ready offline', () => {
  const trace = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as {
    events?: Array<{ type?: string; payload?: { decision?: Record<string, unknown> } }>;
  };
  const event = trace.events?.findLast((candidate) => candidate.type === 'agent.decision');
  const decision = event?.payload?.decision;
  const finalPackage = (decision?.finalPackage as { final_package?: Record<string, unknown> } | undefined)?.final_package;

  assert.equal(decision?.decision, 'stop');
  assert.match(String(decision?.reasoning), /official product and access evidence/i);
  assert.equal(finalPackage?.product_name, 'Example AI Developer Preview');
  assert.equal(finalPackage?.access_status, 'DEVELOPER_PREVIEW');
  assert.equal(finalPackage?.access_or_application_url, 'https://example.ai/apply');
  assert.deepEqual(finalPackage?.eligibility_requirements, ['Developer account', 'Waitlist application']);
  assert.match(String(finalPackage?.geography_or_account_limits), /Selected regions/);
  assert.match(String(finalPackage?.deadline_or_waitlist_status), /Waitlist open/);
});
