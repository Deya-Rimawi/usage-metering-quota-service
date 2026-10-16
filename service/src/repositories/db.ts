import type pg from 'pg';

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Db = pg.Pool | pg.PoolClient;

export const UNIQUE_VIOLATION = '23505';
export const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === UNIQUE_VIOLATION;

/** Runs `fn` in a transaction; rolls back on any error. */
export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
