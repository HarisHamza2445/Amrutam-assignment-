// sensible defaults so `npm test` works with just a DATABASE_URL (CI sets its own)
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/amrutam_test';
process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.DATA_ENCRYPTION_KEYS = `v1:${Buffer.alloc(32, 1).toString('base64')},v2:${Buffer.alloc(32, 2).toString('base64')}`;
process.env.DATA_ENCRYPTION_ACTIVE_KEY = 'v2';
process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.RATE_LIMIT_MAX = '10000';
process.env.AUTH_RATE_LIMIT_MAX = '10000';
delete process.env.REDIS_URL;
