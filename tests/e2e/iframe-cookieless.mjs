// Regression check for the preview sign-in bug: the app is loaded in a cross-site iframe with ALL cookies
// blocked (as browsers do for third-party frames). Compares HEADER_SESSIONS off vs on.
// Run: node tests/e2e/iframe-cookieless.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 3997;
const APP = `http://127.0.0.1:${PORT}`;

async function startServer(headerSessions, sameSiteNone) {
  for (const f of ['/tmp/ifr.db', '/tmp/ifr.db-wal', '/tmp/ifr.db-shm']) fs.rmSync(f, { force: true });
  const srv = spawn('node', ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATABASE_FILE: '/tmp/ifr.db', APP_ENCRYPTION_KEY: 'x'.repeat(40),
      FRAME_ANCESTORS: '*', HEADER_SESSIONS: headerSessions ? 'true' : 'false',
      ...(sameSiteNone ? { COOKIE_SAMESITE: 'none' } : { COOKIE_SECURE: 'false' }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server start timeout')), 10000);
    srv.stdout.on('data', (d) => { if (/listening/.test(d)) { clearTimeout(t); resolve(); } });
    srv.stderr.on('data', (d) => process.stderr.write(d));
    srv.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
  return srv;
}

// Real browser behaviour, no request rewriting: the parent page is on another site, and Chromium is
// launched with third-party cookies blocked (the default in Safari/Firefox strict and many Chrome setups).
async function run(headerSessions, sameSiteNone, blockPartitioned = false) {
  const srv = await startServer(headerSessions, sameSiteNone);
  const browser = await chromium.launch({ args: ['--test-third-party-cookie-phaseout', '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults'] });
  try {
    const ctx = await browser.newContext();
    await ctx.route('http://parent.test/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><iframe src="${APP}/" style="width:1200px;height:800px"></iframe>`,
    }));
    if (blockPartitioned) {
      // Total cookie blocking (Safari ITP / Brave / "block all cookies"): drop Cookie + Set-Cookie on the wire.
      await ctx.route(`${APP}/**`, async (route) => {
        const h = { ...route.request().headers() }; delete h.cookie;
        const resp = await route.fetch({ headers: h });
        const rh = { ...resp.headers() }; delete rh['set-cookie'];
        await route.fulfill({ response: resp, headers: rh });
      });
    }
    const page = await ctx.newPage();
    await page.goto('http://parent.test/');
    const f = page.frameLocator('iframe');
    await f.locator('#auth-email').waitFor({ timeout: 10000 });
    await f.locator('#auth-email').fill('frame@example.com');
    await f.locator('#auth-password').fill('correct-horse-battery');
    await f.locator('button[type=submit]').click();
    try {
      await f.getByRole('heading', { name: 'Settings', level: 1 }).waitFor({ timeout: 4000 });
      await f.locator('a.nav-link[href="#/studio"]').click();
      await f.locator('#provider').selectOption('demo');
      await f.locator('#concept').fill('A test concept inside an iframe preview.');
      await f.locator('#clipCount').fill('3');
      await f.locator('#generate').click();
      await f.locator('article.clip').nth(2).waitFor({ timeout: 8000 });
      let out = `OK: signed in and generated ${await f.locator('article.clip').count()} clips`;
      await page.reload();
      await page.frameLocator('iframe').locator('a.nav-link[href="#/projects"]').waitFor({ timeout: 5000 });
      out += '; still signed in after reload';
      return out;
    } catch {
      const msgs = await f.locator('.form-error, #toast').allTextContents().catch(() => []);
      return `FAILED: ${msgs.filter((m) => m.trim()).join(' | ') || 'stuck on sign-in screen'}`;
    }
  } finally {
    await browser.close();
    srv.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

const a = await run(false, false);
console.log('A  SameSite=Lax (prod default), fallback off →', a);
const b = await run(false, true);
console.log('B  SameSite=None, 3rd-party cookies blocked, fallback off →', b);
const c = await run(true, true);
console.log('C  SameSite=None, 3rd-party cookies blocked, fallback ON  →', c);
const d = await run(false, true, true);
console.log('D  ALL frame cookies blocked (Safari/Brave-like), fallback off →', d);
const e = await run(true, true, true);
console.log('E  ALL frame cookies blocked (Safari/Brave-like), fallback ON  →', e);
process.exitCode = c.startsWith('OK') && e.startsWith('OK') ? 0 : 1;
