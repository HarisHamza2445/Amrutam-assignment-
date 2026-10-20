// Loaded before anything else (see server.js / worker.js) so auto-instrumentation can patch
// http, express and pg. Exports to any OTLP collector - Jaeger in docker-compose.
if (process.env.OTEL_ENABLED === 'true') {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || 'amrutam-api',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
  process.on('SIGTERM', () => sdk.shutdown().catch(() => {}));
}
