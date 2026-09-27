// VideoExpress paste pack: turns a written script into the exact fields of
// VideoExpress → Create with AI → "Create Video From Prompt", scene by scene.
// Field names/limits verified against VideoExpress's own published workflows (2026-09):
//   Image Prompt · Video Prompt ("Video and Audio Prompt" until Narration mode is on) ·
//   Narration Video (Choose my Audio) → "Create Narration Video - Create Audio" dialog, 120-character box ·
//   Lipsync HD Video → "Create Lipsync Audio" dialog, Actor 1/2 Script, under 100 characters ·
//   Use Consistent Character + Reference Photo / Reference Photo 2 · Image Type · Share in public gallery (on by default).
// Pure module: no DOM / Node imports. ClipScript only writes the words; VideoExpress makes the video.
const splitSentences = (t) => (String(t).replace(/\s+/g, ' ').trim().match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g) || []).map((x) => x.trim()).filter(Boolean);

export const VE_LIMITS = { NARRATION_MAX: 120, LIPSYNC_MAX: 100, CHARS_PER_SEC: 15, REF_SLOTS: 2 };
export const VE_VOICE_TABS = ['CloneVoice.ai', 'Text to Speech'];
export const VE_IMAGE_TYPES = ['auto', 'human', '2D', '3D'];
export const DEFAULT_VE = { voiceTab: 'CloneVoice.ai', voice: 'Lucas Rhodes', category: 'System', language: 'English', imageType: 'auto', autoEnhance: false };

const str = (v, max) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
export function normalizeVeSettings(x) {
  const v = x && typeof x === 'object' ? x : {};
  return {
    voiceTab: VE_VOICE_TABS.includes(v.voiceTab) ? v.voiceTab : DEFAULT_VE.voiceTab,
    voice: str(v.voice, 80) || DEFAULT_VE.voice,
    category: str(v.category, 40) || DEFAULT_VE.category,
    language: str(v.language, 40) || DEFAULT_VE.language,
    imageType: VE_IMAGE_TYPES.includes(v.imageType) ? v.imageType : DEFAULT_VE.imageType,
    autoEnhance: v.autoEnhance === true,
  };
}

export function orientationLabel(ar) {
  return ar === '16:9' ? 'Landscape 16:9' : ar === '1:1' ? 'Square 1:1' : ar === '9:16' ? 'Vertical 9:16' : `${ar || '9:16'} (closest option)`;
}

/** Best-guess Image Type from the style words (the user can override it in the pack settings). */
export function suggestImageType(style = '') {
  const t = style.toLowerCase();
  if (/\b(3d|pixar|cgi|clay|claymation|render(ed)?|toy)\b/.test(t)) return '3D';
  if (/\b(2d|flat|cartoon|hand[- ]drawn|anime|illustrat|comic|watercolou?r|vector|paper|doodle|line art)\b/.test(t)) return '2D';
  return 'human';
}

/**
 * Split text into pieces of at most `max` characters WITHOUT dropping a single word:
 * sentence boundaries first, then clause boundaries (, ; : —), then word boundaries.
 */
export function splitForLimit(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (t.length <= max) return [t];
  const pack = (units, sep = ' ') => {
    const out = []; let cur = '';
    for (const u of units) {
      const next = cur ? `${cur}${sep}${u}` : u;
      if (next.length <= max) cur = next;
      else { if (cur) out.push(cur); cur = u; }
    }
    if (cur) out.push(cur);
    return out;
  };
  const bySentence = pack(splitSentences(t));
  const out = [];
  for (const piece of bySentence) {
    if (piece.length <= max) { out.push(piece); continue; }
    const clauses = piece.split(/(?<=[,;:—–])\s+/).filter(Boolean);
    for (const c of pack(clauses)) {
      if (c.length <= max) out.push(c);
      else out.push(...pack(c.split(' ')));
    }
  }
  return out;
}

const pad = (n, w = 3) => String(n).padStart(w, '0');
const endDot = (s) => { const t = (s || '').trim(); if (!t) return ''; const u = t[0].toUpperCase() + t.slice(1); return /[.!?]$/.test(u) ? u : `${u}.`; };
const firstWords = (s, n) => { const w = String(s || '').split(/\s+/).filter(Boolean); return w.slice(0, n).join(' ') + (w.length > n ? '…' : ''); };
const hasName = (text, name) => !!name && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text || '');

/**
 * Build the paste pack.
 * opts.idPrefix: prepended to scene ids (series episodes use "E03-") so every tile caption in the
 * VideoExpress media library says exactly which scene it is (library order is "newest", not story order).
 */
export function buildVePack(script, brief, veIn = {}, { idPrefix = '' } = {}) {
  const ve = normalizeVeSettings(veIn);
  const ss = script.styleSheet || { characters: [] };
  const chars = (ss.characters || []).filter((c) => c.name || c.description);
  const styleText = [ss.visualStyle, ss.palette && `palette ${ss.palette}`].filter(Boolean).join('; ');
  const imageType = ve.imageType === 'auto' ? suggestImageType(`${ss.visualStyle} ${brief.visualStyle || ''}`) : ve.imageType;
  const styleLock = [ss.visualStyle && `Style: ${endDot(ss.visualStyle)}`, ss.palette && `Palette: ${endDot(ss.palette)}`, ss.setting && `Setting: ${endDot(ss.setting)}`, ss.camera && `Camera: ${endDot(ss.camera)}`].filter(Boolean).join(' ');
  const onCamera = brief.dialogueMode === 'dialogue' || brief.dialogueMode === 'mixed';
  const reelish = brief.mode === 'reel' || brief.layout === 'narration' || brief.dialogueMode === 'voiceover';
  const silent = brief.dialogueMode === 'none';
  const isNarrator = (sp) => !sp || /^(narrator|voice ?over|vo)$/i.test(sp.trim()) || !chars.some((c) => c.name && c.name.toLowerCase() === sp.trim().toLowerCase());
  const bible = (c) => [c.name && `${c.name}:`, endDot(c.description)].filter(Boolean).join(' ');

  // Character reference images (Consistent Character). Only real, named characters.
  const characters = chars.filter((c) => c.name).map((c, i) => ({
    id: `CHAR-${pad(i + 1, 2)}`, name: c.name, description: c.description, voice: c.voice,
    refPrompt: [bible(c), ss.visualStyle && `Style: ${endDot(ss.visualStyle)}`, ss.palette && `Palette: ${endDot(ss.palette)}`, 'Looking at the camera, head-and-shoulders close-up, neutral friendly expression, plain softly lit background.'].filter(Boolean).join(' '),
  }));
  const charByName = (n) => characters.find((c) => c.name.toLowerCase() === String(n || '').toLowerCase());

  const scenes = [];
  const warnings = [];
  let n = 0;
  const nextId = () => `${idPrefix}SC-${pad(++n)}`;

  for (const clip of script.clips) {
    const present = characters.filter((c) => hasName(clip.imagePrompt, c.name) || clip.dialogue.some((l) => l.speaker && l.speaker.toLowerCase() === c.name.toLowerCase()));
    const refs = present.slice(0, VE_LIMITS.REF_SLOTS);
    if (present.length > VE_LIMITS.REF_SLOTS) warnings.push(`Clip ${clip.index}: ${present.length} characters in one shot; VideoExpress holds 2 reference photos, so ${present.slice(2).map((c) => c.name).join(', ')} rely on the description only.`);
    const imagePrompt = (id) => [`[${id}]`, ...refs.map((c) => bible(c)), endDot(clip.imagePrompt), styleLock].filter(Boolean).join(' ');
    const baseMotion = endDot(clip.videoPrompt || 'Slow cinematic push-in.');

    // Which lines go where
    const lines = clip.dialogue || [];
    const narrLines = silent ? [] : lines.filter((l) => !onCamera || reelish || isNarrator(l.speaker));
    const castLines = silent || reelish || !onCamera ? [] : lines.filter((l) => !isNarrator(l.speaker));
    const groups = [];
    const narrText = narrLines.map((l) => l.line).join(' ');
    if (narrText) for (const piece of splitForLimit(narrText, VE_LIMITS.NARRATION_MAX)) groups.push({ route: 'narration', narration: piece });
    if (castLines.length) {
      // pack consecutive lines: ≤2 speakers and ≤100 characters of script per scene
      let cur = null;
      const flush = () => { if (cur) groups.push(cur); cur = null; };
      for (const l of castLines) {
        for (const piece of splitForLimit(l.line, VE_LIMITS.LIPSYNC_MAX)) {
          const spk = l.speaker.trim();
          const total = cur ? cur.actors.reduce((t, a) => t + a.script.length + 1, 0) + piece.length : piece.length;
          const known = cur && cur.actors.find((a) => a.speaker.toLowerCase() === spk.toLowerCase());
          if (!cur || total > VE_LIMITS.LIPSYNC_MAX || (!known && cur.actors.length >= 2)) { flush(); cur = { route: 'lipsync', actors: [] }; }
          const a = cur.actors.find((x) => x.speaker.toLowerCase() === spk.toLowerCase());
          if (a) a.script = `${a.script} ${piece}`; else cur.actors.push({ speaker: spk, script: piece });
        }
      }
      flush();
    }
    if (!groups.length) groups.push({ route: silent || !lines.length ? 'silent' : 'narration', narration: '' });

    let firstId = null;
    groups.forEach((g, gi) => {
      const id = nextId();
      const cont = gi > 0;
      if (!firstId) firstId = id;
      const sc = {
        id, clip: clip.index, part: groups.length > 1 ? `${gi + 1}/${groups.length}` : '', beat: clip.beat || '', route: g.route,
        refs: refs.map((c, i) => ({ slot: i === 0 ? 'Reference Photo' : 'Reference Photo 2', name: c.name, id: c.id })),
        reuseImageOf: cont ? firstId : '',
        imagePrompt: imagePrompt(id),
        onScreenText: cont ? '' : clip.onScreenText || '',
        sfx: clip.sfx || '',
      };
      if (g.route === 'narration') {
        sc.videoPrompt = `[${id}] ${cont ? `Continue the same shot: ${baseMotion}` : baseMotion} Narration-led scene: nobody talks on camera, no lip movement.`;
        sc.narration = g.narration;
        sc.chars = g.narration.length;
        sc.seconds = Math.max(1, Math.round((g.narration.length / VE_LIMITS.CHARS_PER_SEC) * 10) / 10);
      } else if (g.route === 'lipsync') {
        const who = g.actors.map((a, i) => {
          const c = charByName(a.speaker);
          return `Actor ${i + 1} is ${a.speaker}${c?.description ? ` (${firstWords(c.description, 12)})` : ''}`;
        }).join('. ');
        const voices = g.actors.map((a) => { const c = charByName(a.speaker); return c?.voice ? `${a.speaker}'s voice: ${c.voice}` : ''; }).filter(Boolean).join('. ');
        sc.videoPrompt = `[${id}] ${cont ? `Continue the same shot: ${baseMotion}` : baseMotion}${voices ? ` ${endDot(voices)}` : ''}`;
        sc.actorPrompt = `${who}. ${g.actors.length > 1 ? 'They say their lines naturally, in turn.' : 'They say the line naturally, looking toward the camera.'}`;
        sc.actors = g.actors.map((a, i) => ({ label: `Actor ${i + 1} Script`, speaker: a.speaker, script: a.script }));
        sc.chars = g.actors.reduce((t, a) => t + a.script.length, 0);
        sc.seconds = Math.max(1, Math.round((sc.chars / VE_LIMITS.CHARS_PER_SEC) * 10) / 10);
      } else {
        sc.videoPrompt = `[${id}] ${baseMotion}${clip.sfx ? ` Sound: ${endDot(clip.sfx)}` : ''}`;
        sc.seconds = Number(clip.durationSeconds) || 5;
      }
      scenes.push(sc);
    });
  }

  const routes = new Set(scenes.map((s) => s.route));
  const setup = [
    'In VideoExpress: Create with AI → click the card "Create Video From Prompt".',
    `Pick ${orientationLabel(brief.aspectRatio)} at the top of that window.`,
    `Image Type: ${imageType}.`,
    'UNTICK "Share this in the public gallery" (it turns itself back on, so check it before every Create Image and Create Video).',
    `"Automatically enhance my image prompt": ${ve.autoEnhance ? 'ON' : 'OFF (these prompts are already detailed; enhancing can change your character)'}.`,
  ];
  if (routes.has('narration')) setup.push('Tick "Narration Video (Choose my Audio)". It worked if "Video Only (No Sound)" disappears and the second box is now called "Video Prompt". Keep "Lipsync HD Video" OFF for these scenes.');
  if (routes.has('lipsync')) setup.push('For the on-camera talking scenes (marked Lipsync): tick "Lipsync HD Video" instead, and untick "Narration Video".');
  if (routes.has('silent') && !routes.has('narration') && !routes.has('lipsync')) setup.push('No voice in this video: leave Narration Video and Lipsync HD Video OFF.');
  setup.push(characters.length ? `Consistent Character: make the ${characters.length} character picture${characters.length > 1 ? 's' : ''} below first, then tick "Use Consistent Character".` : 'Use Consistent Character: OFF (no recurring character). The same style words are pasted into every Image Prompt, so every scene keeps the same look.');

  const voice = routes.has('narration') ? {
    steps: ve.voiceTab === 'CloneVoice.ai'
      ? [`In the "Create Narration Video - Create Audio" window: tab "CloneVoice.ai" → Category "${ve.category}" → Language "${ve.language}" → Voice "${ve.voice}".`, 'Use this SAME voice in every scene, so the whole video sounds like one narrator.']
      : [`In the "Create Narration Video - Create Audio" window: tab "Text to Speech" → voice "${ve.voice}" (${ve.language}).`, 'Use this SAME voice in every scene, so the whole video sounds like one narrator.'],
    label: `${ve.voice} · ${ve.voiceTab}${ve.voiceTab === 'CloneVoice.ai' ? ` · ${ve.category} · ${ve.language}` : ''}`,
  } : null;

  const narrSeconds = Math.round(scenes.reduce((t, s) => t + (s.seconds || 0), 0));
  return { title: script.title, orientation: orientationLabel(brief.aspectRatio), imageType, styleLock, styleText, setup, voice, characters, scenes, warnings, totalSeconds: narrSeconds, ve };
}

/** The whole pack as copy-ready text (Markdown with one code block per field, so every field is one copy). */
const fence = (t) => '```text\n' + String(t).replace(/```/g, "'''") + '\n```';
export function vePackMarkdown(pack, heading = `# ${pack.title}`, { setup = true, h = '##' } = {}) {
  const L = [heading, '', `_VideoExpress paste pack · Create Video From Prompt · ${pack.scenes.length} scenes · ~${pack.totalSeconds}s · ${pack.orientation} · Image Type ${pack.imageType}_`];
  if (setup) {
    L.push('', `${h} 1 · Set up once`, '', ...pack.setup.map((s, i) => `${i + 1}. ${s}`));
    if (pack.voice) L.push('', `${h} 2 · Narrator voice (same in every scene)`, '', ...pack.voice.steps.map((s) => `- ${s}`));
  }
  if (pack.characters.length) {
    L.push('', `${h} 3 · Characters (make these pictures first)`, '', 'For each one: untick "Use Consistent Character" → paste into **Image Prompt** → Create Image → hover the best picture → Save Image (it goes to "My AI Images"). Then tick "Use Consistent Character".');
    pack.characters.forEach((c, i) => L.push('', `### ${c.id} · ${c.name}${i < 2 ? ` (goes in ${i === 0 ? 'Reference Photo' : 'Reference Photo 2'} when on screen)` : ''}`, '', fence(c.refPrompt)));
  }
  if (pack.warnings.length) L.push('', '> ' + pack.warnings.join('\n> '));
  L.push('', `${h} Scenes`, '', 'Do these in order. The [SC-…] tag at the start of each prompt shows up in the VideoExpress Media Library, so you can always tell which clip is which.');
  for (const s of pack.scenes) {
    L.push('', `### ${s.id} · Clip ${s.clip}${s.part ? ` part ${s.part}` : ''}${s.beat ? ` · ${s.beat}` : ''} · ${s.route === 'narration' ? 'Narration' : s.route === 'lipsync' ? 'Lipsync (on camera)' : 'No voice'} · ~${s.seconds}s`);
    if (s.refs.length) L.push('', `Use Consistent Character: ON · ${s.refs.map((r) => `${r.slot}: ${r.name}`).join(' · ')}${s.refs.length < 2 ? ' · Reference Photo 2: empty' : ''}`);
    L.push('', s.reuseImageOf ? `**Image Prompt** (or just select the ${s.reuseImageOf} image again in the carousel):` : '**Image Prompt** → Create Image → click the newest picture:', '', fence(s.imagePrompt));
    L.push('', `**${s.route === 'narration' ? 'Video Prompt' : 'Video and Audio Prompt'}** → Create Video:`, '', fence(s.videoPrompt));
    if (s.route === 'narration') L.push('', `**Narration** (paste in the Create Audio window → Import Speech → Create Narration Video) · ${s.chars}/${VE_LIMITS.NARRATION_MAX} characters:`, '', fence(s.narration));
    if (s.route === 'lipsync') {
      L.push('', '**Create Lipsync Audio window → Video Prompt:**', '', fence(s.actorPrompt));
      for (const a of s.actors) L.push('', `**${a.label}** (${a.speaker}):`, '', fence(a.script));
      L.push('', `_${s.chars}/${VE_LIMITS.LIPSYNC_MAX} characters in total → Create_`);
    }
    if (s.onScreenText) L.push('', `On-screen text (add in the editor): ${s.onScreenText}`);
    if (s.sfx && s.route !== 'silent') L.push('', `Sound idea (optional, add in the editor): ${s.sfx}`);
  }
  L.push('', `${h} Finish`, '', 'Media Library → My AI Videos → drag the clips onto the timeline in SC order (read the [SC-…] tag in each caption).');
  return L.join('\n') + '\n';
}

/** Whole series: set-up and narrator voice once (same voice for every episode), then each episode's scenes. */
export function vePackSeriesMarkdown(title, episodes, ve) {
  const packs = episodes.map((e) => ({ no: e.no, pack: buildVePack(e.script, e.brief, ve, { idPrefix: `E${pad(e.no, 2)}-` }) }));
  const first = packs[0].pack;
  const scenes = packs.reduce((t, p) => t + p.pack.scenes.length, 0);
  const L = [`# ${title}: VideoExpress paste pack`, '', `_Create Video From Prompt · ${episodes.length} episodes · ${scenes} scenes · ${first.orientation} · Image Type ${first.imageType}_`,
    '', '## Set up once (for every episode)', '', ...first.setup.map((s, i) => `${i + 1}. ${s}`)];
  if (first.voice) L.push('', '## Narrator voice: the SAME for every episode', '', ...first.voice.steps.map((s) => `- ${s}`));
  L.push('', 'Style lock (already inside every Image Prompt, shown here so you can check it):', '', fence(first.styleLock || '(none)'));
  for (const { no, pack } of packs) L.push('', '---', '', vePackMarkdown(pack, `# Episode ${no}: ${pack.title}`, { setup: false, h: '###' }).trimEnd());
  return L.join('\n') + '\n';
}
