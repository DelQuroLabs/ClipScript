# Charter — ClipScript Studio
**Problem / user:** A VideoExpress user needs consistent image prompts, motion prompts and timed dialogue for multi‑clip videos. Writing these by hand is slow, and dialogue often overruns the clip length.
**Accepted core outcome:** A signed‑in user enters a brief and chooses 1–10 clips and a clip length. With their own API key (any supported provider), they get a style sheet plus, for every clip, an image prompt, a video/motion prompt and dialogue that fits the per‑clip word budget. They can edit, fix overruns, copy or export, and the project is saved.
**Targets:** browser‑web (responsive desktop/mobile). Declared matrix: current Chrome/Edge (Chromium), Firefox, Safari, desktop and mobile. Verified here: Chromium headless 153 only.
**Stack:** Node 20, Express 4, better‑sqlite3, vanilla ES modules bundled with esbuild. Pure domain in `lib/domain`, server‑only code in `lib/server`.
**Connectivity:** online‑required (LLM calls), with honest offline/error states. **Identity:** authenticated accounts on our own server. **Phase:** production‑candidate.
**Infra:** self‑hosted Docker on the user's Coolify (coolify.delquro.com). SQLite on a persistent volume.
**Cost:** $0 to the server owner for LLMs (BYO keys, billed to each user by their provider). Hosting uses the existing VPS. Ceiling per intake: $0 ideal / $25/mo hard.
**Non‑goals:** automating or logging into app.videoexpress.ai (no public API; ToS/clean‑room); generating images/videos inside this app; team sharing; email password reset (admin can reset via DB); OAuth sign‑in; multi‑instance scaling (in‑memory rate limiter, SQLite).
**Acceptance:** the E2E suite (tests/e2e/run.mjs) steps; unit and API suites; axe WCAG 2.2 AA clean on every screen; no horizontal scroll at 320/768/1280 and at the 200% zoom equivalent; zero secrets in the bundle.
**Risks:** model IDs change (mitigated: free‑text model plus live list); LLMs miscount words (mitigated: server‑side count plus auto‑fit loop); APP_ENCRYPTION_KEY loss (documented backup); publisher entity/jurisdiction unresolved (needed before public signup, privacy policy).
**Completion label:** incomplete (production‑candidate): browser matrix beyond Chromium, deployment and SR testing are blocked. See verification.json.
