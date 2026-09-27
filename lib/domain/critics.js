// Critic panel: the same script audited from many viewpoints. Pure module (server, UI, tests).
// Critics run inside the Analyze step of the quality loop; their notes feed the Repair step and their
// scores count toward the 95+ target. A critic scoring below VETO_BELOW blocks 95+ until it is fixed.

export const CRITICS = [
  { id: 'scroller', name: 'Scroll viewer', icon: '👆', focus: 'A distracted viewer with a thumb on the screen.', asks: 'Would I stop scrolling in the first second? Where would I swipe away? Is there a reason to watch to the end?' },
  { id: 'audience', name: 'Target audience', icon: '🎯', focus: 'The exact audience in the brief (or the most likely one).', asks: 'Is it pitched at my level, in my language, about what I care about? Anything confusing, boring or talking down to me?' },
  { id: 'factcheck', name: 'Fact-checker', icon: '🔎', focus: 'Checks every claim against the brief and source data.', asks: 'Is any number, name, date or claim invented, exaggerated or not supported by the source? Is anything misleading?' },
  { id: 'director', name: 'Director / cinematographer', icon: '🎬', focus: 'Shot design, framing, lighting, visual storytelling.', asks: 'Does each shot have a clear subject, framing, lens and light? Do the pictures tell the story on their own? Any dull or repeated shots?' },
  { id: 'prompteng', name: 'VideoExpress prompt engineer', icon: '🧩', focus: 'Will the AI image/video models actually render this?', asks: 'Is each image prompt self-contained and concrete? Is each motion achievable in one continuous shot of this length? Any text baked into images, vague words or impossible actions?' },
  { id: 'voice', name: 'Voice & narration coach', icon: '🎙️', focus: 'How the words sound when spoken aloud by a voice.', asks: 'Easy to say in one breath? Natural rhythm, no tongue-twisters, numbers written as spoken? Does every line end cleanly and fit its clip?' },
  { id: 'continuity', name: 'Continuity supervisor', icon: '🧷', focus: 'Consistency from clip to clip.', asks: 'Do characters, clothes, places, palette and style stay identical? Do first/last frames connect? Any jumps that break the illusion?' },
  { id: 'story', name: 'Story editor', icon: '📖', focus: 'Structure, pacing and payoff.', asks: 'Clear beginning, middle and end? Does every clip earn its place? Is the ending/call to action satisfying and earned?' },
  { id: 'safety', name: 'Platform & brand safety', icon: '🛡️', focus: 'TikTok / YouTube / Instagram rules and brand risk.', asks: 'Anything that could get flagged, demonetised or cause offence? Risky health/money claims, trademarks, real people, copyrighted characters?' },
  { id: 'access', name: 'Accessibility', icon: '♿', focus: 'Viewers watching with the sound off or with low vision.', asks: 'Does it make sense muted? Is on-screen text short, readable and in a text-safe area? Is key information only in the audio?' },
];
export const CRITIC_IDS = CRITICS.map((c) => c.id);
export const VETO_BELOW = 6; // a critic below 6/10 caps the score below the target

/** Settings → list of enabled critic ids (default: all). Keeps at least one. */
export function enabledCritics(settings) {
  const off = new Set(Array.isArray(settings?.criticsOff) ? settings.criticsOff : []);
  const on = CRITIC_IDS.filter((id) => !off.has(id));
  return on.length ? on : CRITIC_IDS.slice();
}
export function normalizeCriticsOff(v) {
  const off = [...new Set((Array.isArray(v) ? v : []).filter((id) => CRITIC_IDS.includes(id)))];
  return off.length >= CRITIC_IDS.length ? off.slice(0, CRITIC_IDS.length - 1) : off;
}

/** Clamp the model's untrusted critic verdicts. Missing critics get score 0 so they can't be skipped. */
export function normalizeCritics(raw, ids = CRITIC_IDS) {
  const list = Array.isArray(raw) ? raw : [];
  const byId = new Map(list.filter((x) => x && typeof x === 'object').map((x) => [String(x.id), x]));
  const sev = ['high', 'medium', 'low'];
  return ids.map((id) => {
    const def = CRITICS.find((c) => c.id === id);
    const x = byId.get(id) || {};
    const n = Number(x.score);
    const got = byId.has(id) && Number.isFinite(n);
    return {
      id, name: def.name, icon: def.icon,
      score: got ? Math.max(0, Math.min(10, Math.round(n * 10) / 10)) : 0,
      missing: !got,
      verdict: String(x.verdict || (got ? '' : 'No verdict returned.')).slice(0, 300),
      notes: (Array.isArray(x.notes) ? x.notes : []).filter((y) => y && typeof y === 'object' && y.problem).slice(0, 4).map((y) => ({
        clip: Math.max(0, Math.min(200, Math.round(Number(y.clip) || 0))),
        severity: sev.includes(y.severity) ? y.severity : 'medium',
        problem: String(y.problem).slice(0, 300), fix: String(y.fix || '').slice(0, 300),
      })),
    };
  });
}

export function criticAverage(critics) {
  if (!critics?.length) return null;
  return Math.round((critics.reduce((t, c) => t + c.score, 0) / critics.length) * 10) / 10;
}
export const vetoes = (critics) => (critics || []).filter((c) => c.score < VETO_BELOW);

/** Critic notes → repair issues (lowest-scoring critics first). */
export function criticIssues(critics) {
  return [...(critics || [])].sort((a, b) => a.score - b.score).flatMap((c) => c.notes.map((n) => ({ ...n, critic: c.name })));
}
