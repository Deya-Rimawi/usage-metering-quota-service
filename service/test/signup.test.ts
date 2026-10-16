// Self-service signup (OPEN_SIGNUP): anyone can create an account and gets the key in the response.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { ADMIN, client, consume, makeApp, newUser, resetData, setupTestDb } from './helpers';

let pool: pg.Pool;
let closed: FastifyInstance;               // default: OPEN_SIGNUP off
let open: FastifyInstance;                 // OPEN_SIGNUP=true
beforeAll(async () => {
  pool = await setupTestDb();
  closed = makeApp(pool);
  open = makeApp(pool, undefined, { OPEN_SIGNUP: 'true' });
});
beforeEach(() => resetData(pool));
afterAll(async () => { await closed.close(); await open.close(); await pool.end(); });

const signup = (app: FastifyInstance, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/accounts', payload: payload as any, headers });
const accountCount = async () => (await pool.query('SELECT count(*)::int n FROM accounts')).rows[0].n;

describe('signup is closed by default', () => {
  it('without the admin token, account creation is 401 (as before)', async () => {
    const res = await signup(closed, { name: 'Anon' });
    expect(res.statusCode).toBe(401);
    expect(await accountCount()).toBe(0);
  });
});

describe('self-service signup (OPEN_SIGNUP=true)', () => {
  it('anyone can create an account and receives a working key directly in the response', async () => {
    const res = await signup(open, { name: 'PagePilot' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ created: true, account: { name: 'PagePilot', externalId: null, plan: { id: 'starter' } } });
    const c = client(open, body.apiKey);
    expect((await c.get('/account')).statusCode).toBe(200);
    // the new account is a normal account: it can register users and consume, and is isolated from others
    await newUser(c, 'dana', 'basic');
    expect((await consume(c, 'dana', 5)).accepted).toBe(true);
    expect((await pool.query("SELECT source FROM accounts")).rows[0].source).toBe('self_service');
  });

  it('the account holder can choose a predefined plan at signup, like an operator can', async () => {
    const res = await signup(open, { name: 'Big', planId: 'pro' });
    expect(res.json().account.plan.id).toBe('pro');
  });

  it('is never idempotent: externalId is refused for anonymous callers (it would reveal which customer ids exist)', async () => {
    await signup(open, { name: 'Acme', externalId: 'cust_secret' }, { 'x-admin-token': ADMIN }); // an operator made this one
    const probe = await signup(open, { name: 'Probe', externalId: 'cust_secret' });
    expect(probe.statusCode).toBe(403);
    expect(probe.json().error.code).toBe('external_id_requires_admin');
    expect(JSON.stringify(probe.json())).not.toContain('Acme'); // nothing about the existing account leaks
    expect(await accountCount()).toBe(1);
  });

  it('a wrong admin token is refused, never silently turned into a signup', async () => {
    const res = await signup(open, { name: 'Typo' }, { 'x-admin-token': 'wrong-token-123' });
    expect(res.statusCode).toBe(401);
    expect(await accountCount()).toBe(0);
  });

  it('the admin path is unchanged: externalId stays idempotent with the admin token', async () => {
    const first = await signup(open, { name: 'Acme', externalId: 'cust_1' }, { 'x-admin-token': ADMIN });
    const again = await signup(open, { name: 'Acme', externalId: 'cust_1' }, { 'x-admin-token': ADMIN });
    expect([first.statusCode, again.statusCode]).toEqual([201, 200]);
    expect(again.json()).toMatchObject({ created: false, apiKey: null });
    expect((await pool.query("SELECT source FROM accounts")).rows[0].source).toBe('admin');
    expect(await accountCount()).toBe(1);
  });

  it('opens only signup: admin-only routes and data routes stay protected', async () => {
    const { account, apiKey } = (await signup(open, { name: 'Self' })).json();
    expect((await open.inject({ method: 'POST', url: `/accounts/${account.id}/api-key/rotate` })).statusCode).toBe(401);
    expect((await open.inject({ method: 'POST', url: `/accounts/${account.id}/api-key/rotate`, headers: { 'x-api-key': apiKey } })).statusCode).toBe(401);
    expect((await open.inject({ method: 'GET', url: '/usage' })).statusCode).toBe(401);
    expect((await open.inject({ method: 'GET', url: '/account', headers: { 'x-admin-token': ADMIN } })).statusCode).toBe(401);
    // the account can still rotate its OWN key with its current key
    expect((await open.inject({ method: 'POST', url: '/account/api-key/rotate', headers: { 'x-api-key': apiKey } })).statusCode).toBe(200);
  });

  it('validates input like any other account creation', async () => {
    expect((await signup(open, { name: '' })).statusCode).toBe(422);
    expect((await signup(open, { name: 'a\u0000b' })).statusCode).toBe(422);
    expect((await signup(open, { name: 'x', planId: 'nope' })).statusCode).toBe(404);
    expect((await signup(open, { name: 'x', planId: 'basic' })).statusCode).toBe(422); // a user plan cannot be an account plan
    expect(await accountCount()).toBe(0);
  });
});

describe('abuse protection for self-service signup', () => {
  it('anonymous signups are strictly rate-limited per IP, while a valid admin token keeps its own generous limit', async () => {
    const limited = makeApp(pool, undefined, { OPEN_SIGNUP: 'true', SIGNUP_RATE_LIMIT_PER_MIN: '3', ADMIN_RATE_LIMIT_PER_MIN: '1000' });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await signup(limited, { name: `s${i}` })).statusCode);
    expect(codes).toEqual([201, 201, 201, 429]);
    expect((await signup(limited, { name: 'again' })).json().error.code).toBe('rate_limited');
    // the same IP has used up the anonymous allowance, but an operator with the real token is not affected
    expect((await signup(limited, { name: 'operator-made' }, { 'x-admin-token': ADMIN })).statusCode).toBe(201);
    await limited.close();
  });

  it('there is a cap on self-service accounts; operators are not affected by it', async () => {
    const capped = makeApp(pool, undefined, { OPEN_SIGNUP: 'true', SIGNUP_MAX_ACCOUNTS: '2' });
    expect((await signup(capped, { name: 'a' })).statusCode).toBe(201);
    expect((await signup(capped, { name: 'b' })).statusCode).toBe(201);
    const over = await signup(capped, { name: 'c' });
    expect(over.statusCode).toBe(403);
    expect(over.json().error.code).toBe('signup_closed');
    expect((await signup(capped, { name: 'operator' }, { 'x-admin-token': ADMIN })).statusCode).toBe(201); // not counted, not blocked
    expect(await accountCount()).toBe(3);
    await capped.close();
  });

  it('the cap is exact even when 20 signups arrive at the same instant', async () => {
    const capped = makeApp(pool, undefined, { OPEN_SIGNUP: 'true', SIGNUP_MAX_ACCOUNTS: '5' });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => signup(capped, { name: `r${i}` })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(5);
    expect(results.filter((r) => r.statusCode === 403)).toHaveLength(15);
    expect(await accountCount()).toBe(5);
    await capped.close();
  });
});
