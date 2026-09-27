// Server-only: deterministic "Demo" provider so the full flow works without a key (and for E2E tests).
// It parses the numbers it needs back out of the prompt it was given.
import { countWords, speechEstimate } from '../domain/wordcount.js';

const SCENES = [
  ['The hook', 'wide shot of a sunrise over a quiet coastal town, golden light spilling across rooftops'],
  ['Meet Maya', 'medium shot of Maya opening the blue door of her small bakery, flour on her apron'],
  ['The problem', 'close-up of an empty display case and a handwritten "closing soon" sign'],
  ['An idea', 'Maya at the counter sketching a new pastry design in a notebook, warm lamp light'],
  ['Getting to work', 'overhead shot of hands folding dough on a floured wooden table'],
  ['First customer', 'a curious neighbour peering through the bakery window, steam on the glass'],
  ['Word spreads', 'a short queue forming outside the blue door in morning light'],
  ['The rush', 'Maya handing a paper bag across the counter, smiling, shelves full'],
  ['Community', 'people sitting at small outdoor tables sharing pastries and coffee'],
  ['The payoff', 'Maya flipping the sign to "open every day", town square behind her'],
];
const LINES = [
  'Every morning this little town wakes up to the smell of fresh bread and a quiet hope.',
  'Maya has baked here for twelve years, and she knows every regular by name and order.',
  'But lately the shelves stay full, and the bills keep coming faster than customers.',
  'So she tries something new, a pastry nobody in town has ever tasted before.',
  'She works through the night, folding butter into dough until her arms ache.',
  'The first neighbour who tries it comes back an hour later with three friends.',
  'By the weekend there is a line outside, and people are talking about it everywhere.',
  'Maya can barely keep up, and honestly she has never been happier to be tired.',
  'The bakery is full of laughter again, and strangers are becoming friends.',
  'Visit your local bakery this week, because small places make big memories.',
];

let WINDOW = Infinity, WPS = 2.5; // set per request from the prompt
function trimToWords(text, n) {
  if (n <= 0) return '';
  const words = text.split(/\s+/);
  let out = [];
  for (const w of words) {
    const next = [...out, w].join(' ');
    const e = speechEstimate(next + '.', WPS);
    if (e.spokenWords > n || e.seconds > WINDOW * 0.95) break;
    out.push(w);
  }
  let s = out.join(' ').replace(/[,;:]$/, '');
  if (s && !/[.!?]$/.test(s)) s += '.';
  return s;
}

export function demoResponse({ user }) {
  if (/^TASK: (ANALYZE|REPAIR) SCRIPT/.test(user)) return demoPolish(user);
  if (/^TASK: (EXTRACT FACTS|PLAN SERIES|WRITE EPISODE)/.test(user)) return demoSeries(user);
  const num = (re, d) => { const m = user.match(re); return m ? Number(m[1]) : d; };
  const budget = num(/(?:HARD WORD BUDGET: at most|HARD LIMIT(?: is)?:?)\s*(\d+)/i, 20);
  const noDialogue = /There is NO spoken audio/.test(user);
  WINDOW = num(/(?:no more than|AND) ([\d.]+) seconds of speech/, Infinity);
  WPS = num(/≈([\d.]+) words\/second/, 2.5);
  const usage = { input: Math.ceil(user.length / 4), output: 0 };

  if (/The dialogue in these clips is too long/.test(user)) {
    const m = user.match(/<clips>\s*([\s\S]*?)\s*<\/clips>/);
    const clips = m ? JSON.parse(m[1]) : [];
    const out = { clips: clips.map((c) => ({ index: c.index, dialogue: [{ speaker: c.dialogue?.[0]?.speaker || 'Narrator', line: trimToWords(c.dialogue.map((l) => l.line).join(' '), budget) }] })) };
    const text = JSON.stringify(out); usage.output = Math.ceil(text.length / 4);
    return { text, usage };
  }
  const re = user.match(/^Rewrite clip (\d+)/m);
  if (re && /FACELESS REEL RULES/.test(user)) {
    const i = Number(re[1]) - 1;
    const one = demoReel(user.replace(/<script>[\s\S]*<\/script>/, ''), 10, budget, noDialogue).clips[(i + 3) % 10];
    const text = JSON.stringify({ ...one, beat: one.beat + ' (take 2)' }); usage.output = Math.ceil(text.length / 4);
    return { text, usage };
  }
  if (re) {
    const i = (Number(re[1]) - 1) % 10;
    const out = {
      beat: SCENES[i][0] + ' (take 2)',
      imagePrompt: `Alternate angle: ${SCENES[(i + 3) % 10][1]}, Maya (early 30s, curly dark hair tied up, freckles, mustard apron) in frame, soft cinematic light, 35mm, shallow depth of field.`,
      videoPrompt: 'Slow dolly-in toward Maya as she looks up and smiles; flour drifts through a sunbeam.',
      dialogue: noDialogue ? [] : [{ speaker: 'Narrator', line: trimToWords(LINES[(i + 5) % 10], budget) }],
      onScreenText: '', sfx: 'soft piano',
    };
    const text = JSON.stringify(out); usage.output = Math.ceil(text.length / 4);
    return { text, usage };
  }
  const count = Math.min(10, Math.max(1, num(/Output EXACTLY (\d+) objects/, 6)));
  if (/FACELESS REEL RULES/.test(user)) {
    const text = JSON.stringify(demoReel(user, count, budget, noDialogue)); usage.output = Math.ceil(text.length / 4);
    return { text, usage };
  }
  const clips = Array.from({ length: count }, (_, i) => {
    const k = Math.round((i * (SCENES.length - 1)) / Math.max(1, count - 1));
    return {
      beat: SCENES[k][0],
      imagePrompt: `${SCENES[k][1]}${/Maya/.test(SCENES[k][1]) ? ', Maya (early 30s, curly dark hair tied up, freckles, mustard apron)' : ''}, cinematic photoreal, 35mm film look, soft natural light, shallow depth of field.`,
      lastFramePrompt: i % 2 === 0 ? `Same scene seconds later: ${SCENES[k][0].toLowerCase()} resolved, camera closer, warmer light, cinematic photoreal, 35mm film look.` : '',
      videoPrompt: i === 0 ? 'Slow aerial push-in over the rooftops as birds cross the frame; light brightens.' : 'Gentle handheld drift; subject moves naturally; ends on a soft focus pull.',
      dialogue: noDialogue ? [] : [{ speaker: 'Narrator', line: trimToWords(LINES[k], budget) }],
      onScreenText: i === count - 1 ? 'Shop local ❤' : '',
      sfx: i === 0 ? 'gentle acoustic guitar, seagulls' : '',
    };
  });
  const out = {
    title: 'The Bakery on Harbor Street',
    logline: 'A small-town baker saves her shop with one bold new recipe.',
    styleSheet: {
      visualStyle: 'cinematic photoreal, 35mm film grain, warm golden-hour grade',
      setting: 'small coastal town, cobbled streets, a bakery with a blue door',
      palette: 'warm amber, cream, sea blue accents',
      camera: 'eye-level, gentle handheld, shallow depth of field',
      characters: [{ name: 'Maya', description: 'woman in her early 30s, curly dark hair tied up, freckles, mustard-yellow apron over a white linen shirt', voice: 'warm, friendly, mid-pace' }],
    },
    clips,
  };
  const text = JSON.stringify(out); usage.output = Math.ceil(text.length / 4);
  return { text, usage };
}

// Faceless reel from the raw data: one fact per clip, pulled straight from <source_data>.
const REEL_VISUALS = [
  'extreme macro close-up of a relevant object on a dark textured surface, dramatic side light',
  'top-down flat-lay of documents, a notebook and a coffee cup, hands only entering frame',
  'bold animated bar chart made of glowing glass blocks rising from a reflective floor',
  'wide empty cityscape at blue hour, lights flickering on, no people',
  'minimal 3D icons floating in soft gradient space, gentle glow',
  'close-up of a vintage map with a red string connecting pins',
  'slow-motion drops of ink blooming in clear water, black background',
  'silhouette of a figure from behind looking at a huge screen of numbers',
  'split-screen of two contrasting objects on seamless backdrops',
  'sunrise over a quiet horizon, lens flare, calm atmosphere',
];
function demoReel(user, count, budget, noDialogue) {
  const m = user.match(/^<source_data>\n([\s\S]*?)\n<\/source_data>$/m);
  const src = (m ? m[1] : '').replace(/\s+/g, ' ').trim();
  let facts = src.split(/(?<=[.!?])\s+|\s*[\n;•]\s*/).map((x) => x.trim()).filter((x) => x.split(' ').length >= 3);
  if (!facts.length) facts = ['Here is what the data says.'];
  const style = (user.match(/^Visual style: (.+)$/m) || [])[1] || 'clean cinematic macro photography, soft contrast';
  const cta = (user.match(/^Call to action for the final clip: (.+)$/m) || [])[1] || 'Follow for more';
  const title = (user.match(/^Title idea: (.+)$/m) || [])[1] || 'What the data says';
  const shortText = (t) => t.replace(/[^\p{L}\p{N}%$ ]/gu, '').split(' ').slice(0, 6).join(' ');
  const clips = Array.from({ length: count }, (_, i) => {
    const last = i === count - 1;
    const fact = facts[i % facts.length];
    const line = last ? `${facts[(i) % facts.length]} ${cta}.` : i === 0 ? `Stop scrolling. ${fact}` : fact;
    return {
      beat: i === 0 ? 'Hook' : last ? 'Payoff + CTA' : `Fact ${i}`,
      imagePrompt: `${REEL_VISUALS[i % REEL_VISUALS.length]}, visual metaphor for: ${fact.slice(0, 120).replace(/[.!?]+$/, '')}. No people, no faces. ${style}.`,
      videoPrompt: i === 0 ? 'Fast push-in with a snap zoom on the key detail; light flares on.' : last ? 'Slow pull-back revealing the whole scene; motion settles.' : 'Smooth parallax slide left; subtle particles drift.',
      dialogue: noDialogue ? [] : [{ speaker: 'Narrator', line: trimToWords(line, budget) }],
      onScreenText: last ? cta.split(' ').slice(0, 8).join(' ') : shortText(fact),
      sfx: i === 0 ? 'bass hit, whoosh' : '',
    };
  });
  return {
    title,
    logline: `A ${count}-clip faceless reel built from your data.`,
    styleSheet: { visualStyle: style, setting: 'abstract, object-led scenes, no people', palette: (style.match(/palette: (.+)$/) || [])[1] || 'high contrast neutrals with one accent colour', camera: 'macro and top-down, smooth motion-controlled moves', characters: [] },
    clips,
  };
}

// ---- Series (extract → plan → episode) ----
const between = (t, tag) => { const m = t.match(new RegExp(`^<${tag}>\\n([\\s\\S]*?)\\n</${tag}>$`, 'm')); return m ? m[1] : ''; };
const sentencesOf = (t) => (t.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g) || []).map((x) => x.trim()).filter((x) => x.split(' ').length >= 4);
function demoSeries(user) {
  const usage = { input: Math.ceil(user.length / 4), output: 0 };
  let out;
  if (/^TASK: EXTRACT FACTS/.test(user)) {
    const src = between(user, 'source_data');
    const items = src.split(/\n+/).map((l) => l.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, '').trim()).filter((l) => l.split(' ').length >= 4);
    const facts = (items.length >= 2 ? items : sentencesOf(src)).map((text) => {
      // deterministic interest: numbers, "only/never/can", length → more interesting
      let score = 3 + (/\d/.test(text) ? 2 : 0) + (/\b(only|never|can|even|than|times|million)\b/i.test(text) ? 2 : 0) + (text.length > 110 ? 2 : 0);
      return { text, interest: Math.min(10, score) };
    });
    out = { facts };
  } else if (/^TASK: PLAN SERIES/.test(user)) {
    const facts = JSON.parse(between(user, 'facts') || '[]');
    const min = Number((user.match(/between (\d+) and (\d+) seconds/) || [])[1] || 15), max = Number((user.match(/between (\d+) and (\d+) seconds/) || [])[2] || 90);
    const strong = facts.filter((f) => f.interest >= 8), mid = facts.filter((f) => f.interest >= 5 && f.interest < 8), weak = facts.filter((f) => f.interest < 5);
    const episodes = [];
    for (const f of strong) episodes.push({ title: f.text.split(' ').slice(0, 7).join(' '), hook: `This one sounds made up. It isn't.`, angle: 'Explain why it happens', format: 'deep-dive', factIds: [f.id], interest: f.interest, targetSeconds: max, why: 'Very surprising with room to explain' });
    for (const f of mid) episodes.push({ title: f.text.split(' ').slice(0, 6).join(' '), hook: 'Here is something most owners never notice.', angle: 'Straight to the point', format: 'quick-hit', factIds: [f.id], interest: f.interest, targetSeconds: Math.round((min + max) / 2 / 5) * 5, why: 'Solid fact, short and punchy' });
    for (let i = 0; i < weak.length; i += 4) { const g = weak.slice(i, i + 4); episodes.push({ title: `${g.length} small things you never knew`, hook: `${g.length} tiny facts, and the last one is the best.`, angle: 'Rapid-fire list', format: 'compilation', factIds: g.map((f) => f.id), interest: 5, targetSeconds: Math.min(max, Math.max(min, g.length * 10)), why: 'Too thin alone, fun together' }); }
    out = { seriesTitle: 'Things You Never Knew', summary: `${episodes.length} episodes from ${facts.length} facts.`, bible: { visualStyle: 'cinematic macro photography, shallow depth of field, warm natural light', palette: 'warm amber, cream, soft teal', camera: 'macro details and slow push-ins', narratorVoice: 'warm, curious storyteller', tone: 'curious, warm, lightly funny', intro: '', outro: 'Follow for more you never knew', audience: 'curious scrollers' }, episodes };
  } else {
    const facts = JSON.parse(between(user, 'facts') || '[]');
    const target = Number((user.match(/about (\d+) words \(/) || [])[1] || 60);
    const perBeat = Number((user.match(/at most ~(\d+) words/) || [])[1] || 20);
    const none = /There is NO voiceover/.test(user);
    const lastFrames = !/Do NOT write last frames/.test(user);
    const chain = /CHAINED:/.test(user);
    const every = chain || /Every beat gets BOTH/.test(user);
    const cta = (user.match(/Close with this call to action, kept short: (.+)$/m) || [])[1] || 'Follow for more.';
    // Build narration from the facts, growing to the target length with connective sentences (never cut).
    const hook = facts[0] ? `Wait until you hear this. ${facts[0].split(/[.!?]/)[0].trim()}.` : 'Wait until you hear this.';
    const body = [];
    for (const f of facts.slice(1)) body.push(f);
    if (facts[0] && facts[0].split(/[.!?]/).length > 2) body.unshift(facts[0].split(/[.!?]/).slice(1).join('. ').trim());
    const fillers = ['And here is why that matters more than you think.', 'Scientists have a surprisingly simple explanation for it.', 'Once you notice it, you will see it everywhere.', 'It sounds small, but it changes how you see them.', 'That is not a coincidence, it is built in.', 'Most people go their whole lives without knowing this.', 'Next time you see it happen, you will know exactly why.'];
    const parts = [hook, ...body.filter(Boolean).map((b) => (/[.!?]$/.test(b) ? b : b + '.'))];
    let i = 0;
    while (countWords(parts.join(' ')) < target * 0.9 - countWords(cta) && i < 30) parts.push(fillers[i++ % fillers.length]);
    parts.push(/[.!?]$/.test(cta) ? cta : `${cta}.`);
    const narration = none ? '' : parts.join(' ');
    // beats: pack sentences to perBeat words
    const beats = []; let cur = '';
    for (const sen of none ? parts : parts) {
      if (cur && countWords(`${cur} ${sen}`) > perBeat) { beats.push(cur); cur = sen; } else cur = cur ? `${cur} ${sen}` : sen;
    }
    if (cur) beats.push(cur);
    let prevLast = '';
    const B = beats.map((t, k) => {
      const first = chain && prevLast ? prevLast : `${REEL_VISUALS[k % REEL_VISUALS.length]}, visual metaphor for: ${t.slice(0, 90).replace(/[.!?]+$/, '')}. No people, no faces.`;
      const last = lastFrames && (every || k % 2 === 0) ? `Same scene a moment later, the detail now revealed in full, wider framing, light brighter. No people, no faces.` : '';
      prevLast = last;
      return { beat: k === 0 ? 'Hook' : k === beats.length - 1 ? 'Payoff + CTA' : `Beat ${k + 1}`, narration: none ? '' : t, firstFrame: first, lastFrame: last, motion: k === 0 ? 'Snap zoom into the key detail, then a slow drift.' : 'Slow push-in; soft parallax; settles on the subject.', onScreenText: k === 0 ? t.split(' ').slice(0, 5).join(' ') : '', sfx: k === 0 ? 'whoosh' : '' };
    });
    out = { title: (user.match(/Episode: "([^"]+)"/) || [])[1] || 'Episode', hook, narration, beats: B, caption: 'You will never look at them the same way.', hashtags: ['#didyouknow', '#facts', '#dogs', '#shorts', '#learnontiktok'] };
  }
  const text = JSON.stringify(out); usage.output = Math.ceil(text.length / 4);
  return { text, usage };
}

// Quality loop (demo): a first draft scores ~80; one repair pass marks prompts "polished" and scores ~97.
function demoPolish(user) {
  const m = user.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
  const script = m ? JSON.parse(m[1]) : { clips: [] };
  const usage = { input: Math.ceil(user.length / 4), output: 0 };
  let out;
  if (/^TASK: ANALYZE SCRIPT/.test(user)) {
    const polished = script.clips.length && script.clips.every((c) => /polished/i.test(c.imagePrompt || ''));
    const fail = /^- FAIL:/m.test(user);
    const k = polished && !fail ? 0.97 : 0.8;
    const max = { hook: 12, story: 14, accuracy: 14, voice: 14, images: 16, motion: 12, consistency: 10, videoexpress: 8 };
    out = { scores: Object.fromEntries(Object.entries(max).map(([id, mx]) => [id, Math.round(mx * k * 10) / 10])),
      summary: polished ? 'Tight, specific and ready for VideoExpress.' : 'Solid draft; image prompts need lighting/lens detail and the hook can be sharper.',
      issues: polished ? [] : [{ clip: 1, area: 'hook', severity: 'high', problem: 'The opening line is not surprising enough.', fix: 'Lead with the most surprising fact.' },
        { clip: 0, area: 'images', severity: 'medium', problem: 'Image prompts lack lighting and lens detail.', fix: 'Add lighting and a lens/shot size to every image prompt.' }] };
    const ids = [...user.matchAll(/^- critic:([a-z]+) /gm)].map((x) => x[1]);
    if (ids.length) out.critics = ids.map((id, i) => ({ id, score: polished && !fail ? 9.6 : i === 0 ? 5.5 : 7.5,
      verdict: polished ? 'Nothing left to fix from where I sit.' : i === 0 ? 'I would swipe away before the second clip.' : 'Decent, but a few things bother me.',
      notes: polished ? [] : [{ clip: i === 0 ? 1 : 0, severity: i === 0 ? 'high' : 'low', problem: `(${id}) Not concrete enough.`, fix: 'Be more specific and vivid.' }] }));
  } else {
    out = { ...script, clips: script.clips.map((c) => ({ ...c, imagePrompt: /polished/i.test(c.imagePrompt || '') ? c.imagePrompt : `${String(c.imagePrompt || '').replace(/[.\s]+$/, '')}. Crisp rim light, 50mm lens, polished detail.`, videoPrompt: c.videoPrompt || 'Slow push-in, gentle parallax.' })) };
  }
  const text = JSON.stringify(out); usage.output = Math.ceil(text.length / 4);
  return { text, usage };
}
