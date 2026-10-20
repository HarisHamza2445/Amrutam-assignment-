const { parseKeyring, createCipher, hashPassword, verifyPassword, hmacSha256, safeEqual } = require('../../src/lib/crypto');

const k1 = Buffer.alloc(32, 7).toString('base64');
const k2 = Buffer.alloc(32, 9).toString('base64');

describe('field encryption', () => {
  const v1 = createCipher(parseKeyring(`v1:${k1}`, 'v1'));
  const both = createCipher(parseKeyring(`v1:${k1},v2:${k2}`, 'v2'));

  it('encrypts and decrypts', () => {
    const enc = v1.encrypt('+919876543210');
    expect(enc).not.toContain('9876543210');
    expect(v1.decrypt(enc)).toBe('+919876543210');
  });

  it('uses a fresh IV every time', () => {
    expect(v1.encrypt('same')).not.toBe(v1.encrypt('same'));
  });

  it('keeps old data readable after rotating to a new key', () => {
    const old = v1.encrypt('legacy value');
    expect(both.decrypt(old)).toBe('legacy value');
    expect(both.keyVersionOf(both.encrypt('new'))).toBe('v2');
  });

  it('detects tampering', () => {
    const parts = v1.encrypt('do not touch').split(':');
    const data = Buffer.from(parts[3], 'base64');
    data[0] ^= 1;
    parts[3] = data.toString('base64');
    expect(() => v1.decrypt(parts.join(':'))).toThrow();
  });

  it('passes empty values through as null', () => {
    expect(v1.encrypt('')).toBeNull();
    expect(v1.encrypt(undefined)).toBeNull();
    expect(v1.decrypt(null)).toBeNull();
  });

  it('refuses a keyring without the active key or with a short key', () => {
    expect(() => parseKeyring(`v1:${k1}`, 'v2')).toThrow(/active encryption key/);
    expect(() => parseKeyring('v1:c2hvcnQ=', 'v1')).toThrow(/32 bytes/);
  });
});

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const hash = await hashPassword('Correct-Horse-1');
    expect(hash.startsWith('scrypt$')).toBe(true);
    await expect(verifyPassword('Correct-Horse-1', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong-Horse-1', hash)).resolves.toBe(false);
  });

  it('returns false for garbage hashes', async () => {
    await expect(verifyPassword('x', 'md5$abc')).resolves.toBe(false);
  });
});

describe('hmac', () => {
  it('compares signatures safely', () => {
    const sig = hmacSha256('secret', 'body');
    expect(safeEqual(sig, hmacSha256('secret', 'body'))).toBe(true);
    expect(safeEqual(sig, hmacSha256('other', 'body'))).toBe(false);
    expect(safeEqual(sig, 'short')).toBe(false);
  });
});
