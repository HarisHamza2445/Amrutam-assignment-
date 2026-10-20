require('./lib/tracing');
const config = require('./config');
const { createContainer } = require('./container');
const { createApp } = require('./app');
const { migrate } = require('./db/migrator');

async function main() {
  const container = createContainer(config);
  const { logger } = container;

  if (process.env.MIGRATE_ON_START === 'true') await migrate(container.db, logger);

  const app = createApp(container);
  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'api listening'));

  // keep-alive longer than the load balancer's idle timeout avoids random 502s
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await container.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('failed to start', err);
  process.exit(1);
});
