const totp = require('../../src/lib/totp');

// RFC 6238 appendix B, SHA1 seed "12345678901234567890"
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));

describe('totp', () => {
  it('matches the RFC 6238 test vectors (last 6 digits)', () => {
    expect(totp.generateCode(RFC_SECRET, 59 * 1000)).toBe('287082');
    expect(totp.generateCode(RFC_SECRET, 1111111109 * 1000)).toBe('081804');
    expect(totp.generateCode(RFC_SECRET, 1234567890 * 1000)).toBe('005924');
  });

  it('round trips base32', () => {
    const buf = Buffer.from('hello world, this is a secret');
    expect(totp.base32Decode(totp.base32Encode(buf)).equals(buf)).toBe(true);
  });

  it('accepts one step of drift and nothing more', () => {
    const secret = totp.generateSecret();
    const now = Date.now();
    const code = totp.generateCode(secret, now);
    expect(totp.verifyCode(secret, code, now)).toBe(true);
    expect(totp.verifyCode(secret, code, now + 30000)).toBe(true);
    expect(totp.verifyCode(secret, code, now + 90000)).toBe(false);
  });

  it('rejects malformed codes', () => {
    const secret = totp.generateSecret();
    expect(totp.verifyCode(secret, '12345')).toBe(false);
    expect(totp.verifyCode(secret, 'abcdef')).toBe(false);
  });
});
