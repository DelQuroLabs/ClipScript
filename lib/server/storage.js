// Server-only: checks that the database lives on persistent storage and that the encryption key
// is the same one that encrypted existing API keys. Results are shown to admins and logged at startup.
import fs from 'node:fs';
import path from 'node:path';

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

export function storageReport({ dbFile, db, keyStatus }) {
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
    counts, sizeBytes,
  };
}
