// Pure domain logic: spoken-word counting and per-clip dialogue budgets.
// No DOM / Node / framework imports allowed in lib/domain (charter §3.1).

/** Remove stage directions ([...] / (...)) and speaker labels so only spoken words remain. */
export function spokenText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\*[^*]*\*/g, ' ');
}

/**
 * Count words as a TTS voice would speak them.
 * - contractions ("don't") = 1 word
 * - hyphenated compounds ("state-of-the-art") = one word per part (each part is voiced)
 * - em/en dashes and slashes separate words
 * - stage directions in [brackets], (parentheses) or *asterisks* are not spoken → not counted
 */
export function countWords(text) {
  const t = spokenText(text)
    .replace(/[\u2014\u2013/]/g, ' ')
    .replace(/(\w)-(?=\w)/g, '$1 ');
  const tokens = t.match(/[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu);
  return tokens ? tokens.length : 0;
}

export const LIMITS = Object.freeze({
  MIN_CLIPS: 1,
  MAX_CLIPS: 10,
  MAX_EPISODE_CLIPS: 30,
  BREATH: 0.3, // seconds of air after a clip's narration (narration layout)
  MIN_SECONDS: 2,
  MAX_SECONDS: 60,
  MIN_WPS: 1,
  MAX_WPS: 4,
  DEFAULT_WPS: 2.5,
  DEFAULT_PADDING: 0.5,
  DEFAULT_SAFETY: 10, // % of the speaking window held back so the last word is never clipped
});

/** Max spoken words that fit in one clip. padding = silent lead-in/out seconds. */
export function wordBudget(clipSeconds, wordsPerSecond = LIMITS.DEFAULT_WPS, paddingSeconds = LIMITS.DEFAULT_PADDING, safetyPercent = 0) {
  const s = Number(clipSeconds), w = Number(wordsPerSecond), p = Math.max(0, Number(paddingSeconds) || 0);
  if (!Number.isFinite(s) || !Number.isFinite(w) || s <= 0 || w <= 0) return 0;
  const m = Math.min(50, Math.max(0, Number(safetyPercent) || 0));
  return Math.max(0, Math.floor(Math.round(Math.max(0, s - p) * (1 - m / 100) * w * 1000) / 1000));
}

/** Estimated spoken seconds for a word count. */
export function speakingSeconds(words, wordsPerSecond = LIMITS.DEFAULT_WPS) {
  const w = Number(wordsPerSecond);
  if (!w || w <= 0) return 0;
  return Math.round((words / w) * 10) / 10;
}

/**
 * Status of a clip's dialogue vs its budget.
 * over  → exceeds budget (will be cut off / rushed)
 * tight → 90–100% of budget
 * ok    → fits
 * empty → no dialogue
 */
export function budgetStatus(words, budget) {
  if (words === 0) return 'empty';
  if (budget <= 0 || words > budget) return 'over';
  if (words >= Math.ceil(budget * 0.9)) return 'tight';
  return 'ok';
}

/** Total words of a dialogue line list [{speaker, line}]. */
export function dialogueWords(lines) {
  if (!Array.isArray(lines)) return 0;
  return lines.reduce((n, l) => n + countWords(l && l.line), 0);
}

// ---------------------------------------------------------------------------------------------
// Spoken-length estimate. Plain word counts miss what actually makes TTS audio run long:
// "1998" is read as "nineteen ninety-eight" (3 words), "$2.5M" as "two point five million dollars",
// "FBI" as three letters, and "unbelievably" takes as long as three short words.
// So audio is estimated from syllables of the text *as it will be spoken*, plus pause time.
// Deliberately conservative: overestimating costs a word; underestimating cuts a word off.
// ---------------------------------------------------------------------------------------------
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
function under1000(n) {
  const out = [];
  if (n >= 100) { out.push(ONES[Math.floor(n / 100)], 'hundred'); n %= 100; }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)]); n %= 10; if (n) out.push(ONES[n]); } else if (n || !out.length) out.push(ONES[n]);
  return out;
}
/** Integer → spoken words (array). */
export function numberToWords(n) {
  n = Math.floor(Math.abs(n));
  if (n < 1000) return under1000(n);
  const out = [];
  for (const [v, name] of SCALES) if (n >= v) { out.push(...numberToWords(Math.floor(n / v)), name); n %= v; }
  if (n) out.push(...under1000(n));
  return out;
}
function yearWords(y) { // 1998 → nineteen ninety-eight, 2005 → two thousand five, 1900 → nineteen hundred
  if (y >= 2000 && y < 2010) return numberToWords(y);
  const hi = Math.floor(y / 100), lo = y % 100;
  return [...under1000(hi), ...(lo === 0 ? ['hundred'] : lo < 10 ? ['oh', ONES[lo]] : under1000(lo))];
}
const LETTER_WORD = { w: 'double you' };
const SYMBOLS = { '%': 'percent', '&': 'and', '@': 'at', '+': 'plus', '=': 'equals', '#': 'number', '°': 'degrees', '×': 'times' };
const SCALE_SUFFIX = { k: 'thousand', m: 'million', mm: 'million', b: 'billion', bn: 'billion', t: 'trillion' };
const CURRENCY = { $: 'dollars', '€': 'euros', '£': 'pounds', '¥': 'yen' };

/**
 * Rewrite text the way a TTS voice will read it. Returns { text, expansions: [{ from, to }] }.
 * Handles currency, %, k/m/bn suffixes, decimals, years, ordinals, times, acronyms and symbols.
 */
export function toSpoken(text) {
  const expansions = [];
  const note = (from, to) => { if (from.trim() !== to.trim() && expansions.length < 20 && !expansions.some((e) => e.from === from)) expansions.push({ from: from.trim(), to: to.trim() }); return ` ${to} `; };
  let t = spokenText(text);
  // URLs / emails: "example.com" → "example dot com"
  t = t.replace(/\b(?:https?:\/\/)?(?:www\.)?([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:com|org|net|io|ai|co|app|dev|uk|us))\b(\/\S*)?/giu,
    (m, host) => note(m, host.replace(/^www\./, '').split('.').join(' dot ')));
  // currency + number + optional scale: $2.5M, €300, £1,200, 5k
  t = t.replace(/([$€£¥])?\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m|mm|bn|b|t|thousand|million|billion|trillion)?\b(%)?/giu, (m, cur, num, scale, pct) => {
    const clean = num.replace(/,/g, '');
    const [int, dec] = clean.split('.');
    const n = Number(int);
    let words;
    if (!cur && !scale && !pct && !dec && /^\d{4}$/.test(int) && n >= 1100 && n <= 2099) words = yearWords(n);
    else words = numberToWords(n);
    if (dec) words.push('point', ...dec.split('').map((d) => ONES[Number(d)]));
    if (scale) words.push(SCALE_SUFFIX[scale.toLowerCase()] || scale.toLowerCase());
    if (pct) words.push('percent');
    if (cur) words.push(n === 1 && !dec && !scale ? CURRENCY[cur].replace(/s$/, '') : CURRENCY[cur]);
    return note(m, words.join(' '));
  });
  // ordinals left over like "3rd" are covered above as "three rd" → fix to "third"-ish length (3 syllables max)
  t = t.replace(/\b(\p{L}+) (st|nd|rd|th)\b/giu, (m, w) => ` ${w}th `);
  // acronyms: 2–5 capitals (conservative: spelled out letter by letter)
  t = t.replace(/\b([A-Z]{2,5})s?\b/g, (m, ac) => note(m, ac.toLowerCase().split('').map((c) => LETTER_WORD[c] || c).join(' ')));
  // symbols
  t = t.replace(/[%&@+=#°×]/g, (m) => note(m, SYMBOLS[m]));
  return { text: t.replace(/\s+/g, ' ').trim(), expansions };
}

/** English syllable estimate for one word (heuristic, ~90% accurate; slight over-count bias is fine). */
export function syllables(word) {
  let w = String(word).toLowerCase().replace(/[^a-z\u00e0-\u00ff]/g, '');
  if (!w) return 0;
  if (w.length === 1) return w === 'w' ? 3 : 1; // spelled letters
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = w.match(/[aeiouy\u00e0-\u00ff]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

// Average syllables per word in conversational narration; the speaking pace (words/sec) is calibrated on it.
export const SYLLABLES_PER_WORD = 1.45;
const PAUSE_COMMA = 0.12, PAUSE_SENTENCE = 0.25;

/**
 * Estimate how long `text` takes to say at `wordsPerSecond`.
 * @returns {{ words, spokenWords, syllables, seconds, pauses, expansions }}
 */
export function speechEstimate(text, wordsPerSecond = LIMITS.DEFAULT_WPS) {
  const raw = String(text || '');
  const words = countWords(raw);
  if (!words) return { words: 0, spokenWords: 0, syllables: 0, seconds: 0, pauses: 0, expansions: [] };
  const { text: spoken, expansions } = toSpoken(raw);
  const tokens = spoken.replace(/(\w)-(?=\w)/g, '$1 ').match(/[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu) || [];
  const syl = tokens.reduce((n, w) => n + syllables(w), 0);
  const body = spokenText(raw).trim();
  const commas = (body.match(/[,;:\u2014\u2013]|\s-\s|\.\.\./g) || []).length;
  const sentences = Math.max(0, (body.replace(/[.!?]+["')\]]*\s*$/, '').match(/[.!?]+(?=\s)/g) || []).length);
  const pauses = commas * PAUSE_COMMA + sentences * PAUSE_SENTENCE;
  const w = Number(wordsPerSecond) > 0 ? Number(wordsPerSecond) : LIMITS.DEFAULT_WPS;
  const seconds = syl / (w * SYLLABLES_PER_WORD) + pauses;
  return { words, spokenWords: tokens.length, syllables: syl, seconds: Math.round(seconds * 10) / 10, pauses: Math.round(pauses * 100) / 100, expansions };
}

/** Seconds actually available for speech in a clip (after silence padding and safety margin). */
export function speakingWindow(clipSeconds, paddingSeconds = LIMITS.DEFAULT_PADDING, safetyPercent = 0) {
  const s = Number(clipSeconds) || 0, p = Math.max(0, Number(paddingSeconds) || 0), m = Math.min(50, Math.max(0, Number(safetyPercent) || 0));
  return Math.max(0, Math.round((s - p) * (1 - m / 100) * 100) / 100);
}

/**
 * Combined fit check for a clip. A clip is "over" if EITHER its spoken word count exceeds the word
 * budget OR its estimated audio length exceeds the speaking window, so long words, numbers
 * and acronyms can't sneak past a word count that looks fine.
 */
export function fitStatus(estimate, budget, windowSeconds) {
  if (!estimate.words) return 'empty';
  if (budget <= 0 || estimate.spokenWords > budget || estimate.seconds > windowSeconds) return 'over';
  if (estimate.spokenWords >= Math.ceil(budget * 0.9) || estimate.seconds >= windowSeconds * 0.9) return 'tight';
  return 'ok';
}

/**
 * Last-resort safety net: shorten text so it fits, cutting only at a sentence (or clause) boundary,
 * never mid-sentence or mid-word. Returns the original text if no clean cut fits.
 */
export function trimToFit(text, budget, windowSeconds, wordsPerSecond) {
  const fitsNow = (t) => { const e = speechEstimate(t, wordsPerSecond); return e.spokenWords <= budget && e.seconds <= windowSeconds; };
  const t = String(text || '').trim();
  if (!t || fitsNow(t)) return t;
  const sentences = t.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [t];
  for (let n = sentences.length - 1; n >= 1; n--) { const c = sentences.slice(0, n).join('').trim(); if (fitsNow(c)) return c; }
  // single long sentence: cut at a clause boundary and close it with a period
  const clauses = sentences[0].split(/(?<=[,;:\u2014])\s+/);
  for (let n = clauses.length - 1; n >= 1; n--) { const c = clauses.slice(0, n).join(' ').replace(/[,;:\u2014]\s*$/, '').trim() + '.'; if (fitsNow(c)) return c; }
  return t;
}
