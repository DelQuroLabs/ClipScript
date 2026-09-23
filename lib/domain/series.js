// Series: one raw-data dump → an analyzed plan → many faceless episodes.
// Narration-first: each episode's voiceover is written as one continuous piece and the clips are sized
// to fit it, so words are never cut to meet a per-clip box. Pure module (no DOM / Node).
import { speechEstimate, countWords, LIMITS } from './wordcount.js';
import { normalizeBrief } from './project.js';

export const SERIES_LIMITS = Object.freeze({
  SOURCE_MAX: 100000,
  MAX_FACTS: 400,
  MAX_EPISODES: 150,
  MAX_EPISODE_CLIPS: 30,
  MIN_EP_SECONDS: 10,
  MAX_EP_SECONDS: 180,
  BREATH: 0.3, // seconds of air after each clip's narration
});
export const FORMATS = {
  'deep-dive': { label: 'Deep dive', hint: 'One strong fact explored fully: context, why it happens, a surprising angle.' },
  'quick-hit': { label: 'Quick hit', hint: 'One fact, straight to the point: hook, fact, payoff.' },
  compilation: { label: 'Compilation', hint: 'Several smaller facts linked into one rapid-fire episode.' },
};
export const FRAME_MODES = [
  { id: 'auto', label: 'First frame, plus last frame when useful', hint: 'Last frame for reveals, before/after, transformations.' },
  { id: 'first', label: 'First frame only', hint: 'Plain image-to-video.' },
  { id: 'both', label: 'First + last frame on every clip', hint: 'Most control over where each clip ends.' },
  { id: 'chain', label: 'Chained (seamless)', hint: "Each clip's last frame is the next clip's first frame, for one continuous shot." },
];

const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const s = (v, max = 4000) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, max);

export function defaultSeriesOptions() {
  return { minSeconds: 15, maxSeconds: 90, frames: 'auto', maxEpisodes: 0 /* 0 = let the analysis decide */ };
}
export function normalizeSeriesOptions(o) {
  const d = defaultSeriesOptions(), x = o && typeof o === 'object' ? o : {};
  let minSeconds = Math.round(clamp(x.minSeconds, SERIES_LIMITS.MIN_EP_SECONDS, SERIES_LIMITS.MAX_EP_SECONDS, d.minSeconds));
  let maxSeconds = Math.round(clamp(x.maxSeconds, SERIES_LIMITS.MIN_EP_SECONDS, SERIES_LIMITS.MAX_EP_SECONDS, d.maxSeconds));
  if (minSeconds > maxSeconds) [minSeconds, maxSeconds] = [maxSeconds, minSeconds];
  return {
    minSeconds, maxSeconds,
    frames: FRAME_MODES.some((f) => f.id === x.frames) ? x.frames : d.frames,
    maxEpisodes: Math.round(clamp(x.maxEpisodes, 0, SERIES_LIMITS.MAX_EPISODES, 0)),
  };
}
/** Series settings = a reel brief (style, tone, narrator, pace, clip length…) + series options. */
export function normalizeSeriesSettings(input) {
  const x = input && typeof input === 'object' ? input : {};
  const brief = normalizeBrief({ ...(x.brief || {}), mode: 'reel' });
  brief.sourceData = s(x.brief?.sourceData, SERIES_LIMITS.SOURCE_MAX);
  if (brief.dialogueMode !== 'none') brief.dialogueMode = 'voiceover';
  brief.clipSeconds = clamp(brief.clipSeconds, 2, 20, 8); // max length of ONE generated clip
  return { brief, options: normalizeSeriesOptions(x.options) };
}
export function validateSeriesSettings(st) {
  if (!st.brief.sourceData || st.brief.sourceData.trim().length < 40) return [{ field: 'sourceData', message: 'Paste at least a few sentences of raw data (40+ characters).' }];
  return [];
}

/** Target narration words for a spoken length (pace × seconds, minus the breaths between clips). */
export function wordsForSeconds(seconds, brief) {
  const clips = Math.max(1, Math.round(seconds / Math.max(3, brief.clipSeconds)));
  const speak = Math.max(3, seconds - clips * SERIES_LIMITS.BREATH);
  return Math.max(5, Math.round(speak * brief.wordsPerSecond));
}
export const roundTo5 = (n) => Math.max(5, Math.round(n / 5) * 5);

// ---------------- plan ----------------
/** Coerce untrusted analysis output into a valid plan. */
export function normalizePlan(raw, settings) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const { minSeconds, maxSeconds, maxEpisodes } = settings.options;
  const facts = [];
  const seen = new Set();
  for (const [i, f] of (Array.isArray(r.facts) ? r.facts : []).entries()) {
    if (facts.length >= SERIES_LIMITS.MAX_FACTS) break;
    const text = s(typeof f === 'string' ? f : f && (f.text || f.fact), 600);
    if (!text) continue;
    let id = s(f && f.id, 12).replace(/[^\w-]/g, '') || `f${i + 1}`;
    while (seen.has(id)) id += 'x';
    seen.add(id);
    facts.push({ id, text, interest: Math.round(clamp(f && f.interest, 1, 10, 5)) });
  }
  const factIds = new Set(facts.map((f) => f.id));
  const used = new Set();
  let episodes = [];
  for (const e of Array.isArray(r.episodes) ? r.episodes : []) {
    if (!e || typeof e !== 'object') continue;
    const ids = (Array.isArray(e.factIds) ? e.factIds : []).map(String).filter((id) => factIds.has(id) && !used.has(id));
    if (!ids.length) continue;
    ids.forEach((id) => used.add(id));
    const format = FORMATS[e.format] ? e.format : ids.length > 1 ? 'compilation' : 'quick-hit';
    const interest = Math.round(clamp(e.interest, 1, 10, Math.max(...ids.map((id) => facts.find((f) => f.id === id).interest))));
    episodes.push({
      title: s(e.title, 120) || facts.find((f) => f.id === ids[0]).text.slice(0, 60),
      hook: s(e.hook, 200), angle: s(e.angle, 300), why: s(e.why, 200),
      format, factIds: ids, interest,
      targetSeconds: roundTo5(clamp(e.targetSeconds, minSeconds, maxSeconds, lengthForInterest(interest, format, settings.options))),
    });
  }
  // Facts the model forgot become quick hits (nothing in the dump is silently dropped).
  for (const f of facts) if (!used.has(f.id)) episodes.push({ title: f.text.slice(0, 70), hook: '', angle: '', why: 'Not placed by the analysis; added so no fact is lost.', format: 'quick-hit', factIds: [f.id], interest: f.interest, targetSeconds: lengthForInterest(f.interest, 'quick-hit', settings.options), orphan: true });
  if (maxEpisodes > 0) episodes = episodes.slice(0, maxEpisodes);
  episodes = episodes.slice(0, SERIES_LIMITS.MAX_EPISODES).map((e, i) => ({ no: i + 1, include: true, status: 'pending', projectId: null, error: null, seconds: null, ...e }));
  const bible = r.bible && typeof r.bible === 'object' ? r.bible : {};
  return {
    seriesTitle: s(r.seriesTitle || r.title, 120) || 'Untitled series',
    summary: s(r.summary, 600),
    bible: { visualStyle: s(bible.visualStyle, 600), palette: s(bible.palette, 200), camera: s(bible.camera, 300), narratorVoice: s(bible.narratorVoice, 200), tone: s(bible.tone, 200), intro: s(bible.intro, 200), outro: s(bible.outro, 200), audience: s(bible.audience, 200) },
    facts, episodes,
  };
}
/** Default episode length from interest score, mapped into the allowed range. */
export function lengthForInterest(interest, format, { minSeconds, maxSeconds }) {
  const t = (clamp(interest, 1, 10, 5) - 1) / 9;
  const bias = format === 'deep-dive' ? 0.25 : format === 'compilation' ? 0.1 : -0.15;
  return roundTo5(minSeconds + (maxSeconds - minSeconds) * Math.min(1, Math.max(0, t + bias)));
}
/** Apply user edits (include / length / title) to a stored plan without letting them corrupt it. */
export function applyPlanEdits(plan, edits, settings) {
  const byNo = new Map((Array.isArray(edits) ? edits : []).map((e) => [Number(e.no), e]));
  const { minSeconds, maxSeconds } = settings.options;
  return { ...plan, episodes: plan.episodes.map((ep) => {
    const e = byNo.get(ep.no); if (!e) return ep;
    return { ...ep,
      include: e.include === undefined ? ep.include : !!e.include,
      targetSeconds: e.targetSeconds === undefined ? ep.targetSeconds : roundTo5(clamp(e.targetSeconds, minSeconds, maxSeconds, ep.targetSeconds)),
      title: e.title === undefined ? ep.title : s(e.title, 120) || ep.title };
  }) };
}
export function planStats(plan) {
  const inc = plan.episodes.filter((e) => e.include);
  const count = (st) => inc.filter((e) => e.status === st).length;
  return {
    facts: plan.facts.length, episodes: inc.length, skipped: plan.episodes.length - inc.length,
    targetSeconds: inc.reduce((n, e) => n + e.targetSeconds, 0),
    actualSeconds: inc.reduce((n, e) => n + (e.seconds || 0), 0),
    done: count('done'), failed: count('failed'), writing: count('writing'), queued: count('queued'), pending: count('pending'),
    formats: Object.fromEntries(Object.keys(FORMATS).map((f) => [f, inc.filter((e) => e.format === f).length])),
  };
}

// ---------------- episode ----------------
const splitSentences = (t) => (String(t).replace(/\s+/g, ' ').trim().match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g) || []).map((x) => x.trim()).filter(Boolean);
const norm = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Turn the model's beats into timed clips. Clip length follows the narration:
 * - a beat whose narration fits one clip → one clip, trimmed to the narration (+ breath)
 * - a longer beat → split at sentence boundaries into continuation clips (chained with first/last frames)
 * - a single sentence longer than one clip → kept whole; the clip is flagged "extend"
 * Words are never removed.
 */
export function layoutEpisode(beats, brief, frames = 'auto') {
  const maxClip = brief.clipSeconds, wps = brief.wordsPerSecond;
  const clips = [];
  const push = (c) => clips.push({ ...c, index: clips.length + 1 });
  for (const b of beats) {
    const est = speechEstimate(b.narration, wps);
    if (!b.narration || est.seconds + SERIES_LIMITS.BREATH <= maxClip) {
      const need = b.narration ? est.seconds + SERIES_LIMITS.BREATH : Math.min(maxClip, 3);
      push({ ...b, speechSeconds: est.seconds, durationSeconds: roundHalfUp(Math.max(2, need)), flag: '' });
      continue;
    }
    // pack sentences into chunks that each fit one clip
    const chunks = []; let cur = '';
    for (const sen of splitSentences(b.narration)) {
      const next = cur ? `${cur} ${sen}` : sen;
      if (!cur || speechEstimate(next, wps).seconds + SERIES_LIMITS.BREATH <= maxClip) cur = next;
      else { chunks.push(cur); cur = sen; }
    }
    if (cur) chunks.push(cur);
    chunks.forEach((text, i) => {
      const e = speechEstimate(text, wps);
      const need = e.seconds + SERIES_LIMITS.BREATH;
      const cont = i > 0;
      const prev = clips[clips.length - 1];
      push({
        ...b,
        beat: cont ? `${b.beat} (cont.)` : b.beat,
        narration: text,
        imagePrompt: cont ? (prev.lastFramePrompt || b.imagePrompt) : b.imagePrompt,
        lastFramePrompt: i < chunks.length - 1 && frames !== 'first' ? (b.lastFramePrompt || '') : b.lastFramePrompt,
        videoPrompt: cont ? `Continue the previous shot seamlessly: ${b.videoPrompt}` : b.videoPrompt,
        onScreenText: cont ? '' : b.onScreenText,
        continued: cont,
        speechSeconds: e.seconds,
        durationSeconds: roundHalfUp(Math.min(Math.max(2, need), Math.max(need, maxClip))),
        flag: need > maxClip ? 'extend' : '',
      });
    });
  }
  if (frames === 'first') clips.forEach((c) => { c.lastFramePrompt = ''; });
  // 'both' / 'chain' promise a last frame on every clip: fill any the model left out from the next first frame or the motion.
  if (frames === 'both' || frames === 'chain') clips.forEach((c, i) => {
    if (c.lastFramePrompt) return;
    const next = clips[i + 1];
    c.lastFramePrompt = frames === 'chain' && next?.imagePrompt ? next.imagePrompt : c.imagePrompt ? `${c.imagePrompt.replace(/[.\s]+$/, '')}. End of the shot, after this motion: ${c.videoPrompt || 'slow push-in'}` : '';
  });
  if (frames === 'chain') for (let i = 1; i < clips.length; i++) if (clips[i - 1].lastFramePrompt) clips[i].imagePrompt = clips[i - 1].lastFramePrompt;
  // Hard clip cap: fold any overflow into the last clip (flagged) instead of dropping narration.
  if (clips.length > SERIES_LIMITS.MAX_EPISODE_CLIPS) {
    const keep = clips.slice(0, SERIES_LIMITS.MAX_EPISODE_CLIPS), extra = clips.slice(SERIES_LIMITS.MAX_EPISODE_CLIPS);
    const last = keep[keep.length - 1];
    last.narration = [last.narration, ...extra.map((c) => c.narration)].filter(Boolean).join(' ');
    last.speechSeconds = speechEstimate(last.narration, wps).seconds;
    last.durationSeconds = roundHalfUp(last.speechSeconds + SERIES_LIMITS.BREATH);
    last.flag = last.durationSeconds > maxClip ? 'extend' : last.flag;
    return keep.map((c, i) => ({ ...c, index: i + 1 }));
  }
  return clips.map((c, i) => ({ ...c, index: i + 1 }));
}
const roundHalfUp = (n) => Math.ceil(n * 2) / 2;

/** Coerce model output for one episode into the episode script schema (shares clip fields with Studio scripts). */
export function normalizeEpisode(raw, settings, planEp, bible = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const b = settings.brief;
  const rawBeats = (Array.isArray(r.beats) ? r.beats : Array.isArray(r.clips) ? r.clips : []).filter((x) => x && typeof x === 'object');
  let beats = rawBeats.map((x) => ({
    beat: s(x.beat || x.label, 120),
    narration: s(x.narration || x.voiceover || x.line, 1500),
    imagePrompt: s(x.firstFrame || x.imagePrompt || x.firstFramePrompt, 3000),
    lastFramePrompt: s(x.lastFrame || x.lastFramePrompt, 3000),
    videoPrompt: s(x.motion || x.videoPrompt || x.motionPrompt, 2000),
    onScreenText: s(x.onScreenText || x.text, 120),
    sfx: s(x.sfx, 300),
  }));
  // The full narration is the source of truth. If the beats don't cover it, re-split it across the beats.
  let narration = s(r.narration, 12000) || beats.map((x) => x.narration).join(' ');
  if (b.dialogueMode === 'none') { narration = ''; beats = beats.map((x) => ({ ...x, narration: '' })); }
  else if (narration && beats.length) {
    const covered = norm(beats.map((x) => x.narration).join(' '));
    const full = norm(narration);
    const coverage = full ? countWords(covered) / countWords(full) : 1;
    if (coverage < 0.9 || coverage > 1.1 || !full.startsWith(norm(beats[0].narration).slice(0, 20))) beats = redistribute(narration, beats, b.wordsPerSecond);
    else narration = beats.map((x) => x.narration).join(' ');
  } else if (narration && !beats.length) {
    beats = splitSentences(narration).map((t, i) => ({ beat: `Beat ${i + 1}`, narration: t, imagePrompt: '', lastFramePrompt: '', videoPrompt: '', onScreenText: '', sfx: '' }));
  }
  const clips = layoutEpisode(beats, b, settings.options.frames);
  const vs = b.visualStyle || bible.visualStyle || '';
  return {
    title: s(r.title, 160) || planEp?.title || 'Untitled episode',
    logline: s(r.logline || r.hook, 400),
    narration: clips.map((c) => c.narration).filter(Boolean).join(' '),
    caption: s(r.caption, 600),
    hashtags: (Array.isArray(r.hashtags) ? r.hashtags : String(r.hashtags || '').split(/[\s,]+/)).map((h) => s(h, 40).replace(/^#?/, '#')).filter((h) => h.length > 1).slice(0, 12),
    styleSheet: { visualStyle: vs.replace(/;\s*palette:.*$/i, ''), setting: 'faceless, object-led scenes, no identifiable people', palette: (vs.match(/palette:\s*(.+)$/i) || [])[1] || bible.palette || '', camera: bible.camera || '', characters: [] },
    clips: clips.map((c) => ({ index: c.index, durationSeconds: c.durationSeconds, beat: c.beat, imagePrompt: c.imagePrompt, lastFramePrompt: c.lastFramePrompt, videoPrompt: c.videoPrompt, dialogue: c.narration ? [{ speaker: 'Narrator', line: c.narration }] : [], onScreenText: c.onScreenText, sfx: c.sfx, speechSeconds: c.speechSeconds, flag: c.flag, continued: !!c.continued })),
  };
}
/** Assign the full narration's sentences to beats in order, proportionally to beat count. */
function redistribute(narration, beats, wps) {
  const sens = splitSentences(narration);
  const n = Math.max(1, Math.min(beats.length, sens.length));
  const total = sens.reduce((t, x) => t + speechEstimate(x, wps).seconds, 0);
  const per = total / n;
  const groups = []; let cur = [], acc = 0;
  for (const x of sens) {
    cur.push(x); acc += speechEstimate(x, wps).seconds;
    if (acc >= per * (groups.length + 1) && groups.length < n - 1) { groups.push(cur); cur = []; }
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, i) => ({ ...(beats[i] || beats[beats.length - 1]), narration: g.join(' ') }));
}

/** Episode timing summary. Nothing is "over": clips follow the narration. */
export function analyzeEpisode(ep, brief) {
  const est = speechEstimate(ep.narration, brief.wordsPerSecond);
  const seconds = Math.round(ep.clips.reduce((n, c) => n + c.durationSeconds, 0) * 10) / 10;
  return {
    seconds, narrationSeconds: est.seconds, words: est.words, spokenWords: est.spokenWords, clips: ep.clips.length,
    extend: ep.clips.filter((c) => c.flag === 'extend').map((c) => c.index),
    lastFrames: ep.clips.filter((c) => c.lastFramePrompt).length,
    expansions: est.expansions,
  };
}

// ---------------- exports ----------------
const csvCell = (v) => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
export function seriesCsv(series, episodes, compose) {
  const rows = [['episode', 'episode_title', 'clip', 'clip_seconds', 'beat', 'narration', 'first_frame_prompt', 'last_frame_prompt', 'motion_prompt', 'on_screen_text', 'sfx']];
  for (const { no, script, brief } of episodes) for (const c of script.clips) {
    rows.push([no, script.title, c.index, c.durationSeconds, c.beat, c.dialogue.map((l) => l.line).join(' '),
      compose(c.imagePrompt, script.styleSheet, brief), c.lastFramePrompt ? compose(c.lastFramePrompt, script.styleSheet, brief) : '', c.videoPrompt, c.onScreenText, c.sfx]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
export function episodeMarkdown(no, script, brief, compose) {
  const a = analyzeEpisode(script, brief);
  const L = [`# Episode ${no}: ${script.title}`];
  if (script.logline) L.push('', `_${script.logline}_`);
  L.push('', `**Length:** ~${a.seconds}s · **Clips:** ${a.clips} · **Narration:** ${a.words} words (~${a.narrationSeconds}s at ${brief.wordsPerSecond} w/s)`);
  if (script.narration) L.push('', '## Full voiceover (paste into TTS as one track)', '', script.narration);
  for (const c of script.clips) {
    L.push('', `## Clip ${c.index}: ${c.beat} (${c.durationSeconds}s)`);
    if (c.dialogue.length) L.push('', `> ${c.dialogue.map((l) => l.line).join(' ')}`);
    L.push('', '**First frame:**', '', compose(c.imagePrompt, script.styleSheet, brief));
    if (c.lastFramePrompt) L.push('', '**Last frame:**', '', compose(c.lastFramePrompt, script.styleSheet, brief));
    L.push('', '**Motion:**', '', c.videoPrompt);
    if (c.onScreenText) L.push('', `**On-screen text:** ${c.onScreenText}`);
    if (c.sfx) L.push('', `**SFX:** ${c.sfx}`);
  }
  if (script.caption || script.hashtags?.length) L.push('', '## Post caption', '', [script.caption, (script.hashtags || []).join(' ')].filter(Boolean).join('\n\n'));
  return L.join('\n') + '\n';
}
export { LIMITS };
