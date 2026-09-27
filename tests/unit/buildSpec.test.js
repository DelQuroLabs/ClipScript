import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpec, specViolations, restoreFeatures, conflictsWithSpec, filterBySpec, carries, specPromptLines } from '../../lib/domain/buildSpec.js';
import { hardChecks } from '../../lib/domain/quality.js';
import { analyzePrompt, repairPrompt, reviewerSystemPrompt } from '../../lib/domain/polishPrompts.js';
import { normalizeReview } from '../../lib/domain/quality.js';
import { normalizeBrief } from '../../lib/domain/project.js';

const story = normalizeBrief({ concept: 'A robot and an astronaut fix a lunar base.', clipCount: 3, clipSeconds: 8, dialogueMode: 'dialogue', aspectRatio: '16:9', visualStyle: 'Pixar-style 3D', callToAction: 'Subscribe for part two', tone: 'warm' });
const script = () => ({ title: 'Moon', styleSheet: { visualStyle: 'Pixar-style 3D', characters: [{ name: 'Maya', description: 'a 32-year-old astronaut, short black bob, white suit with a red stripe' }, { name: 'Gus', description: 'a round silver robot with one blue eye' }] },
  clips: [1, 2, 3].map((i) => ({ index: i, durationSeconds: 8, imagePrompt: `Shot ${i} of Maya and Gus in the lunar base, soft rim light, 35mm.`, lastFramePrompt: `End of shot ${i}.`, videoPrompt: 'Slow push-in.', onScreenText: `PART ${i}`, sfx: 'hum',
    dialogue: [{ speaker: i === 2 ? 'Gus' : 'Maya', line: i === 3 ? 'Subscribe for part two, see you soon.' : 'We have to fix this before the storm hits.' }] })) });

test('spec: captures brief settings and the features the script really has', () => {
  const ids = buildSpec(story, script()).features.map((f) => f.id);
  for (const want of ['ai-only', 'format', 'aspect', 'audio', 'content', 'characters', 'style', 'tone', 'onscreen', 'lastframe', 'sfx', 'cta']) assert.ok(ids.includes(want), want);
  assert.ok(!ids.includes('faceless') && !ids.includes('chain') && !ids.includes('caption'), 'nothing that was not built');
  const noCta = script(); noCta.clips[2].dialogue[0].line = 'Bye now.';
  assert.ok(!buildSpec(story, noCta).features.some((f) => f.id === 'cta'), 'a CTA the script never had is not enforced');
  const ep = buildSpec(normalizeBrief({ mode: 'reel', layout: 'narration', seriesId: 3, episodeNo: 2, dialogueMode: 'voiceover' }), { clips: [{ index: 1, dialogue: [{ speaker: 'Narrator', line: 'Did you know dogs dream?' }], imagePrompt: 'x' }] }, { hook: 'Did you know dogs dream', format: 'quick-hit', targetSeconds: 30, frames: 'chain' });
  assert.deepEqual(['faceless', 'hook', 'ep-format', 'series', 'chain'].filter((x) => !ep.features.some((f) => f.id === x)), []);
});

test('violations: every enforced feature is detected', () => {
  const spec = buildSpec(story, script());
  assert.deepEqual(specViolations(spec, script(), story), []);
  const s = script();
  s.clips.pop();
  s.styleSheet.characters = s.styleSheet.characters.filter((c) => c.name !== 'Gus');
  s.clips[0].onScreenText = ''; s.clips[1].lastFramePrompt = ''; s.clips.forEach((c) => { c.sfx = ''; });
  const v = specViolations(spec, s, story).map((x) => x.id).sort();
  assert.deepEqual(v, ['characters', 'content', 'cta', 'format', 'lastframe', 'onscreen', 'sfx']);
  s.clips[1].dialogue[0].speaker = 'Maya';
  assert.ok(specViolations(spec, s, story).some((x) => x.id === 'audio' && /Gus/.test(x.detail)), 'a speaker who no longer talks is caught');
  assert.ok(hardChecks(s, story, spec).failed.some((c) => c.id === 'locked'), 'a broken build feature fails the hard checks');
});

test('restore: copies dropped parts back from the previous version (never invents)', () => {
  const spec = buildSpec(story, script());
  const next = script(); next.clips[0].onScreenText = ''; next.clips[1].lastFramePrompt = ''; next.clips[2].sfx = ''; next.styleSheet.characters = [next.styleSheet.characters[0]];
  const { script: fixed, restored } = restoreFeatures(spec, next, script());
  assert.deepEqual(specViolations(spec, fixed, story), []);
  assert.deepEqual(restored.sort(), ['character Gus', 'last frame (clip 2)', 'on-screen text (clip 1)', 'sound cue (clip 3)']);
  assert.equal(next.clips[0].onScreenText, '', 'input not mutated');
  // chain restored
  const b = normalizeBrief({ mode: 'reel', dialogueMode: 'voiceover', clipCount: 2, sourceData: 'x'.repeat(50) });
  const ch = { styleSheet: {}, clips: [{ index: 1, imagePrompt: 'A', lastFramePrompt: 'B', dialogue: [] }, { index: 2, imagePrompt: 'B', lastFramePrompt: 'C', dialogue: [] }] };
  const cs = buildSpec(b, ch);
  assert.ok(cs.features.some((f) => f.id === 'chain'));
  const broken = JSON.parse(JSON.stringify(ch)); broken.clips[1].imagePrompt = 'Something else';
  assert.equal(specViolations(cs, broken, b)[0].id, 'chain');
  assert.equal(restoreFeatures(cs, broken, ch).script.clips[1].imagePrompt, 'B');
});

test('conflicting notes are caught (locked features + anything needing a human), legit fixes pass', () => {
  const spec = buildSpec(story, script());
  const bad = ['Remove the on-screen text, it clutters.', 'Hire a voice actor for a warmer read.', 'Cut Gus, he adds nothing.', 'Drop the sound effects in clip 2.', 'Merge clip 2 into clip 1... add another clip for the ending.', 'Switch to 9:16 for TikTok.', 'Remove the call to action.', 'Have a human reviewer check the facts.', 'Delete the last frame prompts.'];
  for (const t of bad) assert.ok(conflictsWithSpec(t, spec), t);
  const ok = ['Add rim light and a 50mm lens to clip 3.', 'Shorten the line in clip 2 by three words.', 'Replace the invented number in clip 2 with the source figure.', 'Cut filler words in clip 4.', 'Make the on-screen text punchier.', 'Remove the invented fact about the storm.'];
  for (const t of ok) assert.equal(conflictsWithSpec(t, spec), null, t);
  const { kept, dropped } = filterBySpec([{ problem: 'Busy frame', fix: 'Remove the on-screen text.' }, { problem: 'Dark', fix: 'Add a key light.' }], spec);
  assert.equal(kept.length, 1); assert.equal(dropped[0].lockedBy, 'onscreen');
  assert.ok(carries('Follow us for MORE ocean facts!', 'Follow for more ocean facts')); assert.ok(!carries('Bye', 'Follow for more ocean facts'));
});

test('prompts: analyzer, critics and repairer all receive the locked criteria and the AI-only rule', () => {
  const spec = buildSpec(story, script());
  const checks = hardChecks(script(), story, spec);
  assert.match(reviewerSystemPrompt(), /no humans/i); assert.match(reviewerSystemPrompt(), /LOCKED BUILD CRITERIA/);
  const a = analyzePrompt(script(), story, checks, ['voice'], spec);
  assert.match(a, /LOCKED BUILD CRITERIA[\s\S]*\[characters\] Characters: Maya, Gus[\s\S]*RUBRIC/);
  assert.match(a, /Every critic knows the LOCKED BUILD CRITERIA/);
  assert.match(a, /\[ai-only\]/);
  const r = repairPrompt(script(), story, normalizeReview({}), checks, [], spec, [{ label: '3 clips × 8s', detail: 'has 2 clips instead of 3' }]);
  assert.match(r, /LOCKED BUILD CRITERIA/); assert.match(r, /YOUR LAST REPAIR WAS REJECTED[\s\S]*has 2 clips instead of 3/);
  assert.match(r, /Every LOCKED BUILD CRITERION above stays exactly as built/);
  assert.equal(specPromptLines(spec).length, spec.features.length);
});
