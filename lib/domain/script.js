// Clip-script schema, parsing, validation and prompt composition for VideoExpress.
// Pure module: no DOM / Node imports.
import { countWords, dialogueWords, wordBudget, speakingWindow, speechEstimate, fitStatus, LIMITS } from './wordcount.js';

const s = (v, max = 4000) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, max);

/** Extract the first JSON object from model text (handles ```json fences and chatter). */
export function extractJson(text) {
  if (text && typeof text === 'object') return text;
  const t = String(text || '');
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  candidates.push(t);
  for (const c of candidates) {
    const start = c.indexOf('{');
    if (start < 0) continue;
    // scan for balanced braces, respecting strings
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(c.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  throw new Error('The model did not return valid JSON. Try again or pick a stronger model.');
}

function normDialogue(d) {
  if (typeof d === 'string') return d.trim() ? [{ speaker: 'Narrator', line: s(d, 1000) }] : [];
  if (!Array.isArray(d)) return [];
  return d
    .map((l) => (typeof l === 'string' ? { speaker: 'Narrator', line: l } : l))
    .filter((l) => l && typeof l === 'object')
    .map((l) => ({ speaker: s(l.speaker || l.character || 'Narrator', 60) || 'Narrator', line: s(l.line || l.text || '', 1000) }))
    .filter((l) => l.line);
}

/** Coerce untrusted model output into the canonical script schema. */
const normProgress = (p) => (p && typeof p === 'object' && !Array.isArray(p) ? Object.fromEntries(Object.entries(p).filter(([k, v]) => v === true && /^[\w-]{1,40}$/.test(k)).slice(0, 200)) : {});
export function normalizeScript(raw, brief) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ss = r.styleSheet && typeof r.styleSheet === 'object' ? r.styleSheet : {};
  const chars = Array.isArray(ss.characters) ? ss.characters : [];
  const rawClips = Array.isArray(r.clips) ? r.clips : [];
  const clipSeconds = brief ? brief.clipSeconds : 8;
  const narr = brief && brief.layout === 'narration';
  const clips = rawClips.slice(0, narr ? LIMITS.MAX_EPISODE_CLIPS : LIMITS.MAX_CLIPS).map((c, i) => ({
    index: i + 1,
    durationSeconds: narr && Number(c?.durationSeconds) > 0 ? Math.min(60, Math.round(Number(c.durationSeconds) * 10) / 10) : clipSeconds,
    lastFramePrompt: s(c && (c.lastFramePrompt || c.lastFrame), 3000),
    flag: c && c.flag === 'extend' ? 'extend' : '',
    continued: !!(c && c.continued),
    beat: s(c && (c.beat || c.title), 200),
    imagePrompt: s(c && c.imagePrompt, 3000),
    videoPrompt: s(c && (c.videoPrompt || c.motionPrompt), 2000),
    dialogue: normDialogue(c && c.dialogue),
    onScreenText: s(c && c.onScreenText, 200),
    sfx: s(c && (c.sfx || c.audio), 300),
  }));
  return {
    title: s(r.title, 160) || (brief && brief.title) || 'Untitled video',
    logline: s(r.logline, 500),
    ...(narr ? { narration: s(r.narration, 12000), caption: s(r.caption, 600), hashtags: (Array.isArray(r.hashtags) ? r.hashtags : []).map((h) => s(h, 40)).filter(Boolean).slice(0, 12) } : {}),
    buildProgress: normProgress(r.buildProgress),
    styleSheet: {
      visualStyle: s(ss.visualStyle, 1500),
      setting: s(ss.setting, 1000),
      palette: s(ss.palette, 300),
      camera: s(ss.camera, 500),
      characters: chars.slice(0, 8).map((c) => ({
        name: s(c && c.name, 60),
        description: s(c && (c.description || c.appearance), 1200),
        voice: s(c && c.voice, 200),
      })).filter((c) => c.name || c.description),
    },
    clips,
  };
}

/** Per-clip word analysis. */
export function analyzeScript(script, brief) {
  const budget = wordBudget(brief.clipSeconds, brief.wordsPerSecond, brief.paddingSeconds, brief.safetyMargin);
  const window = speakingWindow(brief.clipSeconds, brief.paddingSeconds, brief.safetyMargin);
  const clips = script.clips.map((c) => { const l = clipLimits(c, brief); return clipFit(c, brief, l.budget, l.window); });
  const totalWords = clips.reduce((n, c) => n + c.spokenWords, 0);
  return {
    budget,
    clips,
    totalWords,
    window,
    totalBudget: brief.layout === 'narration' ? clips.reduce((n, c) => n + c.budget, 0) : budget * script.clips.length,
    totalSeconds: Math.round(script.clips.reduce((n, c) => n + (Number(c.durationSeconds) || 0), 0) * 10) / 10,
    overClips: clips.filter((c) => c.status === 'over').map((c) => c.index),
    clipCountMismatch: brief.layout !== 'narration' && script.clips.length !== brief.clipCount,
  };
}

/**
 * Limits for one clip. Fixed layout: every clip gets the same budget.
 * Narration layout (episodes): the clip can be as long as VideoExpress allows (brief.clipSeconds),
 * so a clip is only "over" if its narration can't be said within that maximum. Nothing is trimmed to a box.
 */
export function clipLimits(c, brief) {
  if (brief.layout === 'narration') {
    const window = Math.max(0.5, Math.round((brief.clipSeconds - LIMITS.BREATH) * 100) / 100);
    return { budget: Math.max(1, Math.floor(window * brief.wordsPerSecond * 1.15)), window };
  }
  return { budget: wordBudget(brief.clipSeconds, brief.wordsPerSecond, brief.paddingSeconds, brief.safetyMargin), window: speakingWindow(brief.clipSeconds, brief.paddingSeconds, brief.safetyMargin) };
}
/** Fit of one clip: word count AND estimated spoken seconds (numbers/acronyms expanded, syllables, pauses). */
export function clipFit(c, brief, budget, window) {
  const text = c.dialogue.map((l) => l.line).join(' ');
  const e = speechEstimate(text, brief.wordsPerSecond);
  const none = brief.dialogueMode === 'none';
  const status = none ? (e.words ? 'over' : 'ok') : fitStatus(e, budget, window);
  const reasons = [];
  if (!none && status === 'over') {
    if (e.spokenWords > budget) reasons.push(e.spokenWords > e.words ? `${e.spokenWords} words when read aloud (numbers/abbreviations expand)` : `${e.spokenWords} words, limit ${budget}`);
    if (e.seconds > window) reasons.push(`about ${e.seconds}s to say, only ${window}s fit`);
  }
  return { index: c.index, words: e.words, spokenWords: e.spokenWords, seconds: e.seconds, window: none ? 0 : window, budget: none ? 0 : budget, status, reasons, expansions: e.expansions };
}

/** Narration layout: each clip is as long as its narration needs (+ breath), capped at brief.clipSeconds. */
export function sizeClipsToNarration(script, brief) {
  if (brief.layout !== 'narration') return script;
  return { ...script, clips: script.clips.map((c) => {
    const e = speechEstimate(c.dialogue.map((l) => l.line).join(' '), brief.wordsPerSecond);
    const need = e.words ? e.seconds + LIMITS.BREATH : Math.min(brief.clipSeconds, 3);
    return { ...c, durationSeconds: Math.ceil(Math.max(2, Math.min(brief.clipSeconds, need)) * 2) / 2, flag: need > brief.clipSeconds ? 'extend' : '' };
  }) };
}

/** Full image prompt with the style sheet embedded, so every clip image stays consistent. */
export function composeImagePrompt(clip, styleSheet, brief, { embedStyle = true } = {}) {
  const parts = [clip.imagePrompt];
  if (embedStyle && styleSheet) {
    const names = styleSheet.characters
      .filter((ch) => ch.name && clip.imagePrompt.toLowerCase().includes(ch.name.toLowerCase()));
    for (const ch of names) if (ch.description) parts.push(`${ch.name}: ${ch.description}`);
    if (styleSheet.visualStyle) parts.push(`Style: ${styleSheet.visualStyle}`);
    if (styleSheet.palette) parts.push(`Palette: ${styleSheet.palette}`);
  }
  if (brief && brief.aspectRatio) parts.push(`Aspect ratio ${brief.aspectRatio}`);
  return parts.filter(Boolean).join('. ').replace(/\.\s*\./g, '.');
}

/** Last-frame prompt (First & Last Frame image-to-video) with the same style embedded; '' when the clip has none. */
export function composeLastFramePrompt(clip, styleSheet, brief, opts) {
  if (!clip.lastFramePrompt) return '';
  return composeImagePrompt({ ...clip, imagePrompt: clip.lastFramePrompt }, styleSheet, brief, opts);
}

/** Spoken text for a clip, suitable for pasting into a TTS / voiceover box. */
export function dialogueText(clip, { withSpeakers = false } = {}) {
  return clip.dialogue.map((l) => (withSpeakers ? `${l.speaker}: ${l.line}` : l.line)).join('\n');
}

export function toMarkdown(script, brief, meta = {}) {
  const a = analyzeScript(script, brief);
  const L = [];
  L.push(`# ${script.title}`);
  if (script.logline) L.push('', `_${script.logline}_`);
  L.push('', `**Clips:** ${script.clips.length} × ${brief.clipSeconds}s · **Aspect:** ${brief.aspectRatio} · **Dialogue budget:** ${a.budget} words/clip (${brief.wordsPerSecond} w/s) · **Total words:** ${a.totalWords}/${a.totalBudget} · **Speech window:** ${a.window}s/clip (${brief.safetyMargin}% safety margin)`);
  if (meta.model) L.push(`**Generated with:** ${meta.provider || ''} ${meta.model} · ${meta.generatedAt || ''}`);
  const ss = script.styleSheet;
  L.push('', '## Style sheet');
  if (ss.visualStyle) L.push(`- **Visual style:** ${ss.visualStyle}`);
  if (ss.setting) L.push(`- **Setting:** ${ss.setting}`);
  if (ss.palette) L.push(`- **Palette:** ${ss.palette}`);
  if (ss.camera) L.push(`- **Camera:** ${ss.camera}`);
  for (const ch of ss.characters) L.push(`- **${ch.name}:** ${ch.description}${ch.voice ? ` _(voice: ${ch.voice})_` : ''}`);
  for (const c of script.clips) {
    const ca = a.clips[c.index - 1];
    L.push('', `## Clip ${c.index} — ${c.beat || ''}`.trim());
    L.push('', c.lastFramePrompt ? '**First frame (image prompt):**' : '**Image prompt:**', '', composeImagePrompt(c, ss, brief));
    if (c.lastFramePrompt) L.push('', '**Last frame (image prompt):**', '', composeLastFramePrompt(c, ss, brief));
    if (c.flag === 'extend') L.push('', '_Narration runs past the clip length: use Video Length Increaser or extend the clip._');
    L.push('', '**Video / motion prompt:**', '', c.videoPrompt);
    if (c.dialogue.length) {
      L.push('', `**Dialogue** (${ca.spokenWords}/${ca.budget} words · ~${ca.seconds}s of ${ca.window}s):`, '');
      for (const l of c.dialogue) L.push(`> **${l.speaker}:** ${l.line}`);
    }
    if (c.onScreenText) L.push('', `**On-screen text:** ${c.onScreenText}`);
    if (c.sfx) L.push('', `**SFX / music:** ${c.sfx}`);
  }
  return L.join('\n') + '\n';
}

const csvCell = (v) => {
  let t = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // spreadsheet formula-injection guard
  return '"' + t.replace(/"/g, '""') + '"';
};

export function toCsv(script, brief) {
  const a = analyzeScript(script, brief);
  const rows = [['clip', 'seconds', 'beat', 'image_prompt', 'last_frame_prompt', 'video_prompt', 'dialogue', 'words', 'word_budget', 'est_speech_seconds', 'on_screen_text', 'sfx']];
  for (const c of script.clips) {
    const ca = a.clips[c.index - 1];
    rows.push([c.index, c.durationSeconds, c.beat, composeImagePrompt(c, script.styleSheet, brief), composeLastFramePrompt(c, script.styleSheet, brief), c.videoPrompt,
      dialogueText(c, { withSpeakers: true }), ca.spokenWords, ca.budget, ca.seconds, c.onScreenText, c.sfx]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export { countWords };
