const jwt = require('jsonwebtoken');
const { AppError } = require('../../lib/errors');
const { hashPassword, verifyPassword, sha256, randomToken } = require('../../lib/crypto');
const totp = require('../../lib/totp');

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

function createAuthService({ db, config, cipher, audit }) {
  // used so a login for an unknown email takes about as long as a real one
  const dummyHash = hashPassword('not-a-real-password-1A');

  function signAccessToken(user, mfa) {
    return jwt.sign({ typ: 'access', role: user.role, mfa }, config.JWT_ACCESS_SECRET, {
      subject: user.id,
      expiresIn: config.JWT_ACCESS_TTL,
      audience: 'amrutam-api',
      algorithm: 'HS256',
    });
  }

  async function issueTokens(client, user, { mfa, familyId, meta = {} }) {
    const refreshToken = randomToken(48);
    const { rows } = await client.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, mfa, expires_at, user_agent, ip)
       VALUES ($1, COALESCE($2, gen_random_uuid()), $3, $4, now() + make_interval(days => $5), $6, $7)
       RETURNING id`,
      [user.id, familyId ?? null, sha256(refreshToken), mfa, config.REFRESH_TOKEN_TTL_DAYS, meta.userAgent ?? null, meta.ip ?? null]
    );
    return {
      tokenId: rows[0].id,
      tokens: {
        accessToken: signAccessToken(user, mfa),
        refreshToken,
        tokenType: 'Bearer',
        expiresIn: config.JWT_ACCESS_TTL,
      },
    };
  }

  async function register({ email, password, fullName, role }, ctx) {
    const passwordHash = await hashPassword(password);

    return db.transaction(async (client) => {
      const existing = await client.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
      if (existing.rowCount) throw AppError.conflict('An account with this email already exists', 'EMAIL_TAKEN');

      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role, created_at`,
        [email, passwordHash, role]
      );
      const user = rows[0];
      await client.query('INSERT INTO profiles (user_id, full_name) VALUES ($1, $2)', [user.id, fullName]);
      await audit.record({ actor: user, action: 'user.registered', entityType: 'user', entityId: user.id, metadata: { role }, ctx }, client);

      const { tokens } = await issueTokens(client, user, { mfa: false, meta: ctx });
      return { user: { id: user.id, email: user.email, role: user.role, fullName }, ...tokens };
    });
  }

  async function login({ email, password }, ctx) {
    const { rows } = await db.query('SELECT * FROM users WHERE lower(email) = $1', [email]);
    const user = rows[0];

    if (!user) {
      await verifyPassword(password, await dummyHash);
      throw AppError.unauthorized('Invalid email or password');
    }
    if (user.locked_until && user.locked_until > new Date()) {
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      const { rows: updated } = await db.query(
        `UPDATE users SET failed_login_attempts = failed_login_attempts + 1,
           locked_until = CASE WHEN failed_login_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE NULL END,
           updated_at = now()
         WHERE id = $1 RETURNING failed_login_attempts`,
        [user.id, MAX_FAILED_LOGINS, LOCK_MINUTES]
      );
      if (updated[0].failed_login_attempts >= MAX_FAILED_LOGINS) {
        await audit.record({ actor: user, action: 'auth.account_locked', entityType: 'user', entityId: user.id, ctx });
      }
      throw AppError.unauthorized('Invalid email or password');
    }
    if (user.status !== 'active') throw AppError.forbidden('This account is disabled');

    if (user.mfa_enabled) {
      const mfaToken = jwt.sign({ typ: 'mfa' }, config.JWT_ACCESS_SECRET, {
        subject: user.id,
        expiresIn: '5m',
        audience: 'amrutam-mfa',
        algorithm: 'HS256',
      });
      return { mfaRequired: true, mfaToken };
    }

    return completeLogin(user, { mfa: false }, ctx);
  }

  async function loginWithMfa({ mfaToken, code }, ctx) {
    let payload;
    try {
      payload = jwt.verify(mfaToken, config.JWT_ACCESS_SECRET, { audience: 'amrutam-mfa', algorithms: ['HS256'] });
    } catch {
      throw AppError.unauthorized('MFA session expired, log in again');
    }

    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    const user = rows[0];
    if (!user || !user.mfa_enabled || user.status !== 'active') throw AppError.unauthorized();

    if (!totp.verifyCode(cipher.decrypt(user.mfa_secret_enc), code)) {
      await audit.record({ actor: user, action: 'auth.mfa_failed', entityType: 'user', entityId: user.id, ctx });
      throw AppError.unauthorized('Invalid MFA code');
    }

    return completeLogin(user, { mfa: true }, ctx);
  }

  async function completeLogin(user, { mfa }, ctx) {
    return db.transaction(async (client) => {
      await client.query(
        'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
        [user.id]
      );
      await audit.record({ actor: user, action: 'auth.login', entityType: 'user', entityId: user.id, metadata: { mfa }, ctx }, client);
      const { tokens } = await issueTokens(client, user, { mfa, meta: ctx });
      return { user: { id: user.id, email: user.email, role: user.role, mfaEnabled: user.mfa_enabled }, ...tokens };
    });
  }

  async function refresh({ refreshToken }, ctx) {
    return db.transaction(async (client) => {
      const { rows } = await client.query(
        `SELECT rt.*, u.role, u.status FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
         WHERE rt.token_hash = $1 FOR UPDATE OF rt`,
        [sha256(refreshToken)]
      );
      const stored = rows[0];
      if (!stored) throw AppError.unauthorized('Invalid refresh token');

      if (stored.revoked_at) {
        // someone is replaying an old token - assume it was stolen and kill the whole session family
        await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [stored.family_id]);
        await audit.record(
          { actor: { id: stored.user_id, role: stored.role }, action: 'auth.refresh_token_reuse', entityType: 'user', entityId: stored.user_id, ctx },
          client
        );
        return { reuseDetected: true };
      }
      if (stored.expires_at < new Date() || stored.status !== 'active') throw AppError.unauthorized('Session expired, log in again');

      const user = { id: stored.user_id, role: stored.role };
      const { tokenId, tokens } = await issueTokens(client, user, { mfa: stored.mfa, familyId: stored.family_id, meta: ctx });
      await client.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [stored.id, tokenId]);
      return { tokens };
    }).then((result) => {
      // thrown outside the transaction so the family revocation above is committed
      if (result.reuseDetected) throw AppError.unauthorized('Refresh token was already used; all sessions revoked');
      return result.tokens;
    });
  }

  async function logout({ refreshToken }) {
    await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(refreshToken)]);
  }

  async function setupMfa(userId) {
    const { rows } = await db.query('SELECT email, mfa_enabled FROM users WHERE id = $1', [userId]);
    if (!rows[0]) throw AppError.notFound('User');
    if (rows[0].mfa_enabled) throw AppError.conflict('MFA is already enabled', 'MFA_ALREADY_ENABLED');

    const secret = totp.generateSecret();
    await db.query('UPDATE users SET mfa_secret_enc = $2, updated_at = now() WHERE id = $1', [userId, cipher.encrypt(secret)]);
    return { secret, otpauthUrl: totp.otpauthUrl(secret, rows[0].email) };
  }

  async function enableMfa(user, { code }, ctx) {
    const { rows } = await db.query('SELECT mfa_secret_enc, mfa_enabled FROM users WHERE id = $1', [user.id]);
    const row = rows[0];
    if (!row?.mfa_secret_enc) throw AppError.badRequest('Call /auth/mfa/setup first');
    if (row.mfa_enabled) throw AppError.conflict('MFA is already enabled', 'MFA_ALREADY_ENABLED');
    if (!totp.verifyCode(cipher.decrypt(row.mfa_secret_enc), code)) throw AppError.badRequest('Invalid MFA code');

    await db.transaction(async (client) => {
      await client.query('UPDATE users SET mfa_enabled = true, updated_at = now() WHERE id = $1', [user.id]);
      // existing sessions were not MFA verified, make the user log in again
      await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
      await audit.record({ actor: user, action: 'auth.mfa_enabled', entityType: 'user', entityId: user.id, ctx }, client);
    });
  }

  async function disableMfa(user, { code }, ctx) {
    const { rows } = await db.query('SELECT mfa_secret_enc, mfa_enabled FROM users WHERE id = $1', [user.id]);
    if (!rows[0]?.mfa_enabled) throw AppError.badRequest('MFA is not enabled');
    if (user.role === 'admin' && config.REQUIRE_ADMIN_MFA) throw AppError.forbidden('Admins cannot turn off MFA');
    if (!totp.verifyCode(cipher.decrypt(rows[0].mfa_secret_enc), code)) throw AppError.badRequest('Invalid MFA code');

    await db.transaction(async (client) => {
      await client.query('UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, updated_at = now() WHERE id = $1', [user.id]);
      await audit.record({ actor: user, action: 'auth.mfa_disabled', entityType: 'user', entityId: user.id, ctx }, client);
    });
  }

  return { register, login, loginWithMfa, refresh, logout, setupMfa, enableMfa, disableMfa };
}

module.exports = { createAuthService };
