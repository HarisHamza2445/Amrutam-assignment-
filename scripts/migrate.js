const config = require('../src/config');
const { createDb } = require('../src/db');
const { migrate } = require('../src/db/migrator');

(async () => {
  const db = createDb({ connectionString: config.DATABASE_URL });
  try {
    await migrate(db);
    console.log('migrations up to date');
  } catch (err) {
    console.error('migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
})();
