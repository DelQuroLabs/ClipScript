import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyVault, hashPassword, verifyPassword } from '../../lib/server/crypto.js';

test('password hash verify', () => {
  const h = hashPassword('correct horse battery');
  assert.ok(verifyPassword('correct horse battery', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('x', 'garbage'));
});
test('KeyVault round trip, user binding, tamper detection', () => {
  const v = new KeyVault('x'.repeat(40));
  const blob = v.encrypt('sk-test-FAKE-0000', 7);
  assert.ok(!blob.includes('sk-test'));
  assert.equal(v.decrypt(blob, 7), 'sk-test-FAKE-0000');
  assert.throws(() => v.decrypt(blob, 8));
  const parts = blob.split('.'); parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => v.decrypt(parts.join('.'), 7));
  assert.throws(() => new KeyVault('short'), /APP_ENCRYPTION_KEY/);
  assert.throws(() => new KeyVault('y'.repeat(40)).decrypt(blob, 7));
});
