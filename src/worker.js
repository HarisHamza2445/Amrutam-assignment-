require('./lib/tracing');
const http = require('http');
const config = require('./config');
const { createContainer } = require('./container');
const { scheduleRecurring } = require('./jobs/handlers');
const { registry } = require('./lib/metrics');
const { createLogger } = require('./lib/logger');

async function main() {
  const container = createContainer(config, { logger: createLogger({ level: config.LOG_LEVEL, service: 'amrutam-worker' }) });
  const { logger, queue, jobHandlers } = container;

  const stop = queue.start(jobHandlers, { pollMs: 1000, batchSize: 10 });

  await scheduleRecurring(queue);
  const ticker = setInterval(() => scheduleRecurring(queue).catch((err) => logger.error({ err }, 'scheduler tick failed')), 30000);

  // tiny server so prometheus can scrape worker metrics and k8s can probe it
  const port = Number(process.env.WORKER_METRICS_PORT || 9464);
  const server = http
    .createServer(async (req, res) => {
      if (req.url === '/metrics') {
        res.setHeader('Content-Type', registry.contentType);
        return res.end(await registry.metrics());
      }
      res.end('ok');
    })
    .listen(port);

  const shutdown = async () => {
    logger.info('worker shutting down');
    clearInterval(ticker);
    server.close();
    await stop();
    await container.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('worker failed to start', err);
  process.exit(1);
});
