// Build criteria: what an entry was built with (brief + generation settings + series plan + features the
// generated script actually has). Frozen when the entry is generated, stored in meta.buildSpec, and handed
// to the analyzer, every critic and the repairer as LOCKED. Nothing here relies on a human reviewing the
// result: the code re-checks every repair, restores what it can, and rejects repairs that still drop a feature.
// Pure module (server, UI, tests).

export const BUILD_SPEC_VERSION = 1;

const spoken = (c) => (c.dialogue || []).map((l) => l.line).join(' ').trim();
const words = (t) => String(t || '').split(/\s+/).filter(Boolean).length;
const every = (clips, f) => clips.length > 0 && clips.every(f);
const keyWords = (t) => [...new Set(String(t || '').toLowerCase().match(/[a-z0-9']{4,}/g) || [])];
/** Loose "does this text carry that phrase" check: most (≥60%, and at least 2) of the phrase's key words appear. */
export function carries(text, phrase) {
  const k = keyWords(phrase); if (!k.length) return true;
  const t = String(text || '').toLowerCase();
  return k.filter((w) => t.includes(w)).length >= Math.max(Math.min(2, k.length), Math.ceil(k.length * 0.6));
}
const clipText = (c) => [spoken(c), c?.onScreenText, c?.beat].filter(Boolean).join(' ');
const isChained = (clips) => clips.length > 1 && clips.slice(1).every((c, i) => clips[i].lastFramePrompt && c.imagePrompt === clips[i].lastFramePrompt);

const AI_ONLY = 'Everything is made by AI: VideoExpress renders every image, motion clip and voice from these words. There is no human crew, actor, presenter, voice artist, editor or reviewer, and nothing is filmed. Every fix must be doable by rewriting the words in this script. Never suggest hiring, filming, recording, manual editing, stock footage or "a human should check".';

/**
 * Build the locked criteria for an entry.
 * ctx (optional): { frames, hook, format, targetSeconds, outro, intro, bible, seriesTitle }
 */
export function buildSpec(brief, script, ctx = {}) {
  const clips = script?.clips || [];
  const ss = script?.styleSheet || {};
  const f = [];
  const add = (id, label, rule, params = {}) => f.push({ id, label, rule, ...params });
  const narr = brief.layout === 'narration';

  add('ai-only', '100% AI-produced (no humans)', AI_ONLY);
  if (narr) add('format', `Narrated episode · clips follow the narration (max ${brief.clipSeconds}s each)`, `Clip lengths follow the narration; no clip may run longer than ${brief.clipSeconds}s of speech. Keep it as a narrated episode.`);
  else add('format', `${brief.clipCount} clips × ${brief.clipSeconds}s`, `Exactly ${brief.clipCount} clips of ${brief.clipSeconds}s each. Never add, remove, merge or split clips.`, { clipCount: brief.clipCount });
  add('aspect', `Aspect ratio ${brief.aspectRatio}`, `Frame every shot for ${brief.aspectRatio}${brief.aspectRatio === '9:16' ? ' (vertical)' : brief.aspectRatio === '1:1' ? ' (square)' : ''}.`);
  if (brief.language && brief.language !== 'English') add('language', `Language: ${brief.language}`, `All spoken words and on-screen text stay in ${brief.language}.`);

  if (brief.mode === 'reel') add('faceless', 'Faceless (no identifiable people on camera)', 'No faces, presenters or people looking at the camera; the character list stays empty; the only voice is the off-screen Narrator.');
  if (brief.dialogueMode === 'none') add('audio', 'No spoken audio', 'Every clip\'s dialogue stays empty. Tell it with pictures and on-screen text.', { audio: 'none' });
  else if (brief.dialogueMode === 'voiceover') add('audio', `Narrator voiceover only${brief.narratorVoice ? ` · voice: ${brief.narratorVoice}` : ''}`, `All speech is the off-screen "Narrator"${brief.narratorVoice ? ` in this voice: ${brief.narratorVoice}` : ''}. Do not add on-camera dialogue or change the voice.`, { audio: 'voiceover' });
  else {
    const speakers = [...new Set(clips.flatMap((c) => (c.dialogue || []).map((l) => l.speaker)).filter(Boolean))];
    add('audio', `${brief.dialogueMode === 'dialogue' ? 'On-camera dialogue' : 'Narrator + on-camera dialogue'} · speakers: ${speakers.join(', ') || '—'}`, `Keep the ${brief.dialogueMode} audio and every speaker (${speakers.join(', ')}). Speakers must stay visible when they talk on camera.`, { audio: brief.dialogueMode, speakers });
  }
  const totalWords = clips.reduce((n, c) => n + words(spoken(c)), 0);
  if (brief.dialogueMode !== 'none' && totalWords > 0) add('content', `Keep the full story (≈${totalWords} spoken words)`, `Do not cut the content down: keep at least ${Math.floor(totalWords * 0.8)} spoken words overall (tighten wording, never drop facts or beats) while staying within each clip's limit.`, { minWords: Math.floor(totalWords * 0.8) });

  const chars = (ss.characters || []).filter((c) => c.name);
  if (brief.mode !== 'reel' && chars.length) add('characters', `Characters: ${chars.map((c) => c.name).join(', ')}`, `Keep every character (${chars.map((c) => c.name).join(', ')}) with the same name and fixed look. You may add detail to a look, never change or remove it.`, { names: chars.map((c) => c.name) });
  if (brief.characterNotes) add('character-notes', 'Character notes from the brief', `Honour the brief's character notes: ${brief.characterNotes.slice(0, 400)}`);
  const style = brief.visualStyle || ss.visualStyle || ctx.bible?.visualStyle;
  if (style) add('style', `Visual style: ${style.slice(0, 80)}`, `Keep this visual style in every image: ${style.slice(0, 400)}${ss.palette ? `. Palette: ${ss.palette}` : ''}.`);
  if (brief.tone) add('tone', `Tone: ${brief.tone}`, `Keep the tone: ${brief.tone}.`);
  if (brief.audience) add('audience', `Audience: ${brief.audience}`, `Written for: ${brief.audience}.`);
  if (brief.reelStructure) add('structure', `Reel structure: ${brief.reelStructure}`, `Keep the "${brief.reelStructure}" structure.`);
  if (brief.vibe) add('vibe', `Vibe: ${brief.vibe.replace(/\|/g, ' · ')}`, `Keep the chosen vibe (${brief.vibe.replace(/\|/g, ', ')}).`);

  if (every(clips, (c) => (c.onScreenText || '').trim())) add('onscreen', 'On-screen text in every clip', 'Every clip keeps short on-screen text (you may improve it, never remove it).');
  if (every(clips, (c) => (c.lastFramePrompt || '').trim())) add('lastframe', 'First AND last frame prompt for every clip', 'Every clip keeps both a first-frame image prompt and a last-frame prompt.');
  if (isChained(clips) || ctx.frames === 'chain') add('chain', 'Chained frames (each clip starts on the previous last frame)', 'Each clip\'s first frame must be exactly the previous clip\'s last frame, for one continuous shot.');
  const sfxN = clips.filter((c) => (c.sfx || '').trim()).length;
  if (sfxN) add('sfx', `Sound cues in ${sfxN} clip${sfxN > 1 ? 's' : ''}`, 'Keep the sound-effect cues (improve them, never remove them).', { minSfx: sfxN });
  if ((script?.caption || '').trim()) add('caption', 'Post caption', 'Keep the post caption.');
  if ((script?.hashtags || []).length) add('hashtags', 'Hashtags', 'Keep the hashtags.');

  const last = clips[clips.length - 1];
  if (brief.callToAction && last && carries(clipText(last) + ' ' + (script.caption || ''), brief.callToAction)) add('cta', `Call to action: “${brief.callToAction}”`, `The last clip keeps this call to action: "${brief.callToAction}".`, { phrase: brief.callToAction });
  if (ctx.hook && clips[0] && carries(clipText(clips[0]), ctx.hook)) add('hook', `Planned hook: “${ctx.hook}”`, `Clip 1 opens with the planned hook: "${ctx.hook}" (sharpen the wording, keep the idea).`, { phrase: ctx.hook });
  if (ctx.outro && last && carries(clipText(last), ctx.outro)) add('outro', `Series outro: “${ctx.outro}”`, `The last clip keeps the series outro: "${ctx.outro}".`, { phrase: ctx.outro });
  if (ctx.format) add('ep-format', `Episode format: ${ctx.format}${ctx.targetSeconds ? ` · ~${ctx.targetSeconds}s` : ''}`, `Keep the "${ctx.format}" episode format${ctx.targetSeconds ? ` and a length of about ${ctx.targetSeconds} seconds` : ''}.`);
  if (brief.seriesId) add('series', `Part of a series${ctx.seriesTitle ? `: ${ctx.seriesTitle}` : ''}`, `This is episode ${brief.episodeNo || '?'} of a series: keep the shared series look, narrator voice and tone so it matches the other episodes.`);

  return { v: BUILD_SPEC_VERSION, at: new Date().toISOString(), features: f };
}

/** Which locked features a script breaks. Only features the entry was built with are enforced. */
export function specViolations(spec, script, brief) {
  const out = [];
  const clips = script?.clips || [];
  const bad = (x, detail) => out.push({ id: x.id, label: x.label, detail });
  for (const x of spec?.features || []) {
    switch (x.id) {
      case 'format': if (x.clipCount && clips.length !== x.clipCount) bad(x, `has ${clips.length} clips instead of ${x.clipCount}`); break;
      case 'faceless': if ((script.styleSheet?.characters || []).length || clips.some((c) => (c.dialogue || []).some((l) => l.speaker !== 'Narrator'))) bad(x, 'added characters or an on-camera speaker'); break;
      case 'audio':
        if (x.audio === 'none' && clips.some((c) => (c.dialogue || []).length)) bad(x, 'added spoken lines');
        if (x.audio === 'voiceover' && clips.some((c) => (c.dialogue || []).some((l) => l.speaker !== 'Narrator'))) bad(x, 'added a speaker other than the Narrator');
        if (x.speakers?.length) { const now = new Set(clips.flatMap((c) => (c.dialogue || []).map((l) => l.speaker))); const gone = x.speakers.filter((s) => !now.has(s)); if (gone.length) bad(x, `speaker${gone.length > 1 ? 's' : ''} removed: ${gone.join(', ')}`); }
        break;
      case 'content': { const n = clips.reduce((t, c) => t + words(spoken(c)), 0); if (n < x.minWords) bad(x, `only ${n} spoken words left (keep at least ${x.minWords})`); break; }
      case 'characters': { const now = new Set((script.styleSheet?.characters || []).filter((c) => (c.description || '').trim()).map((c) => c.name)); const gone = x.names.filter((nm) => !now.has(nm)); if (gone.length) bad(x, `removed or blanked: ${gone.join(', ')}`); break; }
      case 'style': if (!(script.styleSheet?.visualStyle || '').trim() && !(brief?.visualStyle || '').trim()) bad(x, 'the visual style was removed'); break;
      case 'onscreen': { const m = clips.filter((c) => !(c.onScreenText || '').trim()).map((c) => c.index); if (m.length) bad(x, `missing in clip ${m.join(', ')}`); break; }
      case 'lastframe': { const m = clips.filter((c) => !(c.lastFramePrompt || '').trim()).map((c) => c.index); if (m.length) bad(x, `missing in clip ${m.join(', ')}`); break; }
      case 'chain': if (clips.length > 1 && !isChained(clips)) bad(x, 'the clips no longer start on the previous last frame'); break;
      case 'sfx': { const n = clips.filter((c) => (c.sfx || '').trim()).length; if (n < x.minSfx) bad(x, `sound cues dropped (${n} of ${x.minSfx} left)`); break; }
      case 'caption': if (!(script.caption || '').trim()) bad(x, 'caption removed'); break;
      case 'hashtags': if (!(script.hashtags || []).length) bad(x, 'hashtags removed'); break;
      case 'cta': { const l = clips[clips.length - 1]; if (!l || !carries(clipText(l) + ' ' + (script.caption || ''), x.phrase)) bad(x, 'the call to action is gone from the last clip'); break; }
      case 'hook': if (!clips[0] || !carries(clipText(clips[0]), x.phrase)) bad(x, 'clip 1 no longer opens with the planned hook'); break;
      case 'outro': { const l = clips[clips.length - 1]; if (!l || !carries(clipText(l), x.phrase)) bad(x, 'the series outro is gone from the last clip'); break; }
      default: break; // rule-only features (ai-only, aspect, tone…) are enforced through the prompts
    }
  }
  return out;
}

/**
 * Put back what a repair dropped, using the previous (best) version, clip by clip. Pure: returns a new script
 * plus the list of things it restored. Never invents content; only copies it back from `prev`.
 */
export function restoreFeatures(spec, next, prev) {
  const ids = new Set((spec?.features || []).map((x) => x.id));
  const s = JSON.parse(JSON.stringify(next));
  const restored = [];
  const same = prev && s.clips.length === prev.clips.length;
  if (same) s.clips.forEach((c, i) => {
    const p = prev.clips[i];
    if (ids.has('onscreen') && !(c.onScreenText || '').trim() && p.onScreenText) { c.onScreenText = p.onScreenText; restored.push(`on-screen text (clip ${c.index})`); }
    if (ids.has('lastframe') && !(c.lastFramePrompt || '').trim() && p.lastFramePrompt) { c.lastFramePrompt = p.lastFramePrompt; restored.push(`last frame (clip ${c.index})`); }
    if (ids.has('sfx') && !(c.sfx || '').trim() && p.sfx) { c.sfx = p.sfx; restored.push(`sound cue (clip ${c.index})`); }
  });
  if (ids.has('chain')) for (let i = 1; i < s.clips.length; i++) if (s.clips[i - 1].lastFramePrompt && s.clips[i].imagePrompt !== s.clips[i - 1].lastFramePrompt) { s.clips[i].imagePrompt = s.clips[i - 1].lastFramePrompt; if (!restored.includes('chained frames')) restored.push('chained frames'); }
  const chars = spec?.features?.find((x) => x.id === 'characters');
  if (chars && prev) {
    s.styleSheet ||= {}; s.styleSheet.characters ||= [];
    for (const nm of chars.names) {
      const cur = s.styleSheet.characters.find((c) => c.name === nm);
      const old = (prev.styleSheet?.characters || []).find((c) => c.name === nm);
      if (!old) continue;
      if (!cur) { s.styleSheet.characters.push(old); restored.push(`character ${nm}`); } else if (!(cur.description || '').trim()) { cur.description = old.description; restored.push(`${nm}'s look`); }
    }
  }
  if (prev && s.styleSheet && !(s.styleSheet.visualStyle || '').trim() && prev.styleSheet?.visualStyle) { s.styleSheet.visualStyle = prev.styleSheet.visualStyle; restored.push('visual style'); }
  if (ids.has('caption') && !(s.caption || '').trim() && prev?.caption) { s.caption = prev.caption; restored.push('caption'); }
  if (ids.has('hashtags') && !(s.hashtags || []).length && prev?.hashtags?.length) { s.hashtags = prev.hashtags; restored.push('hashtags'); }
  return { script: s, restored };
}

// Notes that would undo a locked feature. Critics and the analyzer are told not to write them; any that slip
// through are dropped in code so the repairer never sees them.
const CONFLICTS = {
  'ai-only': /\b(hire|hiring|voice actor|human (actor|narrator|editor|reviewer|voice)|real (actor|presenter)|film(ing)? (on location|it)|shoot (on location|footage|it)|record (a |your |the )?(voice|narration|voiceover) yourself|manual(ly)? edit|stock footage|have (a|someone) (human|person) (check|review))/i,
  onscreen: /\b(remove|drop|cut|delete|get rid of|no need for)\b.{0,25}\b(on-?screen text|text overlays?|captions? on screen|supers)\b/i,
  lastframe: /\b(remove|drop|cut|delete)\b.{0,25}\blast[- ]frame/i,
  chain: /\b(break|remove|drop|stop)\b.{0,25}\b(chain|chaining|continuous shot)/i,
  sfx: /\b(remove|drop|cut|delete)\b.{0,25}\b(sound effects?|sfx|sound cues?)\b/i,
  caption: /\b(remove|drop|delete)\b.{0,20}\bcaption\b/i,
  hashtags: /\b(remove|drop|delete)\b.{0,20}\bhashtags?\b/i,
  cta: /\b(remove|drop|cut|delete)\b.{0,25}\b(call to action|cta|outro)\b/i,
  outro: /\b(remove|drop|cut|delete)\b.{0,25}\b(outro|sign-?off)\b/i,
  hook: /\b(replace|remove|drop)\b.{0,25}\b(planned hook|the hook)\b/i,
  faceless: /\b(show|add|include|feature|use)\b.{0,25}\b(a |the )?(face|faces|presenter|host|talking head|person (on camera|speaking)|on-camera (host|speaker))\b/i,
  audio: /\b(add|switch to|use)\b.{0,25}\b(on-camera dialogue|a second (voice|narrator)|different (voice|narrator))\b|\b(change|switch|replace)\b.{0,15}\b(the )?(narrator|voice)\b/i,
  format: /\b(add|remove|merge|split|cut)\b.{0,15}\b(a |an |one |another |extra )?(clip|scene)s?\b(?! \d)/i,
  characters: /\b(remove|drop|cut|delete|replace|rename)\b.{0,25}\bcharacters?\b/i,
  // (not "facts": the fact-checker must be able to remove an INVENTED fact)
  content: /\b(cut|remove|drop|delete)\b.{0,25}\b(beat|beats|section|half|the ending|the payoff)\b/i,
  aspect: /\b(switch|change)\b.{0,20}\b(to )?(16:9|9:16|1:1|landscape|vertical|portrait|square)\b/i,
};
export function conflictsWithSpec(text, spec) {
  const t = String(text || '');
  const hit = (spec?.features || []).find((x) => CONFLICTS[x.id]?.test(t));
  if (hit) return hit;
  // character names: "remove Maya", "cut Gus"
  const ch = spec?.features?.find((x) => x.id === 'characters');
  if (ch && ch.names.some((nm) => new RegExp(`\\b(remove|drop|cut|delete|replace)\\b.{0,15}\\b${nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t))) return ch;
  return null;
}

export function specPromptLines(spec) {
  return (spec?.features || []).map((x) => `- [${x.id}] ${x.label}: ${x.rule}`);
}

/** Split issues / critic notes into those that respect the build criteria and those that would undo a feature. */
export function filterBySpec(items, spec) {
  const kept = [], dropped = [];
  for (const it of items || []) {
    const hit = conflictsWithSpec(`${it.problem || ''} ${it.fix || ''}`, spec);
    if (hit) dropped.push({ ...it, lockedBy: hit.id }); else kept.push(it);
  }
  return { kept, dropped };
}
