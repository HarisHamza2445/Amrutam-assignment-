const crypto = require('crypto');
const request = require('supertest');
const config = require('../../src/config');
const { createContainer } = require('../../src/container');
const { createApp } = require('../../src/app');
const { migrate } = require('../../src/db/migrator');
const { createLogger } = require('../../src/lib/logger');
const totp = require('../../src/lib/totp');
const { hashPassword } = require('../../src/lib/crypto');

const PASSWORD = 'Sup3rSecretPass';

async function setup() {
  const sent = [];
  const container = createContainer(config, {
    logger: createLogger({ level: 'silent' }),
    notifier: { send: async (msg) => sent.push(msg) },
  });
  await migrate(container.db, { info: () => {} });
  await container.db.query(`TRUNCATE audit_logs, payment_events, payments, prescriptions, consultations,
    availability_slots, doctors, refresh_tokens, idempotency_keys, profiles, users, jobs, daily_stats CASCADE`);
  await container.cache.delPrefix('');

  const app = createApp(container);
  const api = () => request(app);
  const key = () => crypto.randomUUID();

  async function register(role = 'patient', email = `${role}-${crypto.randomUUID()}@test.dev`) {
    const res = await api().post('/api/v1/auth/register').send({ email, password: PASSWORD, fullName: `Test ${role}`, role });
    if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
    return { ...res.body, email, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
  }

  async function createAdmin() {
    const secret = totp.generateSecret();
    const email = `admin-${crypto.randomUUID()}@test.dev`;
    const { rows } = await container.db.query(
      `INSERT INTO users (email, password_hash, role, mfa_enabled, mfa_secret_enc) VALUES ($1, $2, 'admin', true, $3) RETURNING id`,
      [email, await hashPassword(PASSWORD), container.cipher.encrypt(secret)]
    );
    await container.db.query(`INSERT INTO profiles (user_id, full_name) VALUES ($1, 'Admin')`, [rows[0].id]);

    const first = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const second = await api().post('/api/v1/auth/login/mfa').send({ mfaToken: first.body.mfaToken, code: totp.generateCode(secret) });
    return { id: rows[0].id, email, secret, auth: { Authorization: `Bearer ${second.body.accessToken}` } };
  }

  async function createDoctor({ fee = 50000, specialization = 'Panchakarma', languages = ['english', 'hindi'], slots = [] } = {}) {
    const user = await register('doctor');
    const profile = await api()
      .put('/api/v1/doctors/me')
      .set(user.auth)
      .send({ specialization, experienceYears: 8, consultationFee: fee, languages });
    await container.db.query('UPDATE doctors SET is_verified = true WHERE id = $1', [profile.body.id]);
    await container.cache.delPrefix('');

    let createdSlots = [];
    if (slots.length) {
      const res = await api().post('/api/v1/doctors/me/slots').set(user.auth).send({ slots });
      if (res.status !== 201) throw new Error(`slot creation failed: ${JSON.stringify(res.body)}`);
      createdSlots = res.body.data;
    }
    return { ...user, doctorId: profile.body.id, slots: createdSlots };
  }

  // a slot `minutesFromNow` in the future, `length` minutes long
  function slotAt(minutesFromNow, length = 30) {
    const start = new Date(Date.now() + minutesFromNow * 60000);
    start.setSeconds(0, 0);
    return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + length * 60000).toISOString() };
  }

  function webhook(event) {
    const { body, signature } = container.paymentProvider.signWebhook(event);
    return api().post('/api/v1/payments/webhook').set('Content-Type', 'application/json').set('X-Mockpay-Signature', signature).send(body);
  }

  const pay = (orderId, type = 'payment.succeeded') =>
    webhook({ id: `evt_${crypto.randomUUID()}`, type, data: { orderId, paymentId: `pay_${crypto.randomUUID().slice(0, 8)}` } });

  async function book(patient, slotId, body = {}) {
    return api().post('/api/v1/consultations').set(patient.auth).set('Idempotency-Key', key()).send({ slotId, ...body });
  }

  async function runJobs() {
    // run everything that's due, including jobs enqueued by other jobs
    let processed;
    do {
      processed = await container.queue.runOnce(container.jobHandlers, 50);
    } while (processed > 0);
  }

  return { container, app, api, key, register, createAdmin, createDoctor, slotAt, webhook, pay, book, runJobs, sent };
}

module.exports = { setup, PASSWORD };
