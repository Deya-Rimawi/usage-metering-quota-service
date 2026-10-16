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
