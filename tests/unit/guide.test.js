import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGuide, guideProgress, guideMarkdown } from '../../lib/domain/guide.js';
import { normalizeScript } from '../../lib/domain/script.js';
import { normalizeBrief } from '../../lib/domain/project.js';

const epBrief = normalizeBrief({ mode: 'reel', layout: 'narration', clipSeconds: 8, aspectRatio: '9:16', narratorVoice: 'warm narrator' });
const ep = normalizeScript({ title: 'Nose', narration: 'Your dog can smell time. Here is how.', caption: 'Mind blown', hashtags: ['#dogs'],
  styleSheet: { visualStyle: 'macro', characters: [] },
  clips: [
    { beat: 'Hook', durationSeconds: 3.5, imagePrompt: 'wet nose', lastFramePrompt: 'nose extreme close-up', videoPrompt: 'push in', dialogue: [{ speaker: 'Narrator', line: 'Your dog can smell time.' }], onScreenText: 'They smell TIME' },
    { beat: 'Why', durationSeconds: 9, flag: 'extend', imagePrompt: 'hallway', videoPrompt: 'drift', dialogue: [{ speaker: 'Narrator', line: 'Here is how.' }], sfx: 'whoosh' },
  ] }, epBrief);

test('guide: sections follow the VideoExpress build order and include every asset', () => {
  const g = buildGuide(ep, epBrief);
  assert.deepEqual(g.sections.map((s) => s.id), ['images', 'video', 'sound', 'post']);
  const images = g.sections.find((s) => s.id === 'images').items.filter((i) => i.clip);
  assert.equal(images.length, 3, 'clip 1 first+last, clip 2 first');
  assert.match(images[1].label, /last frame/);
  assert.ok(g.sections.find((s) => s.id === 'images').items.some((i) => i.key === 'look-style'), 'style reference lives with the image scripts');
  assert.match(images[0].text, /Aspect ratio 9:16/);
  const anim = g.sections.find((s) => s.id === 'video').items.filter((i) => i.key.startsWith('vid-'));
  assert.match(anim[0].label, /First & Last Frame/); assert.match(anim[1].label, /Image-to-Video/);
  assert.ok(anim[1].warn && /Length Increaser/.test(anim[1].meta));
  const sound = g.sections.find((s) => s.id === 'sound').items;
  assert.deepEqual(sound.map((i) => i.key), ['voice-full', 'sound-sfx'], 'one continuous voiceover + sound cues');
  assert.equal(sound[0].text, ep.narration);
  assert.match(sound[1].text, /Clip 2: whoosh/);
  const tl = g.sections.find((s) => s.id === 'video').items.find((i) => i.key === 'assemble-timeline');
  assert.deepEqual(tl.rows.map((r) => [r.start, r.end]), [[0, 3.5], [3.5, 12.5]]);
  assert.equal(g.totalSeconds, 12.5);
});

test('guide: story scripts get per-clip lines with speakers and no post section', () => {
  const b = normalizeBrief({ concept: 'x', clipCount: 2, clipSeconds: 8, dialogueMode: 'dialogue' });
  const s = normalizeScript({ styleSheet: { characters: [{ name: 'Maya', description: 'curly hair' }] }, clips: [{ imagePrompt: 'Maya smiles', videoPrompt: 'v', dialogue: [{ speaker: 'Maya', line: 'Hi.' }] }, { imagePrompt: 'b', videoPrompt: 'v', dialogue: [] }] }, b);
  const g = buildGuide(s, b);
  assert.ok(g.sections.find((x) => x.id === 'images').items.some((i) => /Maya/.test(i.label)));
  const v = g.sections.find((x) => x.id === 'sound').items;
  assert.equal(v.length, 1); assert.match(v[0].text, /Maya: Hi\./);
  assert.ok(!g.sections.some((x) => x.id === 'post'));
});

test('guide progress: only current keys count; stored progress survives normalizeScript', () => {
  const g = buildGuide(ep, epBrief);
  const p = guideProgress(g, { 'img-1-first': true, 'bogus': true });
  assert.equal(p.done, 1); assert.equal(p.total, g.keys.length); assert.equal(p.sections.images.done, 1);
  const kept = normalizeScript({ ...ep, buildProgress: { 'img-1-first': true, 'x y': true, evil: 'yes' } }, epBrief);
  assert.deepEqual(kept.buildProgress, { 'img-1-first': true });
});

test('guide markdown: checklist with numbered sections', () => {
  const md = guideMarkdown(ep, epBrief, '# Episode 1: Nose');
  assert.match(md, /^# Episode 1: Nose/);
  assert.match(md, /## 1 · Image scripts \(for VideoExpress Text-to-Image\)/);
  assert.doesNotMatch(md, /subtitles|Assemble|Finish/i);
  assert.match(md, /- \[ \] \*\*Clip 1 · last frame\*\*/);
  assert.match(md, /0:03\.5–0:12\.5/);
});
