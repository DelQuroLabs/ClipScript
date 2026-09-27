// Series: raw data dump → AI analysis & plan → many narration-first episodes (each saved as a project).
import { api, apiText } from './api.js';
import { h, clear, icon, toast, download, slug, copyText, textDialog } from './dom.js';
import { FRAME_MODES, FORMATS, SERIES_LIMITS, defaultSeriesOptions } from '../lib/domain/series.js';
import { ASPECT_RATIOS } from '../lib/domain/project.js';
import { formatUsd, formatRange, estimateAnalyzeTokens, priceRange } from '../lib/domain/pricing.js';

const SEC_PRESETS = [5, 6, 8, 10, 12, 15];
let poll = null;
const stopPoll = () => { if (poll) { clearTimeout(poll); poll = null; } };
const draft = { sourceData: '', visualStyle: '', tone: '', narratorVoice: '', callToAction: '', language: 'English', aspectRatio: '9:16', clipSeconds: 8, wordsPerSecond: 2.5, ...defaultSeriesOptions() };
const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.round(s)}s`);
const STATUS = { analyzing: 'Analyzing', planned: 'Plan ready', writing: 'Writing', paused: 'Paused', done: 'Done', error: 'Error' };

/** ctx: { state, modelPicker, currentModel, openProject, go } */
export function seriesView(ctx, id) {
  stopPoll();
  return id ? detailView(ctx, id) : listView(ctx);
}
export { stopPoll as stopSeriesPoll };

// ---------------- list + new ----------------
function listView(ctx) {
  const wrap = h('div', { class: 'studio' });
  const d = draft;
  const f = (id, label, key, opts = {}) => h('div', { class: 'field' }, h('label', { for: id }, label, opts.optional ? h('span', { class: 'opt' }, ' optional') : null),
    h(opts.area ? 'textarea' : 'input', { id, value: d[key], rows: opts.rows || 2, placeholder: opts.ph || '', maxlength: opts.max || 300, onInput: (e) => { d[key] = e.target.value; } }));
  const num = (id, label, key, min, max, step = 1) => h('div', { class: 'field' }, h('label', { for: id }, label),
    h('input', { id, type: 'number', min, max, step, value: d[key], inputmode: 'numeric', onInput: (e) => { d[key] = Number(e.target.value); paintEst(); } }));
  const stats = h('p', { class: 'hint', id: 'series-src-stats', 'aria-live': 'polite' });
  const lines = () => d.sourceData.split(/\n+/).filter((l) => l.trim().split(/\s+/).length >= 4).length;
  const paintStats = () => {
    const c = d.sourceData.length;
    if (!c) { stats.textContent = 'Paste a big list of facts, notes, an article, a CSV, research… The AI finds every usable fact.'; return; }
    const { model } = ctx.currentModel();
    const r = priceRange(model, estimateAnalyzeTokens(c), ctx.state.user.settings.priceOverrides);
    stats.textContent = `${c.toLocaleString()}/${SERIES_LIMITS.SOURCE_MAX.toLocaleString()} chars · about ${lines()} fact-sized lines · analysis ≈ ${formatRange(r)} on ${model}`;
  };
  const est = h('p', { class: 'hint', id: 'series-est' });
  const paintEst = () => { est.textContent = `Episodes will be ${d.minSeconds}–${d.maxSeconds}s. Each clip is at most ${d.clipSeconds}s and is sized to its narration, so no words are cut.`; };
  paintStats(); paintEst();
  const err = h('p', { class: 'form-error', role: 'alert', id: 'series-error' });
  const btn = h('button', { class: 'btn primary block lg', type: 'submit', id: 'series-analyze' }, icon('spark', 18), 'Analyze & plan series');
  const form = h('form', { class: 'card brief', 'aria-labelledby': 'series-new-h', novalidate: true, onSubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    if (d.sourceData.trim().length < 40) { err.textContent = 'Paste your raw data first (at least a few sentences).'; document.getElementById('series-source').focus(); return; }
    const { provider, model } = ctx.currentModel();
    btn.disabled = true; btn.textContent = 'Starting…';
    try {
      const r = await api('/api/series', { method: 'POST', body: { provider, model,
        brief: { sourceData: d.sourceData, visualStyle: d.visualStyle, tone: d.tone, narratorVoice: d.narratorVoice, callToAction: d.callToAction, language: d.language || 'English', aspectRatio: d.aspectRatio, clipSeconds: d.clipSeconds, wordsPerSecond: d.wordsPerSecond, dialogueMode: 'voiceover' },
        options: { minSeconds: d.minSeconds, maxSeconds: d.maxSeconds, frames: d.frames, maxEpisodes: d.maxEpisodes } } });
      ctx.go(`series/${r.series.id}`);
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Analyze & plan series'; }
  } },
    h('div', { class: 'card-head' }, h('h2', { id: 'series-new-h' }, 'New series from your data')),
    h('p', { class: 'hint' }, 'One dump in, a whole series out. The AI pulls out every fact, scores how interesting each one is, and decides the episodes: strong facts get their own deep dive, smaller ones are grouped into compilations.'),
    h('div', { class: 'field' }, h('label', { for: 'series-source' }, 'Raw data dump'),
      h('textarea', { id: 'series-source', rows: 10, maxlength: SERIES_LIMITS.SOURCE_MAX, value: d.sourceData, 'aria-describedby': 'series-src-stats', placeholder: 'e.g. 100 lesser-known dog facts, one per line…', onInput: (e) => { d.sourceData = e.target.value; paintStats(); } }), stats),
    h('fieldset', { class: 'group' }, h('legend', null, 'Episode length'),
      h('div', { class: 'row3' }, num('series-min', 'Shortest (s)', 'minSeconds', 10, 180, 5), num('series-max', 'Longest (s)', 'maxSeconds', 10, 180, 5), num('series-maxeps', 'Max episodes (0 = AI decides)', 'maxEpisodes', 0, SERIES_LIMITS.MAX_EPISODES)),
      h('div', { class: 'row2' },
        h('div', { class: 'field' }, h('label', { for: 'series-clipsec' }, 'Longest single clip'),
          h('select', { id: 'series-clipsec', onChange: (e) => { d.clipSeconds = Number(e.target.value); paintEst(); } }, SEC_PRESETS.map((s) => h('option', { value: s, selected: s === d.clipSeconds ? true : null }, `${s} seconds`)))),
        h('div', { class: 'field' }, h('label', { for: 'series-wps' }, 'Speaking pace (words/sec)'),
          h('input', { id: 'series-wps', type: 'number', min: 1.5, max: 3.5, step: 0.1, value: d.wordsPerSecond, onInput: (e) => { d.wordsPerSecond = Number(e.target.value); } }))),
      est),
    h('fieldset', { class: 'group' }, h('legend', null, 'Frames for VideoExpress'),
      h('div', { class: 'radios', role: 'radiogroup', 'aria-label': 'Frame prompts' }, FRAME_MODES.map((m) => h('label', { class: 'radio' },
        h('input', { type: 'radio', name: 'series-frames', value: m.id, checked: d.frames === m.id, onChange: () => { d.frames = m.id; } }),
        h('span', null, h('strong', null, m.label), h('span', { class: 'hint' }, ` ${m.hint}`)))))),
    h('details', { class: 'group more' }, h('summary', null, 'Look, narrator & call to action (optional: the AI picks if blank)'),
      f('series-style', 'Visual style', 'visualStyle', { optional: true, ph: 'e.g. macro photography, warm light' }),
      h('div', { class: 'row2' }, f('series-tone', 'Tone', 'tone', { optional: true, ph: 'curious, warm' }), f('series-voice', 'Narrator voice', 'narratorVoice', { optional: true, ph: 'calm documentary narrator' })),
      h('div', { class: 'row2' }, f('series-cta', 'Call to action', 'callToAction', { optional: true, ph: 'Follow for part 2' }), f('series-lang', 'Language', 'language', { max: 40 })),
      h('div', { class: 'field' }, h('span', { class: 'label', id: 'series-aspect-l' }, 'Aspect ratio'),
        h('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': 'series-aspect-l' }, ASPECT_RATIOS.map((a) => h('label', { class: 'seg-opt' }, h('input', { type: 'radio', name: 'series-aspect', value: a, checked: a === d.aspectRatio, onChange: () => { d.aspectRatio = a; } }), h('span', null, a)))))),
    h('div', { class: 'group' }, ctx.modelPicker(true)),
    err, btn);

  const list = h('section', { class: 'output', 'aria-labelledby': 'series-list-h' },
    h('div', { class: 'card', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), ' Loading series…'));
  (async () => {
    try {
      const { series } = await api('/api/series');
      clear(list);
      list.append(h('h2', { id: 'series-list-h', class: series.length ? 'section-h' : 'sr-only' }, 'Your series'));
      if (!series.length) {
        list.append(h('div', { class: 'card empty' }, h('h3', null, 'How a series works'),
          h('ol', { class: 'steps' },
            h('li', null, h('strong', null, 'Dump'), ' everything: a list of 100 facts, research notes, an article.'),
            h('li', null, h('strong', null, 'Analyze'), ': the AI extracts each fact, rates it, and plans episodes (one fact or several, 15–90s each). You can tweak the plan.'),
            h('li', null, h('strong', null, 'Write'), ': every episode gets one continuous voiceover, split into clips sized to the words, each with a ', h('em', null, 'first frame'), ', optional ', h('em', null, 'last frame'), ' and ', h('em', null, 'motion'), ' prompt.'))));
        return;
      }
      for (const s of series) {
        const st = s.stats;
        list.append(h('div', { class: 'card prow' },
          h('div', null, h('h3', { class: 'ptitle' }, h('a', { href: `#/series/${s.id}` }, s.title)),
            h('p', { class: 'hint' }, h('span', { class: `badge st-${s.status}` }, STATUS[s.status] || s.status),
              st ? `${st.done}/${st.episodes} episodes written · ${st.facts} facts · ` : `${s.progress?.message || ''} · `, `${s.model} · ${new Date(s.updatedAt).toLocaleString()}`))));
      }
    } catch (e) { clear(list).append(h('p', { class: 'form-error', role: 'alert' }, e.message)); }
  })();
  wrap.append(form, list);
  return wrap;
}

// ---------------- detail ----------------
function detailView(ctx, id) {
  const wrap = h('section', { class: 'series-detail', 'aria-labelledby': 'series-h' },
    h('div', { class: 'card', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), ' Loading series…'));
  let data = null, saveT = null, edits = new Map();
  const load = async (quiet) => {
    try {
      const prevCount = data?.episodes?.length, prevUpd = data?.series?.updatedAt;
      data = await api(`/api/series/${id}`);
      if (prevCount !== data.episodes.length || prevUpd !== data.series.updatedAt) for (const k of Object.keys(cache)) delete cache[k];
      draw();
      if (data.episodes.length && !data.running) prefetch();
      const live = data.running || data.series.status === 'analyzing' || data.series.status === 'writing';
      stopPoll();
      if (live && location.hash.startsWith(`#/series/${id}`)) poll = setTimeout(() => load(true), 1500);
    } catch (e) { if (!quiet) clear(wrap).append(h('p', { class: 'form-error', role: 'alert' }, e.message), h('a', { href: '#/series' }, 'Back to all series')); }
  };
  const flushEdits = async () => {
    if (!edits.size) return;
    const body = { episodes: [...edits.values()] }; edits = new Map();
    try { const r = await api(`/api/series/${id}/plan`, { method: 'PUT', body }); data.series = { ...data.series, ...r.series }; const s = document.getElementById('plan-save'); if (s) s.textContent = 'Plan saved'; paintTotals(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const edit = (no, patch) => {
    edits.set(no, { ...(edits.get(no) || { no }), ...patch });
    const ep = data.series.plan.episodes.find((x) => x.no === no); Object.assign(ep, patch);
    const s = document.getElementById('plan-save'); if (s) s.textContent = 'Saving…';
    clearTimeout(saveT); saveT = setTimeout(flushEdits, 500); paintTotals();
  };
  let totalsEl = null;
  const paintTotals = () => {
    if (!totalsEl || !data?.series.plan) return;
    const inc = data.series.plan.episodes.filter((e) => e.include);
    const secs = inc.reduce((n, e) => n + e.targetSeconds, 0);
    totalsEl.textContent = `${inc.length} of ${data.series.plan.episodes.length} episodes selected · about ${fmtDur(secs)} of video in total`;
    const w = document.getElementById('series-write');
    if (w && !data.running) { const n = inc.filter((e) => e.status !== 'done').length; w.disabled = !n; w.lastChild.textContent = n ? `Write ${n} episode${n > 1 ? 's' : ''}` : 'All selected episodes written'; }
  };
  const act = async (path, body, msg) => {
    try { await flushEdits(); await api(`/api/series/${id}/${path}`, { method: 'POST', body: body || {} }); if (msg) toast(msg, 'ok'); await load(); }
    catch (e) { toast(e.message, 'error'); }
  };
  // Exports are fetched once and cached per format, so Copy/Download run straight from the click (browsers
  // only allow clipboard + downloads during a click; an await before them can get them silently blocked).
  const cache = {};
  const EXPORTS = {
    md: { title: 'Whole series (Markdown)', ext: 'md', type: 'text/markdown', suffix: '' },
    guide: { title: 'Whole series: scripts by service', ext: 'md', type: 'text/markdown', suffix: '-scripts-by-service' },
    csv: { title: 'Whole series (CSV)', ext: 'csv', type: 'text/csv', suffix: '' },
    vepack: { title: 'Whole series: VideoExpress paste pack', ext: 'md', type: 'text/markdown', suffix: '-videoexpress-pack' },
  };
  const fileFor = (fmt) => `${slug(data.series.title)}${EXPORTS[fmt].suffix}.${EXPORTS[fmt].ext}`;
  const getExport = async (fmt) => (cache[fmt] ??= await apiText(`/api/series/${id}/export?format=${fmt}`));
  const prefetch = () => { for (const f of ['vepack', 'md', 'guide']) getExport(f).catch(() => { delete cache[f]; }); };
  const exportAs = async (fmt, how) => {
    const had = cache[fmt] != null;
    let t;
    try { t = await getExport(fmt); } catch (e) { delete cache[fmt]; toast(e.message, 'error'); return; }
    const x = EXPORTS[fmt];
    if (how === 'copy' && had) { const ok = await copyText(t, `${x.title} copied (${data.episodes.length} episodes)`, { quiet: true }); if (ok) { toast(`${x.title} copied: ${data.episodes.length} episodes`, 'ok'); return; } }
    else if (how === 'download') { download(fileFor(fmt), t, x.type); toast(`Downloading ${fileFor(fmt)}: ${data.episodes.length} episodes`, 'ok'); return; }
    // Not cached yet (the click was spent waiting) or the browser blocked it: show the text with fresh buttons.
    textDialog({ title: x.title, text: t, filename: fileFor(fmt), type: x.type, note: how === 'copy' && had ? 'Your browser blocked copying. Use Copy all below or select the text.' : '' });
  };

  function draw() {
    const focusId = document.activeElement?.id;
    const { series: s, episodes } = data;
    const plan = s.plan;
    const live = data.running || s.status === 'analyzing' || s.status === 'writing';
    clear(wrap);
    const p = s.progress || {};
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    const epByNo = new Map(episodes.map((e) => [e.no, e]));
    const st = s.stats;
    wrap.append(h('div', { class: 'card script-head' },
      h('p', { class: 'crumb' }, h('a', { href: '#/series' }, '← All series')),
      h('div', { class: 'sh-top' }, h('div', null, h('h1', { id: 'series-h', class: 'h2', tabindex: '-1' }, s.title), plan?.summary ? h('p', { class: 'muted' }, plan.summary) : null),
        h('span', { class: `badge st-${s.status}` }, STATUS[s.status] || s.status)),
      live ? h('div', { class: 'progress-wrap', role: 'status', 'aria-live': 'polite' },
        live ? h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': 'Series progress' }, h('span', { dataset: { pct } })) : null,
        h('p', { class: 'hint', id: 'series-progress' }, p.message || '')) : null,
      s.error && !live ? h('p', { class: 'form-error', role: 'alert' }, s.error) : null,
      st ? h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('span', { class: 'k' }, 'Facts found'), h('span', { class: 'v' }, String(st.facts))),
        h('div', { class: 'stat' }, h('span', { class: 'k' }, 'Episodes'), h('span', { class: 'v' }, String(st.episodes))),
        h('div', { class: 'stat' }, h('span', { class: 'k' }, 'Written'), h('span', { class: 'v' }, `${st.done}/${st.episodes}`)),
        h('div', { class: 'stat' }, h('span', { class: 'k' }, 'Formats'), h('span', { class: 'v sm' }, Object.entries(st.formats).filter(([, n]) => n).map(([k, n]) => `${n} ${FORMATS[k].label.toLowerCase()}`).join(' · '))),
        h('div', { class: 'stat' }, h('span', { class: 'k' }, 'Tokens used'), h('span', { class: 'v sm' }, `${(s.usage.input + s.usage.output).toLocaleString()}`)),
        h('div', { class: 'stat' }, h('span', { class: 'k' }, 'Est. cost so far'), h('span', { class: 'v sm', id: 'series-cost' }, data.cost?.priced ? formatUsd(data.cost.spent) : 'no price'))) : null,
      plan && data.cost?.remaining?.episodes ? h('p', { class: 'hint', id: 'series-cost-left' },
        `Writing the ${data.cost.remaining.episodes} remaining episode${data.cost.remaining.episodes > 1 ? 's' : ''} on ${s.model}: about ${data.cost.priced ? formatRange(data.cost.remaining.range) : '(add a price for this model in Settings)'} · ~${Math.round(data.cost.remaining.tokens).toLocaleString()} tokens (${data.cost.remaining.basedOn}). Estimate only; your provider bills the exact amount.`) : null,
      plan ? h('div', { class: 'toolbar' },
        live && s.status === 'writing' ? h('button', { class: 'btn warn', type: 'button', id: 'series-pause', onClick: () => act('pause', null, 'Pausing after the current episode…') }, 'Pause')
          : h('button', { class: 'btn primary', type: 'button', id: 'series-write', onClick: () => act('write', null, 'Writing started. You can leave this page; it keeps going.') }, icon('spark'), h('span', null, 'Write')),
        !live && st?.failed ? h('button', { class: 'btn', type: 'button', id: 'series-retry', onClick: () => act('write', { episodes: plan.episodes.filter((e) => e.status === 'failed').map((e) => e.no) }) }, icon('refresh'), `Retry ${st.failed} failed`) : null,
        h('div', { class: 'export-group primary', role: 'group', 'aria-labelledby': 'export-ve-l' }, h('span', { class: 'eg-label', id: 'export-ve-l' }, 'VideoExpress paste pack'),
          h('button', { class: 'btn sm primary', type: 'button', id: 'series-ve-copy', disabled: !episodes.length, onClick: () => exportAs('vepack', 'copy') }, icon('copy'), 'Copy'),
          h('button', { class: 'btn sm', type: 'button', id: 'series-ve', disabled: !episodes.length, onClick: () => exportAs('vepack', 'download') }, icon('download'), 'Download'),
          h('button', { class: 'btn sm ghost', type: 'button', id: 'series-ve-view', disabled: !episodes.length, onClick: () => exportAs('vepack', 'view') }, 'View')),
        h('div', { class: 'export-group', role: 'group', 'aria-labelledby': 'export-md-l' }, h('span', { class: 'eg-label', id: 'export-md-l' }, 'Whole series · Markdown'),
          h('button', { class: 'btn sm', type: 'button', id: 'series-md-copy', disabled: !episodes.length, onClick: () => exportAs('md', 'copy') }, icon('copy'), 'Copy'),
          h('button', { class: 'btn sm', type: 'button', id: 'series-md', disabled: !episodes.length, onClick: () => exportAs('md', 'download') }, icon('download'), 'Download'),
          h('button', { class: 'btn sm ghost', type: 'button', id: 'series-md-view', disabled: !episodes.length, onClick: () => exportAs('md', 'view') }, 'View')),
        h('div', { class: 'export-group', role: 'group', 'aria-labelledby': 'export-guide-l' }, h('span', { class: 'eg-label', id: 'export-guide-l' }, 'Scripts by service'),
          h('button', { class: 'btn sm', type: 'button', id: 'series-guide-copy', disabled: !episodes.length, onClick: () => exportAs('guide', 'copy') }, icon('copy'), 'Copy'),
          h('button', { class: 'btn sm', type: 'button', id: 'series-guide', disabled: !episodes.length, onClick: () => exportAs('guide', 'download') }, icon('download'), 'Download')),
        h('button', { class: 'btn sm', type: 'button', id: 'series-csv', disabled: !episodes.length, onClick: () => exportAs('csv', 'download') }, icon('download'), 'CSV'),
        h('button', { class: 'btn ghost', type: 'button', 'aria-label': 'Delete series', onClick: async () => {
          if (!confirm(`Delete "${s.title}" and its ${episodes.length} episode projects? This cannot be undone.`)) return;
          try { await api(`/api/series/${id}`, { method: 'DELETE' }); toast('Series deleted', 'ok'); ctx.go('series'); } catch (e) { toast(e.message, 'error'); }
        } }, icon('trash'), 'Delete')) : null));

    if (!plan) {
      if (s.status === 'error') wrap.append(h('div', { class: 'card' }, h('p', null, 'The analysis did not finish. Check the model and key in Settings, then start a new series.'), h('a', { class: 'btn', href: '#/series' }, 'Back')));
      else wrap.append(h('div', { class: 'card empty' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', null, 'Reading your data, pulling out facts and scoring them. Big dumps take a minute or two.')));
      restore(focusId); return;
    }
    if (plan.bible?.visualStyle) wrap.append(h('details', { class: 'card stylesheet' }, h('summary', null, h('h2', { class: 'h3' }, 'Series look & voice'), h('span', { class: 'hint' }, 'Shared by every episode so the series feels like one show')),
      h('dl', { class: 'bible' }, ...[['Visual style', plan.bible.visualStyle], ['Palette', plan.bible.palette], ['Camera', plan.bible.camera], ['Narrator', plan.bible.narratorVoice], ['Tone', plan.bible.tone], ['Outro', plan.bible.outro]].filter(([, v]) => v).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))));

    totalsEl = h('p', { class: 'hint', id: 'plan-totals', 'aria-live': 'polite' });
    const o = s.settings.options;
    const lens = []; for (let x = Math.ceil(o.minSeconds / 5) * 5; x <= o.maxSeconds; x += 5) lens.push(x);
    const factText = new Map(plan.facts.map((f) => [f.id, f]));
    const rows = plan.episodes.map((e) => {
      const done = epByNo.get(e.no);
      const locked = live || e.status === 'done';
      return h('tr', { class: e.include ? '' : 'off', dataset: { status: e.status } },
        h('td', null, h('input', { type: 'checkbox', id: `ep-inc-${e.no}`, checked: e.include, disabled: live, 'aria-label': `Include episode ${e.no}`, onChange: (ev) => { edit(e.no, { include: ev.target.checked }); ev.target.closest('tr').classList.toggle('off', !ev.target.checked); } })),
        h('td', { class: 'num' }, String(e.no)),
        h('td', { class: 'ttl' },
          done ? h('a', { href: `#/reels`, id: `ep-open-${e.no}`, onClick: (ev) => { ev.preventDefault(); ctx.openProject(done.projectId); } }, done.title)
            : h('input', { id: `ep-title-${e.no}`, value: e.title, maxlength: 120, disabled: locked, 'aria-label': `Episode ${e.no} title`, onInput: (ev) => edit(e.no, { title: ev.target.value }) }),
          h('details', { class: 'facts' }, h('summary', null, `${e.factIds.length} fact${e.factIds.length > 1 ? 's' : ''}${e.hook ? ` · hook: “${e.hook}”` : ''}`),
            h('ul', null, e.factIds.map((fid) => h('li', null, factText.get(fid)?.text || fid, h('span', { class: 'hint' }, ` (interest ${factText.get(fid)?.interest ?? '?'}/10)`)))),
            e.why ? h('p', { class: 'hint' }, `Why: ${e.why}`) : null)),
        h('td', null, h('span', { class: `fmt fmt-${e.format}` }, FORMATS[e.format]?.label || e.format)),
        h('td', { class: 'num' }, h('span', { class: 'interest', title: 'How interesting the AI rated it' }, `${e.interest}/10`)),
        h('td', null, done?.analysis ? h('span', null, fmtDur(done.analysis.seconds), h('span', { class: 'hint' }, ` · ${done.analysis.clips} clips`))
          : h('select', { id: `ep-len-${e.no}`, disabled: locked, 'aria-label': `Episode ${e.no} target length`, onChange: (ev) => edit(e.no, { targetSeconds: Number(ev.target.value) }) },
            lens.map((x) => h('option', { value: x, selected: x === e.targetSeconds ? true : null }, `${x}s`)))),
        h('td', null, h('span', { class: `epst epst-${e.status}`, title: e.error || '' }, e.status === 'done' ? '✓ Written' : e.status === 'writing' ? 'Writing…' : e.status === 'queued' ? 'Queued' : e.status === 'failed' ? 'Failed' : '—'),
          e.status === 'failed' && e.error ? h('span', { class: 'sr-only' }, `: ${e.error}`) : null,
          done && !live ? h('button', { class: 'btn ghost sm', type: 'button', id: `ep-redo-${e.no}`, 'aria-label': `Rewrite episode ${e.no}`, onClick: () => act('write', { episodes: [e.no] }, `Rewriting episode ${e.no}…`) }, icon('refresh')) : null));
    });
    wrap.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'h3' }, 'Episode plan'), h('span', { class: 'hint', id: 'plan-save', 'aria-live': 'polite' }, live ? 'Locked while writing' : 'Edits save automatically')),
      totalsEl,
      h('div', { class: 'table-wrap' }, h('table', { class: 'plan' },
        h('caption', { class: 'sr-only' }, 'Episodes planned from your data'),
        h('thead', null, h('tr', null, ...['Use', '#', 'Episode', 'Format', 'Interest', 'Length', 'Status'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, rows)))));
    paintTotals();
    wrap.querySelectorAll('.progress span').forEach((sp) => { sp.style.width = `${sp.dataset.pct}%`; });
    restore(focusId);
  }
  const restore = (fid) => { if (fid) document.getElementById(fid)?.focus({ preventScroll: true }); };
  load();
  return wrap;
}
