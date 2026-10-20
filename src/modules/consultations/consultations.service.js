const { AppError } = require('../../lib/errors');
const { randomToken } = require('../../lib/crypto');
const { getPagination, pageMeta } = require('../../lib/pagination');
const { counters } = require('../../lib/metrics');
const { STATUS, canTransition, checkStart, checkNoShow, checkPatientCancel } = require('./consultation.state');

const MIN_LEAD_MINUTES = 5;
const LIVE_STATUSES = [STATUS.PENDING_PAYMENT, STATUS.CONFIRMED, STATUS.IN_PROGRESS];

function createConsultationsService({ db, cipher, audit, queue, config, doctorsService, cache }) {
  function toDto(row, { includePrivate = false } = {}) {
    return {
      id: row.id,
      patientId: row.patient_id,
      doctorId: row.doctor_id,
      slotId: row.slot_id,
      status: row.status,
      fee: row.fee,
      scheduledStart: row.scheduled_start,
      scheduledEnd: row.scheduled_end,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      cancelledAt: row.cancelled_at,
      cancelReason: row.cancel_reason,
      createdAt: row.created_at,
      ...(includePrivate ? { reason: cipher.decrypt(row.reason_enc), notes: cipher.decrypt(row.notes_enc) } : {}),
      ...(row.doctor_name !== undefined ? { doctorName: row.doctor_name, patientName: row.patient_name } : {}),
    };
  }

  async function book(user, { slotId, reason }, ctx) {
    try {
      const result = await db.transaction(async (client) => {
        // lock the slot row: concurrent bookings for the same slot queue up here and only the
        // first one sees status = 'open'
        const { rows } = await client.query(
          `SELECT s.*, d.consultation_fee, d.is_verified, d.user_id AS doctor_user_id
           FROM availability_slots s JOIN doctors d ON d.id = s.doctor_id
           WHERE s.id = $1
           FOR UPDATE OF s`,
          [slotId]
        );
        const slot = rows[0];
        if (!slot || !slot.is_verified) throw AppError.notFound('Slot');
        if (slot.doctor_user_id === user.id) throw AppError.unprocessable('You cannot book your own slot');
        if (slot.status !== 'open') throw AppError.conflict('This slot is no longer available', 'SLOT_UNAVAILABLE');
        if (slot.starts_at.getTime() < Date.now() + MIN_LEAD_MINUTES * 60000) {
          throw AppError.unprocessable('This slot starts too soon to be booked', 'SLOT_TOO_SOON');
        }

        const overlap = await client.query(
          `SELECT 1 FROM consultations
           WHERE patient_id = $1 AND status = ANY($2) AND scheduled_start < $4 AND scheduled_end > $3
           LIMIT 1`,
          [user.id, LIVE_STATUSES, slot.starts_at, slot.ends_at]
        );
        if (overlap.rowCount) throw AppError.conflict('You already have a consultation at this time', 'PATIENT_DOUBLE_BOOKING');

        const free = slot.consultation_fee === 0;
        const holdUntil = new Date(Date.now() + config.BOOKING_HOLD_MINUTES * 60000);

        await client.query(
          `UPDATE availability_slots SET status = $2, held_until = $3, updated_at = now() WHERE id = $1`,
          [slot.id, free ? 'booked' : 'held', free ? null : holdUntil]
        );

        const { rows: created } = await client.query(
          `INSERT INTO consultations (patient_id, doctor_id, slot_id, status, reason_enc, fee, scheduled_start, scheduled_end)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [user.id, slot.doctor_id, slot.id, free ? STATUS.CONFIRMED : STATUS.PENDING_PAYMENT, cipher.encrypt(reason), slot.consultation_fee, slot.starts_at, slot.ends_at]
        );
        const consultation = created[0];

        const { rows: payments } = await client.query(
          `INSERT INTO payments (consultation_id, amount, status, provider_order_id)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [consultation.id, slot.consultation_fee, free ? 'succeeded' : 'pending', `order_${randomToken(12)}`]
        );
        const payment = payments[0];

        if (free) {
          await queue.enqueue('notify.booking_confirmed', { consultationId: consultation.id }, { client });
        } else {
          // the saga's timeout step: if payment never arrives, release the slot
          await queue.enqueue(
            'booking.expire_hold',
            { consultationId: consultation.id },
            { client, runAt: holdUntil, dedupeKey: `expire:${consultation.id}` }
          );
        }

        await audit.record(
          { actor: user, action: 'consultation.booked', entityType: 'consultation', entityId: consultation.id, metadata: { slotId: slot.id, doctorId: slot.doctor_id }, ctx },
          client
        );

        return {
          consultation: toDto(consultation),
          payment: {
            id: payment.id,
            orderId: payment.provider_order_id,
            amount: payment.amount,
            currency: payment.currency,
            status: payment.status,
            payBefore: free ? null : holdUntil,
          },
        };
      });

      counters.bookings.inc({ outcome: 'ok' });
      await cache.delPrefix('doctors:search:');
      return result;
    } catch (err) {
      // unique index on live consultations per slot is the last line of defence
      if (err.code === '23505') {
        counters.bookings.inc({ outcome: 'conflict' });
        throw AppError.conflict('This slot is no longer available', 'SLOT_UNAVAILABLE');
      }
      counters.bookings.inc({ outcome: err.status === 409 ? 'conflict' : 'error' });
      throw err;
    }
  }

  async function loadForUpdate(client, id) {
    const { rows } = await client.query(
      `SELECT c.*, d.user_id AS doctor_user_id FROM consultations c JOIN doctors d ON d.id = c.doctor_id
       WHERE c.id = $1 FOR UPDATE OF c`,
      [id]
    );
    if (!rows[0]) throw AppError.notFound('Consultation');
    return rows[0];
  }

  function participantRole(user, consultation) {
    if (user.role === 'admin') return 'admin';
    if (user.role === 'patient' && consultation.patient_id === user.id) return 'patient';
    if (user.role === 'doctor' && consultation.doctor_user_id === user.id) return 'doctor';
    return null;
  }

  function assertTransition(consultation, to) {
    if (!canTransition(consultation.status, to)) {
      throw AppError.conflict(`Cannot move a ${consultation.status} consultation to ${to}`, 'INVALID_STATUS_TRANSITION');
    }
  }

  async function cancel(user, id, { reason }, ctx) {
    const result = await db.transaction(async (client) => {
      const consultation = await loadForUpdate(client, id);
      const role = participantRole(user, consultation);
      if (!role) throw AppError.notFound('Consultation');

      assertTransition(consultation, STATUS.CANCELLED);
      if (role === 'patient') {
        const problem = checkPatientCancel(consultation, config.CANCELLATION_CUTOFF_HOURS);
        if (problem) throw AppError.unprocessable(problem, 'CANCELLATION_WINDOW_CLOSED');
      }

      const { rows } = await client.query(
        `UPDATE consultations SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, user.id, reason ?? null]
      );

      // patient cancelled -> slot goes back on sale; doctor cancelled -> they can't make it, block it
      const slotStatus = role === 'patient' ? 'open' : 'blocked';
      await client.query(
        `UPDATE availability_slots SET status = CASE WHEN starts_at > now() THEN $2 ELSE 'blocked' END,
           held_until = NULL, updated_at = now()
         WHERE id = $1`,
        [consultation.slot_id, slotStatus]
      );

      const { rows: payRows } = await client.query('SELECT * FROM payments WHERE consultation_id = $1 FOR UPDATE', [id]);
      const payment = payRows[0];
      if (payment?.status === 'succeeded' && payment.amount > 0) {
        await client.query(`UPDATE payments SET status = 'refund_pending', updated_at = now() WHERE id = $1`, [payment.id]);
        await queue.enqueue('payments.refund', { paymentId: payment.id }, { client, dedupeKey: `refund:${payment.id}` });
      } else if (payment?.status === 'pending') {
        await client.query(`UPDATE payments SET status = 'cancelled', updated_at = now() WHERE id = $1`, [payment.id]);
      }

      await queue.enqueue('notify.consultation_cancelled', { consultationId: id, cancelledBy: role }, { client });
      await audit.record(
        { actor: user, action: 'consultation.cancelled', entityType: 'consultation', entityId: id, metadata: { by: role, previousStatus: consultation.status }, ctx },
        client
      );
      return toDto(rows[0]);
    });
    await cache.delPrefix('doctors:search:');
    return result;
  }

  async function doctorTransition(user, id, to, ctx, { notes } = {}) {
    return db.transaction(async (client) => {
      const consultation = await loadForUpdate(client, id);
      if (participantRole(user, consultation) !== 'doctor') throw AppError.notFound('Consultation');
      assertTransition(consultation, to);

      const timing = to === STATUS.IN_PROGRESS ? checkStart(consultation) : to === STATUS.NO_SHOW ? checkNoShow(consultation) : null;
      if (timing) throw AppError.unprocessable(timing, 'OUTSIDE_ALLOWED_TIME');

      const extra = {
        [STATUS.IN_PROGRESS]: 'started_at = now()',
        [STATUS.COMPLETED]: 'ended_at = now(), notes_enc = COALESCE($3, notes_enc)',
        [STATUS.NO_SHOW]: 'ended_at = now()',
      }[to];
      const params = [id, to];
      if (to === STATUS.COMPLETED) params.push(cipher.encrypt(notes));

      const { rows } = await client.query(
        `UPDATE consultations SET status = $2, ${extra}, updated_at = now() WHERE id = $1 RETURNING *`,
        params
      );
      await audit.record(
        { actor: user, action: `consultation.${to}`, entityType: 'consultation', entityId: id, metadata: { from: consultation.status }, ctx },
        client
      );
      return toDto(rows[0], { includePrivate: true });
    });
  }

  async function get(user, id, ctx) {
    const { rows } = await db.query(
      `SELECT c.*, d.user_id AS doctor_user_id, dp.full_name AS doctor_name, pp.full_name AS patient_name,
              pay.id AS payment_id, pay.status AS payment_status, pay.provider_order_id, rx.id AS prescription_id
       FROM consultations c
       JOIN doctors d ON d.id = c.doctor_id
       JOIN profiles dp ON dp.user_id = d.user_id
       JOIN profiles pp ON pp.user_id = c.patient_id
       LEFT JOIN payments pay ON pay.consultation_id = c.id
       LEFT JOIN prescriptions rx ON rx.consultation_id = c.id
       WHERE c.id = $1`,
      [id]
    );
    const row = rows[0];
    const role = row && participantRole(user, row);
    if (!role) throw AppError.notFound('Consultation');

    if (role === 'admin') {
      // admins reading clinical details is exactly what compliance wants a trail of
      await audit.record({ actor: user, action: 'consultation.viewed', entityType: 'consultation', entityId: id, ctx });
    }

    return {
      ...toDto(row, { includePrivate: true }),
      payment: row.payment_id ? { id: row.payment_id, status: row.payment_status, orderId: row.provider_order_id } : null,
      prescriptionId: row.prescription_id,
    };
  }

  async function list(user, filters) {
    const { page, limit, offset } = getPagination(filters);
    const where = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };

    if (user.role === 'patient') add('c.patient_id = ?', user.id);
    if (user.role === 'doctor') {
      const doctor = await doctorsService.findByUserId(user.id);
      if (!doctor) return { data: [], meta: pageMeta({ page, limit }, 0) };
      add('c.doctor_id = ?', doctor.id);
    }
    if (user.role === 'admin') {
      if (filters.doctorId) add('c.doctor_id = ?', filters.doctorId);
      if (filters.patientId) add('c.patient_id = ?', filters.patientId);
    }
    if (filters.status) add('c.status = ?', filters.status);
    if (filters.from) add('c.scheduled_start >= ?', filters.from);
    if (filters.to) add('c.scheduled_start < ?', filters.to);

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = filters.upcoming ? 'c.scheduled_start ASC' : 'c.scheduled_start DESC';

    const [list, count] = await Promise.all([
      db.query(
        `SELECT c.*, dp.full_name AS doctor_name, pp.full_name AS patient_name
         FROM consultations c
         JOIN doctors d ON d.id = c.doctor_id
         JOIN profiles dp ON dp.user_id = d.user_id
         JOIN profiles pp ON pp.user_id = c.patient_id
         ${whereSql}
         ORDER BY ${order}, c.id LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      db.query(`SELECT count(*)::int AS total FROM consultations c ${whereSql}`, params),
    ]);

    return { data: list.rows.map((r) => toDto(r)), meta: pageMeta({ page, limit }, count.rows[0].total) };
  }

  // job: hold ran out without a successful payment
  async function expireHold({ consultationId }) {
    await db.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM consultations WHERE id = $1 FOR UPDATE', [consultationId]);
      const consultation = rows[0];
      if (!consultation || consultation.status !== STATUS.PENDING_PAYMENT) return;

      await client.query(`UPDATE consultations SET status = 'expired', updated_at = now() WHERE id = $1`, [consultationId]);
      await client.query(
        `UPDATE availability_slots SET status = 'open', held_until = NULL, updated_at = now()
         WHERE id = $1 AND status = 'held'`,
        [consultation.slot_id]
      );
      await client.query(
        `UPDATE payments SET status = 'cancelled', updated_at = now() WHERE consultation_id = $1 AND status = 'pending'`,
        [consultationId]
      );
      await audit.record({ action: 'consultation.expired', entityType: 'consultation', entityId: consultationId }, client);
    });
  }

  // safety net in case an expiry job was lost or delayed
  async function sweepExpiredHolds() {
    const { rows } = await db.query(
      `SELECT c.id FROM consultations c JOIN availability_slots s ON s.id = c.slot_id
       WHERE c.status = 'pending_payment' AND s.held_until < now() - interval '1 minute'
       LIMIT 200`
    );
    for (const row of rows) await expireHold({ consultationId: row.id });
    return rows.length;
  }

  return {
    book,
    cancel,
    start: (user, id, ctx) => doctorTransition(user, id, STATUS.IN_PROGRESS, ctx),
    complete: (user, id, ctx, body) => doctorTransition(user, id, STATUS.COMPLETED, ctx, body),
    markNoShow: (user, id, ctx) => doctorTransition(user, id, STATUS.NO_SHOW, ctx),
    get,
    list,
    expireHold,
    sweepExpiredHolds,
    loadForUpdate,
    participantRole,
  };
}

module.exports = { createConsultationsService };
