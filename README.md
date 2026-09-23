# ClipScript Studio

A web app that writes **scripts for [VideoExpress](https://app.videoexpress.ai)**, which you run alongside it. It uses an LLM of your choice (**GPT‑5.6**, Claude, Gemini, Grok, OpenRouter or any OpenAI‑compatible endpoint), and you **bring your own API key**.

For each project (**1–10 clips**) it writes:

| Output | Where it goes in VideoExpress |
|---|---|
| **Style sheet**: visual style, setting, palette, camera, characters with fixed looks and voices | Reused automatically in every image prompt so characters stay consistent |
| **1 · Image prompt** per clip | Text‑to‑image, which gives you the keyframe |
| **2 · Video / motion prompt** per clip | Image‑to‑video, using the keyframe above |
| **3 · Dialogue / voiceover** per clip, **within a word budget** | Voiceover / talking character |

### Word budget
`budget = floor((clip seconds − silence pad) × words per second)`. For example, 8 s clips with a 0.5 s pad at 2.5 w/s give **18 words**.
- The budget goes into the prompt as a hard limit.
- After generation, any clip that's still over gets **auto‑fixed** (up to 2 rewrite passes of just the over clips).
- Live meters turn green, amber or red as you edit, and a **"Fit N clips to budget"** button appears when anything is over.
- The counter works like a TTS voice: contractions count as 1 word, each part of a hyphenated word counts, and `[stage directions]` / `(asides)` aren't counted.

### Series: one data dump → a whole series
Open **Series** and paste a big dump, e.g. 100 lesser‑known dog facts. Then:
1. The AI **extracts and scores every fact**.
2. It **plans the series**: strong facts become their own deep dive (up to your max, default 90 s), and smaller ones are grouped into compilations. You can untick episodes, change lengths or rename them before writing.
3. It **writes every episode in the background** (you can leave the page). Each episode opens as a normal project.
4. **Export** the whole series as Markdown or CSV.

Episodes are **narration‑first**. The full voiceover is written as one piece, and clips are sized to fit it (max clip length configurable), so **no words are cut**. A sentence too long for one clip is flagged for VideoExpress's Video Length Increaser. Each clip gets a **first‑frame** prompt, a **last‑frame** prompt for *First & Last Frame image‑to‑video* (auto / first only / every clip / chained seamless), and a motion prompt.

### Scripts by VideoExpress service
ClipScript only writes the words. **VideoExpress makes the images, video and sound.** Every script has a **Scripts by VideoExpress service** tab that groups the words by the service they're pasted into:
- **Image scripts:** Text‑to‑Image prompts, including first and last frames.
- **Video scripts:** motion prompts, clip order and lengths, on‑screen text.
- **Sound scripts:** the voiceover and music/SFX cues.
- **Post text:** caption and hashtags.

Each script has a Copy button and a "pasted" checkbox. You can export it per project or for a whole series.

### Cost estimates
Costs are estimated next to token counts: in Settings (per model, plus a monthly total), on each project, and on each series (spent so far, plus an estimate for the remaining episodes). OpenAI Standard prices are built in, e.g. **gpt‑5.6‑luna $0.20 in / $1.20 out per 1M tokens**. Add prices for other models under Settings → Your model prices. These are estimates; your provider's bill is exact.

Other features: per‑clip rewrite with direction, inline editing with autosave, projects, Markdown/CSV/JSON export, usage tracking per model, dark mode, and a **Demo** provider so you can try it with no key.

## Security model
- Email and password accounts (scrypt). HttpOnly session cookie, and CSRF token + Origin checks on every write.
- API keys are encrypted with **AES‑256‑GCM**, and each key is tied to its user. They're write‑only: never returned to the browser (only the last 4 characters are shown) and decrypted only for the outbound call to the provider.
- Strict CSP with no inline scripts or styles. Rate limits on auth, writes and LLM calls. SSRF guard on custom base URLs (https only, no private IPs).
- Deleting an account removes its keys, projects, sessions and usage.

## Deploy on Coolify (coolify.delquro.com)

### 1. Create the app
In Coolify, go to **New Resource → your GitHub repo → Build pack: Dockerfile**. Port **3000**, health check path **`/healthz`**. Add your domain, and Coolify handles TLS.

### 2. Environment variables (Configuration → Environment Variables)
| Variable | Value | Notes |
|---|---|---|
| `APP_ENCRYPTION_KEY` | output of `openssl rand -base64 48` | Tick **"Is Literal"**. **Set it once and never change it.** It's what decrypts saved API keys. Store a copy in your password manager. |
| `REGISTRATION` | `first-user` | You sign up first (admin), then signup closes. Use `open` for public signup. |
| `PUBLIC_ORIGIN` | `https://your-domain` | |
| `MONTHLY_TOKEN_CAP_PER_USER` | `0` | Optional. `0` means no cap. |

**Don't set** `HEADER_SESSIONS`, `COOKIE_SAMESITE` or `AUTH_DEBUG`. Those are only for the embedded preview.

### 3. Persistent storage: required, or saved keys vanish on every redeploy
**Configuration → Persistent Storage → Add → Volume Mount**
- **Name:** `clipscript-data`
- **Source Path:** *(leave empty, so it's a named Docker volume)*
- **Destination Path:** **`/data`**

Everything is in `/data/clipscript.db`: accounts, encrypted API keys, projects and usage. Only that folder survives a redeploy.

If you deploy with `docker-compose.yml` instead, the `clipscript-data:/data` volume is already defined and Coolify picks it up.

### 4. Deploy and verify
- **Deploy logs** should show `[storage] OK: /data is a mounted volume`. If you see `WARNING: /data is NOT a mounted volume`, step 3 is missing.
- Sign in as admin, go to **Settings → Server storage (admin)**, and check you see *Persistent volume: Yes* and *Encryption key: Matches saved keys*.
- **Redeploy test:** save your API key, click **Redeploy** in Coolify, sign in again, and check that the key still shows `•••• last4` and **Test** passes.

### 5. Backups (a volume isn't a backup)
Go to **Persistent Storage → your volume → Backups**. Schedule a daily archive, and preferably also copy it to S3-compatible storage. To restore, you need **both** the DB file and the same `APP_ENCRYPTION_KEY`.

### If keys "disappear"
- **Keys, users and projects all gone:** the volume wasn't mounted at `/data` (step 3).
- **Account is there but a key says "can't be decrypted":** `APP_ENCRYPTION_KEY` changed. Restore the old value, or re-enter the key in Settings.

## Local
```bash
npm ci && npm run build
APP_ENCRYPTION_KEY=$(openssl rand -base64 48) COOKIE_SECURE=false npm start   # http://localhost:3000
npm test && npm run test:api && npm run test:e2e   # e2e needs: npx playwright install chromium
```

## Models
The suggested model IDs were checked in Sept 2026: `gpt-5.6-sol|terra|luna`, `claude-sonnet-5`, `gemini-3.8-flash`, `grok-4.6`. You can type any model ID. **Test key** lists the models your key can actually use.

*Independent tool, not affiliated with VideoExpress. It doesn't log into or automate app.videoexpress.ai: you copy the prompts over.*
