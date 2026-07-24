import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDate } from '../src/search-fusion/recency-window';
import { scoreEarlyAccessSignals } from '../src/search-fusion/early-access-signals';

test('classifies ISO and Chinese dates without inventing unknown dates', () => {
  assert.equal(classifyDate('发布于 2026-07-10', { start: '2026-07-01', end: '2026-07-31' }).status, 'in_window');
  assert.equal(classifyDate('更新时间：2026年8月1日', { start: '2026-07-01', end: '2026-07-31' }).status, 'out_of_window');
  assert.equal(classifyDate('预计今年夏季发布', { start: '2026-07-01', end: '2026-07-31' }).status, 'date_unknown');
  assert.equal(classifyDate('2026-02-30，2026-07-20', { start: '2026-07-01', end: '2026-07-31' }).date, '2026-07-20');
  assert.equal(classifyDate('2026-02-30', { start: '2026-07-01', end: '2026-07-31' }).status, 'date_unknown');
});

test('detects early-access wording and penalizes ordinary releases', () => {
  const early = scoreEarlyAccessSignals('小范围灰度，邀请制 waitlist，面向 developers 的 beta preview');
  assert.equal(early.tier, 'A');
  assert.ok(early.score > 0);
  assert.ok(early.signals.length >= 3);
  const ordinary = scoreEarlyAccessSignals('产品正式发布，现已全面上线，面向所有用户开放');
  assert.equal(ordinary.tier, 'C');
  assert.ok(ordinary.score < 0);
  const app = scoreEarlyAccessSignals('mobile app developer preview launch');
  assert.equal(app.tier, 'B');
});
