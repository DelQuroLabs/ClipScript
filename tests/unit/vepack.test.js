import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVePack, vePackMarkdown, vePackSeriesMarkdown, splitForLimit, suggestImageType, orientationLabel, normalizeVeSettings, VE_LIMITS } from '../../lib/domain/vepack.js';

const LONG = 'In 1969, two astronauts walked on the Moon while a third orbited alone, farther from home than anyone had ever been, and he later said he never felt lonely at all.';
const words = (t) => t.split(/\s+/).filter(Boolean);
const script = (extra = {}) => ({ title: 'Moon', styleSheet: { visualStyle: 'Pixar-style 3D animation', palette: 'teal and amber', setting: 'lunar base', camera: '', characters: [
  { name: 'Maya', description: 'a 32-year-old astronaut, short black bob, white suit with a red stripe', voice: 'warm' },
  { name: 'Gus', description: 'a round silver robot with one blue eye', voice: 'cheerful' }] },
  clips: [
    { index: 1, durationSeconds: 8, beat: 'Hook', imagePrompt: 'Maya at the window', videoPrompt: 'slow push-in', dialogue: [{ speaker: 'Narrator', line: LONG }], onScreenText: 'ALONE?', sfx: 'hum' },
    { index: 2, durationSeconds: 8, beat: 'Talk', imagePrompt: 'Maya and Gus in the airlock', videoPrompt: 'gentle sway', dialogue: [{ speaker: 'Maya', line: 'Gus, did you hear that?' }, { speaker: 'Gus', line: 'Only your heartbeat, captain. It is very loud today!' }] },
  ], ...extra });

test('splitForLimit never drops or changes a word and respects the limit', () => {
  for (const max of [120, 100, 40, 12]) {
    const parts = splitForLimit(LONG, max);
    assert.ok(parts.every((p) => p.length <= max), `max ${max}`);
    assert.deepEqual(words(parts.join(' ')), words(LONG));
  }
  assert.deepEqual(splitForLimit('Short line.', 120), ['Short line.']);
  assert.deepEqual(splitForLimit('', 120), []);
});

test('reel/voiceover: every scene is Narration, text ≤120 chars, all narration kept, scene tags', () => {
  const p = buildVePack(script(), { mode: 'reel', dialogueMode: 'voiceover', aspectRatio: '9:16' });
  assert.ok(p.scenes.every((s) => s.route === 'narration' && s.narration.length <= VE_LIMITS.NARRATION_MAX));
  const all = script().clips.flatMap((c) => c.dialogue.map((l) => l.line)).join(' ');
  assert.deepEqual(words(p.scenes.map((s) => s.narration).join(' ')), words(all));
  assert.equal(p.scenes[0].id, 'SC-001');
  assert.ok(p.scenes.every((s) => s.imagePrompt.startsWith(`[${s.id}]`) && s.videoPrompt.startsWith(`[${s.id}]`)));
  assert.equal(p.scenes[1].reuseImageOf, 'SC-001', 'split clip reuses the first picture');
  assert.match(p.setup.join(' '), /Vertical 9:16/);
  assert.match(p.setup.join(' '), /Narration Video \(Choose my Audio\)/);
  assert.match(p.setup.join(' '), /UNTICK "Share this in the public gallery"/);
  assert.match(p.voice.steps[0], /CloneVoice\.ai.*Lucas Rhodes/);
});

test('consistent characters: full description in every image prompt, reference slots, character pictures', () => {
  const p = buildVePack(script(), { mode: 'story', dialogueMode: 'mixed', aspectRatio: '16:9' });
  assert.equal(p.characters.length, 2);
  assert.match(p.characters[0].refPrompt, /^Maya: A 32-year-old astronaut.*head-and-shoulders close-up/);
  const talk = p.scenes.find((s) => s.clip === 2);
  assert.ok(talk.imagePrompt.includes('Maya: A 32-year-old astronaut') && talk.imagePrompt.includes('Gus: A round silver robot'));
  assert.deepEqual(talk.refs.map((r) => `${r.slot}=${r.name}`), ['Reference Photo=Maya', 'Reference Photo 2=Gus']);
});

test('on-camera dialogue → Lipsync with Actor 1/2 scripts ≤100 chars total, never in the video prompt', () => {
  const p = buildVePack(script(), { mode: 'story', dialogueMode: 'dialogue', aspectRatio: '16:9' });
  const lip = p.scenes.filter((s) => s.route === 'lipsync');
  assert.ok(lip.length >= 1);
  for (const s of lip) {
    assert.ok(s.chars <= VE_LIMITS.LIPSYNC_MAX);
    assert.ok(s.actors.length <= 2);
    assert.ok(!s.videoPrompt.includes('heartbeat'));
    assert.match(s.actorPrompt, /^Actor 1 is Maya/);
  }
  assert.deepEqual(words(lip.flatMap((s) => s.actors.map((a) => a.script)).join(' ')), words('Gus, did you hear that? Only your heartbeat, captain. It is very loud today!'));
});

test('no dialogue → silent scenes; faceless (no characters) → consistent character off + style lock', () => {
  const s = script(); s.styleSheet.characters = []; s.clips.forEach((c) => { c.dialogue = []; });
  const p = buildVePack(s, { mode: 'story', dialogueMode: 'none', aspectRatio: '1:1' });
  assert.ok(p.scenes.every((x) => x.route === 'silent'));
  assert.equal(p.voice, null);
  assert.match(p.setup.join(' '), /Use Consistent Character: OFF/);
  assert.ok(p.scenes.every((x) => x.imagePrompt.includes('Style: Pixar-style 3D animation.')));
});

test('settings + helpers', () => {
  assert.equal(suggestImageType('flat 2D cartoon'), '2D');
  assert.equal(suggestImageType('Pixar-style 3D'), '3D');
  assert.equal(suggestImageType('cinematic photoreal'), 'human');
  assert.equal(orientationLabel('16:9'), 'Landscape 16:9');
  const v = normalizeVeSettings({ voiceTab: 'bogus', voice: '  Ava  ', imageType: '2D', autoEnhance: 'yes' });
  assert.deepEqual([v.voiceTab, v.voice, v.imageType, v.autoEnhance], ['CloneVoice.ai', 'Ava', '2D', false]);
  const p = buildVePack(script(), { mode: 'reel', dialogueMode: 'voiceover', aspectRatio: '9:16' }, { voice: 'Ava', voiceTab: 'Text to Speech' });
  assert.match(p.voice.steps[0], /Text to Speech.*Ava/);
});

test('markdown: one fenced block per field; series pack uses one voice and episode-prefixed scene ids', () => {
  const md = vePackMarkdown(buildVePack(script(), { mode: 'reel', dialogueMode: 'voiceover', aspectRatio: '9:16' }));
  assert.match(md, /```text\n\[SC-001\]/);
  assert.match(md, /\*\*Narration\*\*.*116\/120 characters/);
  const eps = [1, 2].map((no) => ({ no, script: script(), brief: { mode: 'reel', layout: 'narration', dialogueMode: 'voiceover', aspectRatio: '9:16' } }));
  const smd = vePackSeriesMarkdown('Space', eps, { voice: 'Lucas Rhodes' });
  assert.equal((smd.match(/^# Episode \d+:/gm) || []).length, 2);
  assert.equal((smd.match(/Narrator voice: the SAME/g) || []).length, 1);
  assert.match(smd, /\[E01-SC-001\]/); assert.match(smd, /\[E02-SC-001\]/);
});
