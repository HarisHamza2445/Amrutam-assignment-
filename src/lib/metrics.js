const client = require('prom-client');

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
  registers: [registry],
});

const bookings = new client.Counter({
  name: 'bookings_total',
  help: 'Booking attempts by outcome',
  labelNames: ['outcome'],
  registers: [registry],
});

const payments = new client.Counter({
  name: 'payment_events_total',
  help: 'Payment webhook events processed',
  labelNames: ['type', 'result'],
  registers: [registry],
});

const jobs = new client.Counter({
  name: 'jobs_processed_total',
  help: 'Background jobs processed',
  labelNames: ['type', 'result'],
  registers: [registry],
});

const jobLag = new client.Histogram({
  name: 'job_start_lag_seconds',
  help: 'Time between a job being due and a worker picking it up',
  labelNames: ['type'],
  buckets: [0.1, 0.5, 1, 5, 15, 60, 300],
  registers: [registry],
});

function httpMetrics(req, res, next) {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    // use the matched route pattern, not the raw url, so ids don't blow up cardinality
    const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    end({ method: req.method, route, status: res.statusCode });
  });
  next();
}

module.exports = { registry, httpMetrics, counters: { bookings, payments, jobs }, jobLag };
