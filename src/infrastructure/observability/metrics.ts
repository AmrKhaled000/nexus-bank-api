import type { RequestHandler } from 'express';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import type { AppConfig } from '../../config/env';
import { constantTimeEqual } from '../../common/crypto/crypto';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry, prefix: 'nexus_' });

export const httpRequestsTotal = new Counter({
  name: 'nexus_http_requests_total',
  help: 'Total HTTP requests by method, route and status code',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [metricsRegistry],
});

export const httpRequestDuration = new Histogram({
  name: 'nexus_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

export const ledgerJournalEntriesTotal = new Counter({
  name: 'nexus_ledger_journal_entries_total',
  help: 'Immutable journal entries posted by currency',
  labelNames: ['currency'] as const,
  registers: [metricsRegistry],
});

export const payoutOutcomesTotal = new Counter({
  name: 'nexus_payout_outcomes_total',
  help: 'Payout attempts by outcome',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

export const webhookEventsTotal = new Counter({
  name: 'nexus_webhook_events_total',
  help: 'Processed webhook events by provider and status',
  labelNames: ['provider', 'status'] as const,
  registers: [metricsRegistry],
});

/** Route labels use the Express route pattern, not the raw URL, to bound cardinality. */
export function httpMetricsMiddleware(): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route?.path
        ? `${req.baseUrl}${String(req.route.path)}`
        : `${req.baseUrl || ''}${req.path}`;
      const labels = {
        method: req.method,
        route,
        status: String(res.statusCode),
      };
      httpRequestsTotal.inc(labels);
      const seconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
      httpRequestDuration.observe(labels, seconds);
    });
    next();
  };
}

export function metricsHandler(config: AppConfig): RequestHandler {
  return async (req, res) => {
    if (!config.METRICS_ENABLED) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Metrics are disabled' } });
      return;
    }
    if (config.METRICS_TOKEN) {
      const authorization = req.headers.authorization;
      const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      const headerToken = req.headers['x-metrics-token'];
      const provided = bearer ?? (Array.isArray(headerToken) ? headerToken[0] : headerToken);
      if (!provided || !constantTimeEqual(provided, config.METRICS_TOKEN)) {
        res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Metrics token required' } });
        return;
      }
    }
    res.setHeader('Content-Type', metricsRegistry.contentType);
    res.send(await metricsRegistry.metrics());
  };
}
