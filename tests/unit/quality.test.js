import test from 'node:test';
import assert from 'node:assert/strict';
import { hardChecks, normalizeReview, combineScore, scoreLabel, RUBRIC, TARGET_SCORE } from '../../lib/domain/quality.js';
import { analyzePrompt, repairPrompt } from '../../lib/domain/polishPrompts.js';
import { normalizeBrief } from '../../lib/domain/project.js';

const IMG = 'Macro shot of a honeybee on a lavender flower, golden hour backlight, 100mm lens, shallow depth of field.';
const clip = (i, line) => ({ index: i, durationSeconds: 6, beat: 'Beat', imagePrompt: IMG, videoPrompt: 'Slow push-in as the bee lifts off.', dialogue: line ? [{ speaker: 'Narrator', line }] : [], onScreenText: 'BEES', sfx: '' });
const reel = normalizeBrief({ mode: 'reel', sourceData: 'x'.repeat(200), clipCount: 3, clipSeconds: 6, dialogueMode: 'voiceover' });
const good = () => ({ title: 'Bees', styleSheet: { characters: [] }, clips: [clip(1, 'Bees dance to talk.'), clip(2, 'They point to food.'), clip(3, 'Follow for more.')] });

test('rubric adds up to 100', () => {
  assert.equal(RUBRIC.reduce((t, r) => t + r.max, 0), 100);
});

test('hard checks: a clean script passes everything', () => {
  const h = hardChecks(good(), reel);
  assert.equal(h.failed.length, 0, JSON.stringify(h.failed));
  assert.equal(h.score, 100);
});

test('hard checks catch overlong, cut-off, missing prompts, wrong count and characters in a reel', () => {
  const s = good();
  s.clips[0].dialogue[0].line = 'This line has far far far far far far far far far far far far far far far far far far too many words.';
  s.clips[1].dialogue[0].line = 'And then the bees';
  s.clips[2].imagePrompt = 'bee';
  s.clips[2].videoPrompt = '';
  s.clips.push(clip(4, 'Extra.'));
  s.styleSheet.characters = [{ name: 'Ben', description: 'a man' }];
  const ids = hardChecks(s, reel).failed.map((c) => c.id).sort();
  assert.deepEqual(ids, ['count', 'endings', 'faceless', 'fit', 'images', 'motion']);
});

test('hard checks: story characters need a fixed look', () => {
  const b = normalizeBrief({ concept: 'x', clipCount: 3, clipSeconds: 6, dialogueMode: 'voiceover' });
  const s = good(); s.styleSheet.characters = [{ name: 'Ada', description: 'tall' }];
  assert.ok(hardChecks(s, b).failed.some((c) => c.id === 'characters'));
  s.styleSheet.characters[0].description = 'a 40-year-old woman, grey braid, navy wool coat, round glasses';
  assert.ok(!hardChecks(s, b).failed.some((c) => c.id === 'characters'));
});

test('normalizeReview clamps untrusted scores and recomputes the total', () => {
  const r = normalizeReview({ scores: { hook: 999, story: -4, accuracy: '10', images: 'x' }, total: 100, issues: [{ clip: 2, area: 'nope', severity: 'huge', problem: 'P', fix: 'F' }, { problem: '' }, null] });
  assert.equal(r.scores.hook, 12); assert.equal(r.scores.story, 0); assert.equal(r.scores.accuracy, 10); assert.equal(r.scores.images, 0);
  assert.equal(r.ai, 22);
  assert.deepEqual(r.issues, [{ clip: 2, area: 'story', severity: 'medium', problem: 'P', fix: 'F' }]);
  assert.equal(normalizeReview('garbage').ai, 0);
});

test('combineScore: 80/20 blend, capped below target when any hard check fails', () => {
  const full = normalizeReview({ scores: Object.fromEntries(RUBRIC.map((r) => [r.id, r.max])) });
  assert.deepEqual(combineScore(full, { score: 100, failed: [] }), { score: 100, capped: false, reason: '' });
  assert.deepEqual(combineScore(full, { score: 90, failed: [{}] }), { score: TARGET_SCORE - 5, capped: true, reason: 'automatic checks failed' });
  const low = normalizeReview({ scores: { hook: 6, story: 7, accuracy: 7, voice: 7, images: 8, motion: 6, consistency: 5, videoexpress: 4 } });
  assert.deepEqual(combineScore(low, { score: 60, failed: [{}] }), { score: Math.round(50 * 0.8 + 12), capped: false, reason: 'automatic checks failed' });
  assert.equal(scoreLabel(96), 'Excellent'); assert.equal(scoreLabel(70), 'Needs work');
});

test('prompts: analyze carries rubric, checks and source; repair carries issues and hard rules', () => {
  const s = good(); const h = hardChecks(s, reel);
  const a = analyzePrompt(s, { ...reel, sourceData: 'SRC'.repeat(5000) }, h);
  assert.match(a, /^TASK: ANALYZE SCRIPT/);
  for (const r of RUBRIC) assert.ok(a.includes(`${r.id} (0-${r.max})`));
  assert.match(a, /PASS: Spoken words fit every clip/);
  assert.ok(a.length < 8000 * 1.1 + 6000, 'source truncated');
  const review = normalizeReview({ scores: { hook: 5 }, issues: [{ clip: 1, area: 'hook', severity: 'high', problem: 'Weak open', fix: 'Lead with the number' }] });
  const r = repairPrompt(s, reel, review, { failed: [{ label: 'No sentence is cut off', detail: 'Clip 2 stops mid-sentence.' }] });
  assert.match(r, /^TASK: REPAIR SCRIPT/);
  assert.match(r, /Output EXACTLY 3 clips/);
  assert.match(r, /Clip 1 · hook: Weak open → Lead with the number/);
  assert.match(r, /MUST FIX[\s\S]*Clip 2 stops mid-sentence/);
  assert.match(r, /Faceless/);
});
