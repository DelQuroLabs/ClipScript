import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveEncryptionKey } from '../../lib/server/storage.js';

test('env key wins when set', () => {
  const r = resolveEncryptionKey('x'.repeat(40), '/nonexistent/db.sqlite');
  assert.equal(r.source, 'env');
});
test('no env key: creates one on the data dir once, then reuses it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-key-'));
  const db = path.join(dir, 'clipscript.db');
  const a = resolveEncryptionKey('', db);
  assert.equal(a.source, 'generated'); assert.ok(a.key.length >= 32);
  assert.equal((fs.statSync(a.file).mode & 0o777), 0o600);
  const b = resolveEncryptionKey(undefined, db);
  assert.equal(b.source, 'file'); assert.equal(b.key, a.key);
});
