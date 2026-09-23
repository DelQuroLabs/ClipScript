import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const app = createApp();

// Startup storage check: loud warnings so a non-persistent or re-keyed deploy is obvious in Coolify logs.
const st = app.locals.storage();
console.log(`[storage] database: ${st.databaseFile} · users=${st.counts.users} keys=${st.counts.keys} projects=${st.counts.projects}`);
if (!st.writable) {
  console.error(`[storage] FATAL: ${st.dataDir} is not writable by this process. In Coolify use a Volume Mount (not a root-owned bind mount) at ${st.dataDir}.`);
  process.exit(1);
}
if (st.persistentMount === false && process.env.NODE_ENV === 'production') {
  console.warn(`[storage] WARNING: ${st.dataDir} is NOT a mounted volume. Accounts, saved API keys and projects will be LOST on the next redeploy. In Coolify: Configuration → Persistent Storage → Add → Volume Mount, Destination Path ${st.dataDir}`);
} else if (st.persistentMount) {
  console.log(`[storage] OK: ${st.dataDir} is a mounted volume (persistent across redeploys)`);
}
if (st.encryptionKey === 'mismatch') {
  console.error('[storage] WARNING: APP_ENCRYPTION_KEY does not match the key that encrypted the saved API keys. Users must re-enter keys, or restore the original APP_ENCRYPTION_KEY.');
}
const server = app.listen(port, host, () => console.log(`ClipScript Studio listening on http://${host}:${port}`));
const shutdown = () => { server.close(() => { app.locals.db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
