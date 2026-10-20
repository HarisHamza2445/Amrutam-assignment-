const { AppError } = require('../../lib/errors');
const { cached } = require('../../lib/cache');
const { sha256 } = require('../../lib/crypto');
const { getPagination, pageMeta } = require('../../lib/pagination');

const SEARCH_CACHE_PREFIX = 'doctors:search:';
const SEARCH_TTL_SEC = 30;
const PROFILE_TTL_SEC = 120;

const SORTS = {
  rating: 'd.rating DESC, d.rating_count DESC',
  fee_asc: 'd.consultation_fee ASC',
  fee_desc: 'd.consultation_fee DESC',
  experience: 'd.experience_years DESC',
};

const MIN_SLOT_MINUTES = 10;
const MAX_SLOT_MINUTES = 120;

function toDoctor(row) {
  return {
    id: row.id,
    userId: row.user_id,
    fullName: row.full_name,
    specialization: row.specialization,
    qualifications: row.qualifications,
    experienceYears: row.experience_years,
    consultationFee: row.consultation_fee,
    languages: row.languages,
    bio: row.bio,
    rating: Number(row.rating),
    ratingCount: row.rating_count,
    isVerified: row.is_verified,
    ...(row.next_available_at !== undefined ? { nextAvailableAt: row.next_available_at } : {}),
  };
}

const toSlot = (row) => ({
  id: row.id,
  doctorId: row.doctor_id,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  status: row.status,
});

function createDoctorsService({ db, cache, audit, timezone = 'Asia/Kolkata' }) {
  async function findByUserId(userId, client = db) {
    const { rows } = await client.query('SELECT * FROM doctors WHERE user_id = $1', [userId]);
    return rows[0] || null;
  }

  async function requireMyDoctor(userId, client) {
    const doctor = await findByUserId(userId, client);
    if (!doctor) throw AppError.unprocessable('Create your doctor profile first', 'DOCTOR_PROFILE_MISSING');
    return doctor;
  }

  async function upsertMyProfile(user, data, ctx) {
    const doctor = await db.transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO doctors (user_id, specialization, qualifications, experience_years, consultation_fee, languages, bio)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE SET
           specialization = EXCLUDED.specialization,
           qualifications = EXCLUDED.qualifications,
           experience_years = EXCLUDED.experience_years,
           consultation_fee = EXCLUDED.consultation_fee,
           languages = EXCLUDED.languages,
           bio = EXCLUDED.bio,
           updated_at = now()
         RETURNING *, (xmax = 0) AS inserted`,
        [user.id, data.specialization, data.qualifications ?? null, data.experienceYears, data.consultationFee, data.languages, data.bio ?? null]
      );
      const row = rows[0];
      await audit.record(
        { actor: user, action: row.inserted ? 'doctor.created' : 'doctor.updated', entityType: 'doctor', entityId: row.id, ctx },
        client
      );
      return row;
    });

    await invalidate(doctor.id);
    return getById(doctor.id, { includeUnverified: true });
  }

  async function invalidate(doctorId) {
    await Promise.all([cache.delPrefix(SEARCH_CACHE_PREFIX), cache.del(`doctors:profile:${doctorId}`)]);
  }

  async function getById(id, { includeUnverified = false } = {}) {
    const doctor = await cached(cache, `doctors:profile:${id}`, PROFILE_TTL_SEC, async () => {
      const { rows } = await db.query(
        `SELECT d.*, p.full_name FROM doctors d JOIN profiles p ON p.user_id = d.user_id WHERE d.id = $1`,
        [id]
      );
      return rows[0] ? toDoctor(rows[0]) : null;
    });
    if (!doctor || (!doctor.isVerified && !includeUnverified)) throw AppError.notFound('Doctor');
    return doctor;
  }

  async function search(filters) {
    const key = SEARCH_CACHE_PREFIX + sha256(JSON.stringify(filters));
    return cached(cache, key, SEARCH_TTL_SEC, () => runSearch(filters));
  }

  async function runSearch(filters) {
    const { page, limit, offset } = getPagination(filters, { maxLimit: 50 });
    const params = [];
    const where = ['d.is_verified'];
    const param = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (filters.q) {
      const like = param(`%${filters.q.replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`(p.full_name ILIKE ${like} OR d.specialization ILIKE ${like})`);
    }
    if (filters.specialization) where.push(`lower(d.specialization) = lower(${param(filters.specialization)})`);
    if (filters.language) where.push(`d.languages @> ARRAY[${param(filters.language.toLowerCase())}]::text[]`);
    if (filters.minFee !== undefined) where.push(`d.consultation_fee >= ${param(filters.minFee)}`);
    if (filters.maxFee !== undefined) where.push(`d.consultation_fee <= ${param(filters.maxFee)}`);
    if (filters.minRating !== undefined) where.push(`d.rating >= ${param(filters.minRating)}`);

    // next open slot (optionally on a given day) - also used as the "available" filter
    let slotWindow = 's.starts_at > now()';
    if (filters.availableOn) {
      // a "day" means a calendar day for the patient, i.e. in IST - not whatever the DB session uses
      const day = param(filters.availableOn);
      const tz = param(timezone);
      slotWindow += ` AND s.starts_at >= (${day}::date)::timestamp AT TIME ZONE ${tz}
                      AND s.starts_at < (${day}::date + 1)::timestamp AT TIME ZONE ${tz}`;
    }
    const nextSlot = `(SELECT min(s.starts_at) FROM availability_slots s
                       WHERE s.doctor_id = d.id AND s.status = 'open' AND ${slotWindow})`;
    if (filters.availableOn) where.push(`${nextSlot} IS NOT NULL`);

    const order = SORTS[filters.sort] || SORTS.rating;
    const whereSql = where.join(' AND ');

    const [list, count] = await Promise.all([
      db.query(
        `SELECT d.*, p.full_name, ${nextSlot} AS next_available_at
         FROM doctors d JOIN profiles p ON p.user_id = d.user_id
         WHERE ${whereSql}
         ORDER BY ${order}, d.id
         LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      db.query(`SELECT count(*)::int AS total FROM doctors d JOIN profiles p ON p.user_id = d.user_id WHERE ${whereSql}`, params),
    ]);

    return { data: list.rows.map(toDoctor), meta: pageMeta({ page, limit }, count.rows[0].total) };
  }

  async function listSlots(doctorId, { from, to, status = 'open' }) {
    await getById(doctorId);
    const start = from ? new Date(from) : new Date();
    const end = to ? new Date(to) : new Date(start.getTime() + 7 * 24 * 3600 * 1000);
    if (end <= start) throw AppError.badRequest('"to" must be after "from"');
    if (end - start > 31 * 24 * 3600 * 1000) throw AppError.badRequest('Range can be at most 31 days');

    const { rows } = await db.query(
      `SELECT * FROM availability_slots
       WHERE doctor_id = $1 AND starts_at >= $2 AND starts_at < $3 AND ($4::text = 'all' OR status = $4)
       ORDER BY starts_at LIMIT 500`,
      [doctorId, start, end, status]
    );
    return rows.map(toSlot);
  }

  async function createSlots(user, slots, ctx) {
    const now = Date.now();
    const parsed = slots
      .map((s) => ({ startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt) }))
      .sort((a, b) => a.startsAt - b.startsAt);

    for (const [i, slot] of parsed.entries()) {
      const minutes = (slot.endsAt - slot.startsAt) / 60000;
      if (slot.startsAt.getTime() <= now) throw AppError.badRequest(`Slot ${i + 1} is in the past`);
      if (minutes < MIN_SLOT_MINUTES || minutes > MAX_SLOT_MINUTES) {
        throw AppError.badRequest(`Slots must be between ${MIN_SLOT_MINUTES} and ${MAX_SLOT_MINUTES} minutes`);
      }
      if (i > 0 && slot.startsAt < parsed[i - 1].endsAt) throw AppError.badRequest('Slots in the request overlap each other');
    }

    const created = await db.transaction(async (client) => {
      const doctor = await requireMyDoctor(user.id, client);

      // serialise slot creation per doctor so two concurrent requests can't create overlapping slots
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`slots:${doctor.id}`]);

      const first = parsed[0].startsAt;
      const last = parsed[parsed.length - 1].endsAt;
      const { rows: existing } = await client.query(
        `SELECT starts_at, ends_at FROM availability_slots
         WHERE doctor_id = $1 AND status <> 'blocked' AND starts_at < $3 AND ends_at > $2`,
        [doctor.id, first, last]
      );
      const clash = parsed.find((s) => existing.some((e) => s.startsAt < e.ends_at && s.endsAt > e.starts_at));
      if (clash) throw AppError.conflict(`Slot at ${clash.startsAt.toISOString()} overlaps an existing slot`, 'SLOT_OVERLAP');

      const { rows } = await client.query(
        `INSERT INTO availability_slots (doctor_id, starts_at, ends_at)
         SELECT $1, s, e FROM unnest($2::timestamptz[], $3::timestamptz[]) AS t(s, e)
         RETURNING *`,
        [doctor.id, parsed.map((s) => s.startsAt), parsed.map((s) => s.endsAt)]
      );
      await audit.record(
        { actor: user, action: 'slots.created', entityType: 'doctor', entityId: doctor.id, metadata: { count: rows.length }, ctx },
        client
      );
      return rows;
    });

    await cache.delPrefix(SEARCH_CACHE_PREFIX);
    return created.map(toSlot);
  }

  async function blockSlot(user, slotId, ctx) {
    const slot = await db.transaction(async (client) => {
      const doctor = await requireMyDoctor(user.id, client);
      const { rows } = await client.query(
        `UPDATE availability_slots SET status = 'blocked', updated_at = now()
         WHERE id = $1 AND doctor_id = $2 AND status = 'open' RETURNING *`,
        [slotId, doctor.id]
      );
      if (!rows[0]) {
        const exists = await client.query('SELECT status FROM availability_slots WHERE id = $1 AND doctor_id = $2', [slotId, doctor.id]);
        if (!exists.rowCount) throw AppError.notFound('Slot');
        throw AppError.conflict('Only open slots can be removed. Cancel the consultation instead.', 'SLOT_NOT_OPEN');
      }
      await audit.record({ actor: user, action: 'slot.blocked', entityType: 'slot', entityId: slotId, ctx }, client);
      return rows[0];
    });
    await cache.delPrefix(SEARCH_CACHE_PREFIX);
    return toSlot(slot);
  }

  async function setVerified(admin, doctorId, isVerified, ctx) {
    await db.transaction(async (client) => {
      const { rowCount } = await client.query('UPDATE doctors SET is_verified = $2, updated_at = now() WHERE id = $1', [doctorId, isVerified]);
      if (!rowCount) throw AppError.notFound('Doctor');
      await audit.record(
        { actor: admin, action: isVerified ? 'doctor.verified' : 'doctor.unverified', entityType: 'doctor', entityId: doctorId, ctx },
        client
      );
    });
    await invalidate(doctorId);
    return getById(doctorId, { includeUnverified: true });
  }

  return { findByUserId, upsertMyProfile, getById, search, listSlots, createSlots, blockSlot, setVerified };
}

module.exports = { createDoctorsService };
