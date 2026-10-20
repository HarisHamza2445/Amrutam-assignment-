const { setup } = require('./helpers');

let t;
let patient;
let patient2;

beforeAll(async () => {
  t = await setup();
  patient = await t.register('patient');
  patient2 = await t.register('patient');
});
afterAll(() => t.container.close());

async function slotStatus(id) {
  const { rows } = await t.container.db.query('SELECT status FROM availability_slots WHERE id = $1', [id]);
  return rows[0].status;
}

describe('booking', () => {
  it('lets exactly one of many concurrent requests book a slot', async () => {
    const doctor = await t.createDoctor({ slots: [t.slotAt(24 * 60)] });
    const slotId = doctor.slots[0].id;
    const patients = [patient, patient2, ...(await Promise.all([1, 2, 3].map(() => t.register('patient'))))];

    const results = await Promise.all(patients.map((p) => t.book(p, slotId)));
    const statuses = results.map((r) => r.status).sort();

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);
    expect(await slotStatus(slotId)).toBe('held');
  });

  it('replays the original response for a repeated Idempotency-Key', async () => {
    const doctor = await t.createDoctor({ slots: [t.slotAt(25 * 60)] });
    const key = t.key();
    const body = { slotId: doctor.slots[0].id, reason: 'joint pain' };

    const first = await t.api().post('/api/v1/consultations').set(patient.auth).set('Idempotency-Key', key).send(body);
    const second = await t.api().post('/api/v1/consultations').set(patient.auth).set('Idempotency-Key', key).send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.consultation.id).toBe(first.body.consultation.id);

    const { rows } = await t.container.db.query('SELECT count(*)::int AS n FROM consultations WHERE slot_id = $1', [body.slotId]);
    expect(rows[0].n).toBe(1);
  });

  it('refuses to reuse a key for a different request, and requires a key', async () => {
    const doctor = await t.createDoctor({ slots: [t.slotAt(26 * 60), t.slotAt(27 * 60)] });
    const key = t.key();
    await t.api().post('/api/v1/consultations').set(patient.auth).set('Idempotency-Key', key).send({ slotId: doctor.slots[0].id });
    const reused = await t.api().post('/api/v1/consultations').set(patient.auth).set('Idempotency-Key', key).send({ slotId: doctor.slots[1].id });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const missing = await t.api().post('/api/v1/consultations').set(patient.auth).send({ slotId: doctor.slots[1].id });
    expect(missing.status).toBe(400);
  });

  it('confirms the booking when the payment webhook arrives, and ignores duplicates', async () => {
    const doctor = await t.createDoctor({ slots: [t.slotAt(28 * 60)] });
    const booking = await t.book(patient2, doctor.slots[0].id, { reason: 'insomnia' });
    const event = { id: 'evt_dup_test', type: 'payment.succeeded', data: { orderId: booking.body.payment.orderId, paymentId: 'pay_1' } };

    const first = await t.webhook(event);
    expect(first.body.outcome).toBe('confirmed');
    const again = await t.webhook(event);
    expect(again.body.outcome).toBe('duplicate');

    const details = await t.api().get(`/api/v1/consultations/${booking.body.consultation.id}`).set(patient2.auth);
    expect(details.body.status).toBe('confirmed');
    expect(details.body.reason).toBe('insomnia');
    expect(await slotStatus(doctor.slots[0].id)).toBe('booked');

    await t.runJobs();
    expect(t.sent.some((m) => m.template === 'booking_confirmed')).toBe(true);
  });

  it('rejects webhooks with a bad signature', async () => {
    const res = await t.api()
      .post('/api/v1/payments/webhook')
      .set('X-Mockpay-Signature', 'deadbeef')
      .send({ id: 'evt_x', type: 'payment.succeeded', data: { orderId: 'order_x' } });
    expect(res.status).toBe(401);
  });

  it('releases the slot when the payment hold expires', async () => {
    const doctor = await t.createDoctor({ slots: [t.slotAt(29 * 60)] });
    const booking = await t.book(patient, doctor.slots[0].id);

    await t.container.db.query(`UPDATE jobs SET run_at = now() WHERE type = 'booking.expire_hold'`);
    await t.runJobs();

    const { rows } = await t.container.db.query('SELECT status FROM consultations WHERE id = $1', [booking.body.consultation.id]);
    expect(rows[0].status).toBe('expired');
    expect(await slotStatus(doctor.slots[0].id)).toBe('open');

    // someone else can now book it
    expect((await t.book(patient2, doctor.slots[0].id)).status).toBe(201);
  });

  it('refunds a payment that arrives after the hold expired', async () => {
    const doctor = await t.createDoctor({ slots: [t.slotAt(30 * 60)] });
    const booking = await t.book(patient, doctor.slots[0].id);
    await t.container.consultationsService.expireHold({ consultationId: booking.body.consultation.id });

    const late = await t.pay(booking.body.payment.orderId);
    expect(late.body.outcome).toBe('refunding_late_payment');

    await t.runJobs();
    const { rows } = await t.container.db.query('SELECT status FROM payments WHERE id = $1', [booking.body.payment.id]);
    expect(rows[0].status).toBe('refunded');
  });

  it('frees the slot when the payment fails', async () => {
    const doctor = await t.createDoctor({ slots: [t.slotAt(31 * 60)] });
    const booking = await t.book(patient, doctor.slots[0].id);
    const res = await t.pay(booking.body.payment.orderId, 'payment.failed');
    expect(res.body.outcome).toBe('released');
    expect(await slotStatus(doctor.slots[0].id)).toBe('open');
  });

  it('stops a patient double booking the same time', async () => {
    const a = await t.createDoctor({ slots: [t.slotAt(32 * 60)] });
    const b = await t.createDoctor({ slots: [t.slotAt(32 * 60)] });
    expect((await t.book(patient2, a.slots[0].id)).status).toBe(201);
    const second = await t.book(patient2, b.slots[0].id);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('PATIENT_DOUBLE_BOOKING');
  });

  it('cancels a paid booking, reopens the slot and refunds', async () => {
    const doctor = await t.createDoctor({ slots: [t.slotAt(33 * 60)] });
    const booking = await t.book(patient, doctor.slots[0].id);
    await t.pay(booking.body.payment.orderId);

    const cancel = await t.api()
      .post(`/api/v1/consultations/${booking.body.consultation.id}/cancel`)
      .set(patient.auth)
      .set('Idempotency-Key', t.key())
      .send({ reason: 'feeling better' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('cancelled');
    expect(await slotStatus(doctor.slots[0].id)).toBe('open');

    await t.runJobs();
    const { rows } = await t.container.db.query('SELECT status FROM payments WHERE id = $1', [booking.body.payment.id]);
    expect(rows[0].status).toBe('refunded');
  });

  it('blocks patient cancellation inside the cutoff window', async () => {
    const doctor = await t.createDoctor({ slots: [t.slotAt(60)] });
    const booking = await t.book(patient2, doctor.slots[0].id);
    await t.pay(booking.body.payment.orderId);

    const res = await t.api()
      .post(`/api/v1/consultations/${booking.body.consultation.id}/cancel`)
      .set(patient2.auth)
      .set('Idempotency-Key', t.key())
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CANCELLATION_WINDOW_CLOSED');
  });

  it("does not show other people's consultations", async () => {
    const doctor = await t.createDoctor({ slots: [t.slotAt(34 * 60)] });
    const booking = await t.book(patient, doctor.slots[0].id);
    const res = await t.api().get(`/api/v1/consultations/${booking.body.consultation.id}`).set(patient2.auth);
    expect(res.status).toBe(404);
  });
});

describe('doctor availability', () => {
  it('rejects overlapping slots, including against existing ones', async () => {
    const doctor = await t.createDoctor({ slots: [t.slotAt(48 * 60, 30)] });
    const overlapping = t.slotAt(48 * 60 + 15, 30);
    const res = await t.api().post('/api/v1/doctors/me/slots').set(doctor.auth).send({ slots: [overlapping] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLOT_OVERLAP');

    const inRequest = await t.api()
      .post('/api/v1/doctors/me/slots')
      .set(doctor.auth)
      .send({ slots: [t.slotAt(50 * 60, 30), t.slotAt(50 * 60 + 10, 30)] });
    expect(inRequest.status).toBe(400);
  });

  it('only lets doctors manage slots', async () => {
    const res = await t.api().post('/api/v1/doctors/me/slots').set(patient.auth).send({ slots: [t.slotAt(60 * 60)] });
    expect(res.status).toBe(403);
  });
});
