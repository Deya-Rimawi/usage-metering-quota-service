// Input hardening, abuse limits and recovery paths found by the security and code reviews.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { ADMIN, client, createAccount, makeApp, newPlan, resetData, setupTestDb } from './helpers';

let pool: pg.Pool;
let app: FastifyInstance;
beforeAll(async () => { pool = await setupTestDb(); app = makeApp(pool); });
beforeEach(() => resetData(pool));
afterAll(async () => { await app.close(); await pool.end(); });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('bad input is a 4xx, never a 500', () => {
  it('rejects cursors that decode but hold nothing usable', async () => {
    const { key } = await createAccount(app, 'acme');
    const c = client(app, key);
    const bad = [b64({ t: 'x', id: 'y' }), b64({ t: '2026-10-01 00:00:00+00', id: 'not-a-uuid' }), b64({ t: 5, id: 7 }), 'x'.repeat(400)];
    for (const cursor of bad) {
      for (const url of ['/users', '/usage', '/requests']) {
        const res = await c.get(`${url}?cursor=${cursor}`);
        expect(res.statusCode, `${url} ${cursor.slice(0, 20)}`).toBe(422);
      }
    }
  });

  it('rejects control characters (NUL) in every client string that reaches the database', async () => {
    const { key } = await createAccount(app, 'acme');
    const c = client(app, key);
    await c.post('/users', { userId: 'alice' });
    const nul = 'a\u0000b';
    expect((await app.inject({ method: 'POST', url: '/accounts', payload: { name: nul }, headers: { 'x-admin-token': ADMIN } })).statusCode).toBe(422);
    expect((await c.post('/plans', { kind: 'user', name: nul })).statusCode).toBe(422);
    expect((await c.post('/consume', { userId: 'alice', units: 1, requestId: nul })).statusCode).toBe(422);
    expect((await c.put('/users/alice/plan', { planId: nul })).statusCode).toBe(422);
    expect((await c.get(`/plans/${encodeURIComponent(nul)}`)).statusCode).toBe(422);
    expect((await c.post('/users', { userId: 'bob', planId: nul })).statusCode).toBe(422);
  });

  it('rejects impossible periods instead of letting the date cast fail', async () => {
    const { key } = await createAccount(app, 'acme');
    const c = client(app, key);
    for (const p of ['0000-01', '0001-01', '1969-12', '2026-00']) {
      expect((await c.get(`/usage?period=${p}`)).statusCode, p).toBe(422);
      expect((await c.get(`/requests?period=${p}`)).statusCode, p).toBe(422);
    }
  });

  it('answers any leftover Postgres data error with 422 (safety net)', async () => {
    // A value the schema accepts but the database rejects: a 2000-char plan id is refused by the schema, so
    // reach the safety net directly through the error handler with a fake class-22 error.
    const probe = makeApp(pool);
    probe.get('/__probe', async () => { throw Object.assign(new Error('boom'), { code: '22P02' }); });
    const res = await probe.inject('/__probe');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_input');
    await probe.close();
  });
});

describe('abuse limits', () => {
  it('rate-limits the admin endpoints per IP with a clear error', async () => {
    const limited = makeApp(pool, undefined, { ADMIN_RATE_LIMIT_PER_MIN: '3' });
    const call = () => limited.inject({ method: 'POST', url: '/accounts', payload: { name: 'a' }, headers: { 'x-admin-token': 'wrong-token-1' } });
    expect([(await call()).statusCode, (await call()).statusCode, (await call()).statusCode]).toEqual([401, 401, 401]);
    const res = await call();
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    await limited.close();
  });

  it('caps custom plans per account', async () => {
    const { key } = await createAccount(app, 'acme');
    const c = client(app, key);
    for (let i = 0; i < 100; i++) await newPlan(c, 'user', `p${i}`, 10, 10);
    const res = await c.post('/plans', { kind: 'user', name: 'one-too-many' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('account_limit_reached');
    // another account is not affected
    const other = client(app, (await createAccount(app, 'other')).key);
    expect((await other.post('/plans', { kind: 'user', name: 'fine' })).statusCode).toBe(201);
  });

  it('sends safe response headers', async () => {
    const res = await app.inject('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('can serve the API without exposing the docs UI', async () => {
    const quiet = makeApp(pool, undefined, { DOCS_ENABLED: 'false' });
    expect((await quiet.inject('/docs/json')).statusCode).toBe(404);
    expect((await quiet.inject('/health')).statusCode).toBe(200);
    await quiet.close();
  });
});

describe('admin key recovery', () => {
  it('lets an admin issue a new key for an account that lost its key', async () => {
    const { id, key } = await createAccount(app, 'acme');
    const url = `/accounts/${id}/api-key/rotate`;
    expect((await app.inject({ method: 'POST', url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, headers: { 'x-api-key': key } })).statusCode).toBe(401); // the account's own key is not admin
    const res = await app.inject({ method: 'POST', url, headers: { 'x-admin-token': ADMIN } });
    expect(res.statusCode).toBe(200);
    expect((await client(app, key).get('/account')).statusCode).toBe(401);
    expect((await client(app, res.json().apiKey).get('/account')).statusCode).toBe(200);
  });

  it('answers 404 for an unknown account and 422 for a malformed id', async () => {
    const h = { 'x-admin-token': ADMIN };
    expect((await app.inject({ method: 'POST', url: '/accounts/00000000-0000-4000-8000-000000000000/api-key/rotate', headers: h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/accounts/nope/api-key/rotate', headers: h })).statusCode).toBe(422);
  });
});
