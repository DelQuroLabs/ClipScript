// HTTP app factory. Server-only.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/server/db.js';
import { KeyVault, hashPassword, verifyPassword, DUMMY_HASH, randomToken, sha256 } from '../lib/server/crypto.js';
import { trimToFit } from '../lib/domain/wordcount.js';
import { rateLimiter } from '../lib/server/ratelimit.js';
import { resolveEncryptionKey, checkEncryptionKey, storageReport } from '../lib/server/storage.js';
import { complete, listModels, assertSafeBaseUrl, LlmError } from '../lib/server/llm.js';
import { PROVIDERS, providerById, MODEL_ID_RE } from '../lib/domain/providers.js';
import { normalizeBrief, validateBrief, wordBudgetFor } from '../lib/domain/project.js';
import { extractJson, normalizeScript, analyzeScript, composeImagePrompt } from '../lib/domain/script.js';
import { guideMarkdown } from '../lib/domain/guide.js';
import { vePackSeriesMarkdown, normalizeVeSettings } from '../lib/domain/vepack.js';
import { hardChecks, normalizeReview, combineScore, TARGET_SCORE, MAX_ROUNDS, DEFAULT_ROUNDS } from '../lib/domain/quality.js';
import { reviewerSystemPrompt, analyzePrompt, repairSystemPrompt, repairPrompt, POLISH_PROMPT_VERSION } from '../lib/domain/polishPrompts.js';
import { costOf, priceFor, normalizePriceOverrides, estimateSeriesWrite, priceRange, PRICES_SOURCE } from '../lib/domain/pricing.js';
import { normalizeSeriesSettings, validateSeriesSettings, normalizePlan, applyPlanEdits, planStats, normalizeEpisode, analyzeEpisode, layoutEpisode, seriesCsv, episodeMarkdown, SERIES_LIMITS } from '../lib/domain/series.js';
import { seriesSystemPrompt, extractPrompt, planPrompt, episodePrompt, SERIES_PROMPT_VERSION } from '../lib/domain/seriesPrompts.js';
import { systemPrompt, userPrompt, tightenPrompt, regenerateClipPrompt, applyTighten, PROMPT_VERSION } from '../lib/domain/prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_COOKIE = 'cs_session';
const SESSION_DAYS = 30;

export function createApp(config = {}) {
  const cfg = {
    dbFile: config.dbFile ?? process.env.DATABASE_FILE ?? path.join(process.cwd(), 'data', 'clipscript.db'),
    encryptionKey: config.encryptionKey ?? process.env.APP_ENCRYPTION_KEY,
    registration: config.registration ?? process.env.REGISTRATION ?? (process.env.NODE_ENV === 'production' ? 'first-user' : 'open'), // open | closed | first-user
    cookieSecure: config.cookieSecure ?? (process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production'),
    publicOrigin: config.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? '',
    staticDir: config.staticDir ?? path.join(__dirname, '..', 'dist'),
    monthlyTokenCap: Number(config.monthlyTokenCap ?? process.env.MONTHLY_TOKEN_CAP_PER_USER ?? 0),
    rateScale: config.rateScale ?? 1,
    // Strict by default. Embedded previews (cross-site iframe) need COOKIE_SAMESITE=none + FRAME_ANCESTORS.
    cookieSameSite: config.cookieSameSite ?? (process.env.COOKIE_SAMESITE === 'none' ? 'None' : 'Lax'),
    frameAncestors: config.frameAncestors ?? process.env.FRAME_ANCESTORS ?? "'self'",
    // Fallback for embedded previews where third-party cookies are blocked: also return the session
    // token in the JSON body and accept it via the X-Session-Token header. OFF by default (production uses HttpOnly cookie only).
    headerSessions: config.headerSessions ?? process.env.HEADER_SESSIONS === 'true',
  };
  if (cfg.cookieSameSite === 'None') cfg.cookieSecure = true;
  if (!/^[a-zA-Z0-9 :/.*'\-]+$/.test(cfg.frameAncestors)) cfg.frameAncestors = "'self'";
  const resolved = config.encryptionKey != null ? { key: cfg.encryptionKey, source: 'env' } : resolveEncryptionKey(cfg.encryptionKey, cfg.dbFile);
  const vault = new KeyVault(resolved.key);
  const db = openDb(cfg.dbFile);
  const keyStatus = checkEncryptionKey(db, vault);
  const storage = () => storageReport({ dbFile: cfg.dbFile, db, keyStatus, keySource: resolved.source });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : 1);

  // ---- security headers ----
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${cfg.frameAncestors}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (cfg.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use(express.json({ limit: '512kb' }));

  // ---- helpers ----
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT id, email, is_admin, settings, created_at FROM users WHERE id = ?'),
    countUsers: db.prepare('SELECT COUNT(*) n FROM users'),
    insertUser: db.prepare('INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (id_hash, user_id, csrf, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'),
    session: db.prepare('SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE id_hash = ?'),
    delSessionsForUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    updSettings: db.prepare('UPDATE users SET settings = ? WHERE id = ?'),
    updPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    keys: db.prepare('SELECT provider, last4, base_url, updated_at FROM api_keys WHERE user_id = ?'),
    key: db.prepare('SELECT * FROM api_keys WHERE user_id = ? AND provider = ?'),
    upsertKey: db.prepare(`INSERT INTO api_keys (user_id, provider, enc, last4, base_url, updated_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(user_id, provider) DO UPDATE SET enc=excluded.enc, last4=excluded.last4, base_url=excluded.base_url, updated_at=excluded.updated_at`),
    delKey: db.prepare('DELETE FROM api_keys WHERE user_id = ? AND provider = ?'),
    projects: db.prepare('SELECT id, title, meta, created_at, updated_at, json_array_length(json_extract(script, \'$.clips\')) AS clips, json_extract(brief, \'$.mode\') AS mode FROM projects WHERE user_id = ? AND series_id IS NULL ORDER BY updated_at DESC LIMIT 500'),
    project: db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?'),
    insertProject: db.prepare('INSERT INTO projects (user_id, title, brief, script, meta) VALUES (?, ?, ?, ?, ?)'),
    insertEpisode: db.prepare('INSERT INTO projects (user_id, title, brief, script, meta, series_id, episode_no) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    episodesOf: db.prepare('SELECT id, title, brief, script, meta, episode_no, updated_at FROM projects WHERE series_id = ? AND user_id = ? ORDER BY episode_no'),
    insertSeries: db.prepare('INSERT INTO series (user_id, title, status, settings, provider, model) VALUES (?, ?, ?, ?, ?, ?)'),
    seriesById: db.prepare('SELECT * FROM series WHERE id = ? AND user_id = ?'),
    seriesAny: db.prepare('SELECT * FROM series WHERE id = ?'),
    seriesList: db.prepare('SELECT id, title, status, plan, progress, provider, model, created_at, updated_at FROM series WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200'),
    updSeries: db.prepare(`UPDATE series SET title = ?, status = ?, plan = ?, progress = ?, error = ?, usage_in = usage_in + ?, usage_out = usage_out + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`),
    delSeries: db.prepare('DELETE FROM series WHERE id = ? AND user_id = ?'),
    countSeries: db.prepare("SELECT COUNT(*) n FROM series WHERE user_id = ? AND status IN ('analyzing','writing')"),
    updProject: db.prepare(`UPDATE projects SET title = ?, brief = ?, script = ?, meta = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ?`),
    delProject: db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?'),
    countProjects: db.prepare('SELECT COUNT(*) n FROM projects WHERE user_id = ?'),
    insertUsage: db.prepare('INSERT INTO usage (user_id, provider, model, action, input_tokens, output_tokens, prompt_hash, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    usageMonth: db.prepare(`SELECT provider, model, COUNT(*) calls, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens FROM usage WHERE user_id = ? AND created_at >= ? GROUP BY provider, model ORDER BY calls DESC`),
    tokensMonth: db.prepare('SELECT COALESCE(SUM(input_tokens + output_tokens),0) n FROM usage WHERE user_id = ? AND created_at >= ?'),
    delUser: db.prepare('DELETE FROM users WHERE id = ?'),
  };
  setInterval(() => q.purgeSessions.run(Date.now()), 3600_000).unref();

  const parseCookies = (h) => Object.fromEntries(String(h || '').split(';').map((p) => p.trim().split('=')).filter((a) => a[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const setSessionCookie = (res, token, maxAgeSec) => {
    const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', `SameSite=${cfg.cookieSameSite}`, `Max-Age=${maxAgeSec}`];
    if (cfg.cookieSecure) parts.push('Secure');
    if (cfg.cookieSameSite === 'None') parts.push('Partitioned');
    res.setHeader('Set-Cookie', parts.join('; '));
  };
  const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };
  const settingsOf = (u) => { try { return JSON.parse(u.settings || '{}'); } catch { return {}; } };
  const publicUser = (u, csrf) => ({ id: u.id, email: u.email, isAdmin: !!u.is_admin, settings: settingsOf(u), csrfToken: csrf });
  const R = (n) => Math.max(1, Math.round(n * cfg.rateScale));

  function createSession(res, userId) {
    const token = randomToken(32);
    const csrf = randomToken(24);
    q.insertSession.run(sha256(token), userId, csrf, Date.now() + SESSION_DAYS * 864e5, Date.now());
    setSessionCookie(res, token, SESSION_DAYS * 86400);
    if (cfg.headerSessions) res.locals.sessionToken = token;
    return csrf;
  }

  // ---- diagnostics: log API auth outcomes without any secret values ----
  if (process.env.AUTH_DEBUG === 'true') {
    app.use('/api', (req, res, next) => {
      res.on('finish', () => {
        const ck = /(?:^|;\s*)cs_session=/.test(req.headers.cookie || '');
        console.log(`[api] ${req.method} ${req.path} → ${res.statusCode} cookie=${ck} hdrToken=${!!req.headers['x-session-token']} csrf=${!!req.headers['x-csrf-token']} user=${req.user ? req.user.id : '-'}`);
      });
      next();
    });
  }

  // ---- auth middleware ----
  app.use('/api', (req, res, next) => {
    let token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token && cfg.headerSessions) {
      const h = req.headers['x-session-token'];
      if (typeof h === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(h)) token = h;
    }
    if (token) {
      const s = q.session.get(sha256(token), Date.now());
      if (s) { req.session = s; req.sessionHash = s.id_hash; req.user = q.userById.get(s.user_id); }
    }
    next();
  });
  // CSRF: state-changing requests need matching Origin (when sent) + X-CSRF-Token for authenticated sessions.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
      const hosts = [req.headers.host, ...String(req.headers['x-forwarded-host'] || '').split(',')].map((x) => String(x || '').trim()).filter(Boolean);
      let ok = false;
      try { ok = hosts.includes(new URL(origin).host) || (cfg.publicOrigin && origin === cfg.publicOrigin); } catch { ok = false; }
      if (!ok) return res.status(403).json({ error: 'Cross-origin request blocked.', code: 'bad_origin' });
    }
    if (req.session && req.headers['x-csrf-token'] !== req.session.csrf) {
      return res.status(403).json({ error: 'Security token missing or expired. Reload the page.', code: 'csrf' });
    }
    if (!req.session && !req.headers['content-type']?.includes('application/json')) {
      return res.status(415).json({ error: 'JSON required', code: 'content_type' });
    }
    next();
  });
  const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in.', code: 'unauthenticated' }));

  const authLimiter = rateLimiter({ name: 'auth', windowMs: 15 * 60_000, max: R(20) });
  const writeLimiter = rateLimiter({ name: 'write', windowMs: 60_000, max: R(120), key: (req) => req.user?.id ?? req.ip });
  const llmLimiter = rateLimiter({ name: 'llm', windowMs: 60_000, max: R(12), key: (req) => req.user?.id ?? req.ip });

  // ---- routes: meta ----
  app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true }); });
  app.get('/api/providers', (req, res) => res.json({ providers: PROVIDERS.map(({ id, label, keyHint, keyUrl, models, defaultModel, noKey, customBaseUrl }) => ({ id, label, keyHint, keyUrl, models, defaultModel, noKey: !!noKey, customBaseUrl: !!customBaseUrl })) }));

  // ---- auth ----
  const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
  app.get('/api/auth/status', (req, res) => {
    const n = q.countUsers.get().n;
    res.json({ registrationOpen: cfg.registration === 'open' || n === 0, hasUsers: n > 0 });
  });
  app.post('/api/auth/register', authLimiter, (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const n = q.countUsers.get().n;
    if (!(cfg.registration === 'open' || n === 0)) return res.status(403).json({ error: 'Registration is closed on this server.', code: 'registration_closed' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.', field: 'email' });
    if (password.length < 10 || password.length > 200) return res.status(400).json({ error: 'Password must be 10–200 characters.', field: 'password' });
    if (q.userByEmail.get(email)) return res.status(409).json({ error: 'An account with this email already exists.', field: 'email' });
    const info = q.insertUser.run(email, hashPassword(password), n === 0 ? 1 : 0);
    const csrf = createSession(res, info.lastInsertRowid);
    res.status(201).json({ user: publicUser(q.userById.get(info.lastInsertRowid), csrf), sessionToken: res.locals.sessionToken });
  });
  app.post('/api/auth/login', authLimiter, (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const u = q.userByEmail.get(email);
    const ok = verifyPassword(password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok) return res.status(401).json({ error: 'Email or password is incorrect.' });
    const csrf = createSession(res, u.id);
    res.json({ user: publicUser(q.userById.get(u.id), csrf), sessionToken: res.locals.sessionToken });
  });
  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionHash) q.delSession.run(req.sessionHash);
    setSessionCookie(res, '', 0);
    res.json({ ok: true });
  });
  app.get('/api/auth/me', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.user) return res.json({ user: null });
    res.json({ user: publicUser(req.user, req.session.csrf) });
  });
  app.post('/api/auth/password', requireAuth, authLimiter, (req, res) => {
    const u = q.userByEmail.get(req.user.email);
    if (!verifyPassword(String(req.body?.currentPassword || ''), u.password_hash)) return res.status(400).json({ error: 'Current password is incorrect.', field: 'currentPassword' });
    const np = String(req.body?.newPassword || '');
    if (np.length < 10 || np.length > 200) return res.status(400).json({ error: 'New password must be 10–200 characters.', field: 'newPassword' });
    q.updPassword.run(hashPassword(np), u.id);
    q.delSessionsForUser.run(u.id);
    const csrf = createSession(res, u.id);
    res.json({ ok: true, csrfToken: csrf, sessionToken: res.locals.sessionToken });
  });
  app.delete('/api/account', requireAuth, authLimiter, (req, res) => {
    const u = q.userByEmail.get(req.user.email);
    if (!verifyPassword(String(req.body?.password || ''), u.password_hash)) return res.status(400).json({ error: 'Password is incorrect.', field: 'password' });
    q.delUser.run(u.id); // cascades keys, projects, sessions, usage
    setSessionCookie(res, '', 0);
    res.json({ ok: true });
  });

  // ---- settings ----
  app.put('/api/settings', requireAuth, writeLimiter, (req, res) => {
    const b = req.body || {};
    const s = settingsOf(req.user);
    if (b.provider !== undefined) { if (!providerById(b.provider)) return res.status(400).json({ error: 'Unknown provider' }); s.provider = b.provider; }
    if (b.model !== undefined) { if (b.model && !MODEL_ID_RE.test(b.model)) return res.status(400).json({ error: 'Invalid model ID', field: 'model' }); s.model = b.model; }
    if (b.autoFit !== undefined) s.autoFit = !!b.autoFit;
    if (b.priceOverrides !== undefined) s.priceOverrides = normalizePriceOverrides(b.priceOverrides);
    if (b.briefDefaults !== undefined) s.briefDefaults = normalizeBrief(b.briefDefaults);
    if (b.ve !== undefined) s.ve = normalizeVeSettings(b.ve);
    q.updSettings.run(JSON.stringify(s), req.user.id);
    res.json({ settings: s });
  });

  // ---- API keys (write-only; never returned) ----
  app.get('/api/keys', requireAuth, (req, res) => res.json({ keys: q.keys.all(req.user.id) }));
  app.put('/api/keys/:provider', requireAuth, writeLimiter, async (req, res, next) => {
    try {
      const p = providerById(req.params.provider);
      if (!p || p.noKey) return res.status(400).json({ error: 'Unknown provider' });
      const key = String(req.body?.apiKey || '').trim();
      if (key.length < 8 || key.length > 400 || /\s/.test(key)) return res.status(400).json({ error: 'That does not look like a valid API key.', field: 'apiKey' });
      let baseUrl = null;
      if (p.customBaseUrl) baseUrl = await assertSafeBaseUrl(String(req.body?.baseUrl || ''));
      q.upsertKey.run(req.user.id, p.id, vault.encrypt(key, req.user.id), key.slice(-4), baseUrl);
      res.json({ keys: q.keys.all(req.user.id) });
    } catch (e) { next(e); }
  });
  app.delete('/api/keys/:provider', requireAuth, writeLimiter, (req, res) => {
    q.delKey.run(req.user.id, req.params.provider);
    res.json({ keys: q.keys.all(req.user.id) });
  });

  function credentialsFor(userId, providerId) {
    const p = providerById(providerId);
    if (!p) throw new LlmError('Unknown provider', 400, 'bad_provider');
    if (p.noKey) return { provider: p.id };
    const row = q.key.get(userId, p.id);
    if (!row) throw new LlmError(`No API key saved for ${p.label}. Add one in Settings.`, 400, 'no_key');
    let apiKey;
    try { apiKey = vault.decrypt(row.enc, userId); } catch {
      throw new LlmError(`Your saved ${p.label} key can't be decrypted. The server's APP_ENCRYPTION_KEY was changed. Re-enter the key in Settings (or restore the original APP_ENCRYPTION_KEY).`, 409, 'key_undecryptable');
    }
    return { provider: p.id, apiKey, baseUrl: row.base_url };
  }

  app.post('/api/keys/:provider/test', requireAuth, llmLimiter, async (req, res, next) => {
    try {
      const creds = credentialsFor(req.user.id, req.params.provider);
      const models = await listModels(creds);
      res.json({ ok: true, models: models.slice(0, 400) });
    } catch (e) { next(e); }
  });

  // ---- LLM calls ----
  function checkCap(userId) {
    if (cfg.monthlyTokenCap > 0 && q.tokensMonth.get(userId, monthStart()).n >= cfg.monthlyTokenCap) {
      throw new LlmError('Monthly token cap for your account on this server has been reached.', 429, 'token_cap');
    }
  }
  function checkModelChoice(provider, model) {
    if (!providerById(provider)) throw new LlmError('Choose a provider.', 400, 'bad_provider');
    if (!MODEL_ID_RE.test(model)) throw new LlmError('Enter a valid model ID.', 400, 'bad_model');
  }
  async function callModelAs(userId, provider, model, action, system, user, version = PROMPT_VERSION) {
    checkModelChoice(provider, model);
    checkCap(userId);
    const creds = credentialsFor(userId, provider);
    const promptHash = sha256(`${version}\n${system}\n${user}`);
    try {
      const r = await complete({ ...creds, model, system, user });
      q.insertUsage.run(userId, provider, model, action, r.usage.input, r.usage.output, promptHash, 1);
      return { ...r, provenance: { provider, model, promptVersion: version, promptHash, generatedAt: new Date().toISOString() } };
    } catch (e) {
      q.insertUsage.run(userId, provider, model, action, 0, 0, promptHash, 0);
      throw e;
    }
  }
  const callModel = (req, action, system, user) => callModelAs(req.user.id, String(req.body?.provider || ''), String(req.body?.model || ''), action, system, user);

  async function fitDialogue(req, script, brief, meta) {
    if (brief.layout === 'narration') {
      // Episodes: never cut words. Re-flow the narration into as many clips as it needs.
      const beats = script.clips.map((c) => ({ beat: c.beat, narration: c.dialogue.map((l) => l.line).join(' '), imagePrompt: c.imagePrompt, lastFramePrompt: c.lastFramePrompt || '', videoPrompt: c.videoPrompt, onScreenText: c.onScreenText, sfx: c.sfx }));
      const clips = layoutEpisode(beats, brief, 'auto').map((c) => ({ index: c.index, durationSeconds: c.durationSeconds, beat: c.beat, imagePrompt: c.imagePrompt, lastFramePrompt: c.lastFramePrompt, videoPrompt: c.videoPrompt, dialogue: c.narration ? [{ speaker: 'Narrator', line: c.narration }] : [], onScreenText: c.onScreenText, sfx: c.sfx, flag: c.flag, continued: !!c.continued }));
      script = { ...script, clips, narration: clips.map((c) => c.dialogue.map((l) => l.line).join(' ')).filter(Boolean).join(' ') };
      meta.fitPasses = 0; meta.trimmedClips = [];
      return { script, analysis: analyzeScript(script, brief) };
    }
    let passes = 0;
    let a = analyzeScript(script, brief);
    while (brief.dialogueMode !== 'none' && a.overClips.length && passes < 2) {
      passes++;
      const r = await callModel(req, 'tighten', systemPrompt(), tightenPrompt(script, brief, a.overClips, a.budget, a.clips.filter((c) => c.status === 'over')));
      script = applyTighten(script, extractJson(r.text));
      meta.usage.input += r.usage.input; meta.usage.output += r.usage.output;
      a = analyzeScript(script, brief);
    }
    // Safety net: if the model still overshoots, drop whole trailing sentences (never mid-sentence/mid-word)
    // so the audio ends cleanly instead of being chopped by the clip cut.
    const trimmed = [];
    if (brief.dialogueMode !== 'none' && a.overClips.length) {
      script = { ...script, clips: script.clips.map((c) => {
        if (!a.overClips.includes(c.index) || c.dialogue.length !== 1) return c;
        const line = trimToFit(c.dialogue[0].line, a.budget, a.window, brief.wordsPerSecond);
        if (line === c.dialogue[0].line) return c;
        trimmed.push(c.index);
        return { ...c, dialogue: [{ ...c.dialogue[0], line }] };
      }) };
      a = analyzeScript(script, brief);
    }
    meta.fitPasses = passes;
    meta.trimmedClips = trimmed;
    return { script, analysis: a };
  }

  function saveProject(userId, projectId, brief, script, meta) {
    const title = (script && script.title) || brief.title || 'Untitled video';
    if (projectId) {
      const existing = q.project.get(projectId, userId);
      if (!existing) throw new LlmError('Project not found', 404, 'not_found');
      q.updProject.run(title, JSON.stringify(brief), script ? JSON.stringify(script) : null, JSON.stringify(meta || {}), projectId, userId);
      return projectId;
    }
    if (q.countProjects.get(userId).n >= 500) throw new LlmError('Project limit reached (500). Delete some projects first.', 400, 'limit');
    return Number(q.insertProject.run(userId, title, JSON.stringify(brief), script ? JSON.stringify(script) : null, JSON.stringify(meta || {})).lastInsertRowid);
  }

  // Faceless reels never carry characters (the model is told so; this enforces it).
  const facelessGuard = (script) => ({ ...script, styleSheet: { ...script.styleSheet, characters: [] }, clips: script.clips.map((c) => ({ ...c, dialogue: c.dialogue.map((l) => ({ ...l, speaker: 'Narrator' })) })) });

  // ---------------- Quality loop: Analyze → Repair → Analyze until the target score ----------------
  // Score = 80% AI rubric (user's own key/model) + 20% hard checks computed in code; a failed hard check caps it below target.
  // The best-scoring version is always kept, so polishing can never make a script worse.
  const polishJobs = new Map(); // 'p:<projectId>' | 's:<seriesId>' → job
  const clampRounds = (n) => Math.max(0, Math.min(MAX_ROUNDS, Number.isFinite(Number(n)) ? Math.round(Number(n)) : DEFAULT_ROUNDS));
  const clampTarget = (n) => Math.max(50, Math.min(100, Number(n) || TARGET_SCORE));
  async function polishScript(userId, provider, model, brief, script, { target, rounds, progress, cancelled }) {
    const usage = { input: 0, output: 0 };
    const history = [];
    const fakeReq = { user: { id: userId }, body: { provider, model } };
    const call = async (action, system, user) => {
      const r = await callModelAs(userId, provider, model, action, system, user, POLISH_PROMPT_VERSION);
      usage.input += r.usage.input; usage.output += r.usage.output;
      return r;
    };
    const evaluate = async (sc, round) => {
      const checks = hardChecks(sc, brief);
      progress({ round, phase: 'analyzing', message: round ? `Round ${round}: checking the repaired script…` : 'Reading and scoring the script…' });
      const r = await call('analyze', reviewerSystemPrompt(), analyzePrompt(sc, brief, checks));
      const review = normalizeReview(extractJson(r.text));
      const { score, capped } = combineScore(review, checks, target);
      const entry = { round, score, capped, ai: review.ai, checks: checks.score, scores: review.scores, summary: review.summary, issues: review.issues, failed: checks.failed.map((c) => ({ label: c.label, detail: c.detail })) };
      history.push(entry);
      progress({ round, phase: 'scored', score, message: `${round ? `Round ${round}` : 'First read'}: ${score}/100` });
      return { entry, review, checks };
    };
    let best = { script, ev: await evaluate(script, 0) };
    for (let i = 1; i <= rounds && best.ev.entry.score < target; i++) {
      if (cancelled()) break;
      progress({ round: i, phase: 'repairing', message: `Round ${i}: repairing ${best.ev.review.issues.length || 'the weakest'} issue${best.ev.review.issues.length === 1 ? '' : 's'}…` });
      const r = await call('repair', repairSystemPrompt(), repairPrompt(best.script, brief, best.ev.review, best.ev.checks));
      let next;
      try { next = normalizeScript(extractJson(r.text), brief); } catch { continue; }
      if (!next.clips.length) continue;
      if (brief.mode === 'reel') next = facelessGuard(next);
      next.buildProgress = best.script.buildProgress || {};
      if (brief.layout === 'narration') { next.caption ||= best.script.caption || ''; if (!next.hashtags?.length) next.hashtags = best.script.hashtags || []; }
      const fm = { usage: { input: 0, output: 0 } };
      ({ script: next } = await fitDialogue(fakeReq, next, brief, fm));
      usage.input += fm.usage.input; usage.output += fm.usage.output;
      if (cancelled()) break;
      const ev = await evaluate(next, i);
      if (ev.entry.score > best.ev.entry.score) best = { script: next, ev };
    }
    return { script: best.script, score: best.ev.entry.score, bestRound: best.ev.entry.round, reached: best.ev.entry.score >= target, history, usage };
  }
  const qualityMeta = (out, model, target) => ({ score: out.score, target, reached: out.reached, bestRound: out.bestRound, rounds: out.history.length - 1, model, at: new Date().toISOString(),
    scores: out.history.find((h) => h.round === out.bestRound)?.scores, summary: out.history.find((h) => h.round === out.bestRound)?.summary,
    issues: out.history.find((h) => h.round === out.bestRound)?.issues || [], failed: out.history.find((h) => h.round === out.bestRound)?.failed || [],
    history: out.history.map(({ round, score, capped }) => ({ round, score, capped })) });
  const jobOut = (j) => j && { status: j.status, phase: j.phase, round: j.round, message: j.message, log: j.log.slice(-40), error: j.error, result: j.result, done: j.done, total: j.total, current: j.current, startedAt: j.startedAt };
  const newJob = (extra = {}) => ({ status: 'running', phase: 'starting', round: 0, message: 'Starting…', log: [], cancel: false, startedAt: new Date().toISOString(), ...extra });
  const jobProgress = (job, prefix = '') => (p) => { Object.assign(job, { phase: p.phase, round: p.round, message: prefix + p.message }); if (p.phase === 'scored' || p.phase === 'repairing') job.log.push(prefix + p.message); };
  function polishProject(userId, projectId, provider, model, target, rounds, job, prefix = '', extraSource = '') {
    const p = q.project.get(projectId, userId);
    if (!p || !p.script) throw new LlmError('Project not found', 404, 'not_found');
    const brief = normalizeBrief(JSON.parse(p.brief));
    const script = normalizeScript(JSON.parse(p.script), brief);
    const oldMeta = JSON.parse(p.meta || '{}');
    const scoreBrief = extraSource && !brief.sourceData ? { ...brief, sourceData: extraSource } : brief;
    return polishScript(userId, provider, model, scoreBrief, script, { target, rounds, progress: jobProgress(job, prefix), cancelled: () => job.cancel }).then((out) => {
      const fresh = normalizeScript(out.script, brief);
      fresh.buildProgress = script.buildProgress || {};
      const meta = { ...oldMeta, quality: qualityMeta(out, model, target), usage: { input: (oldMeta.usage?.input || 0) + out.usage.input, output: (oldMeta.usage?.output || 0) + out.usage.output } };
      q.updProject.run(fresh.title || p.title, JSON.stringify(brief), JSON.stringify(fresh), JSON.stringify(meta), projectId, userId);
      return { out, meta };
    });
  }
  app.post('/api/projects/:id/polish', requireAuth, llmLimiter, (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const p = q.project.get(id, req.user.id);
      if (!p || !p.script) return res.status(404).json({ error: 'Save the project with a script first.' });
      const key = `p:${id}`;
      if (polishJobs.get(key)?.status === 'running') return res.status(409).json({ error: 'This script is already being polished.' });
      const provider = String(req.body?.provider || ''), model = String(req.body?.model || '');
      checkModelChoice(provider, model); checkCap(req.user.id); credentialsFor(req.user.id, provider);
      const target = clampTarget(req.body?.target), rounds = clampRounds(req.body?.rounds);
      const job = newJob({ target, rounds });
      polishJobs.set(key, job);
      polishProject(req.user.id, id, provider, model, target, rounds, job)
        .then(({ out, meta }) => { Object.assign(job, { status: 'done', phase: 'done', message: out.reached ? `Done: ${out.score}/100` : `Best score ${out.score}/100 after ${out.history.length - 1} repair round${out.history.length === 2 ? '' : 's'}`, result: { score: out.score, reached: out.reached, usage: out.usage, quality: meta.quality } }); })
        .catch((e) => { Object.assign(job, { status: 'error', phase: 'error', error: e.message || 'Polishing failed' }); });
      res.status(202).json({ job: jobOut(job) });
    } catch (e) { next(e); }
  });
  app.get('/api/projects/:id/polish', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const p = q.project.get(id, req.user.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    res.json({ job: jobOut(polishJobs.get(`p:${id}`)) || null, quality: JSON.parse(p.meta || '{}').quality || null });
  });
  app.post('/api/projects/:id/polish/cancel', requireAuth, writeLimiter, (req, res) => {
    const j = polishJobs.get(`p:${Number(req.params.id)}`);
    if (j && q.project.get(Number(req.params.id), req.user.id)) j.cancel = true;
    res.json({ ok: true, stopping: !!j });
  });

  app.post('/api/generate', requireAuth, llmLimiter, async (req, res, next) => {
    try {
      const brief = normalizeBrief(req.body?.brief);
      const errors = validateBrief(brief);
      if (errors.length) return res.status(400).json({ error: errors[0].message, field: errors[0].field, errors });
      const r = await callModel(req, 'generate', systemPrompt(), userPrompt(brief));
      let script = normalizeScript(extractJson(r.text), brief);
      if (brief.mode === 'reel') script = facelessGuard(script);
      if (!script.clips.length) throw new LlmError('The model returned no clips. Try again or choose another model.', 502, 'empty');
      const meta = { ...r.provenance, usage: { ...r.usage } };
      const autoFit = req.body?.autoFit !== false;
      let analysis;
      if (autoFit) ({ script, analysis } = await fitDialogue(req, script, brief, meta));
      else analysis = analyzeScript(script, brief);
      const id = saveProject(req.user.id, Number(req.body?.projectId) || null, brief, script, meta);
      res.json({ project: { id, brief, script, meta }, analysis });
    } catch (e) { next(e); }
  });

  app.post('/api/fit', requireAuth, llmLimiter, async (req, res, next) => {
    try {
      const brief = normalizeBrief(req.body?.brief);
      const script = normalizeScript(req.body?.script, brief);
      const meta = { usage: { input: 0, output: 0 } };
      const out = await fitDialogue(req, script, brief, meta);
      res.json({ script: out.script, analysis: out.analysis, usage: meta.usage, trimmedClips: meta.trimmedClips });
    } catch (e) { next(e); }
  });

  app.post('/api/regenerate-clip', requireAuth, llmLimiter, async (req, res, next) => {
    try {
      const brief = normalizeBrief(req.body?.brief);
      const script = normalizeScript(req.body?.script, brief);
      const index = Number(req.body?.index);
      if (!script.clips.some((c) => c.index === index)) return res.status(400).json({ error: 'Unknown clip' });
      const r = await callModel(req, 'regenerate', systemPrompt(), regenerateClipPrompt(script, brief, index, String(req.body?.instruction || '')));
      const one = normalizeScript({ clips: [extractJson(r.text)] }, brief).clips[0];
      let next2 = { ...script, clips: script.clips.map((c) => (c.index === index ? { ...one, index } : c)) };
      if (brief.mode === 'reel') next2 = facelessGuard(next2);
      if (brief.dialogueMode !== 'none') {
        const a1 = analyzeScript(next2, brief);
        if (a1.overClips.includes(index)) {
          const meta = { usage: { input: 0, output: 0 } };
          ({ script: next2 } = await fitDialogue(req, next2, brief, meta));
          r.usage.input += meta.usage.input; r.usage.output += meta.usage.output;
        }
      }
      res.json({ script: next2, analysis: analyzeScript(next2, brief), usage: r.usage });
    } catch (e) { next(e); }
  });

  // ---- projects ----
  const projectOut = (p) => ({ id: p.id, seriesId: p.series_id || null, episodeNo: p.episode_no || null, title: p.title, brief: JSON.parse(p.brief), script: p.script ? JSON.parse(p.script) : null, meta: JSON.parse(p.meta || '{}'), createdAt: p.created_at, updatedAt: p.updated_at });
  app.get('/api/projects', requireAuth, (req, res) => res.json({ projects: q.projects.all(req.user.id).map((p) => ({ id: p.id, title: p.title, clips: p.clips || 0, mode: p.mode === 'reel' ? 'reel' : 'story', updatedAt: p.updated_at, model: JSON.parse(p.meta || '{}').model || '' })) }));
  app.get('/api/projects/:id', requireAuth, (req, res) => {
    const p = q.project.get(Number(req.params.id), req.user.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    res.json({ project: projectOut(p) });
  });
  app.post('/api/projects', requireAuth, writeLimiter, (req, res, next) => {
    try {
      const brief = normalizeBrief(req.body?.brief);
      const script = req.body?.script ? normalizeScript(req.body.script, brief) : null;
      const existing = req.body?.id ? q.project.get(Number(req.body.id), req.user.id) : null;
      const meta = existing ? JSON.parse(existing.meta || '{}') : {};
      if (script) meta.editedAt = new Date().toISOString();
      const id = saveProject(req.user.id, existing ? existing.id : null, brief, script, meta);
      res.json({ project: projectOut(q.project.get(id, req.user.id)) });
    } catch (e) { next(e); }
  });
  app.delete('/api/projects/:id', requireAuth, writeLimiter, (req, res) => {
    const r = q.delProject.run(Number(req.params.id), req.user.id);
    if (!r.changes) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  });

  // ---------------- Series (raw data → analyzed plan → many episodes) ----------------
  // Jobs run in-process, one step at a time, persisting after every step, so a restart resumes where it left off.
  const EP_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.SERIES_CONCURRENCY || 2)));
  const running = new Map(); // seriesId → { cancel }
  const loadSeries = (row) => ({ ...row, settings: JSON.parse(row.settings), plan: row.plan ? JSON.parse(row.plan) : null, progress: JSON.parse(row.progress || '{}') });
  function saveSeries(ser, { usageIn = 0, usageOut = 0 } = {}) {
    q.updSeries.run(ser.plan?.seriesTitle || ser.title, ser.status, ser.plan ? JSON.stringify(ser.plan) : null, JSON.stringify(ser.progress || {}), ser.error || null, usageIn, usageOut, ser.id);
  }
  const seriesOut = (ser, withEpisodes = false) => {
    const out = { id: ser.id, title: ser.plan?.seriesTitle || ser.title, status: ser.status, error: ser.error, progress: ser.progress, provider: ser.provider, model: ser.model,
      settings: { brief: { ...ser.settings.brief, sourceData: undefined }, options: ser.settings.options, sourceChars: ser.settings.brief.sourceData.length },
      plan: ser.plan, stats: ser.plan ? planStats(ser.plan) : null, usage: { input: ser.usage_in, output: ser.usage_out }, createdAt: ser.created_at, updatedAt: ser.updated_at };
    if (withEpisodes) out.sourceData = ser.settings.brief.sourceData;
    return out;
  };
  /** Split a long dump into chunks at paragraph/line breaks (≈12k chars) for extraction. */
  function chunkSource(text, size = 12000) {
    const parts = []; let cur = '';
    for (const para of String(text).split(/\n(?=\s*\S)/)) {
      if (cur && cur.length + para.length > size) { parts.push(cur); cur = ''; }
      if (para.length > size) { for (let i = 0; i < para.length; i += size) parts.push(para.slice(i, i + size)); continue; }
      cur += (cur ? '\n' : '') + para;
    }
    if (cur.trim()) parts.push(cur);
    return parts.slice(0, 12);
  }
  async function runAnalyze(ser, job) {
    const chunks = chunkSource(ser.settings.brief.sourceData);
    ser.progress = { step: 'extract', done: 0, total: chunks.length + 1, message: 'Reading your data…' }; saveSeries(ser);
    const facts = [];
    for (const [i, chunk] of chunks.entries()) {
      if (job.cancel) return;
      const r = await callModelAs(ser.user_id, ser.provider, ser.model, 'series-extract', seriesSystemPrompt(), extractPrompt(chunk, i + 1, chunks.length), SERIES_PROMPT_VERSION);
      const got = extractJson(r.text);
      for (const f of Array.isArray(got.facts) ? got.facts : []) facts.push(f);
      ser.progress = { step: 'extract', done: i + 1, total: chunks.length + 1, message: `Found ${facts.length} facts…` };
      saveSeries(ser, { usageIn: r.usage.input, usageOut: r.usage.output });
    }
    // de-duplicate across chunks, assign ids
    const seen = new Set();
    const uniq = facts.map((f) => ({ text: String(typeof f === 'string' ? f : f?.text || '').trim(), interest: f?.interest })).filter((f) => {
      const k = f.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 80);
      if (!f.text || seen.has(k)) return false; seen.add(k); return true;
    }).slice(0, SERIES_LIMITS.MAX_FACTS).map((f, i) => ({ id: `f${i + 1}`, text: f.text, interest: f.interest }));
    if (!uniq.length) throw new LlmError('No usable facts were found in the data.', 422, 'no_facts');
    const normFacts = normalizePlan({ facts: uniq }, ser.settings).facts;
    if (job.cancel) return;
    ser.progress = { step: 'plan', done: chunks.length, total: chunks.length + 1, message: `Planning episodes from ${normFacts.length} facts…` }; saveSeries(ser);
    const r = await callModelAs(ser.user_id, ser.provider, ser.model, 'series-plan', seriesSystemPrompt(), planPrompt(normFacts, ser.settings), SERIES_PROMPT_VERSION);
    const plan = normalizePlan({ ...extractJson(r.text), facts: normFacts }, ser.settings);
    ser.plan = plan; ser.status = 'planned'; ser.error = null;
    ser.progress = { step: 'planned', done: chunks.length + 1, total: chunks.length + 1, message: `${plan.episodes.length} episodes planned from ${plan.facts.length} facts.` };
    saveSeries(ser, { usageIn: r.usage.input, usageOut: r.usage.output });
  }
  async function writeEpisode(ser, ep) {
    const facts = ser.plan.facts.filter((f) => ep.factIds.includes(f.id));
    const r = await callModelAs(ser.user_id, ser.provider, ser.model, 'series-episode', seriesSystemPrompt(), episodePrompt(ep, facts, ser.settings, ser.plan.bible, ser.plan.seriesTitle), SERIES_PROMPT_VERSION);
    let script = normalizeEpisode(extractJson(r.text), ser.settings, ep, ser.plan.bible);
    if (!script.clips.length) throw new LlmError('The model returned no clips for this episode.', 502, 'empty');
    script = facelessGuard(script);
    const b = ser.settings.brief;
    const brief = normalizeBrief({ ...b, mode: 'reel', layout: 'narration', sourceData: facts.map((f) => `• ${f.text}`).join('\n'), title: script.title, concept: ep.angle || ep.hook || '',
      clipCount: script.clips.length, seriesId: ser.id, episodeNo: ep.no, narratorVoice: b.narratorVoice || ser.plan.bible.narratorVoice, tone: b.tone || ser.plan.bible.tone });
    const a = analyzeEpisode(script, brief);
    const meta = { ...r.provenance, usage: { ...r.usage }, series: { id: ser.id, no: ep.no, format: ep.format, targetSeconds: ep.targetSeconds } };
    const existing = ep.projectId ? q.project.get(ep.projectId, ser.user_id) : null;
    if (existing) q.updProject.run(script.title, JSON.stringify(brief), JSON.stringify(script), JSON.stringify(meta), existing.id, ser.user_id);
    const projectId = existing ? existing.id : Number(q.insertEpisode.run(ser.user_id, script.title, JSON.stringify(brief), JSON.stringify(script), JSON.stringify(meta), ser.id, ep.no).lastInsertRowid);
    return { projectId, seconds: a.seconds, clips: a.clips, usage: r.usage };
  }
  async function runWrite(ser, job) {
    const todo = () => ser.plan.episodes.filter((e) => e.include && (e.status === 'queued'));
    const total = ser.plan.episodes.filter((e) => e.include).length;
    const progress = (msg) => { const st = planStats(ser.plan); ser.progress = { step: 'write', done: st.done, total, failed: st.failed, message: msg }; };
    progress('Writing episodes…'); saveSeries(ser);
    const worker = async () => {
      for (;;) {
        if (job.cancel) return;
        const ep = todo()[0]; if (!ep) return;
        ep.status = 'writing'; progress(`Writing episode ${ep.no}: ${ep.title}`); saveSeries(ser);
        try {
          const out = await writeEpisode(ser, ep);
          Object.assign(ep, { status: 'done', projectId: out.projectId, seconds: out.seconds, clips: out.clips, error: null });
          progress(`Episode ${ep.no} done`); saveSeries(ser, { usageIn: out.usage.input, usageOut: out.usage.output });
        } catch (e) {
          ep.status = 'failed'; ep.error = String(e.message || e).slice(0, 300);
          progress(`Episode ${ep.no} failed`); saveSeries(ser);
          // account-level problems stop the whole run instead of failing every episode
          if (e instanceof LlmError && ['no_key', 'key_undecryptable', 'provider_auth', 'token_cap', 'bad_model', 'bad_provider'].includes(e.code)) { job.cancel = true; ser.error = e.message; }
          else if (e instanceof LlmError && e.code === 'provider_rate_limit') await new Promise((r) => setTimeout(r, 20000));
        }
      }
    };
    await Promise.all(Array.from({ length: EP_CONCURRENCY }, worker));
    // anything still marked writing/queued after a cancel goes back to its resting state
    for (const e of ser.plan.episodes) if (e.status === 'writing' || (job.cancel && e.status === 'queued')) e.status = e.projectId ? 'done' : 'pending';
    const st = planStats(ser.plan);
    ser.status = job.cancel && ser.error ? 'error' : job.cancel ? 'paused' : 'done';
    progress(ser.status === 'done' ? `${st.done} episodes written${st.failed ? `, ${st.failed} failed (retry them)` : ''}.` : ser.status === 'paused' ? 'Paused.' : 'Stopped.');
    saveSeries(ser);
  }
  function startJob(seriesId, kind) {
    if (running.has(seriesId)) return;
    const job = { cancel: false };
    running.set(seriesId, job);
    const row = q.seriesAny.get(seriesId);
    if (!row) { running.delete(seriesId); return; }
    const ser = loadSeries(row);
    (kind === 'analyze' ? runAnalyze(ser, job) : runWrite(ser, job))
      .catch((e) => { ser.status = kind === 'analyze' ? 'error' : 'paused'; ser.error = String(e.message || e).slice(0, 400); ser.progress = { ...ser.progress, message: ser.error }; saveSeries(ser); })
      .finally(() => running.delete(seriesId));
  }
  // Resume interrupted jobs after a restart/redeploy.
  for (const row of db.prepare("SELECT id, status FROM series WHERE status IN ('analyzing','writing')").all()) setTimeout(() => startJob(row.id, row.status === 'analyzing' ? 'analyze' : 'write'), 500);

  const seriesLimiter = rateLimiter({ name: 'series', windowMs: 60 * 60_000, max: R(30), key: (req) => req.user.id });
  const getSeries = (req, res) => {
    const row = q.seriesById.get(Number(req.params.id), req.user.id);
    if (!row) { res.status(404).json({ error: 'Series not found' }); return null; }
    return loadSeries(row);
  };
  app.post('/api/series', requireAuth, seriesLimiter, (req, res, next) => {
    try {
      const settings = normalizeSeriesSettings(req.body || {});
      const errors = validateSeriesSettings(settings);
      if (errors.length) return res.status(400).json({ error: errors[0].message, field: errors[0].field });
      const provider = String(req.body?.provider || ''), model = String(req.body?.model || '');
      checkModelChoice(provider, model); credentialsFor(req.user.id, provider); checkCap(req.user.id);
      if (q.countSeries.get(req.user.id).n >= 2) return res.status(429).json({ error: 'You already have 2 series running. Wait for one to finish.', code: 'busy' });
      const id = Number(q.insertSeries.run(req.user.id, settings.brief.title || 'New series', 'analyzing', JSON.stringify(settings), provider, model).lastInsertRowid);
      startJob(id, 'analyze');
      res.status(202).json({ series: seriesOut(loadSeries(q.seriesById.get(id, req.user.id))) });
    } catch (e) { next(e); }
  });
  app.get('/api/series', requireAuth, (req, res) => {
    res.json({ series: q.seriesList.all(req.user.id).map((r) => { const plan = r.plan ? JSON.parse(r.plan) : null; return { id: r.id, title: r.title, status: r.status, progress: JSON.parse(r.progress || '{}'), stats: plan ? planStats(plan) : null, model: r.model, updatedAt: r.updated_at }; }) });
  });
  app.get('/api/series/:id', requireAuth, (req, res) => {
    const ser = getSeries(req, res); if (!ser) return;
    const episodes = q.episodesOf.all(ser.id, req.user.id).map((p) => ({ projectId: p.id, no: p.episode_no, title: p.title, updatedAt: p.updated_at, analysis: (() => { try { return analyzeEpisode(JSON.parse(p.script), normalizeBrief(JSON.parse(p.brief))); } catch { return null; } })() }));
    const ov = settingsOf(req.user).priceOverrides || {};
    const written = q.episodesOf.all(ser.id, req.user.id).map((p) => JSON.parse(p.meta || '{}').usage).filter((u) => u && u.output > 0);
    const actualAvg = written.length ? { input: written.reduce((n, u) => n + u.input, 0) / written.length, output: written.reduce((n, u) => n + u.output, 0) / written.length } : null;
    const remaining = ser.plan ? estimateSeriesWrite(ser.plan, ser.settings, { actualAvg }) : null;
    const cost = {
      spent: costOf(ser.model, ser.usage_in, ser.usage_out, ov),
      remaining: remaining ? { episodes: remaining.episodes, tokens: remaining.input + remaining.output, range: priceRange(ser.model, remaining, ov), basedOn: actualAvg ? `average of ${written.length} written episode${written.length > 1 ? 's' : ''}` : 'estimate' } : null,
      priced: !!priceFor(ser.model, ov),
    };
    const quality = Object.fromEntries(q.episodesOf.all(ser.id, req.user.id).map((p) => [p.episode_no, JSON.parse(p.meta || '{}').quality?.score ?? null]));
    const pj = polishJobs.get(`s:${ser.id}`);
    res.json({ series: seriesOut(ser, true), episodes, running: running.has(ser.id), cost, quality, polish: jobOut(pj) || null });
  });
  // Edit plan: include/exclude, length, title. Only while not writing.
  app.put('/api/series/:id/plan', requireAuth, writeLimiter, (req, res) => {
    const ser = getSeries(req, res); if (!ser) return;
    if (!ser.plan) return res.status(409).json({ error: 'The plan is not ready yet.' });
    if (running.has(ser.id)) return res.status(409).json({ error: 'Pause the series before editing the plan.' });
    ser.plan = applyPlanEdits(ser.plan, req.body?.episodes, ser.settings);
    if (typeof req.body?.seriesTitle === 'string' && req.body.seriesTitle.trim()) ser.plan.seriesTitle = req.body.seriesTitle.trim().slice(0, 120);
    saveSeries(ser);
    res.json({ series: seriesOut(ser) });
  });
  // Write: all included pending/failed episodes, or a given list of episode numbers (re-write).
  app.post('/api/series/:id/write', requireAuth, seriesLimiter, (req, res, next) => {
    try {
      const ser = getSeries(req, res); if (!ser) return;
      if (!ser.plan) return res.status(409).json({ error: 'The plan is not ready yet.' });
      if (running.has(ser.id)) return res.status(409).json({ error: 'Already writing.' });
      credentialsFor(req.user.id, ser.provider); checkCap(req.user.id);
      const only = Array.isArray(req.body?.episodes) ? new Set(req.body.episodes.map(Number)) : null;
      let n = 0;
      for (const e of ser.plan.episodes) {
        if (!e.include) continue;
        if (only ? only.has(e.no) : e.status === 'pending' || e.status === 'failed') { e.status = 'queued'; e.error = null; n++; }
      }
      if (!n) return res.status(400).json({ error: 'Nothing to write. Select episodes or retry failed ones.' });
      ser.status = 'writing'; ser.error = null; saveSeries(ser);
      startJob(ser.id, 'write');
      res.status(202).json({ series: seriesOut(ser), queued: n });
    } catch (e) { next(e); }
  });
  // Polish every written episode (optionally only those below the target), one at a time.
  app.post('/api/series/:id/polish', requireAuth, seriesLimiter, (req, res, next) => {
    try {
      const ser = getSeries(req, res); if (!ser) return;
      const key = `s:${ser.id}`;
      if (running.has(ser.id)) return res.status(409).json({ error: 'Wait until the episodes are written.' });
      if (polishJobs.get(key)?.status === 'running') return res.status(409).json({ error: 'This series is already being polished.' });
      const provider = String(req.body?.provider || ser.provider), model = String(req.body?.model || ser.model);
      checkModelChoice(provider, model); checkCap(req.user.id); credentialsFor(req.user.id, provider);
      const target = clampTarget(req.body?.target), rounds = clampRounds(req.body?.rounds);
      const onlyBelow = req.body?.onlyBelow !== false;
      const eps = q.episodesOf.all(ser.id, req.user.id).filter((p) => p.script && (!onlyBelow || !((JSON.parse(p.meta || '{}').quality?.score ?? 0) >= target)));
      if (!eps.length) return res.status(409).json({ error: onlyBelow ? `Every episode already scores ${target}+.` : 'No episodes written yet.' });
      const job = newJob({ target, rounds, done: 0, total: eps.length, results: [] });
      polishJobs.set(key, job);
      const userId = req.user.id, source = ser.settings.brief.sourceData || '';
      (async () => {
        for (const p of eps) {
          if (job.cancel) break;
          job.current = p.episode_no;
          try {
            const { out } = await polishProject(userId, p.id, provider, model, target, rounds, job, `Episode ${p.episode_no} · `, source);
            job.results.push({ no: p.episode_no, score: out.score, reached: out.reached });
            job.log.push(`Episode ${p.episode_no}: ${out.score}/100${out.reached ? ' ✓' : ''}`);
            saveSeries(ser, { usageIn: out.usage.input, usageOut: out.usage.output });
          } catch (e) {
            job.results.push({ no: p.episode_no, error: e.message });
            job.log.push(`Episode ${p.episode_no}: ${e.message}`);
            if (e.status === 401 || e.status === 429) { job.error = e.message; break; }
          }
          job.done++;
        }
        const ok = job.results.filter((r) => r.reached).length;
        Object.assign(job, { status: job.error ? 'error' : 'done', phase: 'done', current: null, message: `${job.cancel ? 'Stopped. ' : ''}${ok} of ${job.results.length} episode${job.results.length === 1 ? '' : 's'} at ${target}+`, result: { results: job.results } });
      })();
      res.status(202).json({ job: jobOut(job) });
    } catch (e) { next(e); }
  });
  app.post('/api/series/:id/polish/cancel', requireAuth, writeLimiter, (req, res) => {
    const ser = getSeries(req, res); if (!ser) return;
    const j = polishJobs.get(`s:${ser.id}`); if (j) j.cancel = true;
    res.json({ ok: true, stopping: !!j });
  });
  app.post('/api/series/:id/pause', requireAuth, writeLimiter, (req, res) => {
    const ser = getSeries(req, res); if (!ser) return;
    const job = running.get(ser.id);
    if (job) job.cancel = true;
    res.json({ ok: true, stopping: !!job });
  });
  app.get('/api/series/:id/export', requireAuth, (req, res) => {
    const ser = getSeries(req, res); if (!ser) return;
    const eps = q.episodesOf.all(ser.id, req.user.id).map((p) => ({ no: p.episode_no, script: JSON.parse(p.script), brief: normalizeBrief(JSON.parse(p.brief)) }));
    if (!eps.length) return res.status(409).json({ error: 'No episodes written yet.' });
    const compose = (prompt, ss, brief) => composeImagePrompt({ imagePrompt: prompt }, ss, brief);
    const name = String(ser.plan?.seriesTitle || ser.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'series';
    if (req.query.format === 'guide') {
      const head = [`# ${ser.plan?.seriesTitle || ser.title}: scripts by VideoExpress service`, '', `${eps.length} episodes. Each one lists its image scripts, video scripts and sound scripts. VideoExpress makes the images, video and sound.`, ''];
      res.set('content-type', 'text/markdown; charset=utf-8').set('content-disposition', `attachment; filename="${name}-scripts-by-service.md"`)
        .send(head.join('\n') + '\n' + eps.map((e) => guideMarkdown(e.script, e.brief, `# Episode ${e.no}: ${e.script.title}`)).join('\n---\n\n'));
    } else if (req.query.format === 'vepack') {
      res.set('content-type', 'text/markdown; charset=utf-8').set('content-disposition', `attachment; filename="${name}-videoexpress-pack.md"`)
        .send(vePackSeriesMarkdown(ser.plan?.seriesTitle || ser.title, eps, normalizeVeSettings(settingsOf(req.user).ve)));
    } else if (req.query.format === 'csv') {
      res.set('content-type', 'text/csv; charset=utf-8').set('content-disposition', `attachment; filename="${name}.csv"`).send(seriesCsv(ser, eps, compose));
    } else {
      const head = [`# ${ser.plan?.seriesTitle || ser.title}`, '', ser.plan?.summary || '', '', `${eps.length} episodes · ${ser.model}`, ''];
      const bible = ser.plan?.bible || {};
      if (bible.visualStyle) head.push(`**Series look:** ${bible.visualStyle}${bible.palette ? ` · palette: ${bible.palette}` : ''}`, '');
      if (bible.narratorVoice) head.push(`**Narrator:** ${bible.narratorVoice}`, '');
      res.set('content-type', 'text/markdown; charset=utf-8').set('content-disposition', `attachment; filename="${name}.md"`)
        .send(head.join('\n') + '\n' + eps.map((e) => episodeMarkdown(e.no, e.script, e.brief, compose)).join('\n---\n\n'));
    }
  });
  app.delete('/api/series/:id', requireAuth, writeLimiter, (req, res) => {
    const ser = getSeries(req, res); if (!ser) return;
    const job = running.get(ser.id); if (job) job.cancel = true;
    db.prepare('DELETE FROM projects WHERE series_id = ? AND user_id = ?').run(ser.id, req.user.id);
    q.delSeries.run(ser.id, req.user.id);
    res.json({ ok: true });
  });

  app.get('/api/system/storage', requireAuth, (req, res) => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only.' });
    res.json({ storage: storage() });
  });

  app.get('/api/usage', requireAuth, (req, res) => {
    const ov = settingsOf(req.user).priceOverrides || {};
    const rows = q.usageMonth.all(req.user.id, monthStart()).map((r) => { const p = priceFor(r.model, ov); return { ...r, cost: costOf(r.model, r.input_tokens, r.output_tokens, ov), price: p ? { in: p.in, out: p.out, source: p.source } : null }; });
    const priced = rows.filter((r) => r.cost != null);
    res.json({ since: monthStart(), rows, cap: cfg.monthlyTokenCap || null, totalCost: priced.reduce((n, r) => n + r.cost, 0), unpricedModels: rows.filter((r) => r.cost == null).map((r) => r.model), pricesSource: PRICES_SOURCE });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---- errors ----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof LlmError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (/did not return valid JSON/.test(err.message)) return res.status(502).json({ error: err.message, code: 'bad_json' });
    console.error('[error]', err.message);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  // ---- static SPA ----
  if (fs.existsSync(cfg.staticDir)) {
    app.use(express.static(cfg.staticDir, { index: false, setHeaders: (res, p) => {
      // Hashed assets never change → cache forever; everything else must revalidate.
      res.setHeader('Cache-Control', /\.[0-9a-f]{10}\.(js|css)$/.test(p) ? 'public, max-age=31536000, immutable' : 'no-cache');
    } }));
    app.get('*', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(cfg.staticDir, 'index.html')); });
  }

  app.locals.db = db;
  app.locals.storage = storage;
  return app;
}
