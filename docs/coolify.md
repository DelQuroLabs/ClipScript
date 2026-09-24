# Deploying ClipScript on Coolify (coolify.delquro.com)

Checked against the Coolify docs on 2026-09-23:
- https://coolify.io/docs/applications/builds/docker-compose
- https://coolify.io/docs/core/persistent-storage/storage-mounts/overview
- https://coolify.io/docs/core/persistent-storage/storage-mounts/volume-mounts
- https://coolify.io/docs/applications/builds/dockerfile

## Facts that matter

| Topic | What Coolify does |
|---|---|
| **Docker Compose build pack: storage** | The **Compose file is the source of truth**. Volumes come from the `volumes:` lines. On **Persistent Storage** they show up **read-only**, and you can't change them there. To change one, edit the file in GitHub and then reload the Compose configuration (Configuration → General). |
| **Docker Compose build pack: editing** | For Git-based apps, the "Docker Compose Content" box is a rendered copy, not the primary copy. Edit the repository file instead and reload. |
| **Docker Compose build pack: domain** | Goes in the service's **Domains** field. It includes the internal port when that port isn't 80: `https://clipscript.delqurolabs.app:3000`. The public URL still uses normal ports. |
| **Docker Compose build pack: generated values** (not relied on anymore; see incident 2) | `SERVICE_REALBASE64_64_CLIPSCRIPT` gives 64 random bytes, base64-encoded. `SERVICE_URL_CLIPSCRIPT_3000` gives the service URL plus routing to port 3000. Both persist between deployments and appear under Environment Variables. |
| **Dockerfile build pack: storage** | Added by hand: Configuration → Persistent Storage → **Add → Volume Mount**. Name `clipscript-data`, **Source Path empty** (a Source Path would make it a bind mount instead), Destination Path `/data`. Then redeploy. |
| **Dockerfile build pack: port** | **Ports Exposes** = `3000`. The app listens on 0.0.0.0 (set in the Dockerfile). |
| **Volume names** | Coolify adds the resource UUID in front of volume names, so `docker volume ls` shows a longer name. |
| **Limits** | A volume is **not a backup** (Coolify can schedule storage backups). Apps with persistent storage can't be spread across several servers. Keep **Delete Unused Volumes** off in Docker cleanup. |
| **Health check** | Git-based Compose apps use the image or Compose health check, not the Healthcheck page. Ours is in the Dockerfile and uses `node` fetching `/healthz`, so it needs no curl. |
| **"No Available Server"** | Check the logs, that the service is healthy, that the domain has `:3000`, and that the app listens on 0.0.0.0. |

## Our setup (Docker Compose build pack)

`docker-compose.yml` already does all of this:
- It mounts the named volume `clipscript-data` at `/data`, where the database lives (`/data/clipscript.db`).
- `APP_ENCRYPTION_KEY` is optional. If it's empty, the app creates `/data/.app-encryption-key` once (mode 600) and reuses it on every restart. The log says which source it used.
- It sets `NODE_ENV=production`, secure cookies and `TRUST_PROXY=1`.

Nothing needs to be typed on the Persistent Storage page.

## Incident 2026-09-23: "invalid spec … clipscript-data:/https://clipscript.delqurolabs.app:3000: too many colons"

**Cause:** the domain ended up as the volume's destination path, so the storage settings Coolify held did not match the repository file.

**Fix:**
1. Delete that storage, or simply the whole resource, since there's no data yet.
2. Recreate the resource from GitHub with the Docker Compose build pack.
3. Put the domain only in **Domains**, then deploy.
4. Don't add storage by hand.

## Checks after deploy

- The logs show `[storage] OK: /data is a mounted volume (persistent across redeploys)`.
- The app's Settings page shows **Server storage (admin): Yes: mounted volume**.
- Make a demo project, redeploy, and confirm the account and project are still there.

## Incident 2026-09-24: "APP_ENCRYPTION_KEY must be set (>= 32 chars)", new container unhealthy

**Cause:** the Coolify-generated `${SERVICE_REALBASE64_64_CLIPSCRIPT}` arrived empty, most likely because the resource was reused rather than recreated, or this Coolify version doesn't fill that variable for Git-based Compose.

**Fix in code:**
- `resolveEncryptionKey()` in lib/server/storage.js: the env key wins. Otherwise the app creates or reuses the key file on the volume.
- The Compose file now uses `${APP_ENCRYPTION_KEY:-}`, so no magic variable is involved.

**Security note:** the key file sits on the same volume as the database. Coolify env vars live on the same server anyway, so the practical difference is small. To keep the key off the volume, set APP_ENCRYPTION_KEY before saving any API keys.

**Log lines:**
- `[storage] APP_ENCRYPTION_KEY not set: created a new random key…` on the first boot
- `[storage] Using the saved encryption key…` on later boots
