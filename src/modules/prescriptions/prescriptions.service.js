const { AppError } = require('../../lib/errors');
const { getPagination, pageMeta } = require('../../lib/pagination');

const WRITABLE_STATUSES = ['in_progress', 'completed'];

function createPrescriptionsService({ db, cipher, audit, queue, consultationsService }) {
  function toDto(row) {
    return {
      id: row.id,
      consultationId: row.consultation_id,
      doctorId: row.doctor_id,
      patientId: row.patient_id,
      medications: row.medications,
      diagnosis: cipher.decrypt(row.diagnosis_enc),
      advice: cipher.decrypt(row.advice_enc),
      followUpDate: row.follow_up_date,
      createdAt: row.created_at,
    };
  }

  async function create(user, consultationId, data, ctx) {
    return db.transaction(async (client) => {
      const consultation = await consultationsService.loadForUpdate(client, consultationId);
      if (consultationsService.participantRole(user, consultation) !== 'doctor') throw AppError.notFound('Consultation');
      if (!WRITABLE_STATUSES.includes(consultation.status)) {
        throw AppError.unprocessable('A prescription can only be written during or after the consultation', 'CONSULTATION_NOT_STARTED');
      }

      const existing = await client.query('SELECT 1 FROM prescriptions WHERE consultation_id = $1', [consultationId]);
      if (existing.rowCount) throw AppError.conflict('This consultation already has a prescription', 'PRESCRIPTION_EXISTS');

      const { rows } = await client.query(
        `INSERT INTO prescriptions (consultation_id, doctor_id, patient_id, medications, diagnosis_enc, advice_enc, follow_up_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          consultationId,
          consultation.doctor_id,
          consultation.patient_id,
          JSON.stringify(data.medications),
          cipher.encrypt(data.diagnosis),
          cipher.encrypt(data.advice),
          data.followUpDate ?? null,
        ]
      );

      await queue.enqueue('notify.prescription_ready', { prescriptionId: rows[0].id }, { client });
      await audit.record(
        { actor: user, action: 'prescription.created', entityType: 'prescription', entityId: rows[0].id, metadata: { consultationId }, ctx },
        client
      );
      return toDto(rows[0]);
    });
  }

  async function getForConsultation(user, consultationId, ctx) {
    const { rows } = await db.query(
      `SELECT rx.*, d.user_id AS doctor_user_id FROM prescriptions rx JOIN doctors d ON d.id = rx.doctor_id
       WHERE rx.consultation_id = $1`,
      [consultationId]
    );
    const row = rows[0];
    const allowed =
      row &&
      (user.role === 'admin' ||
        (user.role === 'patient' && row.patient_id === user.id) ||
        (user.role === 'doctor' && row.doctor_user_id === user.id));
    if (!allowed) throw AppError.notFound('Prescription');

    // every read of a prescription is logged (who looked at which patient's record)
    await audit.record({ actor: user, action: 'prescription.viewed', entityType: 'prescription', entityId: row.id, ctx });
    return toDto(row);
  }

  async function listMine(user, filters) {
    const { page, limit, offset } = getPagination(filters);
    const [list, count] = await Promise.all([
      db.query(
        `SELECT * FROM prescriptions WHERE patient_id = $1 ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
        [user.id]
      ),
      db.query('SELECT count(*)::int AS total FROM prescriptions WHERE patient_id = $1', [user.id]),
    ]);
    return { data: list.rows.map(toDto), meta: pageMeta({ page, limit }, count.rows[0].total) };
  }

  return { create, getForConsultation, listMine };
}

module.exports = { createPrescriptionsService };
