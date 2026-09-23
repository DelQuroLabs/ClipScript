// Production build: bundle + minify client, copy static assets to dist/.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const t0 = Date.now();
const r = await build({
  entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'esm', target: ['es2022'],
  outfile: path.join(out, 'app.js'), sourcemap: false, legalComments: 'none', metafile: true,
});
for (const f of fs.readdirSync('public')) fs.copyFileSync(path.join('public', f), path.join(out, f));
// Content-hash asset names so browsers can never run a stale app.js/app.css after a deploy.
const hashed = {};
for (const f of ['app.js', 'app.css']) {
  const buf = fs.readFileSync(path.join(out, f));
  const h = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
  const name = f.replace('.', `.${h}.`);
  fs.renameSync(path.join(out, f), path.join(out, name));
  hashed[f] = name;
}
let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
for (const [k, v] of Object.entries(hashed)) html = html.replace(`/${k}`, `/${v}`);
fs.writeFileSync(path.join(out, 'index.html'), html);
// Guard: server-only code must never be in the client bundle.
const inputs = Object.keys(r.metafile.inputs);
const leaked = inputs.filter((i) => i.includes('lib/server') || i.includes('server/'));
if (leaked.length) { console.error('Server-only modules in client bundle:', leaked); process.exit(1); }
for (const f of fs.readdirSync(out)) console.log(`${f.padEnd(14)} ${fs.statSync(path.join(out, f)).size} bytes`);
console.log(`built in ${Date.now() - t0}ms · inputs: ${inputs.join(', ')}`);
