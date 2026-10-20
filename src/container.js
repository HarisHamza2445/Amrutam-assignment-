const { createDb } = require('./db');
const { createLogger } = require('./lib/logger');
const { createCache } = require('./lib/cache');
const { parseKeyring, createCipher } = require('./lib/crypto');
const { createLogNotifier } = require('./lib/notifier');
const { createQueue } = require('./jobs/queue');
const { createJobHandlers } = require('./jobs/handlers');
const { createAuditService } = require('./modules/audit/audit.service');
const { createAuthService } = require('./modules/auth/auth.service');
const { createUsersService } = require('./modules/users/users.service');
const { createDoctorsService } = require('./modules/doctors/doctors.service');
const { createConsultationsService } = require('./modules/consultations/consultations.service');
const { createPrescriptionsService } = require('./modules/prescriptions/prescriptions.service');
const { createPaymentsService } = require('./modules/payments/payments.service');
const { createMockPaymentProvider } = require('./modules/payments/mockProvider');
const { createAnalyticsService } = require('./modules/admin/analytics.service');
const { createAdminService } = require('./modules/admin/admin.service');

/**
 * Builds the object graph by hand. Every service receives its dependencies as arguments,
 * so tests can pass fakes (see `overrides`) and nothing reaches for globals.
 */
function createContainer(config, overrides = {}) {
  const logger = overrides.logger ?? createLogger({ level: config.LOG_LEVEL });
  const db =
    overrides.db ??
    createDb({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      statementTimeout: config.DB_STATEMENT_TIMEOUT_MS,
      logger,
    });
  const cache = overrides.cache ?? createCache({ redisUrl: config.REDIS_URL, logger });
  const cipher = overrides.cipher ?? createCipher(parseKeyring(config.DATA_ENCRYPTION_KEYS, config.DATA_ENCRYPTION_ACTIVE_KEY));
  const notifier = overrides.notifier ?? createLogNotifier({ logger });
  const paymentProvider = overrides.paymentProvider ?? createMockPaymentProvider({ webhookSecret: config.PAYMENT_WEBHOOK_SECRET });

  const queue = createQueue({ db, logger });
  const audit = createAuditService({ db });

  const authService = createAuthService({ db, config, cipher, audit });
  const usersService = createUsersService({ db, cipher, audit });
  const doctorsService = createDoctorsService({ db, cache, audit, timezone: config.APP_TIMEZONE });
  const consultationsService = createConsultationsService({ db, cipher, audit, queue, config, doctorsService, cache });
  const prescriptionsService = createPrescriptionsService({ db, cipher, audit, queue, consultationsService });
  const paymentsService = createPaymentsService({ db, audit, queue, provider: paymentProvider, config, logger });
  const analyticsService = createAnalyticsService({ db, cache });
  const adminService = createAdminService({ db, audit });

  const jobHandlers = createJobHandlers({ db, consultationsService, paymentsService, analyticsService, notifier, queue });

  return {
    config,
    logger,
    db,
    cache,
    cipher,
    queue,
    paymentProvider,
    auditService: audit,
    authService,
    usersService,
    doctorsService,
    consultationsService,
    prescriptionsService,
    paymentsService,
    analyticsService,
    adminService,
    jobHandlers,
    async close() {
      await Promise.allSettled([db.close(), cache.close()]);
    },
  };
}

module.exports = { createContainer };
