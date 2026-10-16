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

export function makeApp(pool: pg.Pool, clock?: () => Date): FastifyInstance {
  return buildApp({ clock, pool, config: loadConfig({ DATABASE_URL: TEST_URL, ADMIN_TOKEN: ADMIN, LOG_LEVEL: process.env.TEST_LOG ?? "silent" }) });
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

type Client = ReturnType<typeof client>;

export async function newPlan(c: Client, kind: 'account' | 'user', name: string, monthlyAllowance: number | null, maxPerRequest: number | null): Promise<string> {
  return (await c.post('/plans', { kind, name, monthlyAllowance, maxPerRequest })).json().id;
}

export async function newUser(c: Client, userId: string, planId: string) {
  const res = await c.post('/users', { userId, planId });
  if (res.statusCode !== 201) throw new Error(res.body);
}

let seq = 0;
export const consume = async (c: Client, userId: string, units: number, requestId = `r-${++seq}-${Math.random()}`) =>
  (await c.post('/consume', { userId, units, requestId })).json();

/**
 * Invariants I1 + I5 from docs/CONCURRENCY.md, checked straight from the database:
 * every counter equals the sum of accepted units in the request log, and the account total equals the sum of its users.
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
  return [...user.rows, ...account.rows, ...sums.rows];
}
