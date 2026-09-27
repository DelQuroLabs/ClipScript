import { api, setCsrf, setSessionToken } from './api.js';
import { h, clear, $, icon, toast, copyText, download, slug } from './dom.js';
import { countWords, wordBudget, LIMITS } from '../lib/domain/wordcount.js';
import { windowFor, defaultBrief, normalizeBrief, validateBrief, ASPECT_RATIOS, DIALOGUE_MODES, CLIP_SECOND_PRESETS } from '../lib/domain/project.js';
import { randomizeBrief, rerollField, combinationCount, formatBig, analyzeSource, REEL_STRUCTURES, DICE_FIELDS, newSeed } from '../lib/domain/randomize.js';
import { clipFit, clipLimits, analyzeScript, composeImagePrompt, composeLastFramePrompt, dialogueText, toMarkdown, toCsv } from '../lib/domain/script.js';
import { seriesView, stopSeriesPoll } from './series.js';
import { buildGuide, guideProgress, guideMarkdown } from '../lib/domain/guide.js';
import { costOf, formatUsd, priceFor, priceKey } from '../lib/domain/pricing.js';
import { RUBRIC, scoreLabel, TARGET_SCORE } from '../lib/domain/quality.js';
import { CRITICS, VETO_BELOW, enabledCritics } from '../lib/domain/critics.js';
import { buildVePack, vePackMarkdown, normalizeVeSettings, VE_LIMITS, VE_VOICE_TABS, VE_IMAGE_TYPES } from '../lib/domain/vepack.js';

const VE_URL = 'https://app.videoexpress.ai';
const state = {
  user: null, providers: [], keys: [], projects: [],
  project: null, // {id, brief, script, meta}
  brief: defaultBrief(), busy: null, error: null, embedStyle: true,
  view: (() => { try { const v = localStorage.getItem('cs_view'); return ['guide', 'vepack', 'critics'].includes(v) ? v : 'clips'; } catch { return 'clips'; } })(),
  locks: new Set(), lastSeed: null,
  stash: { story: null, reel: null }, // each mode keeps its own brief + project while you switch sections
};
const app = $('#app');

// ---------- theme ----------
const THEME_KEY = 'cs_theme';
function applyTheme(t) { document.documentElement.dataset.theme = t || ''; }
applyTheme(localStorage.getItem(THEME_KEY));
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next); applyTheme(next); render();
}

// ---------- boot / routing ----------
async function boot() {
  try {
    const [{ providers }] = await Promise.all([api('/api/providers')]);
    state.providers = providers;
    const { user } = await api('/api/auth/me');
    if (user) await onSignedIn(user);
  } catch (e) {
    state.error = e.message;
  }
  window.addEventListener('hashchange', render);
  render();
}
async function onSignedIn(user) {
  state.user = user; setCsrf(user.csrfToken);
  if (user.settings.briefDefaults) state.brief = normalizeBrief({ ...user.settings.briefDefaults, concept: '', title: '', mode: 'story', sourceData: '' });
  const [{ keys }] = await Promise.all([api('/api/keys')]);
  state.keys = keys;
}
const route = () => (location.hash.replace(/^#\/?/, '').split('/')[0] || 'studio');
const routeId = () => { const n = Number(location.hash.replace(/^#\/?/, '').split('/')[1]); return Number.isInteger(n) && n > 0 ? n : null; };
/** Keep the address bar pointing at the open project (#/reels/12) without re-rendering, so reloads and links reopen it. */
function syncHash() {
  const r = route(); if (r !== 'studio' && r !== 'reels') return;
  const want = state.project?.id ? `#/${r}/${state.project.id}` : `#/${r}`;
  if (location.hash !== want) history.replaceState(null, '', want);
}
const go = (r) => { if (location.hash !== `#/${r}`) location.hash = `#/${r}`; else render(); };

function render() {
  const focusId = document.activeElement && document.activeElement.id;
  clear(app);
  if (!state.user) { app.append(authView()); restoreFocus(focusId); return; }
  const r = route();
  app.append(header(r));
  const main = h('main', { id: 'main', tabindex: '-1' });
  if (r !== 'series') stopSeriesPoll();
  if (state.busy === 'polish' && (routeId() !== state.polish?.id || !['studio', 'reels'].includes(r))) { stopPolishPoll(); state.busy = null; }
  if (r === 'series') main.append(seriesView({ state, modelPicker, currentModel, openProject, go }, Number(location.hash.split('/')[2]) || null));
  else if (r === 'settings') main.append(settingsView());
  else if (r === 'projects') main.append(projectsView());
  else {
    const wantId = routeId();
    if (wantId && state.project?.id !== wantId) {
      // Deep link / reload: fetch the project, then render it.
      main.append(h('div', { class: 'card', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), ' Opening project…'));
      app.append(main, footer());
      if (state._opening !== wantId) {
        state._opening = wantId;
        api(`/api/projects/${wantId}`).then(({ project }) => {
          const nb = normalizeBrief(project.brief); ensureMode(nb.mode); state.project = project; state.brief = nb; state.error = null;
          state._opening = null;
          const sec = nb.mode === 'reel' ? 'reels' : 'studio';
          history.replaceState(null, '', `#/${sec}/${project.id}`); render(); resumePolish(project.id);
        }).catch((e) => { state._opening = null; toast(e.status === 404 ? 'That project no longer exists.' : e.message, 'error'); history.replaceState(null, '', `#/${r}`); render(); });
      }
      return;
    }
    ensureMode(r === 'reels' ? 'reel' : 'story'); main.append(studioView()); syncHash();
  }
  app.append(main, footer());
  restoreFocus(focusId);
}
/** Swap to the brief/project for this section, stashing the other one so nothing is lost. */
function ensureMode(mode) {
  if (state.brief.mode === mode) return;
  state.stash[state.brief.mode] = { brief: state.brief, project: state.project, locks: state.locks };
  const back = state.stash[mode];
  if (back) { state.brief = back.brief; state.project = back.project; state.locks = back.locks; }
  else {
    const d = state.user.settings.briefDefaults || defaultBrief();
    state.brief = normalizeBrief({ ...d, title: '', concept: '', characterNotes: mode === 'reel' ? '' : d.characterNotes, mode, sourceData: '',
      aspectRatio: mode === 'reel' ? '9:16' : d.aspectRatio, dialogueMode: mode === 'reel' ? 'voiceover' : d.dialogueMode });
    state.project = null; state.locks = new Set();
  }
  state.error = null;
}
function restoreFocus(id) { if (id) { const el = document.getElementById(id); if (el) el.focus({ preventScroll: true }); } }

function header(r) {
  const nav = (id, label, ic) => h('a', { href: `#/${id}`, class: 'nav-link', 'aria-current': r === id ? 'page' : null }, icon(ic), h('span', null, label));
  const dark = (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  return h('header', { class: 'topbar' },
    h('a', { class: 'skip', href: '#main' }, 'Skip to content'),
    h('a', { href: '#/studio', class: 'brand', 'aria-label': 'ClipScript Studio home' }, logo(), h('span', null, 'ClipScript', h('b', null, ' Studio'))),
    h('nav', { 'aria-label': 'Main' }, nav('studio', 'Studio', 'spark'), nav('reels', 'Reels', 'reel'), nav('series', 'Series', 'layers'), nav('projects', 'Projects', 'folder'), nav('settings', 'Settings', 'gear')),
    h('div', { class: 'top-actions' },
      h('a', { class: 'btn ghost sm', href: VE_URL, target: '_blank', rel: 'noopener noreferrer' }, icon('ext'), h('span', { class: 'hide-sm' }, 'Open VideoExpress')),
      h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': dark ? 'Switch to light theme' : 'Switch to dark theme', onClick: toggleTheme }, icon(dark ? 'sun' : 'moon')),
      h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': 'Sign out', onClick: logout }, icon('logout'))));
}
function logo() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 32 32'); s.setAttribute('width', '28'); s.setAttribute('height', '28'); s.setAttribute('aria-hidden', 'true');
  const r = document.createElementNS(s.namespaceURI, 'rect'); r.setAttribute('width', '32'); r.setAttribute('height', '32'); r.setAttribute('rx', '8'); r.setAttribute('class', 'logo-bg');
  const p = document.createElementNS(s.namespaceURI, 'path'); p.setAttribute('d', 'M9 10h9M9 15h14M9 20h7M20 18l5 3-5 3z'); p.setAttribute('class', 'logo-fg');
  s.append(r, p); return s;
}
function footer() {
  return h('footer', { class: 'foot' }, 'Scripts are generated by the AI model you choose, using your own API key. ClipScript is an independent tool and is not affiliated with VideoExpress.');
}
async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  state.user = null; state.project = null; state.brief = defaultBrief(); setCsrf(null); setSessionToken(null); go('studio');
}

// ---------- auth ----------
function authView() {
  let mode = 'login';
  const wrap = h('main', { class: 'auth', id: 'main' });
  const draw = async () => {
    let status = { registrationOpen: true, hasUsers: true };
    try { status = await api('/api/auth/status'); } catch { /* keep defaults */ }
    if (!status.hasUsers) mode = 'register';
    clear(wrap);
    const err = h('p', { class: 'form-error', role: 'alert', id: 'auth-error' });
    const email = h('input', { id: 'auth-email', type: 'email', autocomplete: 'email', required: true, maxlength: 254 });
    const pw = h('input', { id: 'auth-password', type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true, minlength: mode === 'login' ? 1 : 10, maxlength: 200, 'aria-describedby': mode === 'register' ? 'pw-hint' : null });
    const submit = h('button', { class: 'btn primary block', type: 'submit' }, mode === 'login' ? 'Sign in' : 'Create account');
    const form = h('form', { class: 'card auth-card', novalidate: true, onSubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      submit.disabled = true; submit.textContent = mode === 'login' ? 'Signing in…' : 'Creating…';
      try {
        const { user } = await api(`/api/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body: { email: email.value, password: pw.value } });
        try {
          await onSignedIn(user);
        } catch (e2) {
          // Credentials were accepted, but the follow-up request came back signed out:
          // the browser is refusing to keep the session (blocked cookies/storage in an embedded frame).
          state.user = null;
          if (e2.status === 401) {
            err.textContent = '';
            err.append('Your password was accepted, but this browser blocked the sign-in session (common inside embedded previews). ',
              h('a', { href: location.href.split('#')[0], target: '_blank', rel: 'noopener noreferrer' }, 'Open ClipScript in a new tab'),
              ' and sign in there.');
            submit.disabled = false; submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
            return;
          }
          throw e2;
        }
        if (!state.keys.length) toast('Welcome! Add an API key in Settings, or try the Demo model.', 'ok');
        go(state.keys.length ? 'studio' : 'settings');
      } catch (ex) {
        err.textContent = ex.message; submit.disabled = false; submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
      }
    } },
      h('div', { class: 'auth-brand' }, logo(), h('h1', null, 'ClipScript Studio')),
      h('p', { class: 'muted' }, !status.hasUsers ? 'Create the first (admin) account for this server.' : mode === 'login' ? 'Sign in to write image, video and dialogue scripts for VideoExpress.' : 'Create your account.'),
      h('label', { for: 'auth-email' }, 'Email'), email,
      h('label', { for: 'auth-password' }, 'Password'), pw,
      mode === 'register' ? h('p', { class: 'hint', id: 'pw-hint' }, 'At least 10 characters.') : null,
      err, submit,
      status.hasUsers && status.registrationOpen ? h('button', { type: 'button', class: 'linkish', onClick: () => { mode = mode === 'login' ? 'register' : 'login'; draw(); } },
        mode === 'login' ? 'No account? Create one' : 'Have an account? Sign in') : null,
      status.hasUsers && !status.registrationOpen && mode === 'login' ? h('p', { class: 'hint' }, 'New registrations are closed on this server.') : null);
    wrap.append(form);
    if (state.error) wrap.prepend(h('p', { class: 'banner error', role: 'alert' }, state.error));
    email.focus();
  };
  draw();
  return wrap;
}

// ---------- model picker ----------
function currentModel() {
  const s = state.user.settings;
  const provider = s.provider && state.providers.some((p) => p.id === s.provider) ? s.provider : (state.keys[0]?.provider || 'demo');
  const p = state.providers.find((x) => x.id === provider);
  const model = s.provider === provider && s.model ? s.model : p.defaultModel;
  return { provider, model, p };
}
async function saveSettings(patch) {
  const { settings } = await api('/api/settings', { method: 'PUT', body: patch });
  state.user.settings = settings;
}
function modelPicker(compact = false) {
  const { provider, model, p } = currentModel();
  const hasKey = p.noKey || state.keys.some((k) => k.provider === provider);
  const listId = 'model-options';
  const provSel = h('select', { id: 'provider', onChange: async (e) => {
    const np = state.providers.find((x) => x.id === e.target.value);
    await saveSettings({ provider: np.id, model: np.defaultModel }); render();
  } }, state.providers.map((x) => h('option', { value: x.id, selected: x.id === provider ? true : null },
    x.label + (x.noKey || state.keys.some((k) => k.provider === x.id) ? '' : ' — no key'))));
  const modelIn = h('input', { id: 'model', list: listId, value: model, autocomplete: 'off', spellcheck: 'false', placeholder: 'model id', onChange: async (e) => { await saveSettings({ provider, model: e.target.value.trim() }); } });
  return h('div', { class: `model-picker ${compact ? 'compact' : ''}` },
    h('div', { class: 'field' }, h('label', { for: 'provider' }, 'Provider'), provSel),
    h('div', { class: 'field' }, h('label', { for: 'model' }, 'Model'), modelIn,
      h('datalist', { id: listId }, (p.models || []).map((m) => h('option', { value: m })))),
    !hasKey ? h('p', { class: 'hint warn', role: 'status' }, 'No API key saved for this provider. ', h('a', { href: '#/settings' }, 'Add one in Settings'), '.') : null);
}

// ---------- studio ----------
// ---------- randomize ----------
const DICE_LABEL = { title: 'title', concept: 'idea', characterNotes: 'characters', tone: 'tone', visualStyle: 'visual style', audience: 'audience', callToAction: 'call to action', timing: 'clips & timing', dialogueMode: 'spoken audio', aspectRatio: 'aspect ratio', reelStructure: 'structure', narratorVoice: 'narrator voice' };
function applyRoll(brief, seed, msg) {
  state.brief = normalizeBrief(brief); state.lastSeed = seed; state.error = null;
  render(); toast(msg, 'ok');
}
function randomizeAll(fill = 'all', seed = newSeed()) {
  const r = randomizeBrief(state.brief, { seed, fill, locks: [...state.locks] });
  applyRoll(r.brief, seed, fill === 'blanks' ? 'Filled the empty fields.' : `Randomized${state.locks.size ? ` (kept ${state.locks.size} locked)` : ''}.`);
}
function reroll(field) {
  const focus = document.activeElement && document.activeElement.id;
  const seed = newSeed();
  const r = rerollField(state.brief, field, { seed, locks: [...state.locks] });
  state.brief = normalizeBrief(r.brief); state.lastSeed = seed;
  render(); if (focus) document.getElementById(focus)?.focus();
}
function toggleLock(field) {
  if (state.locks.has(field)) state.locks.delete(field); else state.locks.add(field);
  const focus = document.activeElement && document.activeElement.id;
  render(); if (focus) document.getElementById(focus)?.focus();
}
/** Dice + lock buttons shown beside a field label. */
function diceTools(field) {
  if (!DICE_FIELDS.includes(field)) return null;
  const locked = state.locks.has(field), name = DICE_LABEL[field] || field;
  return h('span', { class: 'dice-tools' },
    h('button', { type: 'button', class: 'icon-btn', id: `dice-${field}`, title: `Randomize ${name}`, 'aria-label': `Randomize ${name}`, disabled: locked || !!state.busy, onClick: () => reroll(field) }, icon('dice', 15)),
    h('button', { type: 'button', class: `icon-btn ${locked ? 'on' : ''}`, id: `lock-${field}`, title: locked ? `Unlock ${name}` : `Lock ${name} (keep it when randomizing)`, 'aria-label': `Lock ${name}`, 'aria-pressed': locked ? 'true' : 'false', onClick: () => toggleLock(field) }, icon(locked ? 'lock' : 'unlock', 15)));
}
function randomizeBar() {
  const mode = state.brief.mode;
  const seedIn = h('input', { id: 'seed', type: 'text', inputmode: 'numeric', value: state.lastSeed ?? '', placeholder: 'seed', 'aria-label': 'Seed to replay', maxlength: 10, spellcheck: 'false' });
  return h('div', { class: 'rand-bar', role: 'group', 'aria-label': 'Randomize' },
    h('div', { class: 'rand-btns' },
      h('button', { type: 'button', class: 'btn accent', id: 'randomize-all', disabled: !!state.busy, onClick: () => randomizeAll('all') }, icon('dice', 16), 'Randomize all'),
      h('button', { type: 'button', class: 'btn ghost', id: 'randomize-blanks', disabled: !!state.busy, onClick: () => randomizeAll('blanks') }, 'Fill blanks')),
    h('p', { class: 'hint rand-hint' }, `${formatBig(combinationCount(mode))} combinations, and they're built to fit together. Lock `, icon('lock', 12), ' anything you want to keep.'),
    h('details', { class: 'seed-box' }, h('summary', null, state.lastSeed != null ? `Seed ${state.lastSeed}` : 'Seed'),
      h('div', { class: 'seed-row' }, seedIn,
        h('button', { type: 'button', class: 'btn sm', id: 'seed-replay', onClick: () => { const n = parseInt(seedIn.value, 10); if (Number.isFinite(n) && n >= 0) randomizeAll('all', n); else toast('Enter a number seed.', 'warn'); } }, 'Replay'))));
}

function studioView() {
  const b = state.brief;
  const reel = b.mode === 'reel';
  const set = (k, v) => { state.brief = normalizeBrief({ ...state.brief, [k]: v }); };
  const budget = () => wordBudget(state.brief.clipSeconds, state.brief.wordsPerSecond, state.brief.paddingSeconds, state.brief.safetyMargin);

  const budgetOut = h('output', { id: 'budget-out', class: 'budget-pill', for: 'clipSeconds wps padding', 'aria-live': 'polite' });
  const updateBudget = () => {
    const bb = state.brief;
    budgetOut.textContent = bb.dialogueMode === 'none' ? 'No dialogue' : `≤ ${budget()} words · ≤ ${windowFor(bb)}s of speech per clip · ${bb.clipCount * bb.clipSeconds}s video`;
    if (state.project?.script) renderScriptPanel();
  };

  const text = (id, label, key, opts = {}) => h('div', { class: 'field' + (opts.full ? ' full' : '') + (state.locks.has(key) ? ' locked' : '') },
    h('div', { class: 'label-row' }, h('label', { for: id }, label, opts.optional ? h('span', { class: 'opt' }, ' optional') : null), diceTools(key)),
    h(opts.area ? 'textarea' : 'input', { id, value: b[key], rows: opts.rows || 3, placeholder: opts.ph || '', maxlength: opts.max || 1000,
      onInput: (e) => set(key, e.target.value), 'aria-invalid': opts.invalid ? 'true' : null, 'aria-describedby': opts.desc || null }));

  const clipCount = h('input', { id: 'clipCount', type: 'number', min: LIMITS.MIN_CLIPS, max: LIMITS.MAX_CLIPS, step: 1, value: b.clipCount, inputmode: 'numeric',
    onInput: (e) => { set('clipCount', e.target.value); updateBudget(); }, onBlur: (e) => { e.target.value = state.brief.clipCount; } });
  const preset = CLIP_SECOND_PRESETS.includes(b.clipSeconds) ? String(b.clipSeconds) : 'custom';
  const secSel = h('select', { id: 'clipSeconds', onChange: (e) => {
    if (e.target.value === 'custom') { customSec.hidden = false; customSec.focus(); return; }
    customSec.hidden = true; set('clipSeconds', Number(e.target.value)); updateBudget();
  } }, CLIP_SECOND_PRESETS.map((s) => h('option', { value: s, selected: String(s) === preset ? true : null }, `${s} seconds`)), h('option', { value: 'custom', selected: preset === 'custom' ? true : null }, 'Custom…'));
  const customSec = h('input', { id: 'clipSecondsCustom', type: 'number', min: LIMITS.MIN_SECONDS, max: LIMITS.MAX_SECONDS, step: 0.5, value: b.clipSeconds, 'aria-label': 'Custom clip length in seconds', hidden: preset !== 'custom',
    onInput: (e) => { set('clipSeconds', e.target.value); updateBudget(); } });
  const wps = h('input', { id: 'wps', type: 'range', min: 1.5, max: 3.5, step: 0.1, value: b.wordsPerSecond, 'aria-describedby': 'wps-val',
    onInput: (e) => { set('wordsPerSecond', e.target.value); wpsVal.textContent = `${Number(e.target.value).toFixed(1)} words/sec · ${Math.round(e.target.value * 60)} wpm`; updateBudget(); } });
  const wpsVal = h('span', { id: 'wps-val', class: 'hint' }, `${b.wordsPerSecond.toFixed(1)} words/sec · ${Math.round(b.wordsPerSecond * 60)} wpm`);
  const pad = h('input', { id: 'padding', type: 'number', min: 0, max: 5, step: 0.25, value: b.paddingSeconds, onInput: (e) => { set('paddingSeconds', e.target.value); updateBudget(); } });
  const safety = h('input', { id: 'safetyMargin', type: 'range', min: 0, max: 30, step: 5, value: b.safetyMargin, 'aria-describedby': 'safety-val',
    onInput: (e) => { set('safetyMargin', e.target.value); safetyVal.textContent = safetyText(); updateBudget(); } });
  const safetyText = () => `${state.brief.safetyMargin}% held back · ${state.brief.safetyMargin === 0 ? 'no buffer: last words may clip' : state.brief.safetyMargin < 10 ? 'small buffer' : state.brief.safetyMargin <= 15 ? 'recommended' : 'extra safe (slower voices, dramatic pauses)'}`;
  const safetyVal = h('span', { id: 'safety-val', class: 'hint' }, safetyText());
  const modeSel = h('select', { id: 'dialogueMode', onChange: (e) => { set('dialogueMode', e.target.value); updateBudget(); } },
    DIALOGUE_MODES.filter((m) => !reel || m.id === 'voiceover' || m.id === 'none').map((m) => h('option', { value: m.id, selected: m.id === b.dialogueMode ? true : null }, m.label)));
  const aspect = h('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': 'aspect-label' },
    ASPECT_RATIOS.map((a) => h('label', { class: 'seg-opt' }, h('input', { type: 'radio', name: 'aspect', value: a, checked: a === b.aspectRatio, onChange: () => set('aspectRatio', a) }), h('span', null, a))));

  const errEl = h('p', { class: 'form-error', role: 'alert', id: 'gen-error' }, state.error || '');
  const genBtn = h('button', { class: 'btn primary block lg', type: 'submit', id: 'generate', disabled: !!state.busy, 'aria-busy': state.busy === 'generate' ? 'true' : null },
    icon(reel ? 'reel' : 'spark', 18), state.busy === 'generate' ? (reel ? 'Building your reel…' : 'Writing your script…') : state.project?.script ? (reel ? 'Regenerate reel' : 'Regenerate script') : (reel ? 'Generate faceless reel' : 'Generate script'));

  const lbl = (key, forId, label) => h('div', { class: 'label-row' }, h(forId ? 'label' : 'span', forId ? { for: forId } : { class: 'label', id: `${key}-label` }, label), diceTools(key));
  const timing = h('fieldset', { class: 'group' + (state.locks.has('timing') ? ' locked' : '') }, h('legend', null, h('span', { class: 'legend-row' }, 'Clips & timing', diceTools('timing'))),
    h('div', { class: 'row3' },
      h('div', { class: 'field' }, h('label', { for: 'clipCount' }, 'Clips (1–10)'), clipCount),
      h('div', { class: 'field' }, h('label', { for: 'clipSeconds' }, 'Clip length'), secSel, customSec),
      h('div', { class: 'field' }, h('label', { for: 'padding' }, 'Silence pad (s)'), pad)),
    h('div', { class: 'field' }, h('label', { for: 'wps' }, 'Speaking pace'), wps, wpsVal),
    h('div', { class: 'field' }, h('label', { for: 'safetyMargin' }, 'Cut-off safety margin'), safety, safetyVal),
    h('div', { class: 'field' + (state.locks.has('dialogueMode') ? ' locked' : '') }, lbl('dialogueMode', 'dialogueMode', reel ? 'Narration' : 'Spoken audio'), modeSel),
    budgetOut);
  const aspectField = h('div', { class: 'field' + (state.locks.has('aspectRatio') ? ' locked' : '') }, h('div', { class: 'label-row' }, h('span', { class: 'label', id: 'aspect-label' }, 'Aspect ratio'), diceTools('aspectRatio')), aspect);
  const more = h('details', { class: 'group more', open: state.brief.tone || state.brief.audience || state.brief.callToAction ? true : null }, h('summary', null, reel ? 'Tone, narrator, audience & call to action' : 'Tone, audience & call to action'),
    h('div', { class: 'row2' }, text('tone', 'Tone', 'tone', { optional: true, ph: 'warm, upbeat', max: 200 }), text('audience', 'Audience', 'audience', { optional: true, ph: 'small business owners', max: 200 })),
    text('narratorVoice', 'Narrator voice', 'narratorVoice', { optional: true, ph: 'e.g. deep, calm documentary narrator', max: 200 }),
    h('div', { class: 'row2' }, text('language', 'Language', 'language', { max: 40 }), text('callToAction', 'Call to action', 'callToAction', { optional: true, ph: 'Visit example.com', max: 300 })));

  let body;
  if (reel) {
    const stats = h('p', { class: 'hint', id: 'source-stats', 'aria-live': 'polite' });
    const paintStats = () => { const a = analyzeSource(state.brief.sourceData); stats.textContent = a.chars ? `${a.words.toLocaleString()} words · ${a.numbers} number${a.numbers === 1 ? '' : 's'} · ${a.dates} date${a.dates === 1 ? '' : 's'} · ${a.chars.toLocaleString()}/60,000 chars` : 'Paste notes, an article, a CSV, stats, a transcript, bullet points… anything.'; };
    paintStats();
    const src = h('textarea', { id: 'sourceData', rows: 9, maxlength: 60000, value: b.sourceData, placeholder: 'Dump your raw data here. The app pulls out the facts and turns them into a faceless reel: B-roll image prompts, motion prompts, voiceover and on-screen text. No faces, no presenter.', 'aria-describedby': 'source-stats', onInput: (e) => { set('sourceData', e.target.value); paintStats(); } });
    const structSel = h('select', { id: 'reelStructure', onChange: (e) => set('reelStructure', e.target.value) },
      h('option', { value: '' }, 'Let the model choose'), REEL_STRUCTURES.map((r) => h('option', { value: r.id, selected: r.id === b.reelStructure ? true : null }, r.label)));
    body = [
      h('div', { class: 'field' }, h('label', { for: 'sourceData' }, 'Raw data dump'), src, stats),
      text('title', 'Hook / title', 'title', { optional: true, ph: 'e.g. Nobody talks about this', max: 120 }),
      h('div', { class: 'field' + (state.locks.has('reelStructure') ? ' locked' : '') }, lbl('reelStructure', 'reelStructure', 'Structure'), structSel),
      text('concept', 'Angle', 'concept', { area: true, rows: 2, optional: true, max: 6000, ph: 'e.g. Bust the most common myth in the data' }),
      timing,
      h('fieldset', { class: 'group' }, h('legend', null, 'Look'), aspectField,
        text('visualStyle', 'Visual style', 'visualStyle', { optional: true, ph: 'e.g. macro photography, moody light · or · kinetic typography' }),
        h('p', { class: 'hint' }, 'Faceless: no people on camera. You get objects, places, data visuals, hands-only shots and text.')),
      more,
    ];
  } else {
    body = [
      text('title', 'Working title', 'title', { optional: true, ph: 'e.g. The Bakery on Harbor Street', max: 120 }),
      text('concept', 'What is the video about?', 'concept', { area: true, rows: 5, max: 6000, ph: 'Story, product, message, key points, the hook you want…' }),
      timing,
      h('fieldset', { class: 'group' }, h('legend', null, 'Look & characters'), aspectField,
        text('visualStyle', 'Visual style', 'visualStyle', { optional: true, ph: 'e.g. Pixar-style 3D, soft light · or · gritty 35mm film' }),
        text('characterNotes', 'Characters', 'characterNotes', { area: true, rows: 3, optional: true, max: 3000, ph: 'Name + fixed look, e.g. "Maya, 30s, curly dark hair, mustard apron". Reused in every image prompt for consistency.' })),
      more,
    ];
  }

  const form = h('form', { class: 'card brief', 'aria-labelledby': 'brief-h', novalidate: true, onSubmit: (e) => { e.preventDefault(); generate(); } },
    h('div', { class: 'card-head' }, h('h2', { id: 'brief-h' }, reel ? 'Faceless reel from your data' : 'Brief'),
      h('button', { type: 'button', class: 'btn ghost sm', onClick: newProject }, icon('plus'), 'New')),
    randomizeBar(),
    ...body,
    h('div', { class: 'group' }, modelPicker(true),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'autoFit', checked: state.user.settings.autoFit !== false, onChange: (e) => saveSettings({ autoFit: e.target.checked }) }),
        ' Auto-fix clips that are too long to say in time')),
    errEl, genBtn);
  updateBudget();

  const panel = h('section', { class: 'output', id: 'script-panel', 'aria-labelledby': 'script-h', 'aria-busy': state.busy ? 'true' : 'false' });
  state._panel = panel;
  renderScriptPanel();
  return h('div', { class: 'studio' }, form, panel);
}

function newProject() {
  const mode = state.brief.mode;
  const d = state.user.settings.briefDefaults || defaultBrief();
  state.project = null; state.error = null; state.locks = new Set();
  state.brief = normalizeBrief({ ...d, title: '', concept: '', mode, sourceData: '', characterNotes: mode === 'reel' ? '' : d.characterNotes, aspectRatio: mode === 'reel' ? '9:16' : d.aspectRatio, dialogueMode: mode === 'reel' ? 'voiceover' : d.dialogueMode });
  render(); $(mode === 'reel' ? '#sourceData' : '#concept')?.focus();
}

async function generate() {
  const brief = state.brief;
  const errs = validateBrief(brief);
  if (errs.length) { state.error = errs[0].message; render(); document.getElementById(errs[0].field)?.focus(); return; }
  const { provider, model } = currentModel();
  state.busy = 'generate'; state.error = null; render();
  try {
    const r = await api('/api/generate', { method: 'POST', body: { brief, provider, model, projectId: state.project?.id || null, autoFit: state.user.settings.autoFit !== false } });
    state.project = r.project; state.brief = r.project.brief; syncHash();
    const a = r.analysis;
    toast(a.overClips.length ? `Script ready. ${a.overClips.length} clip(s) are still too long and would be cut off.` : 'Script ready. Every clip fits its word budget and speaking time.', a.overClips.length ? 'warn' : 'ok');
  } catch (e) { state.error = e.message; }
  state.busy = null; render();
  if (state.project?.script) $('#script-h')?.focus();
}

// ---- script panel ----
let saveTimer;
let savePending = false;
function scheduleSave() {
  clearTimeout(saveTimer);
  const st = $('#save-state');
  if (state.busy === 'polish') { if (st) st.textContent = 'Editing is paused while polishing'; return; }
  if (st) st.textContent = 'Unsaved changes…';
  savePending = true;
  saveTimer = setTimeout(saveNow, 800);
}
async function saveNow() {
  clearTimeout(saveTimer); savePending = false;
  try {
    const r = await api('/api/projects', { method: 'POST', body: { id: state.project.id, brief: state.brief, script: state.project.script } });
    state.project.id = r.project.id; syncHash();
    const s = $('#save-state'); if (s) s.textContent = 'Saved';
    return true;
  } catch (e) { const s = $('#save-state'); if (s) s.textContent = `Not saved: ${e.message}`; return false; }
}

// ---- quality loop (Analyze → Repair → Analyze) ----
let polishTimer = null;
function stopPolishPoll() { clearTimeout(polishTimer); polishTimer = null; }
async function startPolish(rounds) {
  const proj = state.project; if (!proj?.script) return;
  if (savePending || !proj.id) { if (!(await saveNow())) return toast('Could not save the script first.', 'error'); }
  const { provider, model } = currentModel();
  try {
    const { job } = await api(`/api/projects/${proj.id}/polish`, { method: 'POST', body: { provider, model, rounds, target: TARGET_SCORE } });
    state.polish = { id: proj.id, job }; state.busy = 'polish'; renderScriptPanel();
    pollPolish(proj.id);
  } catch (e) { toast(e.message, 'error'); }
}
function pollPolish(id) {
  stopPolishPoll();
  polishTimer = setTimeout(async () => {
    if (state.project?.id !== id) { stopPolishPoll(); if (state.busy === 'polish') state.busy = null; return; }
    try {
      const { job } = await api(`/api/projects/${id}/polish`);
      state.polish = { id, job };
      if (job?.status === 'running') { updatePolishCard(); pollPolish(id); return; }
      state.busy = null;
      const { project } = await api(`/api/projects/${id}`);
      if (state.project?.id !== id) return;
      state.project = project;
      if (job?.status === 'error') toast(job.error, 'error');
      else toast(job?.result?.reached ? `Polished: ${job.result.score}/100` : `Best score: ${job?.result?.score ?? '?'}/100`, job?.result?.reached ? 'ok' : 'warn');
      renderScriptPanel();
      $('#quality-h')?.focus();
    } catch (e) { pollPolish(id); }
  }, 1500);
}
async function resumePolish(id) {
  try {
    const { job } = await api(`/api/projects/${id}/polish`);
    if (job?.status === 'running' && state.project?.id === id) { state.polish = { id, job }; state.busy = 'polish'; renderScriptPanel(); pollPolish(id); }
  } catch { /* ignore */ }
}
function polishProgress(job) {
  return h('div', { class: 'polish-run', id: 'polish-run' },
    h('div', { class: 'polish-status' }, h('div', { class: 'spinner sm', 'aria-hidden': 'true' }), h('p', { id: 'polish-msg', role: 'status' }, job.message || 'Working…')),
    h('ol', { class: 'polish-log', id: 'polish-log', 'aria-label': 'Polish log' }, (job.log || []).map((l) => h('li', null, l))),
    h('button', { class: 'btn sm ghost', type: 'button', id: 'polish-stop', onClick: async () => { await api(`/api/projects/${state.polish.id}/polish/cancel`, { method: 'POST', body: {} }).catch(() => {}); const m = $('#polish-msg'); if (m) m.textContent = 'Stopping after this step… the best version so far is kept.'; } }, icon('x'), 'Stop'));
}
function updatePolishCard() {
  const box = $('#polish-run'); if (!box || !state.polish?.job) return renderScriptPanel();
  box.replaceWith(polishProgress(state.polish.job));
}
const scoreCls = (s) => (s >= 95 ? 'good' : s >= 80 ? 'mid' : 'bad');
function qualityCard(proj) {
  const qm = proj.meta?.quality;
  const running = state.busy === 'polish' && state.polish?.id === proj.id && state.polish.job;
  const card = h('section', { class: 'card quality', 'aria-labelledby': 'quality-h' });
  const head = h('div', { class: 'q-head' },
    h('div', null, h('h3', { id: 'quality-h', tabindex: '-1' }, icon('star'), ' Script quality'),
      h('p', { class: 'hint' }, running ? 'The AI and the critic panel read the script, the issues they find are fixed, and it is read again, until it scores 95+ (max 3 repair rounds). The best version is kept.'
        : qm ? `Checked with ${qm.model} · ${new Date(qm.at).toLocaleString()}${qm.rounds ? ` · ${qm.rounds} repair round${qm.rounds > 1 ? 's' : ''}` : ''}` : 'Let the AI and a panel of critics read and grade this script, then fix it until it scores 95+ out of 100. Uses your API key.')),
    qm && !running ? h('div', { class: `q-score ${scoreCls(qm.score)}`, id: 'quality-score', 'aria-label': `Score ${qm.score} out of 100, ${scoreLabel(qm.score)}` }, h('strong', null, String(qm.score)), h('span', null, `/100 · ${scoreLabel(qm.score)}`)) : null);
  card.append(head);
  if (running) { card.append(polishProgress(state.polish.job)); return card; }
  if (qm) {
    if (qm.history?.length > 1) card.append(h('p', { class: 'hint', id: 'quality-history' }, 'Scores: ', qm.history.map((x) => `${x.round ? `round ${x.round}` : 'first read'} ${x.rejected ? 'rejected (broke a locked feature)' : x.score}`).join(' → ')));
    if (qm.summary) card.append(h('p', { class: 'q-summary' }, qm.summary));
    const nLocked = proj.meta?.buildSpec?.features?.length || 0;
    if (nLocked) card.append(h('p', { class: 'hint', id: 'quality-locked' }, `🔒 ${nLocked} build features locked and checked after every repair${qm.ignored?.length ? ` · ${qm.ignored.length} note${qm.ignored.length > 1 ? 's' : ''} ignored because ${qm.ignored.length > 1 ? 'they' : 'it'} would undo one` : ''}.`));
    if (qm.critics?.length) {
      const bl = qm.critics.filter((c) => c.score < VETO_BELOW);
      card.append(h('p', { class: 'q-critics', id: 'quality-critics' }, h('strong', null, `Critic panel: ${qm.criticAvg}/10`), ` from ${qm.critics.length} viewpoints${bl.length ? ` · blocking: ${bl.map((c) => c.name).join(', ')}` : ''} `,
        h('button', { class: 'btn sm ghost', type: 'button', id: 'open-critics', onClick: () => { state.view = 'critics'; try { localStorage.setItem('cs_view', 'critics'); } catch { /* */ } renderScriptPanel(); document.getElementById('critics-h')?.scrollIntoView(); } }, 'See every critic')));
    }
    const bars = h('ul', { class: 'q-bars', 'aria-label': 'Score by area' });
    for (const r of RUBRIC) {
      const v = qm.scores?.[r.id] ?? 0, pct = Math.round((v / r.max) * 100);
      bars.append(h('li', { title: r.what }, h('span', { class: 'k' }, r.label), h('span', { class: 'bar', 'aria-hidden': 'true' }, h('span', { class: `fill ${scoreCls(pct)} w${Math.round(pct / 5) * 5}` })), h('span', { class: 'v' }, `${v}/${r.max}`)));
    }
    card.append(bars);
    if (qm.failed?.length) card.append(h('div', { class: 'q-failed', role: 'note' }, h('strong', null, 'Must fix (automatic checks): '), h('ul', null, qm.failed.map((f) => h('li', null, `${f.label}: ${f.detail}`)))));
    if (qm.issues?.length) card.append(h('details', { class: 'q-issues', id: 'quality-issues' }, h('summary', null, `${qm.issues.length} remaining note${qm.issues.length > 1 ? 's' : ''} from the editor`),
      h('ul', null, qm.issues.map((i) => h('li', null, h('span', { class: `sev ${i.severity}` }, i.severity), ` ${i.clip ? `Clip ${i.clip}` : 'Whole script'} · ${i.problem} `, h('em', null, `Fix: ${i.fix}`))))));
  }
  const { model } = currentModel();
  card.append(h('div', { class: 'toolbar' },
    h('button', { class: 'btn primary', type: 'button', id: 'polish-btn', disabled: !!state.busy, onClick: () => startPolish(3) }, icon('star'), qm && qm.score >= TARGET_SCORE ? 'Polish again' : 'Polish to 95+'),
    h('button', { class: 'btn', type: 'button', id: 'score-btn', disabled: !!state.busy, onClick: () => startPolish(0) }, qm ? 'Re-score' : 'Score only'),
    h('span', { class: 'hint' }, `Model: ${model} · ${enabledCritics(state.user.settings).length} critics · about 2–7 AI calls`)));
  return card;
}

function renderScriptPanel() {
  const panel = state._panel; if (!panel) return;
  const focusId = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.id : null;
  const sel = focusId ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  clear(panel);
  panel.setAttribute('aria-busy', state.busy ? 'true' : 'false');
  const proj = state.project;
  if (state.busy === 'generate') {
    panel.append(h('h2', { id: 'script-h', class: 'sr-only', tabindex: '-1' }, 'Script'),
      h('div', { class: 'card empty', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }),
        h('p', null, 'Writing ', h('strong', null, `${state.brief.clipCount} clips`), '… this can take up to a minute with larger models.')),
      ...Array.from({ length: Math.min(3, state.brief.clipCount) }, () => h('div', { class: 'card skeleton', 'aria-hidden': 'true' })));
    return;
  }
  if (!proj?.script && state.brief.mode === 'reel') {
    panel.append(h('div', { class: 'card empty' },
      h('h2', { id: 'script-h', tabindex: '-1' }, 'Your faceless reel will appear here'),
      h('ol', { class: 'steps' },
        h('li', null, h('strong', null, 'Dump'), ' raw data: notes, stats, an article, a CSV, a transcript.'),
        h('li', null, h('strong', null, 'Randomize'), ' the angle, look and pacing, or set them yourself. Lock what you like.'),
        h('li', null, h('strong', null, 'Generate'), ': every clip gets a people-free ', h('em', null, 'image prompt'), ', a ', h('em', null, 'motion prompt'), ', ', h('em', null, 'voiceover'), ' within the word budget, and ', h('em', null, 'on-screen text'), '.')),
      h('a', { class: 'btn ghost', href: VE_URL, target: '_blank', rel: 'noopener noreferrer' }, icon('ext'), 'Open app.videoexpress.ai')));
    return;
  }
  if (!proj?.script) {
    panel.append(h('div', { class: 'card empty' },
      h('h2', { id: 'script-h', tabindex: '-1' }, 'Your clip script will appear here'),
      h('ol', { class: 'steps' },
        h('li', null, h('strong', null, 'Describe'), ' the video and pick 1–10 clips and a clip length.'),
        h('li', null, h('strong', null, 'Generate'), ' — you get a style sheet plus, for every clip, an ', h('em', null, 'image prompt'), ', a ', h('em', null, 'video/motion prompt'), ' and ', h('em', null, 'dialogue'), ' that fits the word budget.'),
        h('li', null, h('strong', null, 'Copy'), ' each part into VideoExpress: image → image-to-video → voiceover.')),
      h('a', { class: 'btn ghost', href: VE_URL, target: '_blank', rel: 'noopener noreferrer' }, icon('ext'), 'Open app.videoexpress.ai')));
    return;
  }
  const brief = state.brief;
  const script = proj.script;
  const a = analyzeScript(script, brief);
  const over = a.overClips.length;

  panel.append(h('div', { class: 'card script-head' },
    h('div', { class: 'sh-top' },
      h('div', null,
        brief.seriesId ? h('p', { class: 'crumb' }, h('a', { href: `#/series/${brief.seriesId}` }, `← Series · episode ${brief.episodeNo}`)) : null,
        h('h2', { id: 'script-h', tabindex: '-1' }, script.title),
        script.logline ? h('p', { class: 'muted' }, script.logline) : null),
      h('span', { id: 'save-state', class: 'hint', 'aria-live': 'polite' }, 'Saved')),
    h('div', { class: 'stats' },
      stat('Clips', `${script.clips.length}${a.clipCountMismatch ? ` (asked ${brief.clipCount})` : ''}`),
      stat('Video length', `${brief.layout === 'narration' ? a.totalSeconds : script.clips.length * brief.clipSeconds}s`),
      stat('Words', brief.dialogueMode === 'none' ? '—' : `${a.totalWords} / ${a.totalBudget}`),
      brief.layout === 'narration' ? stat('Clip length', `fits narration · max ${brief.clipSeconds}s`) : stat('Budget / clip', brief.dialogueMode === 'none' ? 'none' : `${a.budget} words · ${a.window}s`),
      stat('Over budget', String(over), over ? 'bad' : 'good'),
      proj.meta?.quality ? stat('Quality', `${proj.meta.quality.score}/100`, scoreCls(proj.meta.quality.score) === 'mid' ? '' : scoreCls(proj.meta.quality.score)) : null),
    proj.meta?.model ? h('p', { class: 'hint', id: 'gen-meta' }, `Generated with ${proj.meta.provider} · ${proj.meta.model}${proj.meta.usage ? ` · ${(proj.meta.usage.input + proj.meta.usage.output).toLocaleString()} tokens${(() => { const c = costOf(proj.meta.model, proj.meta.usage.input, proj.meta.usage.output, state.user.settings.priceOverrides); return c == null ? '' : ` ≈ ${formatUsd(c)}`; })()}` : ''}${proj.meta.fitPasses ? ` · auto-fit ×${proj.meta.fitPasses}` : ''}${proj.meta.trimmedClips?.length ? ` · ended early at a sentence break in clip ${proj.meta.trimmedClips.join(', ')}` : ''}`) : null,
    h('div', { class: 'toolbar' },
      over ? h('button', { class: 'btn warn', type: 'button', id: 'fit-btn', disabled: !!state.busy, onClick: fitAll }, icon('scissors'), state.busy === 'fit' ? 'Fitting…' : `Fit ${over} clip${over > 1 ? 's' : ''} to budget`) : null,
      h('button', { class: 'btn', type: 'button', onClick: () => copyText(toMarkdown(script, brief, proj.meta), 'Full script copied') }, icon('copy'), 'Copy all'),
      h('button', { class: 'btn', type: 'button', onClick: () => download(`${slug(script.title)}.md`, toMarkdown(script, brief, proj.meta), 'text/markdown') }, icon('download'), 'Markdown'),
      h('button', { class: 'btn', type: 'button', id: 'guide-md', onClick: () => download(`${slug(script.title)}-scripts-by-service.md`, guideMarkdown(script, brief), 'text/markdown') }, icon('download'), 'Scripts by service'),
      h('button', { class: 'btn', type: 'button', onClick: () => download(`${slug(script.title)}.csv`, toCsv(script, brief), 'text/csv') }, icon('download'), 'CSV'),
      h('button', { class: 'btn', type: 'button', onClick: () => download(`${slug(script.title)}.json`, JSON.stringify({ brief, script, meta: proj.meta }, null, 2), 'application/json') }, icon('download'), 'JSON'),
      h('label', { class: 'check sm' }, h('input', { type: 'checkbox', id: 'embedStyle', checked: state.embedStyle, onChange: (e) => { state.embedStyle = e.target.checked; renderScriptPanel(); } }), ' Embed style sheet in image prompts'))));

  panel.append(qualityCard(proj));
  panel.append(viewTabs());
  if (state.view === 'guide') { panel.append(guidePanel(script, brief)); restorePanelFocus(focusId, sel); return; }
  if (state.view === 'vepack') { panel.append(vePackPanel(script, brief)); restorePanelFocus(focusId, sel); return; }
  if (state.view === 'critics') { panel.append(criticsPanel(proj)); restorePanelFocus(focusId, sel); return; }
  const clipsBody = h('div', { id: 'view-body-clips', role: 'tabpanel', 'aria-labelledby': 'view-clips', class: 'clips-body' });
  panel.append(clipsBody);
  clipsBody.append(styleSheetCard(script));
  if (brief.layout === 'narration' && script.narration) clipsBody.append(h('details', { class: 'card stylesheet' },
    h('summary', null, h('h3', null, 'Full voiceover'), h('span', { class: 'hint' }, 'One continuous track for TTS: paste it once, then line up the clips')),
    h('p', { class: 'vo' }, script.narration),
    h('button', { class: 'btn sm', type: 'button', onClick: () => copyText(script.narration, 'Full voiceover copied') }, icon('copy'), 'Copy voiceover')));
  script.clips.forEach((c) => clipsBody.append(clipCard(c, a.clips[c.index - 1], a.clips[c.index - 1].budget)));

  restorePanelFocus(focusId, sel);
}
function restorePanelFocus(focusId, sel) {
  if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus({ preventScroll: true }); if (sel && el.setSelectionRange && sel[0] != null) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* */ } } }
}
function viewTabs() {
  const tab = (id, label, ic, hint) => h('button', { type: 'button', role: 'tab', id: `view-${id}`, class: `tab ${state.view === id ? 'on' : ''}`, 'aria-selected': state.view === id ? 'true' : 'false', 'aria-controls': state.view === id ? `view-body-${id}` : null, title: hint,
    onClick: () => { state.view = id; try { localStorage.setItem('cs_view', id); } catch { /* */ } renderScriptPanel(); document.getElementById(`view-${id}`)?.focus(); } }, icon(ic, 16), label);
  return h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'How to show the script' },
    tab('clips', 'Edit by clip', 'film', 'Everything for one clip together; edit prompts and lines'),
    tab('vepack', 'VideoExpress paste pack', 'copy', 'Scene by scene, in the exact boxes of VideoExpress → Create Video From Prompt'),
    tab('guide', 'Scripts by VideoExpress service', 'check', 'The scripts grouped by VideoExpress service: image → video → sound'),
    tab('critics', 'Critic panel', 'star', 'The script audited from 10 viewpoints; their notes feed Polish to 95+'));
}
/** The build criteria every analyzer, critic and repair must keep (frozen when the entry was generated). */
function lockedCard(spec) {
  const f = spec?.features || [];
  return h('details', { class: 'card locked', id: 'locked-criteria' },
    h('summary', null, h('h4', { class: 'inline' }, `🔒 Locked build criteria (${f.length || 'set on first polish'})`), h('span', { class: 'hint' }, ' · the analyzer, every critic and the repairer must keep these')),
    f.length ? h('ul', { class: 'locked-list' }, f.map((x) => h('li', { id: `locked-${x.id}` }, h('strong', null, x.label), h('span', { class: 'hint' }, ` ${x.rule}`)))) : h('p', { class: 'hint' }, 'Older entry: the criteria are frozen from the brief and the current script the first time it is scored.'),
    h('p', { class: 'hint' }, 'Enforced in code too: after every repair, anything dropped is put back from the previous version; a repair that still breaks a locked feature is rejected and the best version is kept. No human review needed.'));
}
const critCls = (x) => (x >= 8 ? 'good' : x >= VETO_BELOW ? 'mid' : 'bad');
/** Critic panel: the script audited from many viewpoints. Runs inside Polish to 95+ (and Score only). */
function criticsPanel(proj) {
  const qm = proj.meta?.quality;
  const running = state.busy === 'polish';
  const on = new Set(enabledCritics(state.user.settings));
  const wrap = h('div', { id: 'view-body-critics', role: 'tabpanel', 'aria-labelledby': 'view-critics', class: 'critics' });
  const crit = qm?.critics || [];
  const avg = qm?.criticAvg;
  const spec = proj.meta?.buildSpec;
  const blocking = crit.filter((c) => c.score < VETO_BELOW);
  wrap.append(h('div', { class: 'card guide-top' },
    h('div', { class: 'q-head' },
      h('div', null, h('h3', { id: 'critics-h' }, 'Critic panel'),
        h('p', { class: 'hint' }, `${on.size} critics audit the script from their own viewpoint every time it is scored. Their notes go straight into the Repair step of Polish to 95+, and their average counts for 20% of the score. A critic below ${VETO_BELOW}/10 blocks 95+ until it is fixed.`)),
      avg != null && !running ? h('div', { class: `q-score ${critCls(avg)}`, id: 'critics-avg' }, h('strong', null, String(avg)), h('span', null, `/10 avg${blocking.length ? ` · ${blocking.length} blocking` : ''}`)) : null),
    running ? h('p', { class: 'hint', role: 'status' }, h('span', { class: 'spinner sm', 'aria-hidden': 'true' }), ' The critics are auditing… progress is shown in Script quality above.')
      : h('div', { class: 'toolbar' },
        h('button', { class: 'btn primary', type: 'button', id: 'critics-polish', disabled: !!state.busy, onClick: () => startPolish(3) }, icon('star'), 'Polish to 95+ with the critics'),
        h('button', { class: 'btn', type: 'button', id: 'critics-run', disabled: !!state.busy, onClick: () => startPolish(0) }, crit.length ? 'Re-run critics (no changes)' : 'Run critics (no changes)')),
    h('details', { class: 'critic-pick', id: 'critic-pick' }, h('summary', null, `Choose critics (${on.size} of ${CRITICS.length} on)`),
      h('div', { class: 'critic-toggles' }, CRITICS.map((c) => h('label', { class: 'check sm', title: c.asks },
        h('input', { type: 'checkbox', id: `critic-on-${c.id}`, checked: on.has(c.id), disabled: running || (on.size === 1 && on.has(c.id)), onChange: async (e) => {
          const off = CRITICS.map((x) => x.id).filter((id) => (id === c.id ? !e.target.checked : !on.has(id)));
          try { await saveSettings({ criticsOff: off }); renderScriptPanel(); document.getElementById(`critic-on-${c.id}`)?.focus(); document.getElementById('critic-pick')?.setAttribute('open', ''); } catch (err) { toast(err.message, 'error'); }
        } }), ` ${c.icon} ${c.name}`))),
      h('p', { class: 'hint' }, 'Changes apply the next time the script is scored or polished.'))));
  wrap.append(lockedCard(spec));
  if (!crit.length) {
    wrap.append(h('div', { class: 'card empty' }, h('p', null, running ? 'Waiting for the first verdicts…' : 'No verdicts yet. Run the critics or Polish to 95+ to hear from the panel.'),
      h('ul', { class: 'critic-list-preview' }, CRITICS.filter((c) => on.has(c.id)).map((c) => h('li', null, h('strong', null, `${c.icon} ${c.name}: `), c.focus)))));
    return wrap;
  }
  if (qm.reason) wrap.append(h('p', { class: 'q-failed', role: 'note', id: 'critics-reason' }, h('strong', null, 'Blocking 95+: '), qm.reason));
  if (qm.ignored?.length) wrap.append(h('details', { class: 'card q-issues', id: 'critics-ignored' }, h('summary', null, `${qm.ignored.length} note${qm.ignored.length > 1 ? 's' : ''} ignored (would undo a locked build feature or need a human)`),
    h('ul', null, qm.ignored.map((n) => { const f = spec?.features?.find((x) => x.id === n.lockedBy); return h('li', null, `${n.critic ? `${n.critic}: ` : 'Editor: '}“${n.fix || n.problem}” `, h('em', null, `blocked by 🔒 ${f?.label || n.lockedBy}`)); }))));
  const grid = h('div', { class: 'critic-grid' });
  for (const c of [...crit].sort((a, b) => a.score - b.score)) {
    const def = CRITICS.find((x) => x.id === c.id);
    grid.append(h('article', { class: `card critic ${critCls(c.score)}`, id: `critic-${c.id}`, 'aria-labelledby': `critic-${c.id}-h` },
      h('div', { class: 'critic-top' },
        h('h4', { id: `critic-${c.id}-h` }, h('span', { 'aria-hidden': 'true' }, `${c.icon} `), c.name),
        h('span', { class: `critic-score ${critCls(c.score)}`, 'aria-label': `${c.score} out of 10` }, `${c.score}/10`)),
      c.score < VETO_BELOW ? h('span', { class: 'sev high' }, 'blocking') : null,
      h('p', { class: 'critic-verdict' }, c.verdict ? `“${c.verdict}”` : ''),
      c.notes.length ? h('ul', { class: 'critic-notes' }, c.notes.map((n) => h('li', null, h('span', { class: `sev ${n.severity}` }, n.severity), ` ${n.clip ? `Clip ${n.clip}` : 'Whole script'} · ${n.problem} `, n.fix ? h('em', null, `Fix: ${n.fix}`) : null)))
        : h('p', { class: 'hint' }, 'No notes.'),
      def ? h('p', { class: 'hint critic-focus' }, def.focus) : null));
  }
  wrap.append(grid);
  return wrap;
}
/** Copy-paste pack for VideoExpress → Create Video From Prompt: one card per scene, one Copy per box. */
function vePackPanel(script, brief) {
  const ve = normalizeVeSettings(state.user.settings.ve);
  const pack = buildVePack(script, brief, ve);
  script.buildProgress ||= {};
  const done = script.buildProgress;
  const wrap = h('div', { id: 'view-body-vepack', role: 'tabpanel', 'aria-labelledby': 'view-vepack', class: 'guide vepack' });
  const md = () => vePackMarkdown(pack);
  const file = `${slug(script.title)}-videoexpress-pack.md`;
  const doneCount = () => pack.scenes.filter((s) => done[`ve-${s.id}`]).length;
  const progress = h('span', { class: 'hint', id: 've-progress', 'aria-live': 'polite' });
  const bar = h('span');
  const paint = () => { const n = doneCount(); progress.textContent = `${n} of ${pack.scenes.length} scenes made in VideoExpress`; bar.style.width = `${pack.scenes.length ? Math.round((n / pack.scenes.length) * 100) : 0}%`; };
  paint();
  wrap.append(h('div', { class: 'card guide-top' },
    h('div', { class: 'guide-top-row' }, h('h3', null, 'VideoExpress paste pack'), progress),
    h('p', { class: 'hint' }, `For VideoExpress → Create with AI → Create Video From Prompt · ${pack.scenes.length} scenes · about ${pack.totalSeconds}s · ${pack.orientation} · Image Type ${pack.imageType}${pack.voice ? ` · voice ${pack.voice.label}` : ''}`),
    h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Scenes made', 'aria-valuemin': 0, 'aria-valuemax': pack.scenes.length, 'aria-valuenow': doneCount() }, bar),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary sm', type: 'button', id: 've-copy-all', onClick: () => copyText(md(), 'Whole paste pack copied') }, icon('copy'), 'Copy whole pack'),
      h('button', { class: 'btn sm', type: 'button', id: 've-download', onClick: () => { download(file, md(), 'text/markdown'); toast(`Downloading ${file}`, 'ok'); } }, icon('download'), 'Download pack'),
      h('a', { class: 'btn ghost sm', href: VE_URL, target: '_blank', rel: 'noopener noreferrer' }, icon('ext'), 'Open VideoExpress'))));

  // Pack settings (saved to the account so every project and series uses the same voice)
  const f = { ...ve };
  const inp = (id, label, key, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { id, value: f[key], maxlength: 80, onInput: (e) => { f[key] = e.target.value; } }), hint ? h('p', { class: 'hint' }, hint) : null);
  wrap.append(h('details', { class: 'card ve-settings', id: 've-settings' },
    h('summary', null, h('h3', null, 'Voice & picture settings'), h('span', { class: 'hint' }, `Same for every video: ${pack.voice ? pack.voice.label : ve.voice} · Image Type ${ve.imageType}`)),
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('label', { for: 've-tab' }, 'Voice comes from'), h('select', { id: 've-tab', onChange: (e) => { f.voiceTab = e.target.value; } }, VE_VOICE_TABS.map((t) => h('option', { value: t, selected: t === f.voiceTab ? true : null }, t)))),
      inp('ve-voice', 'Voice name (exactly as VideoExpress shows it)', 'voice', 'Pick it once in VideoExpress and use it for every scene. Default: Lucas Rhodes.'),
      inp('ve-category', 'CloneVoice category', 'category'),
      inp('ve-language', 'Language', 'language'),
      h('div', { class: 'field' }, h('label', { for: 've-imgtype' }, 'Image Type'), h('select', { id: 've-imgtype', onChange: (e) => { f.imageType = e.target.value; } }, VE_IMAGE_TYPES.map((t) => h('option', { value: t, selected: t === f.imageType ? true : null }, t === 'auto' ? `auto (from the style: ${buildVePack(script, brief, { ...ve, imageType: 'auto' }).imageType})` : t)))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 've-enhance', checked: f.autoEnhance, onChange: (e) => { f.autoEnhance = e.target.checked; } }), ' Tell me to turn on “Automatically enhance my image prompt”')),
    h('div', { class: 'toolbar' }, h('button', { class: 'btn sm', type: 'button', id: 've-save', onClick: async () => { try { await saveSettings({ ve: f }); toast('Pack settings saved', 'ok'); renderScriptPanel(); } catch (e) { toast(e.message, 'error'); } } }, 'Save settings'))));

  const field = (label, text, aria, extra) => h('div', { class: 've-field' },
    h('div', { class: 'gi-head' }, h('strong', null, label), extra || null,
      h('button', { class: 'btn sm', type: 'button', 'aria-label': `Copy ${aria}`, onClick: () => copyText(text, `${aria} copied`) }, icon('copy'), 'Copy')),
    h('pre', { class: 'gi-text' }, text));

  // 1 · Set up once
  wrap.append(h('section', { class: 'card guide-sec', 'aria-labelledby': 've-setup-h' },
    h('div', { class: 'guide-head' }, h('span', { class: 'clip-num', 'aria-hidden': 'true' }, '1'), h('div', null, h('h3', { id: 've-setup-h' }, 'Set up once'), h('p', { class: 'hint' }, 'Do this when you open Create Video From Prompt.'))),
    h('ol', { class: 've-steps' }, pack.setup.map((s) => h('li', null, s))),
    pack.voice ? h('div', { class: 've-voice' }, h('h4', null, 'Narrator voice: the same in every scene'), h('ul', null, pack.voice.steps.map((s) => h('li', null, s))),
      h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': 'Copy voice name', onClick: () => copyText(ve.voice, 'Voice name copied') }, icon('copy'), `Copy “${ve.voice}”`)) : null));

  // 2 · Characters
  if (pack.characters.length) {
    wrap.append(h('section', { class: 'card guide-sec', 'aria-labelledby': 've-chars-h' },
      h('div', { class: 'guide-head' }, h('span', { class: 'clip-num', 'aria-hidden': 'true' }, '2'), h('div', null, h('h3', { id: 've-chars-h' }, 'Characters: make these pictures first'),
        h('p', { class: 'hint' }, 'For each one: untick “Use Consistent Character” → paste into Image Prompt → Create Image → hover the best picture → Save Image (goes to “My AI Images”). Then tick “Use Consistent Character” and put the picture in Reference Photo.'))),
      ...pack.characters.map((c, i) => h('div', { class: 'guide-item' }, field(`${c.id} · ${c.name}${i < 2 ? ` → ${i === 0 ? 'Reference Photo' : 'Reference Photo 2'}` : ''}`, c.refPrompt, `${c.name} character picture prompt`), c.voice ? h('p', { class: 'hint' }, `Voice: ${c.voice}`) : null))));
  }
  if (pack.warnings.length) wrap.append(h('div', { class: 'card warnbox', role: 'note' }, pack.warnings.map((w) => h('p', null, w))));

  // 3 · Scenes
  const sec = h('section', { class: 'card guide-sec', 'aria-labelledby': 've-scenes-h' },
    h('div', { class: 'guide-head' }, h('span', { class: 'clip-num', 'aria-hidden': 'true' }, pack.characters.length ? '3' : '2'), h('div', null, h('h3', { id: 've-scenes-h' }, `Scenes (${pack.scenes.length})`),
      h('p', { class: 'hint' }, 'Top to bottom, one scene at a time. The [SC-…] tag shows in the VideoExpress Media Library, so you always know which clip is which.'))));
  for (const s of pack.scenes) {
    const key = `ve-${s.id}`;
    const card = h('article', { class: `guide-item ve-scene ${done[key] ? 'done' : ''}`, id: `ve-${s.id}`, 'aria-labelledby': `ve-${s.id}-h` });
    const cb = h('input', { type: 'checkbox', id: `ve-done-${s.id}`, checked: !!done[key], onChange: (e) => {
      editScript((sc) => { sc.buildProgress ||= {}; if (e.target.checked) sc.buildProgress[key] = true; else delete sc.buildProgress[key]; });
      card.classList.toggle('done', e.target.checked); paint();
    } });
    const routeLabel = s.route === 'narration' ? 'Narration' : s.route === 'lipsync' ? 'Lipsync · on camera' : 'No voice';
    card.append(...[
      h('div', { class: 'gi-head' }, h('h4', { id: `ve-${s.id}-h` }, `${s.id} · Clip ${s.clip}${s.part ? ` (part ${s.part})` : ''}${s.beat ? ` · ${s.beat}` : ''}`),
        h('span', { class: `chip ${s.route}` }, `${routeLabel} · ~${s.seconds}s`),
        h('label', { class: 'check sm', for: `ve-done-${s.id}` }, cb, ' Made')),
      s.refs.length ? h('p', { class: 'hint' }, `Use Consistent Character ON · ${s.refs.map((r) => `${r.slot}: ${r.name}`).join(' · ')}${s.refs.length < 2 ? ' · Reference Photo 2: empty' : ''}`) : null,
      s.reuseImageOf ? h('p', { class: 'hint' }, `Same picture as ${s.reuseImageOf}: select it again in the carousel (or paste the prompt below).`) : null,
      field('① Image Prompt → Create Image → click the newest picture', s.imagePrompt, `${s.id} image prompt`),
      field(`② ${s.route === 'narration' ? 'Video Prompt' : 'Video and Audio Prompt'} → Create Video`, s.videoPrompt, `${s.id} video prompt`)].filter(Boolean));
    if (s.route === 'narration') card.append(field('③ Narration → Import Speech → Create Narration Video', s.narration, `${s.id} narration`,
      h('span', { class: `chip ${s.chars > VE_LIMITS.NARRATION_MAX ? 'bad' : 'good'}` }, `${s.chars}/${VE_LIMITS.NARRATION_MAX}`)));
    if (s.route === 'lipsync') {
      card.append(field('③ Create Lipsync Audio → Video Prompt', s.actorPrompt, `${s.id} lipsync video prompt`));
      s.actors.forEach((a, i) => card.append(field(`${i === 0 ? '④' : '⑤'} ${a.label} (${a.speaker})${i === s.actors.length - 1 ? ' → Create' : ''}`, a.script, `${s.id} ${a.label}`,
        i === 0 ? h('span', { class: `chip ${s.chars > VE_LIMITS.LIPSYNC_MAX ? 'bad' : 'good'}` }, `${s.chars}/${VE_LIMITS.LIPSYNC_MAX} total`) : null)));
      if (s.actors.length > 1) card.append(h('p', { class: 'hint' }, 'Click “Add Actor 2” for the second script.'));
    }
    const notes = [s.onScreenText && `On-screen text (add in the editor): ${s.onScreenText}`, s.sfx && s.route !== 'silent' && `Sound idea (optional, in the editor): ${s.sfx}`].filter(Boolean);
    if (notes.length) card.append(h('p', { class: 'hint' }, notes.join(' · ')));
    sec.append(card);
  }
  wrap.append(sec);
  wrap.append(h('p', { class: 'hint ve-finish' }, 'Finish: Media Library → My AI Videos → drag the clips onto the timeline in SC order (read the [SC-…] tag in each caption).'));
  return wrap;
}
/** Script regrouped into sections that match the VideoExpress build, with saved progress checkboxes. */
function guidePanel(script, brief) {
  const g = buildGuide(script, brief, { embedStyle: state.embedStyle });
  script.buildProgress ||= {};
  const done = script.buildProgress;
  const wrap = h('div', { id: 'view-body-guide', role: 'tabpanel', 'aria-labelledby': 'view-guide', class: 'guide' });
  const overall = h('div', { class: 'card guide-top' });
  const paintTop = () => {
    const p = guideProgress(g, done);
    clear(overall).append(
      h('div', { class: 'guide-top-row' }, h('h3', null, 'Pasted into VideoExpress'), h('span', { class: 'hint', id: 'guide-progress', 'aria-live': 'polite' }, `${p.done} of ${p.total} scripts pasted`)),
      h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Scripts pasted', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': p.pct }, (() => { const sp = h('span'); sp.style.width = `${p.pct}%`; return sp; })()),
      h('ol', { class: 'guide-jump' }, g.sections.map((s) => { const sp = p.sections[s.id]; return h('li', { class: sp.done === sp.total ? 'complete' : '' }, h('a', { href: `#guide-${s.id}`, onClick: (e) => { e.preventDefault(); document.getElementById(`guide-${s.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, `${s.title}`), h('span', { class: 'hint' }, ` ${sp.done}/${sp.total}`)); })),
      h('div', { class: 'toolbar' }, h('a', { class: 'btn ghost sm', href: VE_URL, target: '_blank', rel: 'noopener noreferrer' }, icon('ext'), 'Open VideoExpress'),
        p.done ? h('button', { class: 'btn ghost sm', type: 'button', id: 'guide-reset', onClick: () => { if (!confirm('Clear all checkmarks?')) return; editScript((s) => { s.buildProgress = {}; }, true); } }, 'Reset checklist') : null));
  };
  paintTop();
  wrap.append(overall);
  for (const s of g.sections) {
    const sp = () => guideProgress(g, done).sections[s.id];
    const count = h('span', { class: 'chip', id: `guide-${s.id}-count` }, `${sp().done}/${sp().total}`);
    const sec = h('section', { class: 'card guide-sec', id: `guide-${s.id}`, 'aria-labelledby': `guide-${s.id}-h` },
      h('div', { class: 'guide-head' }, h('span', { class: 'clip-num', 'aria-hidden': 'true' }, String(s.no)),
        h('div', null, h('h3', { id: `guide-${s.id}-h` }, s.title, h('span', { class: 'tool' }, ` · ${s.tool}`)), h('p', { class: 'hint' }, s.what)), count));
    const copyAllText = s.items.map((it) => `${it.label}\n${it.text}`).join('\n\n');
    if (s.items.length > 1) sec.append(h('button', { class: 'btn sm ghost copy-all', type: 'button', 'aria-label': `Copy all ${s.title.toLowerCase()}`, onClick: () => copyText(copyAllText, `${s.title}: all copied`) }, icon('copy'), 'Copy all'));
    for (const it of s.items) {
      const cb = h('input', { type: 'checkbox', id: `gd-${it.key}`, checked: !!done[it.key], onChange: (e) => {
        editScript((sc) => { sc.buildProgress ||= {}; if (e.target.checked) sc.buildProgress[it.key] = true; else delete sc.buildProgress[it.key]; });
        row.classList.toggle('done', e.target.checked); count.textContent = `${sp().done}/${sp().total}`; paintTop();
      } });
      const row = h('div', { class: `guide-item ${done[it.key] ? 'done' : ''} ${it.warn ? 'warn' : ''}` },
        h('div', { class: 'gi-head' },
          h('label', { class: 'check', for: `gd-${it.key}` }, cb, h('strong', null, it.label)),
          it.text ? h('button', { class: 'btn sm', type: 'button', 'aria-label': `Copy ${it.label}`, onClick: () => { copyText(it.text, `${it.label} copied`); } }, icon('copy'), 'Copy') : null),
        it.meta ? h('p', { class: `hint ${it.warn ? 'warn' : ''}` }, it.meta) : null,
        it.rows ? timelineTable(it.rows) : it.text ? h('pre', { class: 'gi-text' }, it.text) : null);
      sec.append(row);
    }
    wrap.append(sec);
  }
  return wrap;
}
function timelineTable(rows) {
  const t = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  return h('div', { class: 'table-wrap' }, h('table', { class: 'plan timeline' }, h('caption', { class: 'sr-only' }, 'Timeline'),
    h('thead', null, h('tr', null, ...['Time', 'Clip', 'Voiceover', 'On-screen text', 'SFX'].map((x) => h('th', { scope: 'col' }, x)))),
    h('tbody', null, rows.map((r) => h('tr', null, h('td', { class: 'num' }, `${t(r.start)}–${t(r.end)}`), h('td', null, `${r.clip}${r.beat ? ` · ${r.beat}` : ''}${r.extend ? ' ⚠ extend' : ''}`), h('td', null, r.line), h('td', null, r.onScreenText), h('td', null, r.sfx))))));
}
const stat = (k, v, cls) => h('div', { class: `stat ${cls || ''}` }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));

function editScript(mutator, rerender = false) {
  mutator(state.project.script);
  scheduleSave();
  if (rerender) renderScriptPanel();
}

function styleSheetCard(script) {
  const ss = script.styleSheet;
  const f = (id, label, key) => h('div', { class: 'field' }, h('label', { for: id }, label),
    h('textarea', { id, rows: 2, value: ss[key], maxlength: 1500, onInput: (e) => editScript((s) => { s.styleSheet[key] = e.target.value; }) }));
  return h('details', { class: 'card stylesheet', open: true },
    h('summary', null, h('h3', null, 'Style sheet'), h('span', { class: 'hint' }, 'Keeps characters and look consistent across all clips')),
    h('div', { class: 'row2' }, f('ss-visual', 'Visual style', 'visualStyle'), f('ss-setting', 'Setting', 'setting')),
    h('div', { class: 'row2' }, f('ss-palette', 'Palette', 'palette'), f('ss-camera', 'Camera', 'camera')),
    ss.characters.length ? h('h4', null, 'Characters') : null,
    ss.characters.map((ch, i) => h('div', { class: 'char' },
      h('div', { class: 'field' }, h('label', { for: `ch-name-${i}` }, 'Name'), h('input', { id: `ch-name-${i}`, value: ch.name, maxlength: 60, onInput: (e) => editScript((s) => { s.styleSheet.characters[i].name = e.target.value; }) })),
      h('div', { class: 'field grow' }, h('label', { for: `ch-desc-${i}` }, 'Fixed look'), h('textarea', { id: `ch-desc-${i}`, rows: 2, value: ch.description, maxlength: 1200, onInput: (e) => editScript((s) => { s.styleSheet.characters[i].description = e.target.value; }) })),
      h('div', { class: 'field' }, h('label', { for: `ch-voice-${i}` }, 'Voice'), h('input', { id: `ch-voice-${i}`, value: ch.voice, maxlength: 200, onInput: (e) => editScript((s) => { s.styleSheet.characters[i].voice = e.target.value; }) })),
      h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': `Copy character sheet for ${ch.name || 'character'}`, onClick: () => copyText(`${ch.name}: ${ch.description}. ${ss.visualStyle}`, 'Character sheet copied') }, icon('copy')))));
}

function meter(f, idp) {
  const { spokenWords: words, budget, seconds, window, status } = f;
  // bar = whichever limit is closer to being hit (words or seconds)
  const ratio = Math.max(budget ? words / budget : (words ? 1 : 0), window ? seconds / window : 0);
  const pct = Math.min(100, Math.round(ratio * 100));
  const label = status === 'over' ? 'too long, will be cut off' : status === 'empty' ? 'no dialogue' : status === 'tight' ? 'tight fit' : 'fits';
  return h('div', { class: `meter ${status}`, id: `${idp}-meter` },
    h('div', { class: 'meter-bar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': `Dialogue uses ${pct}% of the clip's speaking time` }, h('span', { style: null, dataset: { pct } })),
    h('span', { class: 'meter-text' }, h('strong', null, `${words}/${budget}`), ' words · ', h('strong', null, `~${seconds}s/${window}s`), ` speech · ${label}`),
    f.reasons?.length ? h('span', { class: 'meter-why' }, f.reasons.join(' · ')) : null,
    f.expansions?.length ? h('span', { class: 'meter-why subtle', title: 'How a voice will read these' }, 'Read aloud as: ', f.expansions.slice(0, 4).map((e) => `${e.from} → "${e.to}"`).join(', ')) : null);
}

function clipCard(c, ca, budget) {
  const brief = state.brief;
  const id = `clip-${c.index}`;
  const composed = composeImagePrompt(c, state.project.script.styleSheet, brief, { embedStyle: state.embedStyle });
  const meterSlot = h('div', { class: 'meter-slot' }, meter(ca, id));
  const updateMeter = () => {
    const l = clipLimits(c, brief);
    const f = clipFit(c, brief, l.budget, l.window);
    clear(meterSlot).append(meter(f, id));
    card.dataset.status = f.status; paintMeters(card);
  };
  const lines = h('div', { class: 'lines' });
  const drawLines = () => {
    clear(lines);
    c.dialogue.forEach((l, i) => {
      lines.append(h('div', { class: 'line' },
        h('input', { id: `${id}-spk-${i}`, class: 'spk', value: l.speaker, maxlength: 60, 'aria-label': `Clip ${c.index} line ${i + 1} speaker`, onInput: (e) => editScript(() => { l.speaker = e.target.value; }) }),
        h('textarea', { id: `${id}-line-${i}`, rows: 2, value: l.line, maxlength: 1000, 'aria-label': `Clip ${c.index} line ${i + 1} text (${countWords(l.line)} words)`, onInput: (e) => { editScript(() => { l.line = e.target.value; }); updateMeter(); } }),
        h('button', { class: 'btn ghost icon-only sm', type: 'button', 'aria-label': `Remove line ${i + 1} from clip ${c.index}`, onClick: () => { editScript(() => { c.dialogue.splice(i, 1); }); drawLines(); updateMeter(); } }, icon('trash'))));
    });
  };
  drawLines();

  const regenIn = h('input', { id: `${id}-regen`, placeholder: 'Optional direction, e.g. "make it funnier" or "close-up instead"', maxlength: 1000, 'aria-label': `Direction for rewriting clip ${c.index}` });
  const card = h('article', { class: 'card clip', id, 'aria-labelledby': `${id}-h`, dataset: { status: ca.status } },
    h('div', { class: 'clip-head' },
      h('span', { class: 'clip-num', 'aria-hidden': 'true' }, String(c.index).padStart(2, '0')),
      h('h3', { id: `${id}-h` }, h('span', { class: 'sr-only' }, `Clip ${c.index}: `), c.beat || `Clip ${c.index}`),
      c.continued ? h('span', { class: 'chip' }, 'continues') : null,
      h('span', { class: 'chip' }, `${c.durationSeconds}s`)),
    c.flag === 'extend' ? h('p', { class: 'hint warn' }, `This narration needs more than ${brief.clipSeconds}s. Use VideoExpress's Video Length Increaser on this clip (nothing was cut).`) : null,
    block(`${id}-img`, 'image', c.lastFramePrompt ? '1 · First frame (image prompt)' : '1 · Image prompt', 'Paste into VideoExpress text-to-image', composed, c.imagePrompt, (v) => editScript(() => { c.imagePrompt = v; })),
    c.lastFramePrompt ? block(`${id}-last`, 'image', '1b · Last frame (image prompt)', 'For First & Last Frame image-to-video: generate this image too', composeLastFramePrompt(c, state.project.script.styleSheet, brief, { embedStyle: state.embedStyle }), c.lastFramePrompt, (v) => editScript(() => { c.lastFramePrompt = v; })) : null,
    block(`${id}-vid`, 'film', '2 · Video (motion prompt)', c.lastFramePrompt ? 'Paste into First & Last Frame with both images' : 'Paste into image-to-video with the image above', c.videoPrompt, c.videoPrompt, (v) => editScript(() => { c.videoPrompt = v; })),
    h('section', { class: 'part', 'aria-labelledby': `${id}-dlg-h` },
      h('div', { class: 'part-head' }, icon('mic'), h('h4', { id: `${id}-dlg-h` }, '3 · Sound: dialogue / voiceover'),
        h('button', { class: 'btn sm', type: 'button', 'aria-label': `Copy dialogue for clip ${c.index}`, disabled: !c.dialogue.length, onClick: () => copyText(dialogueText(c), `Clip ${c.index} dialogue copied`) }, icon('copy'), 'Copy')),
      meterSlot, lines,
      brief.dialogueMode !== 'none' ? h('button', { class: 'btn ghost sm', type: 'button', onClick: () => { editScript(() => { c.dialogue.push({ speaker: c.dialogue.at(-1)?.speaker || 'Narrator', line: '' }); }); drawLines(); updateMeter(); document.getElementById(`${id}-line-${c.dialogue.length - 1}`)?.focus(); } }, icon('plus'), 'Add line') : null),
    h('div', { class: 'row2 extras' },
      h('div', { class: 'field' }, h('label', { for: `${id}-ost` }, 'On-screen text'), h('input', { id: `${id}-ost`, value: c.onScreenText, maxlength: 200, onInput: (e) => editScript(() => { c.onScreenText = e.target.value; }) })),
      h('div', { class: 'field' }, h('label', { for: `${id}-sfx` }, 'Sound: music / SFX'), h('input', { id: `${id}-sfx`, value: c.sfx, maxlength: 300, onInput: (e) => editScript(() => { c.sfx = e.target.value; }) }))),
    h('div', { class: 'regen' }, regenIn,
      h('button', { class: 'btn sm', type: 'button', id: `${id}-regen-btn`, disabled: !!state.busy, onClick: () => regenerateClip(c.index, regenIn.value) }, icon('refresh'), state.busy === `regen-${c.index}` ? 'Rewriting…' : 'Rewrite clip')));
  paintMeters(card);
  return card;
}
// CSP forbids inline styles; set widths via CSSOM (allowed).
function paintMeters(root) { root.querySelectorAll('.meter-bar span').forEach((s) => { s.style.width = `${s.dataset.pct}%`; }); }

function block(id, ic, title, help, copyValue, editValue, onEdit) {
  const ta = h('textarea', { id, rows: 4, value: editValue, maxlength: 3000, 'aria-describedby': `${id}-help`, onInput: (e) => onEdit(e.target.value) });
  return h('section', { class: 'part', 'aria-labelledby': `${id}-h` },
    h('div', { class: 'part-head' }, icon(ic), h('h4', { id: `${id}-h` }, title),
      h('button', { class: 'btn sm', type: 'button', 'aria-label': `Copy ${title.replace(/^\d+b? · /, '').toLowerCase()}`, onClick: () => {
        const val = id.endsWith('-img') || id.endsWith('-last') ? composeImagePrompt({ imagePrompt: ta.value }, state.project.script.styleSheet, state.brief, { embedStyle: state.embedStyle }) : ta.value;
        copyText(val, 'Prompt copied');
      } }, icon('copy'), 'Copy')),
    h('label', { for: id, class: 'sr-only' }, title), ta,
    h('p', { class: 'hint', id: `${id}-help` }, help, (id.endsWith('-img') || id.endsWith('-last')) && state.embedStyle ? ' (copy includes style sheet + character looks)' : ''),
    copyValue !== editValue ? null : null);
}

async function fitAll() {
  const { provider, model } = currentModel();
  state.busy = 'fit'; renderScriptPanel();
  try {
    const r = await api('/api/fit', { method: 'POST', body: { brief: state.brief, script: state.project.script, provider, model } });
    state.project.script = r.script; scheduleSave();
    toast(r.analysis.overClips.length ? `Clip(s) ${r.analysis.overClips.join(', ')} are still too long. Edit by hand or try again.` : `All clips now fit their word budget and speaking time.${r.trimmedClips?.length ? ` Clip ${r.trimmedClips.join(', ')} was ended at a sentence break.` : ''}`, r.analysis.overClips.length ? 'warn' : 'ok');
  } catch (e) { toast(e.message, 'error'); }
  state.busy = null; renderScriptPanel();
}

async function regenerateClip(index, instruction) {
  const { provider, model } = currentModel();
  state.busy = `regen-${index}`; renderScriptPanel();
  try {
    const r = await api('/api/regenerate-clip', { method: 'POST', body: { brief: state.brief, script: state.project.script, index, instruction, provider, model } });
    state.project.script = r.script; scheduleSave();
    const ca = r.analysis.clips[index - 1];
    toast(ca.status === 'over' ? `Clip ${index} rewritten but is still too long: ${ca.reasons.join('; ')}.` : `Clip ${index} rewritten.`, ca.status === 'over' ? 'warn' : 'ok');
  } catch (e) { toast(e.message, 'error'); }
  state.busy = null; renderScriptPanel();
  document.getElementById(`clip-${index}-h`)?.scrollIntoView({ block: 'start' });
}

// ---------- projects ----------
function projectsView() {
  const wrap = h('section', { class: 'narrow', 'aria-labelledby': 'proj-h' },
    h('div', { class: 'page-head' }, h('h1', { id: 'proj-h' }, 'Projects'), h('button', { class: 'btn primary', type: 'button', onClick: () => { ensureMode('story'); newProject(); go('studio'); } }, icon('plus'), 'New project')));
  const list = h('div', { class: 'card', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), ' Loading projects…');
  wrap.append(list);
  (async () => {
    try {
      const { projects } = await api('/api/projects');
      clear(list).removeAttribute('role');
      if (!projects.length) { list.append(h('p', { class: 'muted' }, 'No projects yet. Generate your first script in the Studio.')); return; }
      list.className = 'plist';
      for (const p of projects) {
        list.append(h('div', { class: 'card prow' },
          h('div', null, h('h2', { class: 'ptitle' }, h('a', { href: '#/studio', onClick: (e) => { e.preventDefault(); openProject(p.id); } }, p.title)),
            h('p', { class: 'hint' }, p.mode === 'reel' ? h('span', { class: 'badge' }, 'Faceless reel') : null, `${p.clips} clips · ${p.model || 'draft'} · updated ${new Date(p.updatedAt).toLocaleString()}`)),
          h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': `Delete project ${p.title}`, onClick: async () => {
            if (!confirm(`Delete "${p.title}"? This cannot be undone.`)) return;
            try { await api(`/api/projects/${p.id}`, { method: 'DELETE' }); if (state.project?.id === p.id) state.project = null; toast('Project deleted', 'ok'); render(); } catch (e) { toast(e.message, 'error'); }
          } }, icon('trash'))));
      }
    } catch (e) {
      clear(list).append(h('p', { class: 'form-error', role: 'alert' }, e.message), h('button', { class: 'btn', type: 'button', onClick: render }, icon('refresh'), 'Retry'));
    }
  })();
  return wrap;
}
async function openProject(id) {
  try {
    const { project } = await api(`/api/projects/${id}`);
    const nb = normalizeBrief(project.brief); ensureMode(nb.mode); state.project = project; state.brief = nb; state.error = null; go(`${nb.mode === 'reel' ? 'reels' : 'studio'}/${project.id}`);
    resumePolish(project.id);
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- settings ----------
function settingsView() {
  const wrap = h('section', { class: 'narrow', 'aria-labelledby': 'set-h' }, h('div', { class: 'page-head' }, h('h1', { id: 'set-h' }, 'Settings')));
  wrap.append(h('section', { class: 'card', 'aria-labelledby': 'def-h' },
    h('h2', { id: 'def-h' }, 'Default model'), h('p', { class: 'muted' }, 'Used for new generations. You can type any model ID your key can access.'), modelPicker()));

  const keysCard = h('section', { class: 'card', 'aria-labelledby': 'keys-h' },
    h('h2', { id: 'keys-h' }, icon('key', 18), ' API keys (bring your own)'),
    h('p', { class: 'muted' }, 'Keys are encrypted (AES-256-GCM) on this server, never shown again after saving, and only used to call the provider you choose. Your usage is billed by the provider to your account.'));
  for (const p of state.providers.filter((x) => !x.noKey)) keysCard.append(keyRow(p));
  wrap.append(keysCard);
  wrap.append(usageCard(), defaultsCard());
  if (state.user.isAdmin) wrap.append(storageCard());
  wrap.append(accountCard());
  return wrap;
}
function keyRow(p) {
  const saved = state.keys.find((k) => k.provider === p.id);
  const id = `key-${p.id}`;
  const input = h('input', { id, type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: saved ? `•••• ${saved.last4} (saved)` : p.keyHint, maxlength: 400 });
  const base = p.customBaseUrl ? h('input', { id: `${id}-base`, type: 'url', placeholder: 'https://api.example.com/v1', value: saved?.base_url || '', 'aria-label': `${p.label} base URL` }) : null;
  const status = h('p', { class: 'hint', id: `${id}-status`, 'aria-live': 'polite' }, saved ? `Saved ${new Date(saved.updated_at).toLocaleDateString()}` : 'Not set');
  return h('div', { class: 'keyrow' },
    h('label', { for: id }, p.label, p.keyUrl ? h('a', { class: 'hint', href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, ' get key ↗') : null),
    h('div', { class: 'keyctl' }, base, input,
      h('button', { class: 'btn primary sm', type: 'button', onClick: async () => {
        status.textContent = 'Saving…';
        try { const r = await api(`/api/keys/${p.id}`, { method: 'PUT', body: { apiKey: input.value, baseUrl: base?.value } }); state.keys = r.keys; input.value = ''; toast(`${p.label} key saved`, 'ok'); render(); }
        catch (e) { status.textContent = e.message; }
      } }, 'Save'),
      saved ? h('button', { class: 'btn sm', type: 'button', onClick: async () => {
        status.textContent = 'Testing…';
        try { const r = await api(`/api/keys/${p.id}/test`, { method: 'POST' }); status.textContent = `Key works · ${r.models.length} models available${r.models.length ? ` (e.g. ${r.models.slice(0, 4).join(', ')})` : ''}`; }
        catch (e) { status.textContent = `Test failed: ${e.message}`; }
      } }, 'Test') : null,
      saved ? h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': `Remove ${p.label} key`, onClick: async () => {
        try { const r = await api(`/api/keys/${p.id}`, { method: 'DELETE' }); state.keys = r.keys; toast('Key removed', 'ok'); render(); } catch (e) { status.textContent = e.message; }
      } }, icon('trash')) : null),
    status);
}
function usageCard() {
  const body = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
  (async () => {
    try {
      const u = await api('/api/usage');
      clear(body);
      if (!u.rows.length) { body.append(h('p', { class: 'muted' }, 'No model calls this month.')); return; }
      body.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl', id: 'usage-table' }, h('caption', { class: 'sr-only' }, 'Model usage this month'),
        h('thead', null, h('tr', null, ['Provider', 'Model', 'Calls', 'Input tokens', 'Output tokens', 'Est. cost'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, u.rows.map((r) => h('tr', null, h('td', null, r.provider), h('td', null, r.model), h('td', null, r.calls), h('td', null, r.input_tokens.toLocaleString()), h('td', null, r.output_tokens.toLocaleString()),
          h('td', { title: r.price ? `$${r.price.in} in / $${r.price.out} out per 1M tokens (${r.price.source} price)` : 'No price for this model: add one below' }, r.cost == null ? 'no price' : formatUsd(r.cost))))),
        h('tfoot', null, h('tr', null, h('th', { scope: 'row', colspan: 5 }, 'Estimated total this month'), h('td', { id: 'usage-total' }, h('strong', null, formatUsd(u.totalCost))))))));
      if (u.unpricedModels.length) body.append(h('p', { class: 'hint warn' }, `No price for ${u.unpricedModels.join(', ')}, so it isn't in the total. Add its price below.`));
      if (u.cap) body.append(h('p', { class: 'hint' }, `Server cap: ${u.cap.toLocaleString()} tokens / month per user.`));
    } catch (e) { clear(body).append(h('p', { class: 'form-error' }, e.message)); }
  })();
  return h('section', { class: 'card', 'aria-labelledby': 'use-h' }, h('h2', { id: 'use-h' }, 'Usage & estimated cost this month'),
    h('p', { class: 'hint' }, 'Token counts are reported by each provider. Costs are estimates from Standard per-token prices (OpenAI prices built in; reasoning tokens are included in output). Your provider dashboard is the exact bill.'),
    body, priceEditor());
}
/** Per-model price overrides ($ per 1M tokens) for models without a built-in price, or to match your contract. */
function priceEditor() {
  const ov = { ...(state.user.settings.priceOverrides || {}) };
  const list = h('ul', { class: 'price-list' });
  const draw = () => {
    clear(list);
    for (const [k, v] of Object.entries(ov)) list.append(h('li', null, h('code', null, k), ` $${v.in} in · $${v.out} out per 1M`,
      h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': `Remove price for ${k}`, onClick: async () => { delete ov[k]; await save(); } }, icon('trash'))));
  };
  const save = async () => { try { await saveSettings({ priceOverrides: ov }); toast('Prices saved', 'ok'); draw(); } catch (e) { toast(e.message, 'error'); } };
  const { model } = currentModel();
  const m = h('input', { id: 'price-model', value: priceFor(model, ov) ? '' : model, placeholder: 'e.g. claude-sonnet-5', maxlength: 80, spellcheck: 'false' });
  const pin = h('input', { id: 'price-in', type: 'number', min: 0, max: 1000, step: 0.01, placeholder: '3.00', inputmode: 'decimal' });
  const pout = h('input', { id: 'price-out', type: 'number', min: 0, max: 1000, step: 0.01, placeholder: '15.00', inputmode: 'decimal' });
  draw();
  return h('details', { class: 'group more', open: Object.keys(ov).length ? true : null }, h('summary', null, 'Your model prices'),
    h('p', { class: 'hint' }, 'Built in: OpenAI GPT-6, GPT-5.6 (Sol, Terra, Luna), GPT-5.x, GPT-4.x, o3, o4-mini. Add Claude, Gemini, Grok or custom models here, from the provider\'s pricing page.'),
    list,
    h('form', { class: 'row3 price-form', onSubmit: async (e) => {
      e.preventDefault();
      const k = priceKey(m.value), i = Number(pin.value), o = Number(pout.value);
      if (!k || !Number.isFinite(i) || !Number.isFinite(o) || pin.value === '' || pout.value === '') { toast('Enter a model ID and both prices.', 'warn'); return; }
      ov[k] = { in: i, out: o }; m.value = ''; pin.value = ''; pout.value = ''; await save();
    } },
      h('div', { class: 'field' }, h('label', { for: 'price-model' }, 'Model ID'), m),
      h('div', { class: 'field' }, h('label', { for: 'price-in' }, 'Input $ / 1M'), pin),
      h('div', { class: 'field' }, h('label', { for: 'price-out' }, 'Output $ / 1M'), pout),
      h('button', { class: 'btn sm', type: 'submit', id: 'price-save' }, icon('plus'), 'Save price')));
}
function storageCard() {
  const body = h('div', null, h('p', { class: 'muted' }, 'Checking…'));
  (async () => {
    try {
      const { storage: st } = await api('/api/system/storage');
      const row = (k, v, cls) => h('tr', null, h('th', { scope: 'row' }, k), h('td', { class: cls || '' }, v));
      const mount = st.persistentMount === true ? ['Yes: mounted volume, survives redeploys', 'good']
        : st.persistentMount === false ? [`No: data will be lost on redeploy. In Coolify add a Volume Mount at ${st.dataDir}`, 'bad']
          : ['Unknown on this host', ''];
      clear(body).append(h('table', { class: 'tbl kv' }, h('caption', { class: 'sr-only' }, 'Storage status'), h('tbody', null,
        row('Database', st.databaseFile),
        row('Persistent volume', mount[0], mount[1]),
        row('Writable', st.writable ? 'Yes' : 'No', st.writable ? 'good' : 'bad'),
        row('Encryption key', st.encryptionKey === 'ok' ? 'Matches saved keys' : 'MISMATCH: saved keys cannot be decrypted', st.encryptionKey === 'ok' ? 'good' : 'bad'),
        row('Stored', `${st.counts.users} users · ${st.counts.keys} API keys · ${st.counts.projects} projects · ${(st.sizeBytes / 1024).toFixed(0)} KB`))));
    } catch (e) { clear(body).append(h('p', { class: 'form-error' }, e.message)); }
  })();
  return h('section', { class: 'card', 'aria-labelledby': 'st-h' }, h('h2', { id: 'st-h' }, 'Server storage (admin)'),
    h('p', { class: 'hint' }, 'API keys and projects are only kept across redeploys if the database folder is a persistent volume, and they only decrypt while APP_ENCRYPTION_KEY stays the same.'), body);
}
function defaultsCard() {
  return h('section', { class: 'card', 'aria-labelledby': 'bd-h' }, h('h2', { id: 'bd-h' }, 'Brief defaults'),
    h('p', { class: 'muted' }, 'Save the clip count, clip length, pace, dialogue mode, aspect ratio and style currently in the Studio as defaults for new projects.'),
    h('button', { class: 'btn', type: 'button', onClick: async () => { try { await saveSettings({ briefDefaults: { ...state.brief, concept: '', title: '' } }); toast('Defaults saved', 'ok'); } catch (e) { toast(e.message, 'error'); } } }, 'Save current brief settings as default'));
}
function accountCard() {
  const cur = h('input', { id: 'pw-cur', type: 'password', autocomplete: 'current-password' });
  const nw = h('input', { id: 'pw-new', type: 'password', autocomplete: 'new-password', minlength: 10 });
  const msg = h('p', { class: 'hint', 'aria-live': 'polite' });
  const del = h('input', { id: 'del-pw', type: 'password', autocomplete: 'current-password' });
  const delMsg = h('p', { class: 'form-error', role: 'alert' });
  return h('section', { class: 'card', 'aria-labelledby': 'acct-h' }, h('h2', { id: 'acct-h' }, 'Account'),
    h('p', { class: 'muted' }, `Signed in as ${state.user.email}${state.user.isAdmin ? ' (admin)' : ''}`),
    h('form', { class: 'row2', onSubmit: async (e) => { e.preventDefault(); try { const r = await api('/api/auth/password', { method: 'POST', body: { currentPassword: cur.value, newPassword: nw.value } }); setCsrf(r.csrfToken); state.user.csrfToken = r.csrfToken; cur.value = nw.value = ''; msg.textContent = 'Password changed. Other sessions were signed out.'; } catch (ex) { msg.textContent = ex.message; } } },
      h('div', { class: 'field' }, h('label', { for: 'pw-cur' }, 'Current password'), cur),
      h('div', { class: 'field' }, h('label', { for: 'pw-new' }, 'New password (10+ chars)'), nw),
      h('button', { class: 'btn', type: 'submit' }, 'Change password'), msg),
    h('details', { class: 'danger' }, h('summary', null, 'Delete account'),
      h('p', null, 'Permanently deletes your account, saved API keys, projects and usage history.'),
      h('div', { class: 'field' }, h('label', { for: 'del-pw' }, 'Confirm with password'), del), delMsg,
      h('button', { class: 'btn danger', type: 'button', onClick: async () => {
        if (!confirm('Delete your account and all data permanently?')) return;
        try { await api('/api/account', { method: 'DELETE', body: { password: del.value } }); state.user = null; setCsrf(null); setSessionToken(null); go('studio'); } catch (e) { delMsg.textContent = e.message; }
      } }, 'Delete my account')));
}

window.addEventListener('offline', () => toast('You are offline — generation needs a connection.', 'warn'));
boot();
