// Re-encrypts every encrypted column with the active key version.
//
// Rotation steps:
//   1. add the new key:  DATA_ENCRYPTION_KEYS=v1:old,v2:new  DATA_ENCRYPTION_ACTIVE_KEY=v2
//   2. deploy - new writes use v2, old rows still decrypt with v1
//   3. run `npm run rotate-keys`
//   4. once it reports 0 rows left on v1, remove v1 from DATA_ENCRYPTION_KEYS
const config = require('../src/config');
const { createDb } = require('../src/db');
const { parseKeyring, createCipher } = require('../src/lib/crypto');

const COLUMNS = {
  users: { key: 'id', columns: ['mfa_secret_enc'] },
  profiles: { key: 'user_id', columns: ['phone_enc'] },
  consultations: { key: 'id', columns: ['reason_enc', 'notes_enc'] },
  prescriptions: { key: 'id', columns: ['diagnosis_enc', 'advice_enc'] },
};
const BATCH = 500;

(async () => {
  const db = createDb({ connectionString: config.DATABASE_URL });
  const cipher = createCipher(parseKeyring(config.DATA_ENCRYPTION_KEYS, config.DATA_ENCRYPTION_ACTIVE_KEY));
  const prefix = `${cipher.activeVersion}:%`;

  try {
    for (const [table, { key, columns }] of Object.entries(COLUMNS)) {
      const stale = columns.map((c) => `(${c} IS NOT NULL AND ${c} NOT LIKE $1)`).join(' OR ');
      let total = 0;

      for (;;) {
        const updated = await db.transaction(async (client) => {
          const { rows } = await client.query(
            `SELECT ${key}, ${columns.join(', ')} FROM ${table} WHERE ${stale} LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`,
            [prefix]
          );
          for (const row of rows) {
            const values = columns.map((c) => (row[c] ? cipher.encrypt(cipher.decrypt(row[c])) : null));
            const sets = columns.map((c, i) => `${c} = $${i + 2}`).join(', ');
            await client.query(`UPDATE ${table} SET ${sets} WHERE ${key} = $1`, [row[key], ...values]);
          }
          return rows.length;
        });
        total += updated;
        if (updated < BATCH) break;
      }
      console.log(`${table}: re-encrypted ${total} rows`);
    }
  } catch (err) {
    console.error('rotation failed:', err.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
})();
