# Decisions
- **D-001** Keys stored server-side, encrypted (user choice: login + DB + encryption). AES-256-GCM, key from APP_ENCRYPTION_KEY, AAD=user id.
- **D-002** SQLite + Express instead of Postgres/framework: single VPS, low ops, fits the $0 ceiling. Vanilla JS client with no framework, since the §3.0 stack was new.
- **D-003** No automation of app.videoexpress.ai (login-only app, no documented public API). Output is copy/paste and export (POL-CLEANROOM-003 / POL-BOUNDARY-004).
- **D-004** Model catalog sources, verified 2026-09-23: OpenAI GPT-5.6 Sol/Terra/Luna IDs (apidog.com, developersdigest.tech, GitHub hermes-agent#61623); Anthropic IDs (benchlm.ai, anthropics/skills models.md); Gemini 3.8 Flash (docs.cloud.google.com); xAI Grok 4.6 (ai-toolbox.co). Treated as suggestions only; free-text model plus live /models listing.
- **D-005** Word budget = floor((sec − pad) × wps), default 2.5 w/s and 0.5 s pad. Server re-counts and auto-fixes (≤2 passes) rather than trusting the model.
- **D-006** Preview-only config: COOKIE_SAMESITE=none + FRAME_ANCESTORS=* so the cross-site preview iframe keeps the session. Production defaults stay SameSite=Lax + frame-ancestors 'self'.
- **D-007** Preview sign-in fix. In a cross-site iframe the browser drops the session cookie, so every call after login returned 401 "Please sign in". I reproduced this in `tests/e2e/iframe-cookieless.mjs`. The fix is an opt-in `HEADER_SESSIONS=true`: the login response also returns the session token, the client keeps it in sessionStorage and sends it as `X-Session-Token`, and CSRF tokens are still required on writes. It's off by default, so production (a top-level page on your own domain) uses only the HttpOnly cookie. Don't enable it in production: it makes the session token readable by JavaScript.
- **D-008** Persistence on Coolify: SQLite lives at `/data`, which needs a Coolify **Volume Mount** at `/data`. I removed the anonymous `VOLUME` from the Dockerfile so a missing mount can't hide behind an empty auto-volume. At startup the server checks the mount (via /proc/self/mountinfo), whether the folder is writable, and an encryption-key canary. It logs loud warnings and shows them in the admin Settings card. A key that can't be decrypted returns 409 with instructions instead of a 500.

## D-009 — Faceless reels + coherent randomizer
- **Reels** is a separate mode (`brief.mode = 'reel'`) in the same project schema. Prompt `clipscript-v2` adds hard faceless rules: no identifiable people, `characters: []`, narrator-only VO, on-screen text on every clip, and facts only from `<source_data>`, which is fenced and treated as data. The server enforces `characters: []` and the Narrator speaker regardless of model output.
- **Randomize** is a seeded (mulberry32) combinatorial generator, not presets. One roll context (niche + mood + format) drives every field. Mood sets tone words, palette, compatible visual styles, pace and narrator voices. Niche sets the lead, then a goal that fits the lead (tags), then a setting that fits both, then supporting cast. Format sets aspect ratio, dialogue mode, clip timing and faceless-only styles. Reel structures that need numbers or dates are only offered when the pasted data contains them.
- Honest lower bound, computed from the lists: about 1e18 story and 3e11 reel combinations. Seeds replay exactly. Locks and "Fill blanks" never overwrite user values, and linked re-rolls (characters ↔ concept) respect locks.

## D-010 — Cut-off protection (speaking time, not just word count)
- Word counts alone miss the things that make TTS run long, so each clip is now also checked against **estimated speaking seconds**:
  - The text is first rewritten the way a voice reads it: `1998` → "nineteen ninety-eight", `$2.5M` → "two point five million dollars", `40%` → "forty percent", `FBI` → "F B I", `site.com` → "site dot com".
  - Duration comes from syllables (pace calibrated at about 1.45 syllables per word) plus pauses: 0.12 s per comma and 0.25 s per sentence break.
- **Speech window** = (clip seconds − silence pad) × (1 − safety margin). The safety margin defaults to 10% and can be set from 0 to 30%. The word budget uses the same margin. A clip is *over* if the words read aloud exceed the budget **or** the estimate exceeds the window.
- **Prompts** tell the model to write for the ear: spell out numbers, avoid acronyms, use short words, and end every clip on a complete sentence. The auto-fit rewrite is told *why* each clip is over and how its numbers will be read.
- **Last-resort safety net:** if the model still overshoots after two rewrites, the server drops whole trailing sentences or clauses. It never cuts mid-sentence or mid-word. The UI notes which clips were shortened this way.
- **Limitation:** the estimate is heuristic. Actual timing depends on the VideoExpress voice. The margin slider is the knob for slower or more dramatic voices.

## D-011 — Series from one dump, narration-first episodes, first/last frames
- **Pipeline** (runs in the background, saved after every step, resumes after a restart):
  1. *Extract*: the dump (≤100k chars) is split into ~12k-char chunks; the model lists every usable fact with an interest score from 1–10. Facts are de-duplicated and given ids f1…
  2. *Plan*: the model groups facts into episodes and picks a format (deep dive / quick hit / compilation), a hook and a length within the user's range (default 15–90 s), plus a series "bible" (look, palette, narrator, tone). The server validates it. **Facts the model forgets become quick hits, so nothing is dropped.**
  3. *Write*: each episode is written 2 at a time and saved as a normal project (`series_id`, `episode_no`, `layout: 'narration'`).
- **Narration-first** replaces the fixed per-clip word box for episodes. That box is what caused the cut-offs on project 1 (22-word budget; the model wrote 22–25 words, so it trimmed).
  - The model writes one continuous voiceover to a word target: (seconds − breaths) × pace.
  - The server splits it into clips at sentence boundaries. Each clip lasts as long as its words plus a 0.3 s breath, capped at the max clip length.
  - A single sentence longer than a clip is kept whole and flagged **extend** (use VideoExpress's Video Length Increaser).
  - If the model's beats don't match its full narration (<90% or >110% coverage), the narration wins and is redistributed. **Words are never removed.**
- **Frames**:
  - Every clip has a first-frame prompt, and optionally a last-frame prompt for VideoExpress *First & Last Frame image-to-video*.
  - Modes: auto (only for reveals and changes), first only, both, and chain (each clip's first frame = the previous clip's last frame, for one seamless shot).
  - "both" and "chain" fill in any missing last frames on the server.
  - Studio scripts also get `lastFramePrompt`; CSV gains a `last_frame_prompt` column.
- **Limits**: 100k chars, 400 facts, 150 episodes, 30 clips per episode (overflow is folded into the last clip rather than dropped), 2 running series per user. Token cap and usage metering apply to every call.

## D-012 — Scripts grouped by VideoExpress service
- **ClipScript only writes words.** VideoExpress makes the images, the video and the sound. The second tab on every script is **Scripts by VideoExpress service**, with four sections:
  - **Image scripts:** the style reference, character looks, and every first-frame and last-frame prompt, for Text-to-Image.
  - **Video scripts:** motion prompts, which image(s) each one uses, clip order and lengths, and on-screen text, for Image-to-Video and First & Last Frame.
  - **Sound scripts:** the voiceover text, plus music and sound-effect cues with times.
  - **Post text:** caption and hashtags.
- The app gives no editing or assembly instructions; that's the user's work in VideoExpress.
- Each script has a Copy button and a "pasted" checkbox, saved on the project as `script.buildProgress`. Markdown export is available per project and for a whole series (`?format=guide`).

## D-013 — Cost estimates
- **Built-in prices** are OpenAI's Standard, short-context rates, taken from the pricing chart the user pasted on 2026-09-23. For example, gpt-5.6-luna is $0.20 in / $1.20 out per 1M tokens, Terra $2/$12, Sol $4/$20; GPT-6, GPT-5.x, GPT-4.x, o3 and o4-mini are also included. `gpt-5.6` maps to Sol, and model IDs are normalised (`openai/` prefixes and date suffixes are stripped).
- **Not built in:** cached-input, Batch, Flex and Fast pricing, since the app never uses those.
- **Other providers** (Claude, Gemini, Grok, custom) have no built-in price, because I haven't verified them. Users enter their own per model in Settings. Anything without a price shows "no price" and is left out of totals.
- **Where cost shows:**
  - Settings: an Est. cost column and a monthly total.
  - Each project: its tokens and cost.
  - Each series: cost so far, plus a low–high range for the remaining episodes. The high end is 2.5× output to cover reasoning tokens. Once episodes exist, the estimate switches to their actual average.
  - The dump box: a pre-analysis estimate.
- **Check:** the real "Not Today, Gus" run (908 in / 4,033 out on luna) comes to $0.0050. A 100-fact series on luna is estimated at about $0.25–$0.60.
- These are estimates only; the provider's invoice is the truth.

## D-014 · VideoExpress paste pack (Create Video From Prompt) · 2026-09-27
- **Why:** the user wants copy-paste that matches VideoExpress's own boxes, keeps characters consistent, and uses Narration Video so the audio stays consistent.
- **Source of field names/limits:** VideoExpress's published agent workflows (videoexpress.ai/workflow: the "Full-Length Consistent Character" and "CloneVoice + VideoExpress Narrative Video" system prompts). These give:
  - the fields Image Prompt, Video Prompt (it is called "Video and Audio Prompt" until Narration Video is on), Narration Video (Choose my Audio) and the Create Narration Video - Create Audio dialog;
  - the 120-character narration box and the Lipsync HD Actor 1/2 Script (under 100 characters);
  - Use Consistent Character with Reference Photo / Reference Photo 2, Image Type, and the public-gallery checkbox (on by default).
- **Design:** `lib/domain/vepack.js` (pure). There is one card per VideoExpress scene with one Copy per box. Scene tags `[SC-001]` (series: `[E01-SC-001]`) appear in the Media Library captions, which fixes the problem that the library shows clips newest first rather than in story order.
  - Narration longer than 120 characters is split at a sentence, then a clause, then a word boundary into extra scenes that reuse the same picture. No word is ever dropped.
  - Character bibles are pasted word-for-word into every Image Prompt, and character reference pictures come first.
  - One narrator voice (default: CloneVoice.ai · System · English · Lucas Rhodes) is saved in the account settings (`settings.ve`) and used for every scene and episode.
  - Faceless scripts get Consistent Character OFF plus a style lock.
- **UI:**
  - Project / Reel / episode: a "VideoExpress paste pack" tab.
  - Series: an export group (Copy / Download / View) using `?format=vepack`.
- **Evidence:** unit 71/71 (vepack 7), API 15/15, E2E 104/104 (12 new vepack steps, axe clean).

## D-015 · Script quality loop ("Polish to 95+")
- **Ask:** one button that reads and grades a script, then loops Analyze → Repair → Analyze until the script scores 95+/100. It works on Reel/Studio projects and whole series, using the user's own API key.
- **Score (out of 100):** 80% AI rubric + 20% hard checks computed in code (`lib/domain/quality.js`).
  - Rubric: hook 12, story 14, accuracy 14, spoken words 14, image prompts 16, motion 12, consistency 10, VideoExpress-ready 8.
  - Hard checks: words fit every clip, exact clip count, full image/motion prompts, spoken words present, no cut-off sentences, faceless rules or fixed character looks, at most 2 reference characters.
  - Any failed hard check caps the score at target − 5, so 95+ always means "fits and nothing is cut off".
  - The AI's total is never trusted: each area is clamped and the total is recomputed.
- **Loop:** up to 3 repair rounds (0 = score only), and it stops at 95.
  - Every repair goes back through normalizeScript → facelessGuard (reels) → fitDialogue, which keeps the cut-off protection.
  - **The best-scoring version is always kept**, so polishing can never make a script worse.
- **Runs:** as an in-memory background job with live progress and a Stop button.
  - Series runs one episode at a time and by default only polishes episodes below 95. It is blocked while a series write is running.
  - The result is saved in `meta.quality` (score, per-area scores, remaining issues, history), and token usage is added to the project/series.
- **Evidence:** unit 78/78 (quality 7), API 16/16 (polish project + series), E2E 115/115 (11 new steps, axe clean).
