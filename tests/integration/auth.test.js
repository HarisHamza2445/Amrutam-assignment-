const { setup, PASSWORD } = require('./helpers');
const totp = require('../../src/lib/totp');

let t;
beforeAll(async () => {
  t = await setup();
});
afterAll(() => t.container.close());

describe('auth', () => {
  it('registers, logs in and returns the profile', async () => {
    const user = await t.register('patient', 'Ravi@Example.com');
    expect(user.user.email).toBe('ravi@example.com');

    const login = await t.api().post('/api/v1/auth/login').send({ email: 'ravi@example.com', password: PASSWORD });
    expect(login.status).toBe(200);

    const me = await t.api().get('/api/v1/users/me').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.profile.fullName).toBe('Test patient');
  });

  it('rejects duplicate emails regardless of case', async () => {
    await t.register('patient', 'dupe@example.com');
    const res = await t.api().post('/api/v1/auth/register').send({ email: 'DUPE@example.com', password: PASSWORD, fullName: 'Dupe' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('validates input and does not allow self-registering as admin', async () => {
    const weak = await t.api().post('/api/v1/auth/register').send({ email: 'a@b.co', password: 'short', fullName: 'X Y' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.details[0].field).toBe('body.password');

    const admin = await t.api().post('/api/v1/auth/register').send({ email: 'evil@b.co', password: PASSWORD, fullName: 'Evil', role: 'admin' });
    expect(admin.status).toBe(400);
  });

  it('locks the account after repeated failures', async () => {
    const user = await t.register();
    for (let i = 0; i < 5; i++) {
      const res = await t.api().post('/api/v1/auth/login').send({ email: user.email, password: 'Wrong-pass-123' });
      expect(res.status).toBe(401);
    }
    const locked = await t.api().post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
    expect(locked.status).toBe(423);
  });

  it('rotates refresh tokens and revokes the family when an old one is reused', async () => {
    const user = await t.register();
    const first = await t.api().post('/api/v1/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(user.refreshToken);

    const replay = await t.api().post('/api/v1/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(replay.status).toBe(401);

    // the legit newer token is now dead too
    const after = await t.api().post('/api/v1/auth/refresh').send({ refreshToken: first.body.refreshToken });
    expect(after.status).toBe(401);
  });

  it('supports TOTP MFA end to end', async () => {
    const user = await t.register();
    const setupRes = await t.api().post('/api/v1/auth/mfa/setup').set(user.auth);
    expect(setupRes.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);

    const bad = await t.api().post('/api/v1/auth/mfa/enable').set(user.auth).send({ code: '000000' });
    expect(bad.status).toBe(400);

    const ok = await t.api().post('/api/v1/auth/mfa/enable').set(user.auth).send({ code: totp.generateCode(setupRes.body.secret) });
    expect(ok.status).toBe(200);

    const login = await t.api().post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
    expect(login.body.mfaRequired).toBe(true);
    expect(login.body.accessToken).toBeUndefined();

    const done = await t.api()
      .post('/api/v1/auth/login/mfa')
      .send({ mfaToken: login.body.mfaToken, code: totp.generateCode(setupRes.body.secret) });
    expect(done.status).toBe(200);
    expect(done.body.accessToken).toBeDefined();
  });

  it('keeps admin routes behind role and MFA checks', async () => {
    const patient = await t.register();
    const forbidden = await t.api().get('/api/v1/admin/audit-logs').set(patient.auth);
    expect(forbidden.status).toBe(403);

    const admin = await t.createAdmin();
    const ok = await t.api().get('/api/v1/admin/audit-logs?action=auth.login').set(admin.auth);
    expect(ok.status).toBe(200);
    expect(ok.body.data.length).toBeGreaterThan(0);
  });

  it('rejects requests without a valid token', async () => {
    expect((await t.api().get('/api/v1/users/me')).status).toBe(401);
    expect((await t.api().get('/api/v1/users/me').set('Authorization', 'Bearer nope')).status).toBe(401);
  });

  it('stores the phone number encrypted', async () => {
    const user = await t.register();
    await t.api().patch('/api/v1/users/me').set(user.auth).send({ phone: '+919812345678', city: 'Pune' });
    const { rows } = await t.container.db.query('SELECT phone_enc FROM profiles WHERE user_id = $1', [user.user.id]);
    expect(rows[0].phone_enc).not.toContain('9812345678');
    const me = await t.api().get('/api/v1/users/me').set(user.auth);
    expect(me.body.profile.phone).toBe('+919812345678');
  });
});
