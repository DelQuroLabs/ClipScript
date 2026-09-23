// Project brief model — single schema shared by UI, persistence, prompts and exports (§4.3).
import { LIMITS, wordBudget, speakingWindow } from './wordcount.js';

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:5'];
export const DIALOGUE_MODES = [
  { id: 'voiceover', label: 'Narrator voiceover' },
  { id: 'dialogue', label: 'Character dialogue (on-camera)' },
  { id: 'mixed', label: 'Mixed: narrator + characters' },
  { id: 'none', label: 'No dialogue (music / visuals only)' },
];
export const CLIP_SECOND_PRESETS = [3, 5, 6, 8, 10, 12, 15];

export function defaultBrief() {
  return {
    title: '',
    concept: '',
    clipCount: 6,
    clipSeconds: 8,
    wordsPerSecond: LIMITS.DEFAULT_WPS,
    paddingSeconds: LIMITS.DEFAULT_PADDING,
    safetyMargin: LIMITS.DEFAULT_SAFETY, // percent
    dialogueMode: 'voiceover',
    aspectRatio: '9:16',
    visualStyle: '',
    characterNotes: '',
    tone: '',
    audience: '',
    language: 'English',
    callToAction: '',
    // v2: faceless reels from raw data
    mode: 'story',          // 'story' | 'reel'
    sourceData: '',         // raw data dump (reel mode)
    reelStructure: '',      // id from randomize.REEL_STRUCTURES ('' = let the model choose)
    narratorVoice: '',
    layout: 'fixed',        // 'fixed' = every clip is clipSeconds long; 'narration' = clips follow the narration (episodes)
    seriesId: null, episodeNo: null,
    vibe: '',               // randomizer context "nicheId|mood" so single-field re-rolls stay coherent
  };
}
export const MODES = ['story', 'reel'];
export const SOURCE_MAX = 60000;

const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
};
const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);

/** Normalize untrusted input into a valid brief. Never throws. */
export function normalizeBrief(input) {
  const d = defaultBrief();
  const b = input && typeof input === 'object' ? input : {};
  return {
    title: str(b.title, 120).trim(),
    concept: str(b.concept, 6000),
    clipCount: Math.round(clamp(b.clipCount, LIMITS.MIN_CLIPS, b.layout === 'narration' ? LIMITS.MAX_EPISODE_CLIPS : LIMITS.MAX_CLIPS, d.clipCount)),
    clipSeconds: clamp(b.clipSeconds, LIMITS.MIN_SECONDS, LIMITS.MAX_SECONDS, d.clipSeconds),
    wordsPerSecond: clamp(b.wordsPerSecond, LIMITS.MIN_WPS, LIMITS.MAX_WPS, d.wordsPerSecond),
    paddingSeconds: clamp(b.paddingSeconds, 0, 5, d.paddingSeconds),
    safetyMargin: Math.round(clamp(b.safetyMargin, 0, 30, d.safetyMargin)),
    dialogueMode: DIALOGUE_MODES.some((m) => m.id === b.dialogueMode) ? b.dialogueMode : d.dialogueMode,
    aspectRatio: ASPECT_RATIOS.includes(b.aspectRatio) ? b.aspectRatio : d.aspectRatio,
    visualStyle: str(b.visualStyle, 1000),
    characterNotes: str(b.characterNotes, 3000),
    tone: str(b.tone, 200),
    audience: str(b.audience, 200),
    language: str(b.language, 40).trim() || 'English',
    callToAction: str(b.callToAction, 300),
    mode: MODES.includes(b.mode) ? b.mode : 'story',
    sourceData: str(b.sourceData, SOURCE_MAX),
    reelStructure: str(b.reelStructure, 40).replace(/[^a-z0-9-]/g, ''),
    narratorVoice: str(b.narratorVoice, 200),
    layout: b.layout === 'narration' ? 'narration' : 'fixed',
    seriesId: Number.isInteger(Number(b.seriesId)) && Number(b.seriesId) > 0 ? Number(b.seriesId) : null,
    episodeNo: Number.isInteger(Number(b.episodeNo)) && Number(b.episodeNo) > 0 ? Number(b.episodeNo) : null,
    vibe: str(b.vibe, 60).replace(/[^a-z0-9|-]/g, ''),
  };
}

/** Validation errors that should block generation. */
export function validateBrief(brief) {
  const errors = [];
  if (brief.mode === 'reel' && brief.layout === 'narration') {
    // episode of a series: facts live in sourceData, no minimum
  } else if (brief.mode === 'reel') {
    if (!brief.sourceData || brief.sourceData.trim().length < 40) errors.push({ field: 'sourceData', message: 'Paste at least a few sentences of raw data (40+ characters) for the reel to be built from.' });
    if (brief.dialogueMode === 'dialogue' || brief.dialogueMode === 'mixed') errors.push({ field: 'dialogueMode', message: 'Faceless reels use narrator voiceover or no dialogue — on-camera characters are not allowed.' });
  } else if (!brief.concept || brief.concept.trim().length < 10) errors.push({ field: 'concept', message: 'Describe the video idea in at least 10 characters.' });
  if (brief.dialogueMode !== 'none' && brief.clipSeconds && wordBudgetFor(brief) < 1) {
    errors.push({ field: 'clipSeconds', message: 'Clip length minus padding leaves no time for dialogue. Lengthen clips or reduce padding.' });
  }
  return errors;
}

export function wordBudgetFor(brief) {
  return wordBudget(brief.clipSeconds, brief.wordsPerSecond, brief.paddingSeconds, brief.safetyMargin);
}
/** Seconds of speech that safely fit in one clip (after padding + safety margin). */
export function windowFor(brief) {
  return speakingWindow(brief.clipSeconds, brief.paddingSeconds, brief.safetyMargin);
}
