import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { brokenInvariants, client, consume, createAccount, makeApp, newPlan, newUser, resetData, setupTestDb } from './helpers';

let pool: pg.Pool;
let app: FastifyInstance;
let now = new Date('2026-10-15T12:00:00Z');
beforeAll(async () => { pool = await setupTestDb(); app = makeApp(pool, () => now); });
beforeEach(async () => { now = new Date('2026-10-15T12:00:00Z'); await resetData(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

/** An account with the given plan, plus a client bound to its key. */
async function setup(monthly: number | null, perRequest: number | null) {
  const root = await createAccount(app, 'acme');
  const c = client(app, root.key);
  const plan = await newPlan(c, 'account', 'acct', monthly, perRequest);
  await c.put('/account/plan', { planId: plan });
  return { c, root };
}

describe('the brief examples', () => {
  it('rejects 25 units on the user per-request limit even though both monthly allowances have room', async () => {
    const { c } = await setup(10_000, 100);
    await newUser(c, 'alice', await newPlan(c, 'user', 'u', 1000, 20));
    const r = await consume(c, 'alice', 25);
    expect(r).toMatchObject({ accepted: false, rule: 'max_per_request', level: 'user' });
    expect(r.user.used).toBe(0);
    expect(r.account.used).toBe(0); // a rejection consumes nothing
  });

  it('accepts 10 units and adds 10 to both the user and the shared account usage', async () => {
    const { c } = await setup(10_000, 100);
    await newUser(c, 'alice', await newPlan(c, 'user', 'u', 1000, 20));
    const r = await consume(c, 'alice', 10);
    expect(r).toMatchObject({ accepted: true, rule: null, level: null, replayed: false });
    expect(r.user).toMatchObject({ used: 10, remaining: 990 });
    expect(r.account).toMatchObject({ used: 10, remaining: 9990 });
  });

  it('rejects 10 units when the account has only 5 left, however much the user has', async () => {
    const { c } = await setup(100, 100);
    await newUser(c, 'alice', await newPlan(c, 'user', 'big', 100_000, 100));
    await newUser(c, 'bob', await newPlan(c, 'user', 'big2', 100_000, 100));
    expect((await consume(c, 'alice', 95)).accepted).toBe(true);
    const r = await consume(c, 'bob', 10);
    expect(r).toMatchObject({ accepted: false, rule: 'monthly_allowance', level: 'account' });
    expect(r.violations[0].remaining).toBe(5);
    expect(r.user.remaining).toBe(100_000); // bob consumed nothing
    expect((await consume(c, 'bob', 5)).accepted).toBe(true); // exactly the remaining 5 still fits
  });

  it('account usage is the sum of its users; users sharing a plan keep separate allowances', async () => {
    const { c } = await setup(null, null);
    const shared = await newPlan(c, 'user', 'shared', 30, null);
    await newUser(c, 'a', shared);
    await newUser(c, 'b', shared);
    expect((await consume(c, 'a', 30)).accepted).toBe(true);
    expect((await consume(c, 'a', 1)).accepted).toBe(false); // a is out...
    const b = await consume(c, 'b', 30);
    expect(b.accepted).toBe(true); // ...b is not affected
    expect(b.account.used).toBe(60);
    expect(await brokenInvariants(pool)).toEqual([]);
  });
});

describe('plan changes', () => {
  it('switching plans keeps units already consumed (no fresh allowance)', async () => {
    const { c } = await setup(null, null);
    const small = await newPlan(c, 'user', 'small', 100, null);
    const big = await newPlan(c, 'user', 'big', 150, null);
    await newUser(c, 'alice', small);
    await consume(c, 'alice', 100);
    expect((await consume(c, 'alice', 1)).accepted).toBe(false);
    await c.put('/users/alice/plan', { planId: big });
    const r = await consume(c, 'alice', 50);
    expect(r).toMatchObject({ accepted: true });
    expect(r.user).toMatchObject({ used: 150, remaining: 0 }); // 100 carried over, not reset
    expect((await consume(c, 'alice', 1)).accepted).toBe(false);
  });

  it('an edit to a shared custom plan applies to the very next request, for every assignee', async () => {
    const { c } = await setup(null, null);
    const plan = await newPlan(c, 'user', 'team', 10, 10);
    await newUser(c, 'a', plan);
    await newUser(c, 'b', plan);
    expect((await consume(c, 'a', 11)).accepted).toBe(false);
    expect((await consume(c, 'b', 11)).accepted).toBe(false);
    await c.patch(`/plans/${plan}`, { maxPerRequest: 50, monthlyAllowance: 100 });
    expect((await consume(c, 'a', 11)).accepted).toBe(true);
    expect((await consume(c, 'b', 11)).accepted).toBe(true);
  });

  it('an allowance cut below existing usage shows 0 remaining and rejects until raised again', async () => {
    const { c } = await setup(null, null);
    const plan = await newPlan(c, 'user', 'p', 100, null);
    await newUser(c, 'alice', plan);
    await consume(c, 'alice', 80);
    await c.patch(`/plans/${plan}`, { monthlyAllowance: 50 });
    const r = await consume(c, 'alice', 1);
    expect(r).toMatchObject({ accepted: false, rule: 'monthly_allowance', level: 'user' });
    expect(r.user).toMatchObject({ used: 80, remaining: 0 });
    await c.patch(`/plans/${plan}`, { monthlyAllowance: 200 });
    expect((await consume(c, 'alice', 1)).user).toMatchObject({ used: 81, remaining: 119 });
  });

  it('an account plan edit applies to all its users', async () => {
    const root = await createAccount(app, 'acme');
    const c = client(app, root.key);
    const acct = await newPlan(c, 'account', 'a', 10, null);
    await c.put('/account/plan', { planId: acct });
    await newUser(c, 'u1', 'premium');
    await newUser(c, 'u2', 'premium');
    expect((await consume(c, 'u1', 10)).accepted).toBe(true);
    expect((await consume(c, 'u2', 1)).accepted).toBe(false);
    await c.patch(`/plans/${acct}`, { monthlyAllowance: 20 });
    expect((await consume(c, 'u2', 10)).accepted).toBe(true);
  });

  it('history keeps the limits that applied at the time of each decision', async () => {
    const { c } = await setup(null, null);
    const plan = await newPlan(c, 'user', 'p', 10, 10);
    await newUser(c, 'alice', plan);
    await consume(c, 'alice', 5, 'old');
    await c.patch(`/plans/${plan}`, { monthlyAllowance: 999 });
    const { rows } = await pool.query("SELECT applied FROM requests WHERE request_id = 'old'");
    expect(rows[0].applied.user.monthlyAllowance).toBe(10);
  });
});

describe('months', () => {
  it('every UTC month starts at zero, and the earlier month stays on record', async () => {
    const { c } = await setup(null, null);
    await newUser(c, 'alice', await newPlan(c, 'user', 'p', 100, null));
    now = new Date('2026-10-31T23:59:59Z');
    expect((await consume(c, 'alice', 100)).accepted).toBe(true);
    expect((await consume(c, 'alice', 1)).accepted).toBe(false);
    now = new Date('2026-11-01T00:00:00Z');
    const r = await consume(c, 'alice', 100);
    expect(r).toMatchObject({ accepted: true, period: '2026-11' });
    expect(r.user.used).toBe(100);
    const { rows } = await pool.query("SELECT period::text, units FROM user_usage ORDER BY period");
    expect(rows).toEqual([{ period: '2026-10-01', units: 100 }, { period: '2026-11-01', units: 100 }]);
  });
});

describe('safe retries (idempotency)', () => {
  it('a retry returns the same decision, flagged replayed, and counts once', async () => {
    const { c } = await setup(null, null);
    await newUser(c, 'alice', await newPlan(c, 'user', 'p', 100, null));
    const first = await consume(c, 'alice', 10, 'req-1');
    const again = await consume(c, 'alice', 10, 'req-1');
    expect(again).toEqual({ ...first, replayed: true });
    expect((await consume(c, 'alice', 1, 'req-2')).user.used).toBe(11);
  });

  it('a rejected request replays as rejected even after the plan would now allow it', async () => {
    const { c } = await setup(null, null);
    const plan = await newPlan(c, 'user', 'p', 100, 5);
    await newUser(c, 'alice', plan);
    const first = await consume(c, 'alice', 10, 'req-1');
    expect(first.accepted).toBe(false);
    await c.patch(`/plans/${plan}`, { maxPerRequest: 50 });
    const again = await consume(c, 'alice', 10, 'req-1');
    expect(again).toMatchObject({ accepted: false, replayed: true });
    expect((await consume(c, 'alice', 10, 'req-2')).accepted).toBe(true); // a NEW request id gets a fresh decision
  });

  it('reusing a requestId with a different user or amount is a 409', async () => {
    const { c } = await setup(null, null);
    const plan = await newPlan(c, 'user', 'p', 100, null);
    await newUser(c, 'alice', plan);
    await newUser(c, 'bob', plan);
    await consume(c, 'alice', 10, 'req-1');
    for (const body of [{ userId: 'alice', units: 11 }, { userId: 'bob', units: 10 }]) {
      const res = await c.post('/consume', { ...body, requestId: 'req-1' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('idempotency_conflict');
    }
  });

  it('request ids are scoped per account', async () => {
    const a = await setup(null, null);
    const b = await createAccount(app, 'other');
    const cb = client(app, b.key);
    await newUser(a.c, 'u', 'basic');
    await newUser(cb, 'u', 'basic');
    expect((await consume(a.c, 'u', 1, 'same-id')).replayed).toBe(false);
    expect((await consume(cb, 'u', 1, 'same-id')).replayed).toBe(false);
  });
});

describe('input and isolation', () => {
  it('validates units, ids and body shape', async () => {
    const { c } = await setup(null, null);
    await newUser(c, 'alice', 'basic');
    for (const body of [
      { userId: 'alice', units: 0, requestId: 'x' }, { userId: 'alice', units: -3, requestId: 'x' },
      { userId: 'alice', units: 1.5, requestId: 'x' }, { userId: 'alice', units: '5', requestId: 'x' },
      { userId: 'alice', units: 5 }, { units: 5, requestId: 'x' }, { userId: 'alice', units: 5, requestId: '' },
    ]) {
      expect((await c.post('/consume', body)).statusCode, JSON.stringify(body)).toBe(422);
    }
  });

  it('requires a valid API key and cannot consume for another account\'s user', async () => {
    const a = await setup(null, null);
    const b = await createAccount(app, 'other');
    await newUser(a.c, 'alice', 'basic');
    const noKey = await app.inject({ method: 'POST', url: '/consume', payload: { userId: 'alice', units: 1, requestId: 'x' } });
    expect(noKey.statusCode).toBe(401);
    const cross = await client(app, b.key).post('/consume', { userId: 'alice', units: 1, requestId: 'x' });
    expect(cross.statusCode).toBe(404);
    expect((await pool.query('SELECT count(*)::int n FROM requests')).rows[0].n).toBe(0); // nothing recorded
  });
});

describe('concurrency', () => {
  it('200 parallel requests against a 100-unit user allowance: exactly 100 accepted', async () => {
    const { c } = await setup(null, null);
    await newUser(c, 'alice', await newPlan(c, 'user', 'p', 100, null));
    const results = await Promise.all(Array.from({ length: 200 }, () => consume(c, 'alice', 1)));
    expect(results.filter((r) => r.accepted)).toHaveLength(100);
    expect(results.filter((r) => !r.accepted).every((r) => r.rule === 'monthly_allowance' && r.level === 'user')).toBe(true);
    expect((await pool.query('SELECT units FROM user_usage')).rows[0].units).toBe(100);
    expect(await brokenInvariants(pool)).toEqual([]);
  });

  it('many users racing for a shared account allowance never exceed it', async () => {
    const { c } = await setup(120, null);
    const plan = await newPlan(c, 'user', 'p', null, null);
    for (let i = 0; i < 10; i++) await newUser(c, `u${i}`, plan);
    const results = await Promise.all(Array.from({ length: 300 }, (_, i) => consume(c, `u${i % 10}`, 2)));
    expect(results.filter((r) => r.accepted)).toHaveLength(60); // 60 x 2 units = 120 exactly
    expect((await pool.query('SELECT units FROM account_usage')).rows[0].units).toBe(120);
    expect(await brokenInvariants(pool)).toEqual([]);
  });

  it('20 simultaneous duplicates of one requestId produce one decision and count once', async () => {
    const { c } = await setup(null, null);
    await newUser(c, 'alice', await newPlan(c, 'user', 'p', 100, null));
    const results = await Promise.all(Array.from({ length: 20 }, () => consume(c, 'alice', 7, 'dup')));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.every((r) => r.accepted)).toBe(true);
    expect((await pool.query('SELECT units FROM user_usage')).rows[0].units).toBe(7);
    expect((await pool.query('SELECT count(*)::int n FROM requests')).rows[0].n).toBe(1);
  });

  it('plan edits during a burst never break the counters', async () => {
    const { c } = await setup(null, null);
    const plan = await newPlan(c, 'user', 'p', 50, null);
    for (const u of ['a', 'b', 'c']) await newUser(c, u, plan);
    const burst = Array.from({ length: 150 }, (_, i) => consume(c, 'abc'[i % 3]!, 1));
    const edits = [30, 80, 10, 60, 200].map((m) => c.patch(`/plans/${plan}`, { monthlyAllowance: m }));
    await Promise.all([...burst, ...edits]);
    expect(await brokenInvariants(pool)).toEqual([]);
  });
});
