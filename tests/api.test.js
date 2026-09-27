// Integration tests against the real HTTP app (in-memory DB, Demo provider — no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

let server, base;
before(async () => {
  const app = createApp({ dbFile: ':memory:', encryptionKey: 'test-only-'.repeat(5), registration: 'open', cookieSecure: false, staticDir: '/nonexistent', rateScale: 100 });
  server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  globalThis.__db = app.locals.db;
});
after(() => server.close());

function client() {
  let cookie = '', csrf = '';
  const call = async (path, { method = 'GET', body, headers = {}, noCsrf } = {}) => {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (cookie) h.cookie = cookie;
    if (csrf && method !== 'GET' && !noCsrf) h['x-csrf-token'] = csrf;
    const res = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (data.user?.csrfToken) csrf = data.user.csrfToken;
    if (data.csrfToken) csrf = data.csrfToken;
    return { status: res.status, data, headers: res.headers };
  };
  const raw = (path) => fetch(base + path, { headers: cookie ? { cookie } : {} });
  return { call, raw, get cookie() { return cookie; } };
}

test('security headers present', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('full flow: register → key → generate → edit → fit → regenerate → delete', async () => {
  const a = client();
  let r = await a.call('/api/auth/register', { method: 'POST', body: { email: 'owner@example.com', password: 'short' } });
  assert.equal(r.status, 400);
  r = await a.call('/api/auth/register', { method: 'POST', body: { email: 'owner@example.com', password: 'correct-horse-battery' } });
  assert.equal(r.status, 201); assert.equal(r.data.user.isAdmin, true);
  assert.match(a.cookie, /^cs_session=/);

  // save a (fake, synthetic) key — never returned
  r = await a.call('/api/keys/openai', { method: 'PUT', body: { apiKey: 'sk-FAKE-test-key-000000001234' } });
  assert.equal(r.status, 200); assert.equal(r.data.keys[0].last4, '1234');
  assert.ok(!JSON.stringify(r.data).includes('FAKE'));
  const row = globalThis.__db.prepare('SELECT enc FROM api_keys').get();
  assert.ok(!row.enc.includes('sk-FAKE'), 'stored encrypted');
  r = await a.call('/api/keys');
  assert.ok(!JSON.stringify(r.data).includes('FAKE'));

  // generate with demo
  const brief = { concept: 'A small bakery saves itself with a new pastry.', clipCount: 10, clipSeconds: 6, wordsPerSecond: 2.5, paddingSeconds: 0.5 };
  r = await a.call('/api/generate', { method: 'POST', body: { brief, provider: 'demo', model: 'demo-writer' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.project.script.clips.length, 10);
  assert.equal(r.data.analysis.budget, 12); // 6s − 0.5 pad, 10% safety margin
  assert.equal(r.data.analysis.window, 4.95);
  for (const c of r.data.analysis.clips) assert.ok(c.seconds <= c.window, `clip ${c.index} ${c.seconds}s > ${c.window}s`);
  assert.deepEqual(r.data.analysis.overClips, []);
  assert.equal(r.data.project.meta.promptVersion, 'clipscript-v2');
  assert.match(r.data.project.meta.promptHash, /^[0-9a-f]{64}$/);
  const pid = r.data.project.id;
  const script = r.data.project.script;

  // manual edit to go over budget, then fit
  script.clips[2].dialogue = [{ speaker: 'Narrator', line: Array(30).fill('word').join(' ') }];
  r = await a.call('/api/projects', { method: 'POST', body: { id: pid, brief, script } });
  assert.equal(r.status, 200); assert.equal(r.data.project.id, pid);
  r = await a.call('/api/fit', { method: 'POST', body: { brief, script, provider: 'demo', model: 'demo-writer' } });
  assert.equal(r.status, 200); assert.deepEqual(r.data.analysis.overClips, []);

  r = await a.call('/api/regenerate-clip', { method: 'POST', body: { brief, script: r.data.script, index: 4, instruction: 'funnier', provider: 'demo', model: 'demo-writer' } });
  assert.equal(r.status, 200); assert.match(r.data.script.clips[3].beat, /take 2/);

  r = await a.call('/api/projects'); assert.equal(r.data.projects.length, 1); assert.equal(r.data.projects[0].clips, 10);
  r = await a.call('/api/usage'); assert.ok(r.data.rows.length >= 1);

  // missing key for real provider → clear error, no network
  r = await a.call('/api/generate', { method: 'POST', body: { brief, provider: 'anthropic', model: 'claude-sonnet-5' } });
  assert.equal(r.status, 400); assert.equal(r.data.code, 'no_key');

  // validation
  r = await a.call('/api/generate', { method: 'POST', body: { brief: { concept: 'x' }, provider: 'demo', model: 'demo-writer' } });
  assert.equal(r.status, 400); assert.equal(r.data.field, 'concept');
  r = await a.call('/api/generate', { method: 'POST', body: { brief, provider: 'demo', model: 'bad model id!' } });
  assert.equal(r.status, 400);

  r = await a.call(`/api/projects/${pid}`, { method: 'DELETE' }); assert.equal(r.status, 200);
});

test('CSRF + origin + auth enforcement', async () => {
  const a = client();
  await a.call('/api/auth/register', { method: 'POST', body: { email: 'csrf@example.com', password: 'correct-horse-battery' } });
  let r = await a.call('/api/keys/openai', { method: 'PUT', body: { apiKey: 'sk-FAKE-aaaaaaaaaaaa' }, noCsrf: true });
  assert.equal(r.status, 403); assert.equal(r.data.code, 'csrf');
  r = await a.call('/api/keys/openai', { method: 'PUT', body: { apiKey: 'sk-FAKE-aaaaaaaaaaaa' }, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403); assert.equal(r.data.code, 'bad_origin');
  const anon = client();
  r = await anon.call('/api/projects'); assert.equal(r.status, 401);
  r = await anon.call('/api/generate', { method: 'POST', body: {} }); assert.equal(r.status, 401);
});

test('tenant isolation: users cannot see each other\'s projects or keys', async () => {
  const a = client(), b = client();
  await a.call('/api/auth/register', { method: 'POST', body: { email: 'alice@example.com', password: 'correct-horse-battery' } });
  await b.call('/api/auth/register', { method: 'POST', body: { email: 'bob@example.com', password: 'correct-horse-battery' } });
  const g = await a.call('/api/generate', { method: 'POST', body: { brief: { concept: 'alice private concept here', clipCount: 2 }, provider: 'demo', model: 'demo-writer' } });
  const id = g.data.project.id;
  let r = await b.call(`/api/projects/${id}`); assert.equal(r.status, 404);
  r = await b.call(`/api/projects/${id}`, { method: 'DELETE' }); assert.equal(r.status, 404);
  r = await b.call('/api/projects', { method: 'POST', body: { id, brief: { concept: 'hijack attempt!!' } } });
  assert.notEqual(r.data.project?.id, id);
  r = await a.call(`/api/projects/${id}`); assert.equal(r.data.project.brief.concept, 'alice private concept here');
});

test('login, wrong password, logout, account deletion cascades', async () => {
  const a = client();
  await a.call('/api/auth/register', { method: 'POST', body: { email: 'del@example.com', password: 'correct-horse-battery' } });
  await a.call('/api/keys/gemini', { method: 'PUT', body: { apiKey: 'AIzaFAKE000000000000' } });
  const c = client();
  let r = await c.call('/api/auth/login', { method: 'POST', body: { email: 'del@example.com', password: 'nope-nope-nope' } });
  assert.equal(r.status, 401);
  r = await c.call('/api/auth/login', { method: 'POST', body: { email: 'DEL@example.com', password: 'correct-horse-battery' } });
  assert.equal(r.status, 200);
  r = await c.call('/api/auth/logout', { method: 'POST' }); assert.equal(r.status, 200);
  r = await c.call('/api/auth/me'); assert.equal(r.data.user, null);
  r = await a.call('/api/account', { method: 'DELETE', body: { password: 'correct-horse-battery' } }); assert.equal(r.status, 200);
  const n = globalThis.__db.prepare("SELECT COUNT(*) n FROM api_keys k JOIN users u ON u.id=k.user_id WHERE u.email='del@example.com'").get().n;
  assert.equal(n, 0);
  r = await a.call('/api/auth/me'); assert.equal(r.data.user, null);
});

test('custom provider rejects private / non-https base URLs (SSRF guard)', async () => {
  const a = client();
  await a.call('/api/auth/register', { method: 'POST', body: { email: 'ssrf@example.com', password: 'correct-horse-battery' } });
  for (const url of ['http://example.com/v1', 'https://127.0.0.1/v1', 'https://169.254.169.254/latest', 'https://user:pw@example.com', 'not a url']) {
    const r = await a.call('/api/keys/custom', { method: 'PUT', body: { apiKey: 'FAKEKEY-123456789', baseUrl: url } });
    assert.equal(r.status, 400, url);
  }
});

test('rate limiting returns 429', async () => {
  const app = createApp({ dbFile: ':memory:', encryptionKey: 'test-only-'.repeat(5), cookieSecure: false, staticDir: '/nonexistent', rateScale: 0.1 });
  const s = app.listen(0, '127.0.0.1'); await new Promise((r) => s.once('listening', r));
  const url = `http://127.0.0.1:${s.address().port}/api/auth/login`;
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"a@example.com","password":"x"}' })).status);
  s.close();
  assert.ok(codes.includes(429), codes.join(','));
});

test('header-session fallback: off by default, works without cookies when enabled', async () => {
  // default (production): no token in body, header ignored
  const a = client();
  let r = await a.call('/api/auth/register', { method: 'POST', body: { email: 'hdr-off@example.com', password: 'correct-horse-battery' } });
  assert.equal(r.data.sessionToken, undefined);

  const app = createApp({ dbFile: ':memory:', encryptionKey: 'test-only-'.repeat(5), cookieSecure: false, staticDir: '/nonexistent', headerSessions: true });
  const s = app.listen(0, '127.0.0.1'); await new Promise((res) => s.once('listening', res));
  const b = `http://127.0.0.1:${s.address().port}`;
  try {
    // simulate a browser that drops all cookies (blocked third-party cookies in an iframe)
    const j = async (path, { method = 'GET', body, headers = {} } = {}) => {
      const res = await fetch(b + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    r = await j('/api/auth/register', { method: 'POST', body: { email: 'hdr@example.com', password: 'correct-horse-battery' } });
    assert.equal(r.status, 201);
    const tok = r.data.sessionToken, csrf = r.data.user.csrfToken;
    assert.match(tok, /^[A-Za-z0-9_-]{20,}$/);
    r = await j('/api/auth/me'); assert.equal(r.data.user, null, 'no cookie, no header → signed out');
    r = await j('/api/auth/me', { headers: { 'x-session-token': tok } }); assert.equal(r.data.user.email, 'hdr@example.com');
    r = await j('/api/projects', { headers: { 'x-session-token': tok } }); assert.equal(r.status, 200);
    // CSRF still enforced on writes
    r = await j('/api/keys/openai', { method: 'PUT', body: { apiKey: 'sk-FAKE-hdr-00000000' }, headers: { 'x-session-token': tok } });
    assert.equal(r.status, 403);
    r = await j('/api/keys/openai', { method: 'PUT', body: { apiKey: 'sk-FAKE-hdr-00000000' }, headers: { 'x-session-token': tok, 'x-csrf-token': csrf } });
    assert.equal(r.status, 200);
    // malformed / bogus tokens rejected
    r = await j('/api/projects', { headers: { 'x-session-token': 'bogus' } }); assert.equal(r.status, 401);
    r = await j('/api/projects', { headers: { 'x-session-token': 'A'.repeat(43) } }); assert.equal(r.status, 401);
    // logout invalidates the token server-side
    r = await j('/api/auth/logout', { method: 'POST', headers: { 'x-session-token': tok, 'x-csrf-token': csrf } }); assert.equal(r.status, 200);
    r = await j('/api/projects', { headers: { 'x-session-token': tok } }); assert.equal(r.status, 401);
  } finally { s.close(); }
});

test('persistence: keys survive restart with same APP_ENCRYPTION_KEY; wrong key is detected, not a crash', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-persist-'));
  const dbFile = path.join(dir, 'clipscript.db');
  const KEY = 'persist-test-'.repeat(4);
  const boot = async (encryptionKey) => {
    const app = createApp({ dbFile, encryptionKey, cookieSecure: false, staticDir: '/nonexistent', headerSessions: true });
    const s = app.listen(0, '127.0.0.1'); await new Promise((r) => s.once('listening', r));
    const u = `http://127.0.0.1:${s.address().port}`;
    const j = async (p, { method = 'GET', body, headers = {} } = {}) => {
      const r = await fetch(u + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };
    return { app, s, j };
  };
  const login = async (j) => {
    const r = await j('/api/auth/login', { method: 'POST', body: { email: 'persist@example.com', password: 'correct-horse-battery' } });
    return { 'x-session-token': r.data.sessionToken, 'x-csrf-token': r.data.user?.csrfToken };
  };

  // 1st "deploy": create account + save key
  let b = await boot(KEY);
  let r = await b.j('/api/auth/register', { method: 'POST', body: { email: 'persist@example.com', password: 'correct-horse-battery' } });
  let hd = { 'x-session-token': r.data.sessionToken, 'x-csrf-token': r.data.user.csrfToken };
  r = await b.j('/api/keys/openai', { method: 'PUT', body: { apiKey: 'sk-FAKE-persist-00004321' }, headers: hd });
  assert.equal(r.status, 200);
  r = await b.j('/api/system/storage', { headers: hd });
  assert.equal(r.status, 200); assert.equal(r.data.storage.encryptionKey, 'ok'); assert.equal(r.data.storage.counts.keys, 1);
  b.s.close(); b.app.locals.db.close();

  // 2nd "deploy", same key: account + key still there, and decryptable (demo call uses credentials path for openai → expect decrypt OK then network; so check via keys list + storage)
  b = await boot(KEY);
  hd = await login(b.j);
  r = await b.j('/api/keys', { headers: hd }); assert.equal(r.data.keys[0].last4, '4321');
  r = await b.j('/api/system/storage', { headers: hd }); assert.equal(r.data.storage.encryptionKey, 'ok');
  b.s.close(); b.app.locals.db.close();

  // 3rd "deploy", DIFFERENT key: detected, and using the key gives a clear 409 (no 500)
  b = await boot('a-different-key-'.repeat(3));
  hd = await login(b.j);
  r = await b.j('/api/system/storage', { headers: hd }); assert.equal(r.data.storage.encryptionKey, 'mismatch');
  r = await b.j('/api/keys/openai/test', { method: 'POST', headers: hd });
  assert.equal(r.status, 409); assert.equal(r.data.code, 'key_undecryptable');
  // re-entering the key fixes it
  r = await b.j('/api/keys/openai', { method: 'PUT', body: { apiKey: 'sk-FAKE-persist-00009999' }, headers: hd });
  assert.equal(r.status, 200);
  b.s.close(); b.app.locals.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('storage endpoint is admin-only', async () => {
  const a = client(), b2 = client();
  await a.call('/api/auth/register', { method: 'POST', body: { email: 'nonadmin@example.com', password: 'correct-horse-battery' } });
  const r = await a.call('/api/system/storage');
  assert.equal(r.status, 403); // owner@example.com is the admin in this DB
  void b2;
});

test('faceless reel from raw data: generate, faceless guard, regenerate, listing', async () => {
  const a = client();
  let r = await a.call('/api/auth/register', { method: 'POST', body: { email: 'reels@example.com', password: 'correct-horse-battery' } });
  assert.equal(r.status, 201);
  const sourceData = 'Honeybees visit about 2 million flowers to make one pound of honey. A colony can hold 60,000 bees in summer. Worker bees live about 6 weeks. Bees communicate with a waggle dance. Honey never spoils when sealed.';
  r = await a.call('/api/generate', { method: 'POST', body: { brief: { mode: 'reel', sourceData: 'tiny' }, provider: 'demo', model: 'demo-writer' } });
  assert.equal(r.status, 400, 'short data rejected');
  r = await a.call('/api/generate', { method: 'POST', body: { brief: { mode: 'reel', sourceData, dialogueMode: 'dialogue' }, provider: 'demo', model: 'demo-writer' } });
  assert.equal(r.status, 400, 'on-camera dialogue rejected for reels');
  const brief = { mode: 'reel', sourceData, clipCount: 5, clipSeconds: 6, wordsPerSecond: 2.5, paddingSeconds: 0.5, dialogueMode: 'voiceover', aspectRatio: '9:16', reelStructure: 'did-you-know', callToAction: 'Follow for more bee facts', title: 'Bees are wild' };
  r = await a.call('/api/generate', { method: 'POST', body: { brief, provider: 'demo', model: 'demo-writer' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { project, analysis } = r.data;
  assert.equal(project.brief.mode, 'reel');
  assert.equal(project.brief.sourceData, sourceData);
  assert.equal(project.script.clips.length, 5);
  assert.deepEqual(project.script.styleSheet.characters, []);
  assert.equal(analysis.overClips.length, 0);
  for (const c of project.script.clips) {
    assert.ok(c.onScreenText.length > 0, 'every clip has on-screen text');
    assert.match(c.imagePrompt, /No people, no faces/);
    for (const l of c.dialogue) assert.equal(l.speaker, 'Narrator');
  }
  assert.match(project.script.clips[1].dialogue[0].line + project.script.clips[2].dialogue[0].line, /colony|flowers|Worker|bees/i, 'narration comes from the data');
  assert.match(project.script.clips.at(-1).onScreenText, /Follow for more bee facts/);
  // regenerate one clip stays faceless
  r = await a.call('/api/regenerate-clip', { method: 'POST', body: { brief: project.brief, script: project.script, index: 2, provider: 'demo', model: 'demo-writer' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.script.styleSheet.characters, []);
  assert.match(r.data.script.clips[1].beat, /take 2/);
  r = await a.call('/api/projects');
  assert.equal(r.data.projects[0].mode, 'reel');
});

test('cut-off protection: a line that fits by word count but not by speaking time is caught and fixed', async () => {
  const a = client();
  await a.call('/api/auth/register', { method: 'POST', body: { email: 'cutoff@example.com', password: 'correct-horse-battery' } });
  const brief = { concept: 'Numbers heavy explainer clip here.', clipCount: 1, clipSeconds: 5, wordsPerSecond: 2.5, paddingSeconds: 0.5, safetyMargin: 10 };
  // 9 written words (budget 10) — but "1998", "FBI", "$2.5M" and "40%" are read as many more words.
  const line = 'In 1998 the FBI spent $2.5M, about 40%.';
  const script = { title: 'T', styleSheet: { characters: [] }, clips: [{ beat: 'b', imagePrompt: 'i', videoPrompt: 'v', dialogue: [{ speaker: 'Narrator', line }] }] };
  let r = await a.call('/api/projects', { method: 'POST', body: { brief, script } });
  assert.equal(r.status, 200);
  r = await a.call('/api/fit', { method: 'POST', body: { brief, script, provider: 'demo', model: 'demo-writer' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = r.data.analysis.clips[0];
  assert.ok(c.seconds <= c.window && c.spokenWords <= c.budget, JSON.stringify(c));
  const out = r.data.script.clips[0].dialogue.map((l) => l.line).join(' ');
  assert.match(out, /[.!?]$/, 'ends on a complete sentence');
});

test('series: dump → analyze → plan edit → write → episodes as projects → export → tenant isolation → delete', async () => {
  const a = client(), b = client();
  await a.call('/api/auth/register', { method: 'POST', body: { email: 'series@example.com', password: 'correct-horse-battery' } });
  await b.call('/api/auth/register', { method: 'POST', body: { email: 'series-b@example.com', password: 'correct-horse-battery' } });
  const facts = [
    'Dogs have about 300 million scent receptors compared with about 6 million in humans.',
    "A dog's nose print is unique, much like a human fingerprint, and can be used to identify them.",
    'Dalmatian puppies are born completely white and only develop their spots as they grow older.',
    'Greyhounds can reach speeds of up to 45 miles per hour in a sprint.',
    'Basenjis do not bark at all; they make a yodel-like sound.',
    'Dogs sweat mostly through the pads of their paws.',
    'Puppies are born deaf and blind.',
    'Dogs have three eyelids on each eye.',
  ].join('\n');
  let r = await a.call('/api/series', { method: 'POST', body: { brief: { sourceData: 'too short' }, provider: 'demo', model: 'demo-writer' } });
  assert.equal(r.status, 400);
  r = await a.call('/api/series', { method: 'POST', body: { brief: { sourceData: facts, clipSeconds: 8 }, options: { minSeconds: 15, maxSeconds: 60, frames: 'both' }, provider: 'demo', model: 'demo-writer' } });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const id = r.data.series.id;
  const until = async (pred) => { for (let i = 0; i < 200; i++) { const x = await a.call(`/api/series/${id}`); if (pred(x.data)) return x.data; await new Promise((res) => setTimeout(res, 25)); } throw new Error('timeout'); };
  let d = await until((x) => x.series.status !== 'analyzing');
  assert.equal(d.series.status, 'planned', d.series.error);
  assert.equal(d.series.stats.facts, 8);
  const placed = d.series.plan.episodes.flatMap((e) => e.factIds);
  assert.equal(new Set(placed).size, 8, 'every fact lands in exactly one episode');
  assert.ok(d.series.plan.episodes.every((e) => e.targetSeconds >= 15 && e.targetSeconds <= 60));
  // other tenant cannot see it
  assert.equal((await b.call(`/api/series/${id}`)).status, 404);
  assert.equal((await b.call(`/api/series/${id}/write`, { method: 'POST', body: {} })).status, 404);
  // edit plan: skip the last episode, change a length
  const last = d.series.plan.episodes.at(-1).no;
  r = await a.call(`/api/series/${id}/plan`, { method: 'PUT', body: { episodes: [{ no: last, include: false }, { no: 1, targetSeconds: 30 }] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.series.plan.episodes[0].targetSeconds, 30);
  r = await a.call(`/api/series/${id}/write`, { method: 'POST', body: {} });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(r.data.queued, d.series.plan.episodes.length - 1);
  d = await until((x) => !x.running && x.series.status !== 'writing');
  assert.equal(d.series.status, 'done', d.series.error);
  assert.equal(d.episodes.length, d.series.plan.episodes.length - 1, 'skipped episode not written');
  const ep1 = d.episodes.find((e) => e.no === 1);
  assert.ok(Math.abs(ep1.analysis.seconds - 30) <= 12, `ep1 ${ep1.analysis.seconds}s vs 30s target`);
  // episode = a normal project in narration layout, with first+last frames, and not in the project list
  const p = (await a.call(`/api/projects/${ep1.projectId}`)).data.project;
  assert.equal(p.brief.layout, 'narration'); assert.equal(p.brief.seriesId, id); assert.equal(p.seriesId, id);
  assert.ok(p.script.clips.every((c) => c.imagePrompt && c.lastFramePrompt), 'frames=both → every clip has a last frame');
  assert.ok(p.script.narration.length > 50);
  assert.deepEqual(p.script.clips.map((c) => c.dialogue.map((l) => l.line).join(' ')).join(' ').split(/\s+/), p.script.narration.split(/\s+/), 'clips carry the whole narration');
  assert.ok(p.script.clips.every((c) => !/\b(man|woman|person|face)\b/i.test(c.imagePrompt) || /No people/i.test(c.imagePrompt)));
  assert.ok(!(await a.call('/api/projects')).data.projects.some((x) => x.id === ep1.projectId), 'episodes are grouped under the series');
  // re-running with nothing pending is a 400, rewriting a specific episode works
  assert.equal((await a.call(`/api/series/${id}/write`, { method: 'POST', body: {} })).status, 400);
  r = await a.call(`/api/series/${id}/write`, { method: 'POST', body: { episodes: [1] } });
  assert.equal(r.status, 202);
  d = await until((x) => !x.running && x.series.status !== 'writing');
  assert.equal(d.episodes.find((e) => e.no === 1).projectId, ep1.projectId, 'rewrite updates the same project');
  // polish the whole series: every written episode reaches 95+, scores show in the series view
  r = await a.call(`/api/series/${id}/polish`, { method: 'POST', body: { rounds: 2 } });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(r.data.job.total, d.episodes.length);
  d = await until((x) => x.polish && x.polish.status !== 'running');
  assert.equal(d.polish.status, 'done', d.polish.error);
  assert.equal(d.polish.done, d.episodes.length);
  for (const e of d.episodes) assert.ok(d.quality[e.no] >= 95, `episode ${e.no} scored ${d.quality[e.no]}`);
  const pe = (await a.call(`/api/projects/${ep1.projectId}`)).data.project;
  assert.equal(pe.brief.layout, 'narration', 'layout kept');
  assert.equal(pe.meta.quality.rounds, 1);
  assert.deepEqual(pe.script.clips.map((c) => c.dialogue.map((l) => l.line).join(' ')).join(' ').split(/\s+/), p.script.narration.split(/\s+/), 'narration untouched by repair');
  r = await a.call(`/api/series/${id}/polish`, { method: 'POST', body: {} });
  assert.equal(r.status, 409, 'nothing left below target');
  // exports
  const csv = await a.raw(`/api/series/${id}/export?format=csv`);
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/);
  const body = await csv.text();
  assert.match(body.split('\r\n')[0], /first_frame_prompt.*last_frame_prompt/);
  const md = await (await a.raw(`/api/series/${id}/export?format=md`)).text();
  assert.match(md, /# Episode 1:/); assert.match(md, /\*\*Last frame:\*\*/);
  const guide = await (await a.raw(`/api/series/${id}/export?format=guide`)).text();
  assert.match(guide, /## 1 · Image scripts/); assert.match(guide, /## 2 · Video scripts/); assert.match(guide, /## 3 · Sound scripts/); assert.match(guide, /First & Last Frame/);
  // build-progress checkmarks persist on the episode project
  r = await a.call('/api/projects', { method: 'POST', body: { id: ep1.projectId, brief: p.brief, script: { ...p.script, buildProgress: { 'img-1-first': true } } } });
  assert.equal(r.status, 200);
  assert.deepEqual((await a.call(`/api/projects/${ep1.projectId}`)).data.project.script.buildProgress, { 'img-1-first': true });
  // usage recorded per step
  const u = (await a.call('/api/usage')).data;
  const calls = u.rows.reduce((n, x) => n + x.calls, 0);
  assert.ok(calls >= 2 + d.episodes.length + 1, `every extract/plan/episode call metered (${calls})`);
  // list + delete cascades to episode projects
  assert.equal((await a.call('/api/series')).data.series.length, 1);
  assert.equal((await a.call(`/api/series/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await a.call(`/api/projects/${ep1.projectId}`)).status, 404);
});

test('series: no key for provider → clear error before any job starts', async () => {
  const a = client();
  await a.call('/api/auth/register', { method: 'POST', body: { email: 'series-nokey@example.com', password: 'correct-horse-battery' } });
  const r = await a.call('/api/series', { method: 'POST', body: { brief: { sourceData: 'Dogs have three eyelids. Puppies are born deaf. Basenjis yodel instead of bark.' }, provider: 'openai', model: 'gpt-5.6' } });
  assert.ok(r.status >= 400 && r.status < 500, String(r.status));
  assert.equal((await a.call('/api/series')).data.series.length, 0);
});

test('cost estimates: usage report prices gpt-5.6-luna, user price overrides, series cost block', async () => {
  const a = client();
  await a.call('/api/auth/register', { method: 'POST', body: { email: 'cost@example.com', password: 'correct-horse-battery' } });
  let r = await a.call('/api/settings', { method: 'PUT', body: { priceOverrides: { 'demo-writer': { in: 1, out: 2 }, junk: { in: 'x' } } } });
  assert.deepEqual(r.data.settings.priceOverrides, { 'demo-writer': { in: 1, out: 2 } });
  r = await a.call('/api/generate', { method: 'POST', body: { brief: { concept: 'A bakery story for a local ad, warm.', clipCount: 2, clipSeconds: 8 }, provider: 'demo', model: 'demo-writer' } });
  assert.equal(r.status, 200);
  const u = (await a.call('/api/usage')).data;
  const row = u.rows.find((x) => x.model === 'demo-writer');
  assert.equal(row.price.source, 'yours');
  assert.ok(Math.abs(row.cost - (row.input_tokens * 1 + row.output_tokens * 2) / 1e6) < 1e-9);
  assert.ok(Math.abs(u.totalCost - row.cost) < 1e-12);
  assert.match(u.pricesSource, /OpenAI/);
  // series exposes spent + remaining estimate
  r = await a.call('/api/series', { method: 'POST', body: { brief: { sourceData: 'Dogs have three eyelids on each eye.\nPuppies are born deaf and blind.\nBasenjis yodel instead of barking.' }, provider: 'demo', model: 'demo-writer' } });
  const id = r.data.series.id;
  let d; for (let i = 0; i < 100; i++) { d = (await a.call(`/api/series/${id}`)).data; if (d.series.status !== 'analyzing') break; await new Promise((x) => setTimeout(x, 25)); }
  assert.equal(d.cost.priced, true);
  assert.ok(d.cost.spent > 0);
  assert.equal(d.cost.remaining.episodes, d.series.plan.episodes.length);
  assert.ok(d.cost.remaining.range.hi >= d.cost.remaining.range.lo);
  assert.equal(d.cost.remaining.basedOn, 'estimate');
});

test('polish loop: analyze → repair → analyze reaches 95+, keeps the best version, score-only, errors', async () => {
  const a = client();
  await a.call('/api/auth/register', { method: 'POST', body: { email: 'polish@example.com', password: 'correct-horse-battery' } });
  const sourceData = 'Honeybees visit about two million flowers to make one pound of honey. A single bee makes about one twelfth of a teaspoon in its life. Bees communicate with a waggle dance that points to food. A colony can hold sixty thousand bees in summer.';
  const brief = { mode: 'reel', sourceData, clipCount: 4, clipSeconds: 6, dialogueMode: 'voiceover', aspectRatio: '9:16', title: 'Bees' };
  let r = await a.call('/api/generate', { method: 'POST', body: { brief, provider: 'demo', model: 'demo-writer' } });
  assert.equal(r.status, 200);
  const id = r.data.project.id;
  const until = async () => { for (let i = 0; i < 200; i++) { const x = await a.call(`/api/projects/${id}/polish`); if (x.data.job && x.data.job.status !== 'running') return x.data; await new Promise((res) => setTimeout(res, 25)); } throw new Error('timeout'); };
  // score only (rounds 0): no changes, score below target
  const before = (await a.call(`/api/projects/${id}`)).data.project.script;
  r = await a.call(`/api/projects/${id}/polish`, { method: 'POST', body: { provider: 'demo', model: 'demo-writer', rounds: 0 } });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  let d = await until();
  assert.equal(d.job.status, 'done', d.job.error);
  assert.ok(d.quality.score < 95 && d.quality.score > 60, `first read ${d.quality.score}`);
  assert.equal(d.quality.rounds, 0);
  assert.ok(d.quality.issues.length > 0);
  let p = (await a.call(`/api/projects/${id}`)).data.project;
  assert.deepEqual(p.script.clips.map((c) => c.imagePrompt), before.clips.map((c) => c.imagePrompt), 'score-only changes nothing');
  // polish: one repair gets it to 95+
  r = await a.call(`/api/projects/${id}/polish`, { method: 'POST', body: { provider: 'demo', model: 'demo-writer' } });
  assert.equal(r.status, 202);
  d = await until();
  assert.equal(d.job.status, 'done', d.job.error);
  assert.ok(d.quality.score >= 95, `polished ${d.quality.score}`);
  assert.equal(d.quality.reached, true);
  assert.deepEqual(d.quality.history.map((h) => h.round), [0, 1]);
  assert.ok(d.job.log.length >= 2);
  p = (await a.call(`/api/projects/${id}`)).data.project;
  assert.equal(p.script.clips.length, 4, 'clip count kept');
  assert.deepEqual(p.script.styleSheet.characters, [], 'still faceless');
  assert.ok(p.script.clips.every((c) => /polished/.test(c.imagePrompt)), 'repair saved');
  assert.equal(p.meta.quality.score, d.quality.score);
  assert.ok(p.meta.usage.output > 0);
  // errors: unknown project, missing key, other users
  assert.equal((await a.call('/api/projects/999999/polish', { method: 'POST', body: { provider: 'demo', model: 'demo-writer' } })).status, 404);
  r = await a.call(`/api/projects/${id}/polish`, { method: 'POST', body: { provider: 'openai', model: 'gpt-5.6-sol' } });
  assert.ok(r.status >= 400 && r.status < 500 && /key/i.test(r.data.error), JSON.stringify(r.data));
  const b = client();
  await b.call('/api/auth/register', { method: 'POST', body: { email: 'polish-b@example.com', password: 'correct-horse-battery' } });
  assert.equal((await b.call(`/api/projects/${id}/polish`)).status, 404);
  assert.equal((await b.call(`/api/projects/${id}/polish`, { method: 'POST', body: { provider: 'demo', model: 'demo-writer' } })).status, 404);
});
