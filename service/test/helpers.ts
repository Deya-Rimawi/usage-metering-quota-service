import pg from 'pg';
import { createPool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';
import { seedPlans } from '../src/db/seed';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:metering@localhost:5433/postgres';
export const TEST_DB = 'metering_test';
export const TEST_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);

/** Creates the test database if missing, migrates and seeds it. Returns a pool. */
export async function setupTestDb(): Promise<pg.Pool> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  const pool = createPool(TEST_URL, 10);
  await migrate(pool);
  await seedPlans(pool);
  return pool;
}

/** Wipes all data and re-seeds the predefined plans. Call in beforeEach. */
export async function resetData(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE requests, user_usage, account_usage, users, accounts, plans CASCADE');
  await seedPlans(pool);
}

import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config';
import { buildApp } from '../src/http/app';

export const ADMIN = 'test-admin-token';

export function makeApp(pool: pg.Pool, clock?: () => Date, env: Record<string, string> = {}): FastifyInstance {
  return buildApp({
    clock, pool,
    config: loadConfig({ DATABASE_URL: TEST_URL, ADMIN_TOKEN: ADMIN, ADMIN_RATE_LIMIT_PER_MIN: '1000000', LOG_LEVEL: process.env.TEST_LOG ?? 'silent', ...env }),
  });
}

/** Tiny HTTP client bound to one API key. */
export function client(app: FastifyInstance, key?: string) {
  const call = (method: any, url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as any, headers: key ? { 'x-api-key': key } : {} });
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, body?: unknown) => call('POST', url, body ?? {}),
    put: (url: string, body: unknown) => call('PUT', url, body),
    patch: (url: string, body: unknown) => call('PATCH', url, body),
  };
}

export async function createAccount(app: FastifyInstance, name: string, planId = 'starter') {
  const res = await app.inject({ method: 'POST', url: '/accounts', payload: { name, planId }, headers: { 'x-admin-token': ADMIN } });
  const body = res.json();
  return { id: body.account.id as string, key: body.apiKey as string, res };
}

type Client = Pick<ReturnType<typeof client>, 'get' | 'post' | 'put' | 'patch'>;

export async function newPlan(
  c: Client, kind: 'account' | 'user', name: string, monthlyAllowance: number | null, maxPerRequest: number | null, dailyAllowance: number | null = null,
): Promise<string> {
  return (await c.post('/plans', { kind, name, monthlyAllowance, maxPerRequest, dailyAllowance })).json().id;
}

export async function newUser(c: Client, userId: string, planId: string) {
  const res = await c.post('/users', { userId, planId });
  if (res.statusCode !== 201) throw new Error(res.body);
}

let seq = 0;
export const consume = async (c: Client, userId: string, units: number, requestId = `r-${++seq}-${Math.random()}`) =>
  (await c.post('/consume', { userId, units, requestId })).json();

/**
 * Invariants I1, I2 and I5 from docs/CONCURRENCY.md, checked straight from the database, for the monthly AND the
 * daily counters: every counter equals the sum of accepted units in the request log, the account total equals the
 * sum of its users, and no accepted decision left a balance above the allowance that applied to it.
 * Returns the offending rows (empty = healthy).
 */
export async function brokenInvariants(pool: pg.Pool) {
  const user = await pool.query(`
    SELECT uu.user_id, uu.units AS counter, COALESCE(r.s, 0) AS logged FROM user_usage uu
    LEFT JOIN (SELECT user_id, period, sum(units) AS s FROM requests WHERE accepted GROUP BY 1, 2) r USING (user_id, period)
    WHERE uu.units <> COALESCE(r.s, 0)`);
  const account = await pool.query(`
    SELECT au.account_id, au.units AS counter, COALESCE(r.s, 0) AS logged FROM account_usage au
    LEFT JOIN (SELECT account_id, period, sum(units) AS s FROM requests WHERE accepted GROUP BY 1, 2) r USING (account_id, period)
    WHERE au.units <> COALESCE(r.s, 0)`);
  const sums = await pool.query(`
    SELECT au.account_id FROM account_usage au
    WHERE au.units <> (SELECT COALESCE(sum(uu.units), 0) FROM user_usage uu JOIN users u ON u.id = uu.user_id
                       WHERE u.account_id = au.account_id AND uu.period = au.period)`);
  // I2, per decision: the balance after every accepted decision fits inside the allowance that applied to it.
  // (Uses the snapshot stored with the decision, so it stays valid however plans were edited afterwards.)
  const overspent = await pool.query(`
    SELECT request_id FROM requests WHERE accepted AND (
      ((applied->'user'->>'monthlyAllowance') IS NOT NULL
        AND (applied->'user'->>'used')::bigint > (applied->'user'->>'monthlyAllowance')::bigint)
      OR ((applied->'account'->>'monthlyAllowance') IS NOT NULL
        AND (applied->'account'->>'used')::bigint > (applied->'account'->>'monthlyAllowance')::bigint))`);
  // The other direction: accepted requests that left no counter behind.
  const uncounted = await pool.query(`
    SELECT r.user_id FROM (SELECT user_id, period FROM requests WHERE accepted GROUP BY 1, 2) r
    LEFT JOIN user_usage uu USING (user_id, period) WHERE uu.user_id IS NULL`);
  const uncountedAcc = await pool.query(`
    SELECT r.account_id FROM (SELECT account_id, period FROM requests WHERE accepted GROUP BY 1, 2) r
    LEFT JOIN account_usage au USING (account_id, period) WHERE au.account_id IS NULL`);
  // The daily allowance (extra rule) gets the same guarantees, per UTC day.
  const userDay = await pool.query(`
    SELECT ud.user_id FROM user_daily_usage ud
    LEFT JOIN (SELECT user_id, day, sum(units) AS s FROM requests WHERE accepted GROUP BY 1, 2) r USING (user_id, day)
    WHERE ud.units <> COALESCE(r.s, 0)`);
  const accountDay = await pool.query(`
    SELECT ad.account_id FROM account_daily_usage ad
    LEFT JOIN (SELECT account_id, day, sum(units) AS s FROM requests WHERE accepted GROUP BY 1, 2) r USING (account_id, day)
    WHERE ad.units <> COALESCE(r.s, 0)`);
  const sumsDay = await pool.query(`
    SELECT ad.account_id FROM account_daily_usage ad
    WHERE ad.units <> (SELECT COALESCE(sum(ud.units), 0) FROM user_daily_usage ud JOIN users u ON u.id = ud.user_id
                       WHERE u.account_id = ad.account_id AND ud.day = ad.day)`);
  const overspentDay = await pool.query(`
    SELECT request_id FROM requests WHERE accepted AND (
      ((applied->'user'->>'dailyAllowance') IS NOT NULL
        AND (applied->'user'->>'usedToday')::bigint > (applied->'user'->>'dailyAllowance')::bigint)
      OR ((applied->'account'->>'dailyAllowance') IS NOT NULL
        AND (applied->'account'->>'usedToday')::bigint > (applied->'account'->>'dailyAllowance')::bigint))`);
  const uncountedDay = await pool.query(`
    SELECT r.user_id FROM (SELECT user_id, day FROM requests WHERE accepted GROUP BY 1, 2) r
    LEFT JOIN user_daily_usage ud USING (user_id, day) WHERE ud.user_id IS NULL`);
  return [
    ...user.rows, ...account.rows, ...sums.rows, ...overspent.rows, ...uncounted.rows, ...uncountedAcc.rows,
    ...userDay.rows, ...accountDay.rows, ...sumsDay.rows, ...overspentDay.rows, ...uncountedDay.rows,
  ];
}
