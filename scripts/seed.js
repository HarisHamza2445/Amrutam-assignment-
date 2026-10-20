// Loads demo data. Wipes the tables first - never point this at a real database.
const config = require('../src/config');
const { createDb } = require('../src/db');
const { migrate } = require('../src/db/migrator');
const { parseKeyring, createCipher, hashPassword } = require('../src/lib/crypto');
const totp = require('../src/lib/totp');

const PASSWORD = 'Password123';

const DOCTORS = [
  { name: 'Dr. Meera Iyer', spec: 'Panchakarma', fee: 60000, exp: 14, langs: ['english', 'hindi', 'tamil'], rating: 4.8 },
  { name: 'Dr. Arjun Sharma', spec: 'Kayachikitsa', fee: 45000, exp: 9, langs: ['english', 'hindi'], rating: 4.5 },
  { name: 'Dr. Kavya Nair', spec: 'Prasuti Tantra', fee: 70000, exp: 18, langs: ['english', 'malayalam'], rating: 4.9 },
  { name: 'Dr. Rohan Kulkarni', spec: 'Dermatology', fee: 50000, exp: 6, langs: ['english', 'marathi', 'hindi'], rating: 4.2 },
  { name: 'Dr. Sana Qureshi', spec: 'Kayachikitsa', fee: 40000, exp: 11, langs: ['english', 'hindi', 'urdu'], rating: 4.6 },
];

async function createUser(client, { email, role, name, passwordHash, mfaSecretEnc = null }) {
  const { rows } = await client.query(
    `INSERT INTO users (email, password_hash, role, mfa_enabled, mfa_secret_enc) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [email, passwordHash, role, Boolean(mfaSecretEnc), mfaSecretEnc]
  );
  await client.query('INSERT INTO profiles (user_id, full_name) VALUES ($1, $2)', [rows[0].id, name]);
  return rows[0].id;
}

(async () => {
  if (config.isProd) {
    console.error('refusing to seed a production database');
    process.exit(1);
  }

  const db = createDb({ connectionString: config.DATABASE_URL });
  const cipher = createCipher(parseKeyring(config.DATA_ENCRYPTION_KEYS, config.DATA_ENCRYPTION_ACTIVE_KEY));
  const passwordHash = await hashPassword(PASSWORD);
  const adminSecret = totp.generateSecret();

  try {
    await migrate(db, { info: () => {} });

    await db.transaction(async (client) => {
      // audit_logs is append-only, so it gets truncated rather than deleted from
      await client.query(`TRUNCATE audit_logs, payment_events, payments, prescriptions, consultations,
        availability_slots, doctors, refresh_tokens, idempotency_keys, profiles, users, jobs, daily_stats CASCADE`);

      await createUser(client, { email: 'admin@amrutam.test', role: 'admin', name: 'Platform Admin', passwordHash, mfaSecretEnc: cipher.encrypt(adminSecret) });
      await createUser(client, { email: 'patient@amrutam.test', role: 'patient', name: 'Ananya Gupta', passwordHash });
      await createUser(client, { email: 'patient2@amrutam.test', role: 'patient', name: 'Vikram Rao', passwordHash });

      for (const [i, d] of DOCTORS.entries()) {
        const userId = await createUser(client, { email: `doctor${i + 1}@amrutam.test`, role: 'doctor', name: d.name, passwordHash });
        const { rows } = await client.query(
          `INSERT INTO doctors (user_id, specialization, qualifications, experience_years, consultation_fee, languages, rating, rating_count, is_verified)
           VALUES ($1, $2, 'BAMS, MD (Ayurveda)', $3, $4, $5, $6, $7, true) RETURNING id`,
          [userId, d.spec, d.exp, d.fee, d.langs, d.rating, 20 + i * 7]
        );

        // 30 minute slots, 10:00-13:00 IST for the next 7 days
        await client.query(
          `INSERT INTO availability_slots (doctor_id, starts_at, ends_at)
           SELECT $1, t, t + interval '30 minutes'
           FROM generate_series(1, 7) AS day,
                generate_series(0, 5) AS n,
                LATERAL (SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + make_interval(days => day, hours => 10, mins => n * 30))
                         AT TIME ZONE 'Asia/Kolkata' AS t) x`,
          [rows[0].id]
        );
      }
    });

    console.log('Seeded. Every account uses the password:', PASSWORD);
    console.log('  admin@amrutam.test (MFA on)  totp secret:', adminSecret);
    console.log('  patient@amrutam.test, patient2@amrutam.test');
    console.log('  doctor1..doctor5@amrutam.test');
    console.log(`Current admin code: npm run totp -- ${adminSecret}`);
  } catch (err) {
    console.error('seed failed:', err);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
})();
