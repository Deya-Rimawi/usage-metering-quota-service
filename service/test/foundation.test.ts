import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { loadConfig } from '../src/config';
import { migrate } from '../src/db/migrate';
import { waitForDatabase } from '../src/db/pool';
import { buildApp } from '../src/http/app';
import { resetData, setupTestDb, TEST_URL } from './helpers';

let pool: pg.Pool;
beforeAll(async () => { pool = await setupTestDb(); });
beforeEach(() => resetData(pool));
afterAll(() => pool.end());

describe('startup', () => {
  it('seeds the four predefined plans with the documented limits', async () => {
    const { rows } = await pool.query('SELECT id, kind, monthly_allowance m, max_per_request r FROM plans WHERE account_id IS NULL ORDER BY id');
    expect(rows).toEqual([
      { id: 'basic', kind: 'user', m: 500, r: 20 },
      { id: 'premium', kind: 'user', m: 5000, r: 200 },
      { id: 'pro', kind: 'account', m: 1_000_000, r: 1000 },
      { id: 'starter', kind: 'account', m: 10_000, r: 100 },
    ]);
  });

  it('migrations are idempotent (second run applies nothing)', async () => {
    expect(await migrate(pool)).toEqual([]);
  });

  it('database refuses a user plan on an account (kind enforced by FK)', async () => {
    await expect(
      pool.query("INSERT INTO accounts (name, api_key_hash, plan_id) VALUES ('x', 'h', 'basic')"),
    ).rejects.toThrow();
  });
});

describe('health', () => {
  const config = loadConfig({ DATABASE_URL: TEST_URL, ADMIN_TOKEN: 'test-admin-token', LOG_LEVEL: 'silent' });
  it('/health and /ready answer', async () => {
    const app = buildApp({ pool, config });
    expect((await app.inject('/health')).statusCode).toBe(200);
    expect((await app.inject('/ready')).statusCode).toBe(200);
  });
});

describe('waitForDatabase', () => {
  const noSleep = { sleep: async () => {} };

  it('retries until the database answers instead of crashing', async () => {
    let calls = 0;
    const flaky = { query: async () => { if (++calls <= 3) throw new Error('the database system is starting up'); return {} as never; } };
    const seen: number[] = [];
    await waitForDatabase(flaky, { ...noSleep, onRetry: (_e, attempt) => seen.push(attempt) });
    expect(calls).toBe(4);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('gives up with a clear message when the database never comes', async () => {
    const down = { query: async () => { throw new Error('connect ECONNREFUSED'); } };
    await expect(waitForDatabase(down, { ...noSleep, timeoutMs: 20 })).rejects.toThrow(/not reachable after 20 ms: connect ECONNREFUSED/);
  });
});
