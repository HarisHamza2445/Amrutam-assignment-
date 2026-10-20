// RFC 6238 TOTP, compatible with Google Authenticator / Authy (SHA1, 6 digits, 30s)
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = str.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

function generateCode(secret, time = Date.now()) {
  return hotp(secret, Math.floor(time / 1000 / 30));
}

// allow one step of clock drift either side
function verifyCode(secret, code, time = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return false;
  const counter = Math.floor(time / 1000 / 30);
  for (let drift = -1; drift <= 1; drift++) {
    const candidate = hotp(secret, counter + drift);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(String(code)))) return true;
  }
  return false;
}

function otpauthUrl(secret, account, issuer = 'Amrutam') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, generateCode, verifyCode, otpauthUrl, base32Encode, base32Decode };
