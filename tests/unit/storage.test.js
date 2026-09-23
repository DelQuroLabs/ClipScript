import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMounted, isWritable } from '../../lib/server/storage.js';
import os from 'node:os';

test('isMounted: root is not treated as persistent; returns boolean or null', () => {
  const r = isMounted('/definitely/not/a/mount/xyz');
  assert.ok(r === false || r === true || r === null);
  if (r !== null) assert.equal(isMounted('/'), false);
});
test('isWritable', () => {
  assert.equal(isWritable(os.tmpdir()), true);
  assert.equal(isWritable('/proc'), false);
});
