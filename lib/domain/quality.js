// Script quality: hard checks (computed in code, the model cannot argue with them) + an AI rubric review.
// Pure module (shared by server, UI and tests).
import { analyzeScript } from './script.js';
import { buildVePack } from './vepack.js';

export const TARGET_SCORE = 95;
export const MAX_ROUNDS = 5;
export const DEFAULT_ROUNDS = 3;

/** AI rubric. Points add up to 100. */
export const RUBRIC = [
  { id: 'hook', label: 'Hook', max: 12, what: 'The first clip stops the scroll in the first 2 seconds (a surprising fact, question, tension or striking image).' },
  { id: 'story', label: 'Story & flow', max: 14, what: 'Clear arc; every clip earns its place and leads into the next; satisfying ending / call to action.' },
  { id: 'accuracy', label: 'Accuracy', max: 14, what: 'Faithful to the brief and source data. No invented facts, numbers, names or dates.' },
  { id: 'voice', label: 'Spoken words', max: 14, what: 'Natural, easy to say aloud, no filler, numbers speakable, fits the clip time, never ends mid-thought.' },
  { id: 'images', label: 'Image prompts', max: 16, what: 'Concrete subject, setting, composition, lighting and lens; each prompt stands alone (no "same as before"); style consistent.' },
  { id: 'motion', label: 'Motion prompts', max: 12, what: 'One continuous shot; concrete camera move + subject motion; present tense; achievable in the clip length.' },
  { id: 'consistency', label: 'Consistency', max: 10, what: 'Characters, objects, palette and style stay the same across clips.' },
  { id: 'videoexpress', label: 'VideoExpress-ready', max: 8, what: 'Paste-ready plain text; no markup; no text baked into images except the on-screen text field; narration pieces short.' },
];
const RUBRIC_MAX = Object.fromEntries(RUBRIC.map((r) => [r.id, r.max]));

const spoken = (c) => (c.dialogue || []).map((l) => l.line).join(' ').trim();

/**
 * Hard checks. Each: { id, label, ok, detail, weight }. Any failure caps the final score below the target,
 * so 95+ always means "fits the clips, nothing cut off, every box filled".
 */
export function hardChecks(script, brief) {
  const checks = [];
  const add = (id, label, ok, detail, weight) => checks.push({ id, label, ok: !!ok, detail: ok ? '' : detail, weight });
  const clips = script.clips || [];
  const a = analyzeScript(script, brief);
  const narr = brief.layout === 'narration';
  const voiced = brief.dialogueMode !== 'none';

  if (narr) {
    const ext = clips.filter((c) => c.flag === 'extend').map((c) => c.index);
    add('fit', 'Every clip’s narration fits the clip', !ext.length, `Clip ${ext.join(', ')} ${ext.length > 1 ? 'run' : 'runs'} longer than a clip can be.`, 25);
  } else {
    add('fit', 'Spoken words fit every clip', !voiced || !a.overClips.length, `Clip ${a.overClips.join(', ')} ${a.overClips.length > 1 ? 'have' : 'has'} too many words for ${brief.clipSeconds}s.`, 25);
    add('count', `Exactly ${brief.clipCount} clips`, clips.length === brief.clipCount, `Has ${clips.length} clips, the brief asks for ${brief.clipCount}.`, 10);
  }
  const noImg = clips.filter((c) => (c.imagePrompt || '').trim().length < 40).map((c) => c.index);
  add('images', 'Every clip has a full image prompt', !noImg.length, `Clip ${noImg.join(', ')}: image prompt missing or too short.`, 15);
  const noMot = clips.filter((c) => (c.videoPrompt || '').trim().length < 15).map((c) => c.index);
  add('motion', 'Every clip has a motion prompt', !noMot.length, `Clip ${noMot.join(', ')}: motion prompt missing or too short.`, 10);
  if (voiced) {
    const silent = clips.filter((c) => !spoken(c)).map((c) => c.index);
    add('voice', 'Every clip has words to speak', !silent.length || narr, `Clip ${silent.join(', ')} ${silent.length > 1 ? 'have' : 'has'} no spoken words.`, 10);
    const cut = clips.filter((c) => spoken(c) && !/[.!?…]["'”’)\]]*$/.test(spoken(c))).map((c) => c.index);
    add('endings', 'No sentence is cut off', !cut.length, `Clip ${cut.join(', ')}: the words stop mid-sentence.`, 15);
  }
  if (brief.mode === 'reel') {
    add('faceless', 'Faceless: no characters', !(script.styleSheet?.characters || []).length, 'A faceless reel must not have characters.', 10);
  } else {
    const chars = (script.styleSheet?.characters || []).filter((c) => c.name);
    const thin = chars.filter((c) => (c.description || '').length < 30).map((c) => c.name);
    add('characters', 'Every character has a fixed look', !thin.length, `${thin.join(', ')}: describe the fixed look (age, hair, clothes…) so VideoExpress keeps them the same.`, 10);
    const pack = buildVePack(script, brief, {});
    add('refs', 'At most 2 characters per shot (VideoExpress reference photos)', !pack.warnings.length, pack.warnings.join(' '), 5);
  }
  const total = checks.reduce((t, c) => t + c.weight, 0);
  const got = checks.filter((c) => c.ok).reduce((t, c) => t + c.weight, 0);
  return { checks, score: total ? Math.round((got / total) * 100) : 100, failed: checks.filter((c) => !c.ok) };
}

/** Clamp an untrusted AI review into { scores, ai, summary, issues }. The total is recomputed, never trusted. */
export function normalizeReview(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const src = r.scores && typeof r.scores === 'object' ? r.scores : {};
  const scores = {};
  for (const { id, max } of RUBRIC) {
    const v = Number(src[id]);
    scores[id] = Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v * 10) / 10)) : 0;
  }
  const ai = Math.round(Object.values(scores).reduce((t, v) => t + v, 0));
  const sev = ['high', 'medium', 'low'];
  const issues = (Array.isArray(r.issues) ? r.issues : []).filter((x) => x && typeof x === 'object').slice(0, 15).map((x) => ({
    clip: Math.max(0, Math.min(200, Math.round(Number(x.clip) || 0))),
    area: RUBRIC_MAX[x.area] ? x.area : 'story',
    severity: sev.includes(x.severity) ? x.severity : 'medium',
    problem: String(x.problem || '').slice(0, 400),
    fix: String(x.fix || '').slice(0, 400),
  })).filter((x) => x.problem);
  return { scores, ai, summary: String(r.summary || '').slice(0, 600), issues };
}

/**
 * Final score: 80% AI rubric + 20% hard checks. If any hard check fails, the score is capped at target − 5,
 * so the loop keeps repairing until the script really fits.
 */
export function combineScore(review, checks, target = TARGET_SCORE) {
  let score = Math.round(review.ai * 0.8 + checks.score * 0.2);
  const capped = checks.failed.length > 0 && score > target - 5;
  if (capped) score = target - 5;
  return { score, capped };
}

export function scoreLabel(score) {
  return score >= 95 ? 'Excellent' : score >= 85 ? 'Good' : score >= 70 ? 'Needs work' : 'Weak';
}
