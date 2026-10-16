import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { client, consume, createAccount, makeApp, newPlan, newUser, resetData, setupTestDb } from './helpers';

let pool: pg.Pool;
let app: FastifyInstance;
let now = new Date('2026-10-15T12:00:00Z');
beforeAll(async () => { pool = await setupTestDb(); app = makeApp(pool, () => now); });
beforeEach(async () => { now = new Date('2026-10-15T12:00:00Z'); await resetData(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function setup() {
  const root = await createAccount(app, 'acme');
  const c = client(app, root.key);
  await c.put('/account/plan', { planId: await newPlan(c, 'account', 'acct', 1000, 100) });
  const plan = await newPlan(c, 'user', 'u', 200, 50);
  for (const u of ['alice', 'bob', 'idle']) await newUser(c, u, plan);
  return { c, root, plan };
}

describe('usage', () => {
  it('shows consumed and remaining for the account and every user, including users with no usage', async () => {
    const { c } = await setup();
    await consume(c, 'alice', 30);
    await consume(c, 'bob', 20);
    await consume(c, 'bob', 999); // rejected: must not show up as usage
    const body = (await c.get('/usage')).json();
    expect(body).toMatchObject({ period: '2026-10', current: true });
    expect(body.account).toMatchObject({ used: 50, remaining: 950, monthlyAllowance: 1000, maxPerRequest: 100 });
    const byUser = Object.fromEntries(body.users.map((u: any) => [u.userId, u]));
    expect(byUser.alice).toMatchObject({ used: 30, remaining: 170 });
    expect(byUser.bob).toMatchObject({ used: 20, remaining: 180 });
    expect(byUser.idle).toMatchObject({ used: 0, remaining: 200 });
    expect(body.users.reduce((n: number, u: any) => n + u.used, 0)).toBe(body.account.used); // I5, as the caller sees it
  });

  it('past months stay queryable (used only); the new month starts at zero', async () => {
    const { c } = await setup();
    await consume(c, 'alice', 40);
    now = new Date('2026-11-02T08:00:00Z');
    await consume(c, 'alice', 5);
    const oct = (await c.get('/usage?period=2026-10')).json();
    expect(oct).toMatchObject({ period: '2026-10', current: false });
    expect(oct.account).toMatchObject({ used: 40, remaining: null });
    expect(oct.users.find((u: any) => u.userId === 'alice')).toMatchObject({ used: 40, remaining: null });
    const nov = (await c.get('/usage')).json();
    expect(nov).toMatchObject({ period: '2026-11', current: true });
    expect(nov.account).toMatchObject({ used: 5, remaining: 995 });
    expect((await c.get('/users/alice/usage?period=2026-10')).json().user.used).toBe(40);
  });

  it('rejects malformed and future periods; a month with no activity is simply zero', async () => {
    const { c } = await setup();
    expect((await c.get('/usage?period=2026-13')).statusCode).toBe(422);
    expect((await c.get('/usage?period=oct')).statusCode).toBe(422);
    const future = await c.get('/usage?period=2027-01');
    expect(future.statusCode).toBe(422);
    expect(future.json().error.code).toBe('future_period');
    expect((await c.get('/usage?period=2026-01')).json().account.used).toBe(0);
  });

  it('paginates the user list', async () => {
    const { c } = await setup();
    const first = (await c.get('/usage?limit=2')).json();
    expect(first.users).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = (await c.get(`/usage?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.users).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('is isolated per account', async () => {
    const { c } = await setup();
    await consume(c, 'alice', 10);
    const other = client(app, (await createAccount(app, 'other')).key);
    expect((await other.get('/usage')).json().account.used).toBe(0);
    expect((await other.get('/usage')).json().users).toEqual([]);
    expect((await other.get('/users/alice/usage')).statusCode).toBe(404);
    expect((await other.get('/users/alice/limits')).statusCode).toBe(404);
  });
});

describe('limits', () => {
  it('shows the plans currently applied and the remaining units, and follows plan changes', async () => {
    const { c, plan } = await setup();
    await consume(c, 'alice', 25);
    const before = (await c.get('/users/alice/limits')).json();
    expect(before.user).toMatchObject({ planId: plan, monthlyAllowance: 200, maxPerRequest: 50, used: 25, remaining: 175 });
    expect(before.account).toMatchObject({ monthlyAllowance: 1000, maxPerRequest: 100, used: 25, remaining: 975 });
    await c.put('/users/alice/plan', { planId: 'premium' });
    const after = (await c.get('/users/alice/limits')).json();
    expect(after.user).toMatchObject({ planId: 'premium', monthlyAllowance: 5000, used: 25, remaining: 4975 });
  });
});

describe('request history', () => {
  it('lists accepted and rejected decisions newest first, with the reason and the limits applied', async () => {
    const { c } = await setup();
    await consume(c, 'alice', 10, 'a');
    await consume(c, 'alice', 60, 'b'); // user per-request limit is 50
    await consume(c, 'bob', 5, 'c');
    const { requests } = (await c.get('/requests')).json();
    expect(requests.map((r: any) => r.requestId)).toEqual(['c', 'b', 'a']);
    expect(requests[1]).toMatchObject({ accepted: false, rule: 'max_per_request', level: 'user', units: 60, userId: 'alice' });
    expect(requests[1].message).toContain('at most 50');
    expect(requests[1].user.maxPerRequest).toBe(50);
    expect(requests[2]).toMatchObject({ accepted: true, rule: null, level: null });
  });

  it('paginates without gaps or duplicates, even while new requests arrive', async () => {
    const { c } = await setup();
    for (let i = 0; i < 7; i++) await consume(c, 'alice', 1, `r${i}`);
    const page1 = (await c.get('/requests?limit=3')).json();
    await consume(c, 'alice', 1, 'late'); // arrives between page fetches
    const page2 = (await c.get(`/requests?limit=3&cursor=${page1.nextCursor}`)).json();
    const page3 = (await c.get(`/requests?limit=3&cursor=${page2.nextCursor}`)).json();
    const ids = [...page1.requests, ...page2.requests, ...page3.requests].map((r: any) => r.requestId);
    expect(ids).toEqual(['r6', 'r5', 'r4', 'r3', 'r2', 'r1', 'r0']); // no 'late', no repeats, nothing skipped
    expect(page3.nextCursor).toBeNull();
    expect((await c.get('/requests?cursor=garbage')).statusCode).toBe(422);
  });

  it('filters by user, outcome and month', async () => {
    const { c } = await setup();
    await consume(c, 'alice', 10, 'a1');
    await consume(c, 'alice', 99, 'a2'); // rejected
    await consume(c, 'bob', 10, 'b1');
    now = new Date('2026-11-03T00:00:00Z');
    await consume(c, 'bob', 10, 'b2');
    const ids = async (q: string) => (await c.get(`/requests${q}`)).json().requests.map((r: any) => r.requestId).sort();
    expect(await ids('?userId=alice')).toEqual(['a1', 'a2']);
    expect(await ids('?accepted=false')).toEqual(['a2']);
    expect(await ids('?period=2026-11')).toEqual(['b2']);
    expect(await ids('?userId=bob&period=2026-10')).toEqual(['b1']);
    expect((await c.get('/requests?userId=ghost')).statusCode).toBe(404);
    expect((await c.get('/requests?period=nope')).statusCode).toBe(422);
  });

  it('history survives plan changes and other accounts cannot see it', async () => {
    const { c, plan } = await setup();
    await consume(c, 'alice', 60, 'a'); // rejected under the old limit
    await c.patch(`/plans/${plan}`, { maxPerRequest: 100 });
    await c.put('/users/alice/plan', { planId: 'premium' });
    const [r] = (await c.get('/requests')).json().requests;
    expect(r).toMatchObject({ requestId: 'a', accepted: false });
    expect(r.user.maxPerRequest).toBe(50); // the limit that applied then
    const other = client(app, (await createAccount(app, 'other')).key);
    expect((await other.get('/requests')).json().requests).toEqual([]);
  });
});

describe('API docs', () => {
  it('serves the OpenAPI document and UI without an API key, covering every endpoint', async () => {
    const ui = await app.inject('/docs');
    expect([200, 302]).toContain(ui.statusCode);
    const spec = (await app.inject('/docs/json')).json();
    for (const path of ['/consume', '/usage', '/requests', '/users/{userId}/limits', '/plans/{planId}', '/accounts', '/health']) {
      expect(spec.paths[path], path).toBeDefined();
    }
    expect(spec.components.securitySchemes.apiKey.name).toBe('X-API-Key');
  });
});

describe('daily allowance in usage, limits and history', () => {
  async function dailySetup() {
    const root = await createAccount(app, 'acme');
    const c = client(app, root.key);
    await c.put('/account/plan', { planId: await newPlan(c, 'account', 'acct', 1000, 100, 200) });
    await newUser(c, 'alice', await newPlan(c, 'user', 'u', 500, 50, 60));
    await newUser(c, 'bob', await newPlan(c, 'user', 'u2', 500, 50, null));
    return { c, root };
  }

  it('limits and usage show today\'s numbers next to the monthly ones', async () => {
    const { c } = await dailySetup();
    await consume(c, 'alice', 25);
    const limits = (await c.get('/users/alice/limits')).json();
    expect(limits.user).toMatchObject({ monthlyAllowance: 500, used: 25, remaining: 475, dailyAllowance: 60, usedToday: 25, remainingToday: 35 });
    expect(limits.account).toMatchObject({ dailyAllowance: 200, usedToday: 25, remainingToday: 175 });
    const usageBody = (await c.get('/usage')).json();
    expect(usageBody.account).toMatchObject({ used: 25, usedToday: 25, remainingToday: 175 });
    const byUser = Object.fromEntries(usageBody.users.map((u: any) => [u.userId, u]));
    expect(byUser.alice).toMatchObject({ usedToday: 25, remainingToday: 35 });
    expect(byUser.bob).toMatchObject({ usedToday: 0, dailyAllowance: null, remainingToday: null }); // no daily limit: unlimited
  });

  it('a new UTC day starts at zero for the daily numbers while the month keeps its total', async () => {
    const { c } = await dailySetup();
    await consume(c, 'alice', 30);
    now = new Date('2026-10-16T08:00:00Z');
    const limits = (await c.get('/users/alice/limits')).json();
    expect(limits.user).toMatchObject({ used: 30, remaining: 470, usedToday: 0, remainingToday: 60 });
    expect((await c.get('/usage')).json().account).toMatchObject({ used: 30, usedToday: 0 });
  });

  it('past months report what was used and no daily or monthly balance (they describe now)', async () => {
    const { c } = await dailySetup();
    await consume(c, 'alice', 10);
    now = new Date('2026-11-03T09:00:00Z');
    const oct = (await c.get('/usage?period=2026-10')).json();
    expect(oct.account).toMatchObject({ used: 10, remaining: null, usedToday: null, remainingToday: null });
    expect(oct.users.find((u: any) => u.userId === 'alice')).toMatchObject({ used: 10, usedToday: null, remainingToday: null });
    expect((await c.get('/users/alice/usage?period=2026-10')).json().user).toMatchObject({ used: 10, usedToday: null });
  });

  it('history records the daily rule and the balances at the time, and filters still work', async () => {
    const { c } = await dailySetup();
    await consume(c, 'alice', 50, 'a');
    await consume(c, 'alice', 20, 'b'); // 50 + 20 > 60 a day
    const { requests } = (await c.get('/requests')).json();
    expect(requests[0]).toMatchObject({ requestId: 'b', accepted: false, rule: 'daily_allowance', level: 'user' });
    expect(requests[0].user).toMatchObject({ dailyAllowance: 60, usedToday: 50, remainingToday: 10 });
    expect(requests[1].user).toMatchObject({ usedToday: 50 });
    expect((await c.get('/requests?accepted=false')).json().requests.map((r: any) => r.requestId)).toEqual(['b']);
  });

  it('decisions stored before the daily rule existed still read back (daily fields show as null)', async () => {
    const { c, root } = await dailySetup();
    const { rows: [u] } = await pool.query("SELECT id, account_id FROM users WHERE external_id = 'alice'");
    const oldSide = { planId: 'basic', planName: 'Basic', monthlyAllowance: 500, maxPerRequest: 20, used: 7, remaining: 493 }; // no daily keys
    await pool.query(
      `INSERT INTO requests (account_id, request_id, user_id, units, period, day, accepted, violations, applied)
       VALUES ($1, 'legacy', $2, 7, '2026-10-01', '2026-10-15', true, '[]', $3)`,
      [u.account_id, u.id, JSON.stringify({ account: oldSide, user: oldSide })],
    );
    const res = await c.get('/requests');
    expect(res.statusCode).toBe(200);
    const legacy = res.json().requests.find((r: any) => r.requestId === 'legacy');
    expect(legacy.user).toMatchObject({ used: 7, dailyAllowance: null, usedToday: null, remainingToday: null });
    // and a retry of it replays instead of failing
    expect(root).toBeDefined();
    expect((await c.post('/consume', { userId: 'alice', units: 7, requestId: 'legacy' })).json()).toMatchObject({ replayed: true, accepted: true });
  });
});
