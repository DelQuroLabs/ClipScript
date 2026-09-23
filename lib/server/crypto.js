// Server-only: password hashing, API-key encryption, tokens.
import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

// A constant dummy hash so login timing does not reveal whether an email exists.
export const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

export function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
export function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

/**
 * Envelope for BYO API keys: AES-256-GCM with a key derived from APP_ENCRYPTION_KEY.
 * Per-record random IV; user id bound as AAD so ciphertexts cannot be swapped between users.
 */
export class KeyVault {
  constructor(masterSecret) {
    if (!masterSecret || String(masterSecret).length < 32) {
      throw new Error('APP_ENCRYPTION_KEY must be set (>= 32 chars). Generate one with: openssl rand -base64 48');
    }
    this.key = crypto.createHash('sha256').update('clipscript/keyvault/v1\0' + masterSecret).digest();
  }
  encrypt(plaintext, userId) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(`user:${userId}`));
    const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
    return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
  }
  decrypt(blob, userId) {
    const [v, ivB, tagB, dataB] = String(blob).split('.');
    if (v !== 'v1') throw new Error('Unsupported key envelope');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB, 'base64'));
    d.setAAD(Buffer.from(`user:${userId}`));
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([d.update(Buffer.from(dataB, 'base64')), d.final()]).toString('utf8');
  }
}
