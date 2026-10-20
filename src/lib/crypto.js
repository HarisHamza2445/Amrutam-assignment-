const crypto = require('crypto');

// ---- field level encryption (AES-256-GCM, versioned keys so they can be rotated) ----

function parseKeyring(keysString, activeVersion) {
  const keys = new Map();
  for (const entry of keysString.split(',')) {
    const [version, b64] = entry.trim().split(':');
    if (!version || !b64) continue;
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error(`encryption key ${version} must be 32 bytes`);
    keys.set(version, key);
  }
  if (!keys.has(activeVersion)) {
    throw new Error(`active encryption key "${activeVersion}" is not in DATA_ENCRYPTION_KEYS`);
  }
  return { keys, activeVersion };
}

function createCipher(keyring) {
  function encrypt(plain) {
    if (plain === null || plain === undefined || plain === '') return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyring.keys.get(keyring.activeVersion), iv);
    const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [keyring.activeVersion, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
  }

  function decrypt(value) {
    if (!value) return null;
    const [version, iv, tag, data] = value.split(':');
    const key = keyring.keys.get(version);
    if (!key) throw new Error(`no key loaded for version ${version}`);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }

  const keyVersionOf = (value) => (value ? value.split(':')[0] : null);

  return { encrypt, decrypt, keyVersionOf, activeVersion: keyring.activeVersion };
}

// ---- passwords (scrypt, built into node so no native deps) ----

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function scryptAsync(password, salt, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, opts.keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [algo, N, r, p, salt, hash] = (stored || '').split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    keylen: expected.length,
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(actual, expected);
}

// ---- misc ----

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function hmacSha256(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  parseKeyring,
  createCipher,
  hashPassword,
  verifyPassword,
  sha256,
  randomToken,
  hmacSha256,
  safeEqual,
};
