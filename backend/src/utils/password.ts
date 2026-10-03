import crypto from 'node:crypto';

// scrypt params: N=16384, r=8, p=1, 64-byte key. ~50ms per hash on local CPU.
// Stored format: scrypt$<saltHex>$<hashHex> (params fixed in code, never in DB).
const KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } as const;

function scryptKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, SCRYPT_OPTS, (err, key) => {
      if (err) reject(err);
      else resolve(key as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scryptKey(password, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1]!, 'hex');
    const expected = Buffer.from(parts[2]!, 'hex');
    if (salt.length !== 16 || expected.length !== KEYLEN) return false;
    const key = await scryptKey(password, salt);
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}
