const { setup } = require('./helpers');

let t;
beforeAll(async () => {
  t = await setup();
});
afterAll(() => t.container.close());

describe('platform', () => {
  it('has health checks', async () => {
    expect((await t.api().get('/health/live')).status).toBe(200);
    expect((await t.api().get('/health/ready')).body.status).toBe('ok');
  });

  it('exposes prometheus metrics', async () => {
    await t.api().get('/api/v1/doctors');
    const res = await t.api().get('/metrics');
    expect(res.text).toContain('http_request_duration_seconds');
  });

  it('serves the openapi document', async () => {
    const res = await t.api().get('/openapi.json');
    expect(res.body.openapi).toBe('3.0.3');
  });

  it('returns a consistent error shape with the request id', async () => {
    const res = await t.api().get('/api/v1/nope').set('x-request-id', 'test-request-123');
    expect(res.status).toBe(404);
    expect(res.body.error.requestId).toBe('test-request-123');
    expect(res.headers['x-request-id']).toBe('test-request-123');
  });

  it('sets security headers', async () => {
    const res = await t.api().get('/health/live');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('handles malformed json', async () => {
    const res = await t.api().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
  });
});
