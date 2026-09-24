// E2E + A11Y + VISUAL + PERF against the PRODUCTION build (dist/ served by server/index.js).
// Uses the Demo provider — no external network or real keys.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'artifacts/evidence';
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync('/tmp/cs-e2e.db', { force: true }); fs.rmSync('/tmp/cs-e2e.db-wal', { force: true }); fs.rmSync('/tmp/cs-e2e.db-shm', { force: true });

const srv = spawn('node', ['server/index.js'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATABASE_FILE: '/tmp/cs-e2e.db', APP_ENCRYPTION_KEY: 'e2e-only-'.repeat(6), NODE_ENV: 'production', COOKIE_SECURE: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => { srv.stdout.on('data', (d) => /listening/.test(d) && res()); srv.stderr.on('data', (d) => process.stderr.write(d)); setTimeout(() => rej(new Error('server start timeout')), 10000); });

const results = { steps: [], axe: {}, visual: [], perf: {}, keyboard: [], consoleErrors: [] };
const step = (name, ok, detail = '') => { results.steps.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };

const vis = async (loc, timeout = 5000) => { try { await loc.first().waitFor({ state: 'visible', timeout }); return true; } catch { return false; } };
const browser = await chromium.launch();
const version = browser.version();
results.browser = `chromium-headless-shell@${version}`;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();
  const EXPECTED_4XX = new Set(['POST /api/auth/register 400', 'GET /api/projects/999999 404']);
  results.httpErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) results.consoleErrors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) { const k = `${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`; results.httpErrors.push(k); if (!EXPECTED_4XX.has(k)) results.consoleErrors.push(`unexpected HTTP ${k}`); } });
  page.on('pageerror', (e) => results.consoleErrors.push(String(e)));

  // PERF: cold load
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.getByRole('heading', { name: 'ClipScript Studio' }).waitFor();
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const fcp = performance.getEntriesByName('first-contentful-paint')[0]; return { domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), fcp: fcp ? Math.round(fcp.startTime) : null, transferBytes: performance.getEntriesByType('resource').reduce((s, r) => s + (r.transferSize || 0), n.transferSize || 0) }; });
  results.perf.coldLoad = { ...nav, wallToAuthFormMs: Date.now() - t0, method: 'Playwright navigation timing, localhost, no throttling (lab, approximate)' };
  step('auth screen renders (first user → create admin)', await vis(page.getByText('Create the first (admin) account')));
  results.axe.auth = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations;

  // Register
  await page.getByLabel('Email').fill('e2e@example.com');
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();
  step('short password rejected with message', await vis(page.getByRole('alert').filter({ hasText: '10' })));
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
  step('registered → lands on Settings (no keys yet)', true);

  // Save a synthetic key, verify masking
  await page.getByLabel('OpenAI', { exact: false }).first().fill('sk-FAKE-e2e-000000009999');
  await page.locator('.keyrow').first().getByRole('button', { name: 'Save' }).click();
  await page.getByText('•••• 9999', { exact: false }).or(page.locator('input[placeholder*="9999"]')).first().waitFor();
  const html = await page.content();
  step('saved key is masked and not present in DOM', !html.includes('sk-FAKE-e2e'));
  results.axe.settings = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations;

  // Studio: choose demo provider
  await page.getByRole('link', { name: 'Studio', exact: true }).click();
  await page.getByLabel('Provider', { exact: true }).selectOption('demo');
  await page.getByLabel('What is the video about?').fill('A small-town baker saves her shop with one bold new recipe.');
  await page.getByLabel('Clips (1–10)').fill('10');
  await page.getByLabel('Clip length', { exact: true }).selectOption('5');
  const budgetText = await page.locator('#budget-out').textContent();
  step('live budget shown (5s, 2.5 w/s, 0.5 pad, 10% margin → 10 words, 4.05s)', /≤ 10 words · ≤ 4\.05s of speech per clip/.test(budgetText) && /50s video/.test(budgetText), budgetText);
  // empty-state / validation
  await page.getByLabel('What is the video about?').fill('short');
  await page.getByRole('button', { name: 'Generate script' }).click();
  step('validation error for too-short concept', await vis(page.locator('#gen-error').filter({ hasText: 'at least 10' })));
  await page.getByLabel('What is the video about?').fill('A small-town baker saves her shop with one bold new recipe.');
  await page.getByRole('button', { name: 'Generate script' }).click();
  await page.locator('article.clip').nth(9).waitFor({ timeout: 15000 });
  const clips = await page.locator('article.clip').count();
  step('core outcome: 10 clips generated', clips === 10, `clips=${clips}`);
  const statuses = await page.locator('article.clip').evaluateAll((els) => els.map((e) => e.dataset.status));
  step('every clip within word budget', statuses.every((s) => s === 'ok' || s === 'tight'), statuses.join(','));
  const parts = await page.locator('article.clip').first().locator('h4').allTextContents();
  step('each clip has image, video and dialogue parts', /Image prompt|First frame/.test(parts.join('|')) && parts.join('|').includes('Video (motion prompt)') && /dialogue/i.test(parts.join('|')), parts.join(' | '));
  step('style sheet with character shown', await page.locator('#ch-name-0').inputValue() === 'Maya');

  // Copy image prompt → clipboard contains style + character
  await page.locator('#clip-2').getByRole('button', { name: /Copy image prompt/i }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  step('copied image prompt embeds character sheet + style + aspect', /Maya: woman in her early 30s/.test(clip) && /Style: cinematic/.test(clip) && /Aspect ratio 9:16/.test(clip), clip.slice(0, 120) + '…');

  // Edit dialogue over budget → meter goes red, fit button appears, fit fixes
  const long = Array(25).fill('extra').join(' ');
  await page.locator('#clip-1-line-0').fill(long);
  step('live meter flags over-budget edit', (await page.locator('#clip-1').getAttribute('data-status')) === 'over' && await vis(page.locator('#clip-1-meter').filter({ hasText: 'cut off' })), await page.locator('#clip-1-meter').textContent());
  // fits by word count but numbers/acronyms make it too long to say → caught, with explanation
  await page.locator('#clip-1-line-0').fill('In 1998 the FBI spent $2.5M, about 40%.');
  const mt = await page.locator('#clip-1-meter').textContent();
  step('cut-off guard: short-looking line with numbers flagged by speaking time', (await page.locator('#clip-1').getAttribute('data-status')) === 'over' && /read aloud/i.test(mt) && /1998 → "nineteen ninety eight"/.test(mt), mt.slice(0, 160));
  const sb = await page.locator('#safetyMargin').inputValue();
  step('safety margin control present (default 10%)', sb === '10');
  await page.waitForTimeout(1000);
  await page.locator('#embedStyle').click(); await page.locator('#embedStyle').click(); // forces panel re-render → fit button
  await page.getByRole('button', { name: /Fit 1 clip to budget/ }).click();
  await page.getByText('All clips now fit').waitFor({ timeout: 10000 });
  step('"Fit to budget" rewrites the over clip', (await page.locator('#clip-1').getAttribute('data-status')) !== 'over');

  // Rewrite single clip
  await page.locator('#clip-4-regen').fill('closer shot');
  await page.locator('#clip-4-regen-btn').click();
  await page.getByText('Clip 4 rewritten').waitFor({ timeout: 10000 });
  step('single clip rewrite works', /take 2/.test(await page.locator('#clip-4-h').textContent()));

  // Export
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV' }).click()]);
  const csvPath = `${OUT}/export.csv`; await dl.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, 'utf8');
  step('CSV export has header + 10 rows', csv.trim().split('\r\n').length === 11);
  results.axe.studio = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations;

  // Persistence: projects list + reopen after reload
  await page.waitForTimeout(1200);
  await page.reload();
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page.getByRole('link', { name: 'The Bakery on Harbor Street' }).click();
  await page.locator('article.clip').nth(9).waitFor();
  step('project persists across reload and reopens', (await page.locator('#clip-4-h').textContent()).includes('take 2'));
  results.axe.projects = null;
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page.getByRole('heading', { name: 'Projects', level: 1 }).waitFor();
  await page.locator('.prow').first().waitFor();
  results.axe.projects = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations;

  // Keyboard pass: skip link, nav, reach generate button via Tab only
  await page.getByRole('link', { name: 'Studio', exact: true }).click();
  await page.locator('#concept').waitFor();
  await page.keyboard.press('Tab');
  let active = await page.evaluate(() => document.activeElement.textContent);
  results.keyboard.push(`first Tab → "${active}"`);
  step('keyboard: first Tab focuses skip link', active === 'Skip to content');
  let reached = false; const seen = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => { const a = document.activeElement; const cs = getComputedStyle(a); return { id: a.id, tag: a.tagName, text: (a.textContent || '').trim().slice(0, 30), outline: cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px' }; });
    seen.push(info);
    if (info.id === 'generate') { reached = true; break; }
  }
  const unfocusedVisible = seen.filter((s) => !s.outline).map((s) => s.id || s.text);
  results.keyboard.push(`tab stops to Generate: ${seen.length}`, `stops lacking visible outline: ${JSON.stringify(unfocusedVisible)}`);
  step('keyboard: Generate reachable by Tab with visible focus on every stop', reached && unfocusedVisible.length === 0, `${seen.length} stops`);

  // Target size check (WCAG 2.2 AA 2.5.8 ≥24×24) for interactive elements in studio
  const small = await page.evaluate(() => [...document.querySelectorAll('button, a, input:not([type=hidden]), select, textarea, summary')].filter((e) => e.offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(); return { t: e.id || e.textContent.trim().slice(0, 20) || e.tagName, w: Math.round(r.width), h: Math.round(r.height) }; }).filter((r) => (r.w < 24 || r.h < 24) && !(r.t === 'embedStyle' || r.t === 'autoFit')));
  results.targetSizeUnder24 = small;
  step('pointer targets ≥ 24×24 CSS px (checkbox inputs excepted: label enlarges target)', small.length === 0, JSON.stringify(small).slice(0, 200));

  // VISUAL matrix
  const shots = [
    { name: 'studio-1280-light', w: 1280, h: 900, scheme: 'light' },
    { name: 'studio-1280-dark', w: 1280, h: 900, scheme: 'dark' },
    { name: 'studio-768-light', w: 768, h: 1024, scheme: 'light' },
    { name: 'studio-320-light', w: 320, h: 720, scheme: 'light' },
    { name: 'studio-320-dark-reduced-motion', w: 320, h: 720, scheme: 'dark', motion: 'reduce' },
  ];
  for (const s of shots) {
    const c = await browser.newContext({ viewport: { width: s.w, height: s.h }, colorScheme: s.scheme, reducedMotion: s.motion || 'no-preference', storageState: await ctx.storageState() });
    const p = await c.newPage();
    await p.goto(`${BASE}/#/projects`); await p.locator('.prow a').first().click();
    await p.locator('article.clip').first().waitFor();
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await p.screenshot({ path: `${OUT}/${s.name}.png`, fullPage: false });
    let axeV = null;
    if (s.scheme === 'dark') axeV = (await new AxeBuilder({ page: p }).withTags(['wcag2aa']).analyze()).violations.map((v) => v.id);
    results.visual.push({ ...s, horizontalOverflowPx: overflow, axeDark: axeV });
    step(`visual ${s.name}: no horizontal scroll`, overflow <= 0, `overflow=${overflow}px`);
    if (axeV) step(`visual ${s.name}: axe AA clean in dark scheme`, axeV.length === 0, axeV.join(','));
    await c.close();
  }
  // 400% zoom ≈ 320 CSS px at 1280 device px: covered by the 320 run; 200% zoom ≈ 640 CSS px:
  {
    const c = await browser.newContext({ viewport: { width: 640, height: 450 }, storageState: await ctx.storageState() });
    const p = await c.newPage(); await p.goto(`${BASE}/#/settings`); await p.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await p.screenshot({ path: `${OUT}/settings-640-zoom200.png` });
    step('reflow at 200% zoom equivalent (640 CSS px): no horizontal scroll', overflow <= 0, `overflow=${overflow}px`);
    await c.close();
  }

  // ---- Reels: raw data → faceless reel, randomize all / per-field / lock / seed replay ----
  {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('link', { name: 'Reels', exact: true }).click();
    await page.locator('#sourceData').waitFor();
    step('reels: section reachable from nav with empty state', await vis(page.getByRole('heading', { name: 'Your faceless reel will appear here' })));
    const hint = await page.locator('.rand-hint').textContent();
    step('reels: randomizer advertises combination count (≥ millions)', /(million|billion|trillion|quadrillion)/.test(hint), hint.trim());
    await page.getByRole('button', { name: 'Generate faceless reel' }).click();
    step('reels: validation asks for raw data', await vis(page.locator('#gen-error').filter({ hasText: 'raw data' })));
    const DATA = 'Octopuses have three hearts and blue blood. They can taste with their arms, which hold about two thirds of their neurons. Some species live only one year. In 2021 researchers filmed octopuses throwing shells at each other. An octopus can squeeze through any gap larger than its beak.';
    await page.locator('#sourceData').fill(DATA);
    step('reels: live source stats', /\d+ numbers? · \d+ dates?/.test(await page.locator('#source-stats').textContent()));
    await page.getByRole('button', { name: 'Randomize all' }).click();
    const b1 = await page.evaluate(() => ({ title: document.querySelector('#title').value, concept: document.querySelector('#concept').value, style: document.querySelector('#visualStyle').value, tone: document.querySelector('#tone').value, count: document.querySelector('#clipCount').value, src: document.querySelector('#sourceData').value, seed: document.querySelector('.seed-box summary').textContent }));
    step('reels: Randomize all fills every field and keeps the raw data', b1.title && b1.concept && b1.style && b1.tone && Number(b1.count) >= 2 && b1.src === DATA, JSON.stringify(b1).slice(0, 200));
    // lock the title, randomize again → title unchanged, others change
    await page.locator('#lock-title').click();
    step('reels: lock toggles aria-pressed', (await page.locator('#lock-title').getAttribute('aria-pressed')) === 'true');
    await page.getByRole('button', { name: 'Randomize all' }).click();
    const b2 = await page.evaluate(() => ({ title: document.querySelector('#title').value, style: document.querySelector('#visualStyle').value, concept: document.querySelector('#concept').value }));
    step('reels: locked field survives Randomize all', b2.title === b1.title && (b2.style !== b1.style || b2.concept !== b1.concept));
    step('reels: dice disabled on a locked field', await page.locator('#dice-title').isDisabled());
    // per-field dice
    const toneBefore = await page.locator('#tone').inputValue();
    let changed = false;
    for (let i = 0; i < 5 && !changed; i++) { await page.locator('#dice-tone').click(); changed = (await page.locator('#tone').inputValue()) !== toneBefore; }
    step('reels: per-field dice re-rolls just that field', changed && (await page.locator('#title').inputValue()) === b1.title);
    // seed replay reproduces
    await page.locator('#lock-title').click();
    await page.getByRole('button', { name: 'Randomize all' }).click();
    const seed = (await page.locator('.seed-box summary').textContent()).replace(/\D/g, '');
    const snap = await page.locator('#concept').inputValue() + '|' + await page.locator('#visualStyle').inputValue();
    await page.getByRole('button', { name: 'Randomize all' }).click();
    await page.locator('.seed-box summary').click();
    await page.locator('#seed').fill(seed);
    await page.getByRole('button', { name: 'Replay' }).click();
    const snap2 = await page.locator('#concept').inputValue() + '|' + await page.locator('#visualStyle').inputValue();
    step('reels: seed replay reproduces the same roll', snap === snap2, `seed ${seed}`);
    const opts = await page.locator('#dialogueMode option').allTextContents();
    step('reels: no on-camera dialogue options offered', opts.length === 2 && !opts.some((o) => /on-camera|Mixed/.test(o)), opts.join(' / '));
    await page.getByLabel('Provider', { exact: true }).selectOption('demo');
    await page.getByRole('button', { name: /Generate faceless reel/ }).click();
    await page.locator('article.clip').first().waitFor({ timeout: 15000 });
    const n = await page.locator('article.clip').count();
    const expected = Number(await page.locator('#clipCount').inputValue());
    step('reels: faceless reel generated with requested clip count', n === expected, `clips=${n}`);
    const rs = await page.locator('article.clip').evaluateAll((els) => els.map((e) => e.dataset.status));
    step('reels: every clip within the word budget', rs.every((x) => x === 'ok' || x === 'tight' || x === 'none' || x === undefined), rs.join(','));
    step('reels: style sheet has no characters', (await page.locator('[id^="ch-name-"]').count()) === 0);
    results.axe.reels = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations;
    await page.screenshot({ path: `${OUT}/reels-1280-light.png` });
    // studio keeps its own brief when switching back
    await page.getByRole('link', { name: 'Studio', exact: true }).click();
    { await page.locator('#characterNotes').waitFor(); const cv = await page.locator('#concept').inputValue(); step('reels: Studio brief preserved while switching sections', /baker/.test(cv), cv.slice(0, 80)); }
    // story randomize: characters appear in concept
    await page.getByRole('button', { name: 'New' }).click();
    await page.getByRole('button', { name: 'Randomize all' }).click();
    const sb = await page.evaluate(() => ({ concept: document.querySelector('#concept').value, chars: document.querySelector('#characterNotes').value }));
    const names = sb.chars.split('\n').map((l) => l.split(':')[0]).filter(Boolean);
    step('studio: Randomize all builds a cast that the concept actually uses', names.length >= 1 && names.every((x) => sb.concept.includes(x)), `${names.join(',')} :: ${sb.concept.slice(0, 90)}`);
    const small2 = await page.evaluate(() => [...document.querySelectorAll('.icon-btn')].filter((e) => e.offsetParent !== null).map((e) => e.getBoundingClientRect()).filter((r) => r.width < 24 || r.height < 24).length);
    step('dice/lock buttons ≥ 24×24 CSS px', small2 === 0);
    const c = await browser.newContext({ viewport: { width: 320, height: 720 }, storageState: await ctx.storageState() });
    const p = await c.newPage(); await p.goto(`${BASE}/#/reels`); await p.locator('#sourceData').waitFor();
    const of = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await p.screenshot({ path: `${OUT}/reels-320-light.png`, fullPage: false });
    step('visual reels-320: no horizontal scroll', of <= 0, `overflow=${of}px`);
    await c.close();
  }

  // ---- Series: one dump → analyzed plan → many narration-first episodes with first/last frames ----
  {
    const DOGS = ['Dogs have about 300 million scent receptors compared with about 6 million in humans.', "A dog's nose print is unique, much like a human fingerprint, and can identify them.", 'Dalmatian puppies are born completely white and develop their spots as they grow.', 'Greyhounds can reach speeds of up to 45 miles per hour in a sprint.', 'Basenjis do not bark; they make a yodel-like sound instead.', 'Dogs sweat mostly through the pads of their paws.', 'Puppies are born deaf and blind.', 'Dogs have three eyelids on each eye.'].join('\n');
    await page.getByRole('link', { name: 'Series', exact: true }).click();
    step('series: section reachable from nav', await vis(page.getByRole('heading', { name: 'New series from your data' })));
    step('series: empty state explains the flow', await vis(page.getByRole('heading', { name: 'How a series works' })));
    await page.getByRole('button', { name: 'Analyze & plan series' }).click();
    step('series: validation asks for raw data', await vis(page.locator('#series-error').filter({ hasText: 'raw data' })));
    await page.locator('#series-source').fill(DOGS);
    step('series: live source stats', /about 8 fact-sized lines/.test(await page.locator('#series-src-stats').textContent()));
    await page.getByLabel('Longest (s)').fill('60');
    await page.getByRole('radio', { name: /Chained \(seamless\)/ }).check();
    await page.getByLabel('Provider', { exact: true }).selectOption('demo');
    await page.getByRole('button', { name: 'Analyze & plan series' }).click();
    await page.getByRole('heading', { name: 'Episode plan' }).waitFor({ timeout: 15000 });
    const rows = await page.locator('table.plan tbody tr').count();
    step('series: analysis produced a plan table', rows >= 2, `episodes=${rows}`);
    step('series: plan shows facts found = 8', /8/.test(await page.locator('.stat', { hasText: 'Facts found' }).textContent()));
    await page.locator(`#ep-inc-${rows}`).uncheck();
    await page.locator('#plan-save').filter({ hasText: 'Plan saved' }).waitFor({ timeout: 5000 });
    step('series: unchecking an episode saves and updates totals', /\d+ of \d+ episodes selected/.test(await page.locator('#plan-totals').textContent()) && (await page.locator('#plan-totals').textContent()).startsWith(`${rows - 1} of ${rows}`));
    results.axe.seriesPlan = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations;
    await page.screenshot({ path: `${OUT}/series-plan-1280.png`, fullPage: true });
    await page.locator('#series-write').click();
    await page.locator('.badge.st-done').first().waitFor({ timeout: 20000 });
    const written = await page.locator('table.plan .epst-done').count();
    step('series: cost so far shown', /^\$\d|no price/.test(await page.locator('#series-cost').textContent()), await page.locator('#series-cost').textContent());
    step('series: all selected episodes written, skipped one left alone', written === rows - 1, `written=${written}/${rows}`);
    step('series: export buttons enabled', await page.locator('#series-csv').isEnabled() && await page.locator('#series-md').isEnabled());
    const dl = page.waitForEvent('download'); await page.locator('#series-csv').click(); const file = await dl;
    step('series: CSV export downloads', /\.csv$/.test(file.suggestedFilename()), file.suggestedFilename());
    // Whole-series Markdown: copy, download, view
    await page.waitForTimeout(400); // prefetch
    await page.locator('#series-md-copy').click();
    await page.locator('#toast').filter({ hasText: /copied/ }).waitFor({ timeout: 5000 });
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const epCount = (clip.match(/^# Episode \d+:/gm) || []).length;
    step('series: Copy puts the WHOLE series Markdown on the clipboard', epCount === written && /\*\*First frame:\*\*/.test(clip), `${epCount} episodes, ${clip.length} chars`);
    const dl2 = page.waitForEvent('download'); await page.locator('#series-md').click(); const f2 = await dl2;
    const mdText = fs.readFileSync(await f2.path(), 'utf8');
    step('series: Markdown download contains every episode', /\.md$/.test(f2.suggestedFilename()) && (mdText.match(/^# Episode \d+:/gm) || []).length === written, f2.suggestedFilename());
    await page.locator('#series-guide-copy').click();
    await page.locator('#toast').filter({ hasText: /scripts by service copied/i }).waitFor({ timeout: 5000 });
    const g = await page.evaluate(() => navigator.clipboard.readText());
    step('series: Copy scripts-by-service for the whole series', (g.match(/^# Episode \d+:/gm) || []).length === written && /Image scripts/.test(g));
    await page.locator('#series-md-view').click();
    await page.locator('#text-dialog').waitFor();
    step('series: View opens the full text in a window with Copy/Download', (await page.locator('#text-dialog-body').inputValue()).length === clip.length && await vis(page.locator('#text-dialog-copy')) && await vis(page.locator('#text-dialog-download')));
    results.axe.exportDialog = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations;
    await page.keyboard.press('Escape');
    step('series: Escape closes the window', await page.locator('#text-dialog').count() === 0);
    await page.locator('#ep-open-1').click();
    await page.locator('article.clip').first().waitFor({ timeout: 8000 });
    step('series: episode opens as a project with a link back', await vis(page.getByRole('link', { name: /Series · episode 1/ })));
    const lf = await page.locator('[id$="-last"]').count(), clipsN = await page.locator('article.clip').count();
    step('series: chained mode → every clip has a last-frame prompt', lf === clipsN && clipsN > 1, `${lf}/${clipsN}`);
    const firsts = await page.locator('textarea[id$="-img"]').evaluateAll((e) => e.map((x) => x.value));
    const lasts = await page.locator('textarea[id$="-last"]').evaluateAll((e) => e.map((x) => x.value));
    step('series: chained frames link (clip 2 first frame = clip 1 last frame)', firsts[1] === lasts[0]);
    step('series: full voiceover card present', await vis(page.getByText('Full voiceover')));
    // Build-in-VideoExpress view: sections that match the VideoExpress build
    await page.getByRole('tab', { name: 'Scripts by VideoExpress service' }).click();
    await page.locator('#guide-images').waitFor();
    const secs = await page.locator('.guide-sec h3').allTextContents();
    step('guide: one script section per VideoExpress service (image → video → sound → post text)', ['Image scripts', 'Video scripts', 'Sound scripts', 'Post text'].every((w, i) => (secs[i] || '').startsWith(w)) && secs.length === 4, secs.map((x) => x.split(' ·')[0]).join(' → '));
    const imgItems = await page.locator('#guide-images .guide-item [id^="gd-img-"]').count();
    step('guide: image scripts include first AND last frame for every chained clip', imgItems === clipsN * 2, `${imgItems} prompts for ${clipsN} clips`);
    step('guide: timeline table shows clip start/end times', await vis(page.locator('table.timeline td', { hasText: /0:00–0:0\d/ })));
    await page.locator('#gd-img-1-first').check();
    await page.locator('#save-state').filter({ hasText: 'Saved' }).waitFor({ timeout: 5000 });
    step('guide: marking a script as pasted updates progress', /^1 of \d+ scripts pasted/.test(await page.locator('#guide-progress').textContent()));
    results.axe.guide = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations;
    await page.screenshot({ path: `${OUT}/guide-1280.png` });
    await page.reload(); await page.getByRole('link', { name: 'Series', exact: true }).waitFor();
    await page.goto(`${BASE}/#/series`); await page.locator('table.plan, .prow').first().waitFor().catch(() => {});
    await page.locator('.prow a').first().click(); await page.locator('#ep-open-1').click(); await page.locator('#guide-images').waitFor();
    step('guide: view choice and checkmarks survive reload + reopen', await page.locator('#gd-img-1-first').isChecked());
    await page.getByRole('tab', { name: 'Edit by clip' }).click(); await page.locator('article.clip').first().waitFor();
    const hash = await page.evaluate(() => location.hash);
    step('deep link: open project id is in the URL', /^#\/reels\/\d+$/.test(hash), hash);
    const title1 = await page.locator('#script-h').textContent();
    await page.reload(); await page.locator('article.clip').first().waitFor({ timeout: 8000 });
    step('deep link: reload reopens the same project', (await page.locator('#script-h').textContent()) === title1, title1);
    await page.goto(`${BASE}/#/reels/999999`); await page.waitForFunction(() => !location.hash.includes('999999'), null, { timeout: 5000 }).catch(() => {});
    step('deep link: missing project → message, back to the open project, no endless spinner', !(await page.evaluate(() => location.hash)).includes('999999') && await vis(page.getByText('That project no longer exists.')) && await vis(page.locator('article.clip')), await page.evaluate(() => location.hash));
    const st = await page.locator('article.clip').evaluateAll((els) => els.map((e) => e.dataset.status));
    step('series: no episode clip flagged as cut off', !st.includes('over'), st.join(','));
    const durs = await page.locator('article.clip .chip').allTextContents();
    step('series: clip lengths follow narration (not all identical)', new Set(durs.filter((d) => /s$/.test(d))).size > 1, durs.join(' '));
    results.axe.episode = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations;
    await page.screenshot({ path: `${OUT}/series-episode-1280.png` });
    await page.getByRole('link', { name: /Series · episode 1/ }).click();
    step('series: back link returns to the series', await vis(page.getByRole('heading', { name: 'Episode plan' })));
    const c = await browser.newContext({ viewport: { width: 320, height: 720 }, storageState: await ctx.storageState() });
    const p = await c.newPage(); await p.goto(`${BASE}/#/series`); await p.locator('#series-source').waitFor();
    const of = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    step('visual series-320: no horizontal page scroll', of <= 0, `overflow=${of}px`);
    await c.close();
  }

  // ---- Cost estimates on Settings ----
  {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.locator('#usage-table').waitFor({ timeout: 8000 });
    step('cost: usage table has an Est. cost column and a monthly total', await vis(page.getByRole('columnheader', { name: 'Est. cost' })) && /^\$/.test(await page.locator('#usage-total').textContent()), await page.locator('#usage-total').textContent());
    await page.getByText('Your model prices').click();
    await page.locator('#price-model').fill('claude-sonnet-5'); await page.locator('#price-in').fill('3'); await page.locator('#price-out').fill('15');
    await page.locator('#price-save').click();
    step('cost: custom model price saved and listed', await vis(page.locator('.price-list li', { hasText: 'claude-sonnet-5' })));
    results.axe.settingsCost = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations;
    await page.screenshot({ path: `${OUT}/settings-cost-1280.png`, fullPage: true });
  }

  for (const [k, v] of Object.entries(results.axe)) step(`axe WCAG 2.2 AA: ${k}`, Array.isArray(v) && v.length === 0, (v || []).map((x) => `${x.id}(${x.nodes.length})`).join(', '));
  step('no JS console errors or unexpected HTTP errors (expected: validation 400 on short password)', results.consoleErrors.length === 0, results.consoleErrors.join(' | ').slice(0, 300));

  // Offline/error state: server unreachable
  const off = await ctx.newPage();
  await off.goto(`${BASE}/#/studio`); await off.locator('#concept').waitFor();
  await off.route('**/api/generate', (r) => r.abort('internetdisconnected'));
  await off.getByLabel('What is the video about?').fill('Offline test concept for error state.');
  await off.getByLabel('Provider', { exact: true }).selectOption('demo');
  await off.locator('#generate').click();
  step('network failure shows honest retryable error', await vis(off.locator('#gen-error').filter({ hasText: /reach the server|offline/ })) && await off.locator('#generate').isEnabled());
} catch (e) {
  step('unexpected exception', false, e.stack);
} finally {
  await browser.close();
  srv.kill('SIGTERM');
  for (const k of Object.keys(results.axe)) results.axe[k] = (results.axe[k] || []).map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
  fs.writeFileSync(`${OUT}/e2e-results.json`, JSON.stringify(results, null, 2));
  console.log(`\n${results.steps.filter((s) => s.ok).length}/${results.steps.length} passed · ${results.browser}`);
}
