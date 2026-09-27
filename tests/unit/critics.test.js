import test from 'node:test';
import assert from 'node:assert/strict';
import { CRITICS, CRITIC_IDS, VETO_BELOW, enabledCritics, normalizeCriticsOff, normalizeCritics, criticAverage, criticIssues, vetoes } from '../../lib/domain/critics.js';
import { combineScore, normalizeReview, RUBRIC, TARGET_SCORE, hardChecks } from '../../lib/domain/quality.js';
import { analyzePrompt, repairPrompt } from '../../lib/domain/polishPrompts.js';
import { normalizeBrief } from '../../lib/domain/project.js';

test('panel: 10 distinct viewpoints, each with a focus and questions', () => {
  assert.equal(CRITICS.length, 10);
  assert.equal(new Set(CRITIC_IDS).size, 10);
  for (const c of CRITICS) assert.ok(c.name && c.focus.length > 10 && c.asks.length > 20, c.id);
});

test('enabled critics: default all, switch-offs respected, never zero', () => {
  assert.deepEqual(enabledCritics({}), CRITIC_IDS);
  assert.deepEqual(enabledCritics({ criticsOff: ['safety'] }), CRITIC_IDS.filter((x) => x !== 'safety'));
  assert.deepEqual(normalizeCriticsOff(['safety', 'safety', 'bogus', 7]), ['safety']);
  assert.equal(normalizeCriticsOff(CRITIC_IDS).length, 9);
  assert.deepEqual(enabledCritics({ criticsOff: CRITIC_IDS }), CRITIC_IDS, 'all off in stored data → fall back to all');
});

test('normalizeCritics clamps untrusted output; a skipped critic scores 0 (cannot dodge the audit)', () => {
  const out = normalizeCritics([{ id: 'scroller', score: 42, verdict: 'wow', notes: [{ clip: 1, severity: 'x', problem: 'P', fix: 'F' }, { problem: '' }] }, { id: 'hacker', score: 10 }], ['scroller', 'voice']);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: 'scroller', name: 'Scroll viewer', icon: '👆', score: 10, missing: false, verdict: 'wow', notes: [{ clip: 1, severity: 'medium', problem: 'P', fix: 'F' }] });
  assert.equal(out[1].score, 0); assert.equal(out[1].missing, true);
  assert.equal(criticAverage(out), 5);
  assert.deepEqual(vetoes(out).map((c) => c.id), ['voice']);
  assert.deepEqual(normalizeCritics('junk', ['story']).map((c) => c.score), [0]);
});

test('combineScore with critics: 60/20/20 blend and a critic veto caps below target', () => {
  const full = normalizeReview({ scores: Object.fromEntries(RUBRIC.map((r) => [r.id, r.max])) });
  const ok = [{ name: 'A', score: 10 }, { name: 'B', score: 9 }];
  assert.deepEqual(combineScore(full, { score: 100, failed: [] }, TARGET_SCORE, ok), { score: Math.round(60 + 95 * 0.2 + 20), capped: false, reason: '' });
  const r = combineScore(full, { score: 100, failed: [] }, TARGET_SCORE, [{ name: 'Fact-checker', score: VETO_BELOW - 1 }, { name: 'B', score: 10 }]);
  assert.equal(r.score, TARGET_SCORE - 1); assert.equal(r.capped, true); assert.match(r.reason, /Fact-checker scored below 6/);
  assert.equal(combineScore(full, { score: 80, failed: [{}] }, TARGET_SCORE, [{ name: 'x', score: 1 }]).reason, 'automatic checks failed', 'hard checks win');
});

test('prompts: analyze lists only enabled critics and asks for their verdicts; repair carries critic notes', () => {
  const brief = normalizeBrief({ mode: 'reel', sourceData: 'x'.repeat(200), clipCount: 2, clipSeconds: 6, dialogueMode: 'voiceover' });
  const script = { title: 'T', styleSheet: { characters: [] }, clips: [1, 2].map((i) => ({ index: i, durationSeconds: 6, imagePrompt: 'A long enough image prompt of a hive at dawn, macro lens.', videoPrompt: 'Slow push-in on the hive.', dialogue: [{ speaker: 'Narrator', line: 'Bees talk.' }] })) };
  const checks = hardChecks(script, brief);
  const a = analyzePrompt(script, brief, checks, ['factcheck', 'voice']);
  assert.match(a, /CRITIC PANEL/); assert.match(a, /- critic:factcheck · Fact-checker/); assert.match(a, /- critic:voice /);
  assert.ok(!a.includes('critic:safety')); assert.match(a, /"critics": \[/);
  assert.ok(!analyzePrompt(script, brief, checks, []).includes('CRITIC PANEL'), 'no panel when none enabled');
  const critics = normalizeCritics([{ id: 'factcheck', score: 4, notes: [{ clip: 2, severity: 'high', problem: 'Invented number', fix: 'Use the source figure' }] }, { id: 'voice', score: 9 }], ['factcheck', 'voice']);
  const r = repairPrompt(script, brief, normalizeReview({}), checks, critics);
  assert.match(r, /CRITIC PANEL NOTES[\s\S]*Fact-checker · Clip 2: Invented number → Use the source figure/);
  assert.match(r, /Fact-checker 4\/10 \(BLOCKING\)/);
  assert.equal(criticIssues(critics)[0].critic, 'Fact-checker');
});
