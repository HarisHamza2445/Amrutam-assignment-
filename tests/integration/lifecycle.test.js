const { setup } = require('./helpers');

let t;
let patient;
let doctor;
let admin;

beforeAll(async () => {
  t = await setup();
  patient = await t.register('patient');
  admin = await t.createAdmin();
  // first slot starts in 10 minutes so the doctor is allowed to start it straight away
  doctor = await t.createDoctor({ fee: 45000, specialization: 'Kayachikitsa', languages: ['english', 'tamil'], slots: [t.slotAt(10), t.slotAt(36 * 60)] });
});
afterAll(() => t.container.close());

describe('consultation lifecycle and prescriptions', () => {
  let consultationId;

  it('goes from booked to completed with a prescription', async () => {
    const booking = await t.book(patient, doctor.slots[0].id, { reason: 'digestion issues' });
    consultationId = booking.body.consultation.id;
    await t.pay(booking.body.payment.orderId);

    const early = await t.api().post(`/api/v1/consultations/${consultationId}/prescription`).set(doctor.auth).set('Idempotency-Key', t.key()).send({
      medications: [{ name: 'Triphala churna', dosage: '5g', frequency: 'at bedtime', durationDays: 30 }],
    });
    expect(early.status).toBe(422);

    const start = await t.api().post(`/api/v1/consultations/${consultationId}/start`).set(doctor.auth);
    expect(start.status).toBe(200);
    expect(start.body.status).toBe('in_progress');

    const rx = await t.api()
      .post(`/api/v1/consultations/${consultationId}/prescription`)
      .set(doctor.auth)
      .set('Idempotency-Key', t.key())
      .send({
        medications: [{ name: 'Triphala churna', dosage: '5g', frequency: 'at bedtime', durationDays: 30, instructions: 'with warm water' }],
        diagnosis: 'Agnimandya',
        advice: 'Light dinner before 8pm',
      });
    expect(rx.status).toBe(201);
    expect(rx.body.diagnosis).toBe('Agnimandya');

    const { rows } = await t.container.db.query('SELECT diagnosis_enc FROM prescriptions WHERE id = $1', [rx.body.id]);
    expect(rows[0].diagnosis_enc).not.toContain('Agnimandya');

    const dupe = await t.api()
      .post(`/api/v1/consultations/${consultationId}/prescription`)
      .set(doctor.auth)
      .set('Idempotency-Key', t.key())
      .send({ medications: [{ name: 'x', dosage: '1', frequency: 'once', durationDays: 1 }] });
    expect(dupe.status).toBe(409);

    const done = await t.api().post(`/api/v1/consultations/${consultationId}/complete`).set(doctor.auth).send({ notes: 'review in 4 weeks' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
  });

  it('does not allow invalid transitions', async () => {
    const again = await t.api().post(`/api/v1/consultations/${consultationId}/start`).set(doctor.auth);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('lets the patient read the prescription and logs the access', async () => {
    const res = await t.api().get(`/api/v1/consultations/${consultationId}/prescription`).set(patient.auth);
    expect(res.status).toBe(200);
    expect(res.body.medications[0].name).toBe('Triphala churna');

    const mine = await t.api().get('/api/v1/prescriptions').set(patient.auth);
    expect(mine.body.meta.total).toBe(1);

    const audit = await t.api().get(`/api/v1/admin/audit-logs?action=prescription.viewed&entityId=${res.body.id}`).set(admin.auth);
    expect(audit.body.data[0].actorId).toBe(patient.user.id);
  });

  it('does not let another doctor touch the consultation', async () => {
    const other = await t.createDoctor();
    const res = await t.api().get(`/api/v1/consultations/${consultationId}/prescription`).set(other.auth);
    expect(res.status).toBe(404);
  });

  it('keeps the audit log append-only', async () => {
    await expect(t.container.db.query(`UPDATE audit_logs SET action = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(t.container.db.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
  });
});

describe('search', () => {
  it('filters by specialization, language, fee and day', async () => {
    const bySpec = await t.api().get('/api/v1/doctors?specialization=kayachikitsa');
    expect(bySpec.body.data.map((d) => d.id)).toContain(doctor.doctorId);

    const byLang = await t.api().get('/api/v1/doctors?language=Tamil');
    expect(byLang.body.data.map((d) => d.id)).toContain(doctor.doctorId);

    const tooCheap = await t.api().get('/api/v1/doctors?maxFee=10000');
    expect(tooCheap.body.data.map((d) => d.id)).not.toContain(doctor.doctorId);

    const day = new Date(doctor.slots[1].startsAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const available = await t.api().get(`/api/v1/doctors?availableOn=${day}`);
    expect(available.body.data.map((d) => d.id)).toContain(doctor.doctorId);
  });

  it('hides unverified doctors', async () => {
    const user = await t.register('doctor');
    const profile = await t.api()
      .put('/api/v1/doctors/me')
      .set(user.auth)
      .send({ specialization: 'Hidden', experienceYears: 1, consultationFee: 100, languages: ['english'] });
    expect((await t.api().get(`/api/v1/doctors/${profile.body.id}`)).status).toBe(404);
  });

  it('validates query params', async () => {
    const res = await t.api().get('/api/v1/doctors?minRating=9&sort=random');
    expect(res.status).toBe(400);
  });
});

describe('admin', () => {
  it('returns analytics', async () => {
    const res = await t.api().get('/api/v1/admin/analytics/overview').set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.consultations.byStatus.completed).toBe(1);
    expect(res.body.revenue.gross).toBe(45000);
    expect(res.body.topDoctors[0].id).toBe(doctor.doctorId);
  });

  it('rolls up daily stats through the job', async () => {
    await t.container.queue.enqueue('analytics.rollup', {});
    await t.runJobs();
    const res = await t.api().get('/api/v1/admin/analytics/daily').set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('disables a user and kills their sessions', async () => {
    const victim = await t.register();
    const res = await t.api().patch(`/api/v1/admin/users/${victim.user.id}/status`).set(admin.auth).send({ status: 'disabled' });
    expect(res.status).toBe(200);
    const refresh = await t.api().post('/api/v1/auth/refresh').send({ refreshToken: victim.refreshToken });
    expect(refresh.status).toBe(401);
  });
});
