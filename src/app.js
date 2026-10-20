const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const YAML = require('yaml');
const swaggerUi = require('swagger-ui-express');

const requestContext = require('./middlewares/requestContext');
const rateLimit = require('./middlewares/rateLimit');
const idempotency = require('./middlewares/idempotency');
const { authenticate } = require('./middlewares/auth');
const { notFound, errorHandler } = require('./middlewares/errorHandler');
const { registry, httpMetrics } = require('./lib/metrics');

const authRoutes = require('./modules/auth/auth.routes');
const usersRoutes = require('./modules/users/users.routes');
const doctorsRoutes = require('./modules/doctors/doctors.routes');
const consultationsRoutes = require('./modules/consultations/consultations.routes');
const prescriptions = require('./modules/prescriptions/prescriptions.routes');
const paymentsRoutes = require('./modules/payments/payments.routes');
const adminRoutes = require('./modules/admin/admin.routes');

function createApp(container) {
  const { config, logger, db, cache } = container;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      autoLogging: { ignore: (req) => req.url === '/metrics' || req.url.startsWith('/health') },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    })
  );
  app.use(httpMetrics);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false }));
  app.use(
    express.json({
      limit: '100kb',
      // the payment webhook signature is computed over the exact bytes we received
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  // health + metrics sit outside the rate limiter
  app.get('/health/live', (req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (req, res) => {
    try {
      await db.ping();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  });

  const openapi = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'openapi.yaml'), 'utf8'));
  app.get('/openapi.json', (req, res) => res.json(openapi));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));

  const globalLimiter = rateLimit({ store: cache, windowSec: config.RATE_LIMIT_WINDOW_SEC, max: config.RATE_LIMIT_MAX, prefix: 'rl:ip' });
  const authLimiter = rateLimit({ store: cache, windowSec: 300, max: config.AUTH_RATE_LIMIT_MAX, prefix: 'rl:auth' });
  const userLimiter = rateLimit({ store: cache, windowSec: config.RATE_LIMIT_WINDOW_SEC, max: config.RATE_LIMIT_MAX, prefix: 'rl:user', keyBy: 'user' });

  const deps = {
    ...container,
    authenticate: authenticate({ secret: config.JWT_ACCESS_SECRET }),
    idempotent: idempotency({ db }),
    authLimiter,
    userLimiter,
  };

  const api = express.Router();
  api.use(globalLimiter);
  api.use('/auth', authRoutes(deps));
  api.use('/users', usersRoutes(deps));
  api.use('/doctors', doctorsRoutes(deps));
  api.use('/consultations', consultationsRoutes({ ...deps, prescriptionsRoutes: prescriptions.nestedRoutes(deps) }));
  api.use('/prescriptions', prescriptions.patientRoutes(deps));
  api.use('/payments', paymentsRoutes(deps));
  api.use('/admin', adminRoutes(deps));

  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
