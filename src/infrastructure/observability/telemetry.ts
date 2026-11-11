import type { AppConfig } from '../../config/env';

type TelemetryShutdown = () => Promise<void>;

/**
 * OpenTelemetry is opt-in. Dynamic imports keep the SDK and auto-instrumentations out of the
 * cold path when OTEL_ENABLED=false (the default for local development and tests).
 */
export async function initTelemetry(config: AppConfig): Promise<TelemetryShutdown | null> {
  if (!config.OTEL_ENABLED) return null;
  const [{ NodeSDK }, { getNodeAutoInstrumentations }, { OTLPTraceExporter }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
  ]);

  const sdk = new NodeSDK({
    serviceName: config.OTEL_SERVICE_NAME,
    ...(config.OTEL_EXPORTER_OTLP_ENDPOINT
      ? { traceExporter: new OTLPTraceExporter({ url: config.OTEL_EXPORTER_OTLP_ENDPOINT }) }
      : {}),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  });
  await sdk.start();
  return async () => {
    await sdk.shutdown();
  };
}
