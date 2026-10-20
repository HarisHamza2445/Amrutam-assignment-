const { AppError } = require('../../lib/errors');

function createUsersService({ db, cipher, audit }) {
  async function getMe(userId) {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.role, u.status, u.mfa_enabled, u.created_at,
              p.full_name, p.phone_enc, p.date_of_birth, p.gender, p.city,
              d.id AS doctor_id
       FROM users u
       JOIN profiles p ON p.user_id = u.id
       LEFT JOIN doctors d ON d.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );
    const row = rows[0];
    if (!row) throw AppError.notFound('User');

    return {
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      mfaEnabled: row.mfa_enabled,
      doctorId: row.doctor_id,
      profile: {
        fullName: row.full_name,
        phone: cipher.decrypt(row.phone_enc),
        dateOfBirth: row.date_of_birth,
        gender: row.gender,
        city: row.city,
      },
      createdAt: row.created_at,
    };
  }

  async function updateProfile(user, changes, ctx) {
    const columns = {
      fullName: 'full_name',
      dateOfBirth: 'date_of_birth',
      gender: 'gender',
      city: 'city',
    };
    const sets = [];
    const params = [user.id];

    for (const [field, column] of Object.entries(columns)) {
      if (changes[field] !== undefined) {
        params.push(changes[field]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    if (changes.phone !== undefined) {
      params.push(cipher.encrypt(changes.phone));
      sets.push(`phone_enc = $${params.length}`);
    }
    if (!sets.length) return getMe(user.id);

    await db.transaction(async (client) => {
      await client.query(`UPDATE profiles SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1`, params);
      await audit.record(
        { actor: user, action: 'profile.updated', entityType: 'user', entityId: user.id, metadata: { fields: Object.keys(changes) }, ctx },
        client
      );
    });
    return getMe(user.id);
  }

  return { getMe, updateProfile };
}

module.exports = { createUsersService };
