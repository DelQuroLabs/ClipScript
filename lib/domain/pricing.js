// Cost estimates from token counts. Prices are USD per 1M tokens (Standard processing, short context).
// OpenAI rows come from the OpenAI pricing page the user pasted on 2026-09-23. Other providers have no built-in
// price (not verified); users can enter their own per model in Settings. All figures are estimates:
// the provider's bill is the source of truth.
export const PRICES_SOURCE = 'OpenAI pricing page (Standard, short context), as provided 2026-09-23';
export const BUILTIN_PRICES = Object.freeze({
  'gpt-6-astra': { in: 10, cachedIn: 1, out: 50 },
  'gpt-6-sol': { in: 2, cachedIn: 0.2, out: 10 },
  'gpt-6-luna': { in: 0.1, cachedIn: 0.01, out: 0.5 },
  'gpt-5.6-sol': { in: 4, cachedIn: 0.4, out: 20 },
  'gpt-5.6-terra': { in: 2, cachedIn: 0.2, out: 12 },
  'gpt-5.6-luna': { in: 0.2, cachedIn: 0.02, out: 1.2 },
  'gpt-5.5': { in: 5, cachedIn: 0.5, out: 30 },
  'gpt-5.4': { in: 2.5, cachedIn: 0.25, out: 15 },
  'gpt-5.4-mini': { in: 0.75, cachedIn: 0.075, out: 4.5 },
  'gpt-5.4-nano': { in: 0.2, cachedIn: 0.02, out: 1.25 },
  'gpt-5.2': { in: 1.75, cachedIn: 0.175, out: 14 },
  'gpt-5.1': { in: 1.25, cachedIn: 0.125, out: 10 },
  'gpt-5': { in: 1.25, cachedIn: 0.125, out: 10 },
  'gpt-5-mini': { in: 0.25, cachedIn: 0.025, out: 2 },
  'gpt-5-nano': { in: 0.05, cachedIn: 0.005, out: 0.4 },
  'gpt-4.1': { in: 2, cachedIn: 0.5, out: 8 },
  'gpt-4.1-mini': { in: 0.4, cachedIn: 0.1, out: 1.6 },
  'gpt-4.1-nano': { in: 0.1, cachedIn: 0.025, out: 0.4 },
  'gpt-4o': { in: 2.5, cachedIn: 1.25, out: 10 },
  'gpt-4o-mini': { in: 0.15, cachedIn: 0.075, out: 0.6 },
  'o3': { in: 2, cachedIn: 0.5, out: 8 },
  'o4-mini': { in: 1.1, cachedIn: 0.275, out: 4.4 },
  'demo-writer': { in: 0, out: 0 },
});
// Aliases that point at a priced model.
const ALIASES = { 'gpt-5.6': 'gpt-5.6-sol', 'gpt-6': 'gpt-6-sol' };

/** Normalise a model id to a price key: lower-case, drop "openai/" style prefixes and date/version suffixes. */
export function priceKey(model) {
  let m = String(model || '').trim().toLowerCase();
  m = m.replace(/^[a-z0-9-]+\//, '');                    // openai/gpt-5.6-luna (OpenRouter style)
  m = m.replace(/-(\d{4}-\d{2}-\d{2}|\d{8}|latest)$/, ''); // gpt-5.6-luna-2026-08-01
  return ALIASES[m] || m;
}
const valid = (p) => p && Number.isFinite(p.in) && Number.isFinite(p.out) && p.in >= 0 && p.out >= 0;

/** Price for a model: user override (by exact key) → built-in → null (unknown). */
export function priceFor(model, overrides = {}) {
  const k = priceKey(model);
  const o = overrides && overrides[k];
  if (valid(o)) return { in: o.in, out: o.out, source: 'yours', key: k };
  const b = BUILTIN_PRICES[k];
  if (b) return { in: b.in, out: b.out, source: 'built-in', key: k };
  return null;
}

/** Dollar cost for token counts, or null if the model has no price. */
export function costOf(model, inputTokens, outputTokens, overrides) {
  const p = priceFor(model, overrides);
  if (!p) return null;
  return ((Number(inputTokens) || 0) * p.in + (Number(outputTokens) || 0) * p.out) / 1e6;
}

/** "$0.0042", "$0.12", "$3.40". Tiny but non-zero costs never show as $0.00. */
export function formatUsd(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** Clean user price overrides from untrusted input: { key: { in, out } } in $/1M, sane bounds. */
export function normalizePriceOverrides(x) {
  const out = {};
  if (!x || typeof x !== 'object') return out;
  for (const [k0, v] of Object.entries(x).slice(0, 50)) {
    const k = priceKey(k0);
    if (!/^[a-z0-9._:-]{1,80}$/.test(k) || !v || typeof v !== 'object') continue;
    const i = Number(v.in), o = Number(v.out);
    if (Number.isFinite(i) && Number.isFinite(o) && i >= 0 && o >= 0 && i <= 1000 && o <= 1000) out[k] = { in: i, out: o };
  }
  return out;
}

// ---------- pre-run estimates for a series (tokens, then priced) ----------
// Heuristics calibrated against the prompts in seriesPrompts.js. Reasoning models also bill hidden
// "reasoning" tokens as output, so we show a low–high range (high = 2.5× output).
const TOK_PER_CHAR = 1 / 4;
export function estimateAnalyzeTokens(sourceChars) {
  const chunks = Math.max(1, Math.ceil(sourceChars / 12000));
  const facts = Math.min(400, Math.max(3, Math.round(sourceChars / 110)));
  const input = Math.round(sourceChars * TOK_PER_CHAR + chunks * 700 + facts * 45 + 1200);
  const output = Math.round(facts * 45 + Math.max(3, facts * 0.6) * 90);
  return { input, output, calls: chunks + 1 };
}
export function estimateEpisodeTokens(targetSeconds, factCount = 1, wps = 2.5, maxClip = 8) {
  const words = targetSeconds * wps;
  const clips = Math.max(2, Math.ceil(targetSeconds / Math.max(3, maxClip - 1.5)));
  const input = Math.round(1900 + factCount * 60);
  const output = Math.round(words * 1.35 * 2 /* narration + split beats */ + clips * 230 + 250);
  return { input, output, calls: 1 };
}
/** Range for remaining episodes: uses the average of already-written episodes when available. */
export function estimateSeriesWrite(plan, settings, { actualAvg } = {}) {
  const eps = plan.episodes.filter((e) => e.include && e.status !== 'done');
  let input = 0, output = 0;
  for (const e of eps) {
    if (actualAvg) { input += actualAvg.input; output += actualAvg.output; continue; }
    const t = estimateEpisodeTokens(e.targetSeconds, e.factIds.length, settings.brief.wordsPerSecond, settings.brief.clipSeconds);
    input += t.input; output += t.output;
  }
  return { episodes: eps.length, input, output };
}
export function priceRange(model, tokens, overrides) {
  const lo = costOf(model, tokens.input, tokens.output, overrides);
  const hi = costOf(model, tokens.input, tokens.output * 2.5, overrides);
  return lo == null ? null : { lo, hi };
}
export const formatRange = (r) => (r ? (formatUsd(r.lo) === formatUsd(r.hi) ? formatUsd(r.lo) : `${formatUsd(r.lo)}–${formatUsd(r.hi)}`) : 'no price set');
