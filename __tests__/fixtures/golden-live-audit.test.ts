import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fixtureUrl = new URL('../../fixtures/live-audit/shanghai-medical-subsidy-debug-trace.json', import.meta.url);

function findFinalDecision(trace: { events?: Array<{ type?: string; payload?: unknown }> }) {
  return trace.events?.findLast((event) => event.type === 'agent.decision')?.payload as {
    decision?: {
      decision?: string;
      reasoning?: string;
      uncertainties?: string[];
      discardedLeads?: string[];
      finalPackage?: {
        final_package?: {
          policy_document_title?: string;
          policy_official_id?: string;
          issuing_authority?: string;
          temporal_lifespan?: string;
          substantive_math_clauses?: Array<{ recipient?: string; clause?: string; source_url?: string }>;
          application_gateway?: string;
        };
      };
    };
  } | undefined;
}

test('golden fixture proves Putuo medical subsidy trace is regression-ready offline', () => {
  const trace = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as { events?: Array<{ type?: string; payload?: unknown }> };
  const finalDecision = findFinalDecision(trace)?.decision;
  const finalPackage = finalDecision?.finalPackage?.final_package;

  assert.equal(finalDecision?.decision, 'stop');
  assert.match(finalDecision?.reasoning ?? '', /official Shanghai Putuo government text/);
  assert.equal(finalPackage?.policy_official_id, '普卫健行办〔2026〕1号');
  assert.equal(finalPackage?.issuing_authority, '上海市普陀区卫生健康委员会');
  assert.match(finalPackage?.temporal_lifespan ?? '', /2026/);

  const clauses = finalPackage?.substantive_math_clauses ?? [];
  assert.ok(clauses.length >= 7, 'expected multiple substantive math clauses');
  for (const recipient of ['普陀区中心医院', '普陀区人民医院', '普陀区利群医院']) {
    assert.ok(
      clauses.some((clause) => clause.recipient === recipient && clause.source_url?.includes('shpt.gov.cn')),
      `missing official clause for ${recipient}`,
    );
  }

  assert.ok(
    finalDecision?.uncertainties?.some((uncertainty) => uncertainty.includes('district-level') || uncertainty.includes('普陀区')),
    'expected district-level boundary uncertainty',
  );
  assert.ok(
    finalDecision?.uncertainties?.some((uncertainty) => uncertainty.includes('not an open public application guide')),
    'expected non-public-application-guide boundary uncertainty',
  );
  assert.ok(
    finalDecision?.discardedLeads?.some((lead) => lead.includes('shui5.cn') && lead.includes('non-official')),
    'expected non-official shui5.cn lead to be discarded',
  );
});
