// Scripts by service: the same written script regrouped by the VideoExpress service each part is pasted into.
// Pure module (shared by the UI, the Markdown export and the series export).
import { composeImagePrompt, composeLastFramePrompt, dialogueText } from './script.js';

// ClipScript only writes words. VideoExpress makes the images, the video and the sound.
// The guide groups the written scripts by the VideoExpress service each one is for.
export const GUIDE_SECTIONS = [
  { id: 'images', title: 'Image scripts', tool: 'for VideoExpress Text-to-Image', what: 'Prompts to paste into VideoExpress. Clips with a last frame have two prompts.' },
  { id: 'video', title: 'Video scripts', tool: 'for VideoExpress Image-to-Video · First & Last Frame', what: 'Motion prompts to paste into VideoExpress with each clip’s image(s), plus clip order, lengths and on-screen text.' },
  { id: 'sound', title: 'Sound scripts', tool: 'for VideoExpress voice, music & sound effects', what: 'The voiceover text and the sound cues to paste into VideoExpress.' },
  { id: 'post', title: 'Post text', tool: 'caption & hashtags', what: 'Words for when you publish.' },
];

/**
 * Build a step-by-step guide. Every item has a stable `key` (used for progress checkboxes),
 * a label, the text to copy, and optional meta.
 */
export function buildGuide(script, brief, { embedStyle = true } = {}) {
  const ss = script.styleSheet || { characters: [] };
  const narr = brief.layout === 'narration';
  const sections = {};
  const add = (id, item) => { (sections[id] ||= []).push(item); };

  // 1 · Look
  const lookText = [ss.visualStyle && `Style: ${ss.visualStyle}`, ss.setting && `Setting: ${ss.setting}`, ss.palette && `Palette: ${ss.palette}`, ss.camera && `Camera: ${ss.camera}`, brief.aspectRatio && `Aspect ratio ${brief.aspectRatio}`].filter(Boolean).join('. ');
  if (lookText) add('images', { key: 'look-style', label: 'Style reference (use for every image)', text: lookText });
  for (const [i, ch] of (ss.characters || []).entries()) {
    add('images', { key: `look-char-${i}`, label: `Character: ${ch.name || i + 1}`, text: [ch.name && `${ch.name}:`, ch.description, ss.visualStyle && `Style: ${ss.visualStyle}`].filter(Boolean).join(' '), meta: ch.voice ? `Voice: ${ch.voice}` : '' });
  }

  // 2 · Images + 3 · Animate
  for (const c of script.clips) {
    const pair = !!c.lastFramePrompt;
    add('images', { key: `img-${c.index}-first`, clip: c.index, label: `Clip ${c.index}${pair ? ' · first frame' : ''}`, text: composeImagePrompt(c, ss, brief, { embedStyle }), meta: c.beat || '' });
    if (pair) add('images', { key: `img-${c.index}-last`, clip: c.index, label: `Clip ${c.index} · last frame`, text: composeLastFramePrompt(c, ss, brief, { embedStyle }), meta: c.beat || '' });
    add('video', {
      key: `vid-${c.index}`, clip: c.index,
      label: `Clip ${c.index} · ${pair ? 'First & Last Frame' : 'Image-to-Video'} · ${c.durationSeconds}s`,
      text: c.videoPrompt,
      meta: [pair ? `Use images: clip ${c.index} first + last` : `Use image: clip ${c.index}`, c.continued ? 'continues the previous shot' : '', c.flag === 'extend' ? 'then Video Length Increaser (narration runs long)' : ''].filter(Boolean).join(' · '),
      warn: c.flag === 'extend',
    });
  }

  // 4 · Voice
  const hasDialogue = script.clips.some((c) => c.dialogue.length);
  if (hasDialogue) {
    if (narr || brief.mode === 'reel') {
      const full = script.narration || script.clips.map((c) => dialogueText(c)).filter(Boolean).join(' ');
      add('sound', { key: 'voice-full', label: 'Full voiceover (one track)', text: full, meta: [brief.narratorVoice && `Voice: ${brief.narratorVoice}`, `~${Math.round(full.split(/\s+/).filter(Boolean).length / brief.wordsPerSecond)}s at ${brief.wordsPerSecond} words/sec`].filter(Boolean).join(' · ') });
    }
    if (!narr) {
      for (const c of script.clips) if (c.dialogue.length) add('sound', { key: `voice-${c.index}`, clip: c.index, label: `Clip ${c.index} lines`, text: dialogueText(c, { withSpeakers: brief.dialogueMode !== 'voiceover' && brief.mode !== 'reel' }), meta: `${c.durationSeconds}s clip` });
    }
  }

  // Finish (timeline)
  let t = 0;
  const rows = script.clips.map((c) => {
    const start = t; t += Number(c.durationSeconds) || 0;
    return { clip: c.index, start: Math.round(start * 10) / 10, end: Math.round(t * 10) / 10, seconds: c.durationSeconds, beat: c.beat, line: dialogueText(c), onScreenText: c.onScreenText, sfx: c.sfx, extend: c.flag === 'extend' };
  });
  const cues = rows.filter((r) => r.sfx);
  if (cues.length) add('sound', { key: 'sound-sfx', label: `Music & sound effects · ${cues.length} cue${cues.length > 1 ? 's' : ''}`, text: cues.map((r) => `${fmtT(r.start)}  Clip ${r.clip}: ${r.sfx}`).join('\n') });
  add('video', { key: 'assemble-timeline', label: `Clip order & lengths · ${rows.length} clips · ${Math.round(t * 10) / 10}s`, text: rows.map((r) => `${fmtT(r.start)}–${fmtT(r.end)}  Clip ${r.clip}${r.beat ? ` (${r.beat})` : ''}${r.onScreenText ? `  | text: ${r.onScreenText}` : ''}${r.sfx ? `  | sfx: ${r.sfx}` : ''}`).join('\n'), rows });
  const texts = rows.filter((r) => r.onScreenText);
  if (texts.length) add('video', { key: 'assemble-text', label: 'On-screen text', text: texts.map((r) => `${fmtT(r.start)}  ${r.onScreenText}`).join('\n') });

  // 6 · Post
  if (script.caption || script.hashtags?.length) add('post', { key: 'post-caption', label: 'Caption & hashtags', text: [script.caption, (script.hashtags || []).join(' ')].filter(Boolean).join('\n\n') });

  const out = GUIDE_SECTIONS.filter((s) => sections[s.id]?.length).map((s, i) => ({ ...s, no: i + 1, items: sections[s.id] }));
  return { sections: out, keys: out.flatMap((s) => s.items.map((it) => it.key)), totalSeconds: Math.round(t * 10) / 10 };
}
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}${s % 1 ? `.${Math.round((s % 1) * 10)}` : ''}`;

/** Progress over a stored done-map ({ key: true }). Only keys that exist in the current guide count. */
export function guideProgress(guide, done = {}) {
  const n = guide.keys.filter((k) => done[k]).length;
  return { done: n, total: guide.keys.length, pct: guide.keys.length ? Math.round((n / guide.keys.length) * 100) : 0,
    sections: Object.fromEntries(guide.sections.map((s) => [s.id, { done: s.items.filter((i) => done[i.key]).length, total: s.items.length }])) };
}

export function guideMarkdown(script, brief, heading = `# ${script.title}`) {
  const g = buildGuide(script, brief);
  const L = [heading, '', `_Scripts for VideoExpress (VideoExpress makes the images, video and sound) · ${script.clips.length} clips · ~${g.totalSeconds}s_`];
  for (const s of g.sections) {
    L.push('', `## ${s.no} · ${s.title} (${s.tool})`, '', s.what);
    for (const it of s.items) {
      L.push('', `- [ ] **${it.label}**${it.meta ? ` (${it.meta})` : ''}`);
      if (it.text) L.push('', it.key === 'assemble-timeline' || it.key === 'assemble-text' || it.key === 'sound-sfx' ? '```\n' + it.text + '\n```' : it.text.split('\n').map((l) => `    ${l}`).join('\n'));
    }
  }
  return L.join('\n') + '\n';
}
