import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { ADMIN, client, createAccount, makeApp, resetData, setupTestDb } from './helpers';

let pool: pg.Pool;
let app: FastifyInstance;
beforeAll(async () => { pool = await setupTestDb(); app = makeApp(pool); });
beforeEach(() => resetData(pool));
afterAll(async () => { await app.close(); await pool.end(); });

describe('API key authentication', () => {
  it('creating an account needs the admin token', async () => {
    const none = await app.inject({ method: 'POST', url: '/accounts', payload: { name: 'a' } });
    const bad = await app.inject({ method: 'POST', url: '/accounts', payload: { name: 'a' }, headers: { 'x-admin-token': 'nope-nope-nope' } });
    expect(none.statusCode).toBe(401);
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/accounts', payload: { name: 'a' }, headers: { 'x-admin-token': ADMIN } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().apiKey).toMatch(/^mk_/);
  });

  it('stores only a hash of the key', async () => {
    const { key } = await createAccount(app, 'acme');
    const { rows } = await pool.query('SELECT api_key_hash FROM accounts');
    expect(rows[0].api_key_hash).not.toContain(key);
    expect(rows[0].api_key_hash).toHaveLength(64);
  });

  it('rejects missing and invalid keys on every account endpoint', async () => {
    const { key } = await createAccount(app, 'acme');
    for (const [method, url] of [['GET', '/account'], ['GET', '/users'], ['GET', '/plans'], ['POST', '/users'], ['POST', '/plans']] as const) {
      for (const headers of [{}, { 'x-api-key': 'mk_wrong' }, { 'x-api-key': key + 'x' }]) {
        const res = await app.inject({ method, url, headers, payload: method === 'POST' ? {} : undefined });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
        expect(res.json().error.code).toBe('unauthorized');
      }
    }
  });

  it('a valid key works, and rotation invalidates the old key at once', async () => {
    const { key } = await createAccount(app, 'acme');
    expect((await client(app, key).get('/account')).statusCode).toBe(200);
    const rotated = (await client(app, key).post('/account/api-key/rotate')).json().apiKey;
    expect((await client(app, key).get('/account')).statusCode).toBe(401);
    expect((await client(app, rotated).get('/account')).statusCode).toBe(200);
  });

  it('new accounts default to the Starter plan', async () => {
    const { key } = await createAccount(app, 'acme');
    expect((await client(app, key).get('/account')).json().plan).toMatchObject({ id: 'starter', monthlyAllowance: 10000, dailyAllowance: 2000, maxPerRequest: 100 });
  });
});

describe('users', () => {
  it('registers users with a default Basic plan and rejects duplicates', async () => {
    const { key } = await createAccount(app, 'acme');
    const c = client(app, key);
    const res = await c.post('/users', { userId: 'alice' });
    expect(res.statusCode).toBe(201);
    expect(res.json().plan.id).toBe('basic');
    const dup = await c.post('/users', { userId: 'alice' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('user_exists');
  });

  it('validates input with a useful 422', async () => {
    const { key } = await createAccount(app, 'acme');
    const res = await client(app, key).post('/users', { userId: 'bad id with spaces' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('changes a user plan; only user plans are accepted', async () => {
    const { key } = await createAccount(app, 'acme');
    const c = client(app, key);
    await c.post('/users', { userId: 'alice' });
    expect((await c.put('/users/alice/plan', { planId: 'premium' })).json().plan.id).toBe('premium');
    const wrong = await c.put('/users/alice/plan', { planId: 'pro' });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.code).toBe('wrong_plan_kind');
    expect((await c.put('/users/alice/plan', { planId: 'nope' })).statusCode).toBe(404);
  });

  it('paginates with a cursor without gaps or duplicates', async () => {
    const { key } = await createAccount(app, 'acme');
    const c = client(app, key);
    for (let i = 0; i < 5; i++) await c.post('/users', { userId: `u${i}` });
    const seen: string[] = [];
    let cursor = '';
    do {
      const body = (await c.get(`/users?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).json();
      seen.push(...body.users.map((u: any) => u.userId));
      cursor = body.nextCursor ?? '';
    } while (cursor);
    expect(seen).toEqual(['u0', 'u1', 'u2', 'u3', 'u4']);
    expect((await c.get('/users?cursor=garbage')).statusCode).toBe(422);
  });
});

describe('custom plans', () => {
  it('lists predefined plus own plans; predefined are read-only', async () => {
    const { key } = await createAccount(app, 'acme');
    const c = client(app, key);
    expect((await c.get('/plans')).json().plans.map((p: any) => p.id)).toEqual(expect.arrayContaining(['starter', 'pro', 'basic', 'premium']));
    const res = await c.patch('/plans/basic', { monthlyAllowance: 99999 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('predefined_plan_read_only');
  });

  it('creates, updates (including unlimited via null) and shares a plan between users', async () => {
    const { key } = await createAccount(app, 'acme');
    const c = client(app, key);
    const plan = (await c.post('/plans', { kind: 'user', name: 'Team', monthlyAllowance: 100, maxPerRequest: 10 })).json();
    expect(plan.predefined).toBe(false);
    await c.post('/users', { userId: 'a', planId: plan.id });
    await c.post('/users', { userId: 'b', planId: plan.id });
    const upd = (await c.patch(`/plans/${plan.id}`, { monthlyAllowance: null })).json();
    expect(upd).toMatchObject({ monthlyAllowance: null, maxPerRequest: 10 });
    expect((await c.get('/users/a')).json().plan.monthlyAllowance).toBeNull();
    expect((await c.get('/users/b')).json().plan.monthlyAllowance).toBeNull();
  });

  it('plans carry a daily allowance: create it, edit it, clear it with null; invalid values are refused', async () => {
    const { key } = await createAccount(app, 'acme');
    const c = client(app, key);
    const made = (await c.post('/plans', { kind: 'user', name: 'Daily', monthlyAllowance: 1000, dailyAllowance: 50, maxPerRequest: 10 })).json();
    expect(made).toMatchObject({ monthlyAllowance: 1000, dailyAllowance: 50, maxPerRequest: 10 });
    expect((await c.patch(`/plans/${made.id}`, { dailyAllowance: 75 })).json()).toMatchObject({ dailyAllowance: 75, monthlyAllowance: 1000 }); // others unchanged
    expect((await c.patch(`/plans/${made.id}`, { dailyAllowance: null })).json().dailyAllowance).toBeNull();
    expect((await c.post('/plans', { kind: 'user', name: 'NoDaily' })).json().dailyAllowance).toBeNull(); // omitted = unlimited
    for (const bad of [0, -1, 2.5, 10 ** 13]) expect((await c.post('/plans', { kind: 'user', name: 'x' + bad, dailyAllowance: bad })).statusCode).toBe(422);
    const predefined = (await c.get('/plans')).json().plans.find((p: any) => p.id === 'basic');
    expect(predefined).toMatchObject({ monthlyAllowance: 500, dailyAllowance: 100, maxPerRequest: 20 });
  });

  it('rejects invalid limits and duplicate names', async () => {
    const { key } = await createAccount(app, 'acme');
    const c = client(app, key);
    for (const bad of [0, -5, 1.5, 10 ** 13]) {
      expect((await c.post('/plans', { kind: 'user', name: 'x', monthlyAllowance: bad })).statusCode).toBe(422);
    }
    await c.post('/plans', { kind: 'user', name: 'Dup' });
    expect((await c.post('/plans', { kind: 'user', name: 'dup' })).statusCode).toBe(409);
  });

  it('assigns a custom account plan to the account', async () => {
    const { key } = await createAccount(app, 'acme');
    const c = client(app, key);
    const plan = (await c.post('/plans', { kind: 'account', name: 'Mine', monthlyAllowance: 50, maxPerRequest: 5 })).json();
    expect((await c.put('/account/plan', { planId: plan.id })).json().plan.id).toBe(plan.id);
  });
});

describe('account isolation', () => {
  it('account B cannot see or use account A users or plans', async () => {
    const a = await createAccount(app, 'A');
    const b = await createAccount(app, 'B');
    const ca = client(app, a.key);
    const cb = client(app, b.key);
    await ca.post('/users', { userId: 'alice' });
    const plan = (await ca.post('/plans', { kind: 'user', name: 'Secret', monthlyAllowance: 5 })).json();

    expect((await cb.get('/users/alice')).statusCode).toBe(404);
    expect((await cb.put('/users/alice/plan', { planId: 'premium' })).statusCode).toBe(404);
    expect((await cb.get('/users')).json().users).toEqual([]);
    expect((await cb.get(`/plans/${plan.id}`)).statusCode).toBe(404);
    expect((await cb.patch(`/plans/${plan.id}`, { monthlyAllowance: 1 })).statusCode).toBe(404);
    expect((await cb.get('/plans')).json().plans.find((p: any) => p.id === plan.id)).toBeUndefined();

    // B cannot assign A's plan to its own users or account.
    await cb.post('/users', { userId: 'bob' });
    expect((await cb.put('/users/bob/plan', { planId: plan.id })).statusCode).toBe(404);
    expect((await cb.post('/users', { userId: 'carol', planId: plan.id })).statusCode).toBe(404);

    // The same userId can exist independently in two accounts.
    expect((await cb.post('/users', { userId: 'alice' })).statusCode).toBe(201);
    // A's data is untouched.
    expect((await ca.get(`/plans/${plan.id}`)).json().monthlyAllowance).toBe(5);
    expect((await ca.get('/users')).json().users).toHaveLength(1);
  });
});

describe('idempotent account creation (externalId)', () => {
  const adminPost = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload as any, headers: { 'x-admin-token': ADMIN } });
  const accountCount = async () => (await pool.query('SELECT count(*)::int n FROM accounts')).rows[0].n;

  it('creating the same externalId twice returns the same account, once, and never a second key', async () => {
    const first = await adminPost('/accounts', { name: 'Acme', externalId: 'cust_42', planId: 'pro' });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ created: true, account: { externalId: 'cust_42', plan: { id: 'pro' } } });
    const key = first.json().apiKey as string;

    const retry = await adminPost('/accounts', { name: 'Acme', externalId: 'cust_42', planId: 'pro' });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ created: false, apiKey: null });
    expect(retry.json().account.id).toBe(first.json().account.id);
    expect(await accountCount()).toBe(1);
    expect((await client(app, key).get('/account')).statusCode).toBe(200); // the original key is untouched
  });

  it('only the first call decides name and plan; a later call with other values does not change the account', async () => {
    await adminPost('/accounts', { name: 'Acme', externalId: 'cust_7', planId: 'pro' });
    const again = await adminPost('/accounts', { name: 'Renamed', externalId: 'cust_7', planId: 'starter' });
    expect(again.json().account).toMatchObject({ name: 'Acme', plan: { id: 'pro' } });
    // even a retry whose other fields are no longer valid finds the existing account (the id alone decides)
    const stale = await adminPost('/accounts', { name: 'Acme', externalId: 'cust_7', planId: 'a-plan-that-does-not-exist' });
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toMatchObject({ created: false, account: { name: 'Acme' } });
  });

  it('different externalIds, or none, make different accounts', async () => {
    await adminPost('/accounts', { name: 'A', externalId: 'a' });
    await adminPost('/accounts', { name: 'B', externalId: 'b' });
    await adminPost('/accounts', { name: 'C' });
    await adminPost('/accounts', { name: 'C' }); // no externalId: not idempotent, as before
    expect(await accountCount()).toBe(4);
  });

  it('ten simultaneous creations of one externalId produce exactly one account and one key', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => adminPost('/accounts', { name: 'Race', externalId: 'cust_race' })));
    const bodies = results.map((r) => r.json());
    expect(results.every((r) => [200, 201].includes(r.statusCode))).toBe(true);
    expect(bodies.filter((b) => b.created)).toHaveLength(1);
    expect(bodies.filter((b) => b.apiKey !== null)).toHaveLength(1);
    expect(new Set(bodies.map((b) => b.account.id)).size).toBe(1);
    expect(await accountCount()).toBe(1);
  });

  it('a lost first response is recoverable: the retry finds the account and the admin rotates a working key', async () => {
    await adminPost('/accounts', { name: 'Acme', externalId: 'cust_lost' }); // pretend this response never arrived
    const retry = await adminPost('/accounts', { name: 'Acme', externalId: 'cust_lost' });
    expect(retry.json()).toMatchObject({ created: false, apiKey: null });
    const rotated = await adminPost(`/accounts/${retry.json().account.id}/api-key/rotate`);
    expect(rotated.statusCode).toBe(200);
    expect((await client(app, rotated.json().apiKey).get('/account')).json().externalId).toBe('cust_lost');
    expect(await accountCount()).toBe(1);
  });

  it('is still admin-only, validates the id, and an account key cannot do any of it', async () => {
    expect((await app.inject({ method: 'POST', url: '/accounts', payload: { name: 'x', externalId: 'e' } })).statusCode).toBe(401);
    const { key } = await createAccount(app, 'acme');
    const withAccountKey = await app.inject({ method: 'POST', url: '/accounts', payload: { name: 'x', externalId: 'e' }, headers: { 'x-api-key': key } });
    expect(withAccountKey.statusCode).toBe(401); // an account key is not admin
    expect((await adminPost('/accounts', { name: 'x', externalId: '' })).statusCode).toBe(422);
    expect((await adminPost('/accounts', { name: 'x', externalId: 'a\u0000b' })).statusCode).toBe(422);
    expect((await adminPost('/accounts', { name: 'x', externalId: 'e'.repeat(201) })).statusCode).toBe(422);
  });

  it('the admin token is not accepted on data routes (the two credentials never overlap)', async () => {
    const res = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-admin-token': ADMIN } });
    expect(res.statusCode).toBe(401);
  });
});
