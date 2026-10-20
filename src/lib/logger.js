const pino = require('pino');

function createLogger({ level = 'info', service = 'amrutam-api' } = {}) {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    // never let credentials or PHI end up in log storage
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-signature"]',
        '*.password',
        '*.refreshToken',
        '*.mfaCode',
        '*.phone',
        '*.diagnosis',
        '*.advice',
      ],
      censor: '[redacted]',
    },
  });
}

module.exports = { createLogger };
