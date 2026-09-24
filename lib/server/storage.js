// Server-only: checks that the database lives on persistent storage and that the encryption key
// is the same one that encrypted existing API keys. Results are shown to admins and logged at startup.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Is `dir` (or a parent) a separate mount point? Reads /proc/self/mountinfo (Linux/Docker). */
export function isMounted(dir) {
  try {
    const abs = path.resolve(dir);
    const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
      .map((l) => l.split(' ')[4]).filter(Boolean).map((m) => m.replace(/\\040/g, ' '));
    // Longest mount point that contains the dir; "/" (the container's own layer) doesn't count.
    const best = mounts.filter((m) => abs === m || abs.startsWith(m.endsWith('/') ? m : m + '/'))
      .sort((a, b) => b.length - a.length)[0];
    return !!best && best !== '/';
  } catch { return null; } // unknown (not Linux)
}

export function isWritable(dir) {
  try {
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); return true;
  } catch { return false; }
}

/**
 * Encryption key source. APP_ENCRYPTION_KEY (env) wins. If it's missing, a random key is created ONCE
 * in the data directory (the persistent volume) and reused on every restart, so a deploy never fails
 * just because a platform didn't pass the variable. Returns { key, source: 'env' | 'file' | 'generated' }.
 */
export function resolveEncryptionKey(envKey, dbFile) {
  if (envKey && String(envKey).length >= 32) return { key: String(envKey), source: 'env' };
  if (!dbFile || dbFile === ':memory:') return { key: envKey, source: 'env' }; // KeyVault will explain
  const file = path.join(path.dirname(path.resolve(dbFile)), '.app-encryption-key');
  try {
    const k = fs.readFileSync(file, 'utf8').trim();
    if (k.length >= 32) return { key: k, source: 'file', file };
  } catch { /* create below */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const k = crypto.randomBytes(48).toString('base64');
  fs.writeFileSync(file, k + '\n', { mode: 0o600, flag: 'wx' });
  return { key: k, source: 'generated', file };
}

const CANARY = 'clipscript-key-canary-v1';

/**
 * Stores an encrypted canary the first time; afterwards verifies it decrypts.
 * Returns 'ok' | 'created' | 'mismatch'.
 */
export function checkEncryptionKey(db, vault) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  const row = db.prepare("SELECT v FROM meta WHERE k = 'key_canary'").get();
  if (!row) {
    db.prepare("INSERT INTO meta (k, v) VALUES ('key_canary', ?)").run(vault.encrypt(CANARY, 0));
    return 'created';
  }
  try { return vault.decrypt(row.v, 0) === CANARY ? 'ok' : 'mismatch'; } catch { return 'mismatch'; }
}

export function storageReport({ dbFile, db, keyStatus, keySource = 'env' }) {
  const memory = dbFile === ':memory:';
  const dir = memory ? null : path.dirname(path.resolve(dbFile));
  const mounted = memory ? false : isMounted(dir);
  const counts = db.prepare('SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM api_keys) keys, (SELECT COUNT(*) FROM projects) projects').get();
  let sizeBytes = 0;
  if (!memory) for (const f of [dbFile, `${dbFile}-wal`]) { try { sizeBytes += fs.statSync(f).size; } catch { /* none */ } }
  return {
    databaseFile: memory ? ':memory:' : path.resolve(dbFile),
    dataDir: dir,
    persistentMount: mounted, // true | false | null(unknown)
    writable: memory ? true : isWritable(dir),
    encryptionKey: keyStatus === 'mismatch' ? 'mismatch' : 'ok',
    encryptionKeySource: keySource,
    counts, sizeBytes,
  };
}
