import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { createTestContext, type TestContext } from '../helpers/app';

const context: TestContext = createTestContext();
const { agent } = context;

describe('application surface', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await context.close();
  });

  it('serves the root descriptor', async () => {
    const response = await agent().get('/');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      name: 'NEXUS BANK API',
      api: '/api/v1',
      health: '/health',
    });
  });

  it('serves liveness and readiness probes backed by the database', async () => {
    const live = await agent().get('/health');
    expect(live.status).toBe(200);
    expect(live.body.status).toBe('ok');

    const ready = await agent().get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ ready: true, checks: { database: 'up', redis: 'disabled' } });
  });

  it('serves the versioned API index', async () => {
    const response = await agent().get('/api/v1');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: expect.objectContaining({ service: 'nexus-bank-api', simulation: true }),
    });
  });

  it('applies security headers and forbids caching of API responses', async () => {
    const response = await agent().get('/api/v1');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBeDefined();
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('rejects disallowed CORS origins', async () => {
    const response = await agent().get('/api/v1').set('Origin', 'https://evil.example.com');
    expect(response.status).toBe(403);

    const allowed = await agent().get('/api/v1').set('Origin', 'http://localhost:3001');
    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3001');
  });

  it('returns a structured 404 for unknown routes', async () => {
    const response = await agent().get('/api/v1/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      error: expect.objectContaining({ code: 'NOT_FOUND' }),
    });
  });

  it('serves the OpenAPI contract and Swagger UI when docs are enabled', async () => {
    const spec = await agent().get('/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe('3.1.0');
    expect(spec.body.paths).toHaveProperty('/auth/register');

    const docs = await agent().get('/docs/');
    expect([200, 301]).toContain(docs.status);
  });

  it('hides the metrics endpoint because METRICS_ENABLED=false in test', async () => {
    const response = await agent().get('/metrics');
    expect(response.status).toBe(404);
  });
});
