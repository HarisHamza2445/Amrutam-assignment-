require('dotenv').config({ quiet: true });
const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.string().default('info'),
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: z.coerce.number().int().default(20),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().default(5000),
  REDIS_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  REQUIRE_ADMIN_MFA: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // "v1:<base64 32 bytes>,v2:<base64 32 bytes>" - the active one is used for new writes
  DATA_ENCRYPTION_KEYS: z.string().min(1),
  DATA_ENCRYPTION_ACTIVE_KEY: z.string().min(1),

  PAYMENT_WEBHOOK_SECRET: z.string().min(16),
  BOOKING_HOLD_MINUTES: z.coerce.number().int().default(10),
  CANCELLATION_CUTOFF_HOURS: z.coerce.number().int().default(2),

  CORS_ORIGINS: z.string().default(''),
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().default(120),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().default(10),

  OTEL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid environment configuration:\n${problems}`);
  process.exit(1);
}

const env = parsed.data;

module.exports = {
  ...env,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  corsOrigins: env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};
