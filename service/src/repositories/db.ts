import type pg from 'pg';

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Db = pg.Pool | pg.PoolClient;

export const UNIQUE_VIOLATION = '23505';
export const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === UNIQUE_VIOLATION;

/** Runs `fn` in a transaction; rolls back on any error. */
export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>, begin = 'BEGIN'): Promise<T> {
  const c = await pool.connect();
  let broken = false;
  try {
    await c.query(begin);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => { broken = true; });
    throw e;
  } finally {
    c.release(broken); // true = destroy this connection instead of reusing it
  }
}

/**
 * Runs read-only queries against ONE consistent snapshot, so the pieces of a response (an account total and
 * its users' rows) describe the same instant and agree with each other. Takes no locks.
 */
export const withSnapshot = <T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>) =>
  withTx(pool, fn, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
