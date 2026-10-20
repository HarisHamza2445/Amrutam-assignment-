const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

async function migrate(db, logger = console) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    await db.transaction(async (client) => {
      // stops two pods from running the same migration at once
      await client.query('SELECT pg_advisory_xact_lock(727274)');
      const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (rowCount) return;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      logger.info(`applied migration ${file}`);
    });
  }
}

module.exports = { migrate };
