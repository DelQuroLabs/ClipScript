import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costOf, priceFor, priceKey, formatUsd, normalizePriceOverrides, estimateAnalyzeTokens, estimateEpisodeTokens, estimateSeriesWrite, priceRange, formatRange } from '../../lib/domain/pricing.js';

test('gpt-5.6-luna: $0.20 in / $1.20 out per 1M (Standard)', () => {
  assert.equal(costOf('gpt-5.6-luna', 1e6, 0), 0.2);
  assert.equal(costOf('gpt-5.6-luna', 0, 1e6), 1.2);
  // the real "Not Today, Gus" generate: 908 in / 4033 out
  assert.ok(Math.abs(costOf('gpt-5.6-luna', 908, 4033) - 0.0050212) < 1e-7);
  assert.equal(formatUsd(costOf('gpt-5.6-luna', 908, 4033)), '$0.0050');
});
test('other rows from the pasted chart + alias', () => {
  assert.deepEqual([priceFor('gpt-5.6-sol').in, priceFor('gpt-5.6-sol').out], [4, 20]);
  assert.deepEqual([priceFor('gpt-5.6-terra').in, priceFor('gpt-5.6-terra').out], [2, 12]);
  assert.deepEqual([priceFor('gpt-6-luna').in, priceFor('gpt-6-luna').out], [0.1, 0.5]);
  assert.equal(priceFor('gpt-5.6').key, 'gpt-5.6-sol', 'gpt-5.6 is an alias of Sol');
  assert.equal(priceKey('openai/GPT-5.6-Luna-2026-08-01'), 'gpt-5.6-luna');
  assert.equal(costOf('demo-writer', 5000, 5000), 0);
});
test('unknown models have no price until the user adds one; overrides win', () => {
  assert.equal(priceFor('claude-sonnet-5'), null);
  assert.equal(costOf('claude-sonnet-5', 1000, 1000), null);
  const ov = normalizePriceOverrides({ 'Claude-Sonnet-5': { in: 3, out: 15 }, bad: { in: -1, out: 2 }, 'x y': { in: 1, out: 1 }, big: { in: 5000, out: 1 } });
  assert.deepEqual(ov, { 'claude-sonnet-5': { in: 3, out: 15 } });
  assert.equal(costOf('claude-sonnet-5', 1e6, 1e6, ov), 18);
  assert.equal(priceFor('gpt-5.6-luna', { 'gpt-5.6-luna': { in: 0.1, out: 0.6 } }).source, 'yours');
});
test('formatUsd never shows a tiny cost as $0.00', () => {
  assert.equal(formatUsd(0.00004), '$0.0000'); assert.equal(formatUsd(0.0042), '$0.0042');
  assert.equal(formatUsd(0), '$0.00'); assert.equal(formatUsd(0.123), '$0.123'); assert.equal(formatUsd(3.456), '$3.46'); assert.equal(formatUsd(null), '—');
});
test('series estimates: 100 dog facts on gpt-5.6-luna stays well under a dollar', () => {
  const a = estimateAnalyzeTokens(11000);
  assert.equal(a.calls, 2);
  const plan = { episodes: Array.from({ length: 60 }, (_, i) => ({ include: true, status: 'pending', targetSeconds: i < 25 ? 90 : 45, factIds: ['f'] })) };
  const w = estimateSeriesWrite(plan, { brief: { wordsPerSecond: 2.5, clipSeconds: 8 } });
  assert.equal(w.episodes, 60);
  const r = priceRange('gpt-5.6-luna', { input: a.input + w.input, output: a.output + w.output });
  assert.ok(r.lo > 0.1 && r.hi < 1, formatRange(r));
  assert.ok(estimateEpisodeTokens(90).output > estimateEpisodeTokens(30).output);
  // actual average replaces the heuristic once episodes exist; done/skipped excluded
  plan.episodes[0].status = 'done'; plan.episodes[1].include = false;
  assert.deepEqual(estimateSeriesWrite(plan, { brief: { wordsPerSecond: 2.5, clipSeconds: 8 } }, { actualAvg: { input: 100, output: 200 } }), { episodes: 58, input: 5800, output: 11600 });
  assert.equal(formatRange(null), 'no price set');
});
