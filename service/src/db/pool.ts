import pg from 'pg';

// BIGINT (OID 20) arrives as string by default. All units/limits are capped far below
// Number.MAX_SAFE_INTEGER (see docs/ASSUMPTIONS.md), so parsing to number is safe.
pg.types.setTypeParser(20, (v) => Number(v));
// DATE (OID 1082) stays a 'YYYY-MM-DD' string: no timezone surprises for usage periods.
pg.types.setTypeParser(1082, (v) => v);

export function createPool(url: string, max: number): pg.Pool {
  return new pg.Pool({ connectionString: url, max });
}

/**
 * Waits until the database answers, retrying with a short backoff. The service can start (or the database
 * can restart) at the same moment, and "not ready yet" must not crash the process.
 * Gives up after `timeoutMs` so a genuinely wrong DATABASE_URL still fails loudly.
 */
export async function waitForDatabase(
  pool: Pick<pg.Pool, 'query'>,
  { timeoutMs = 60_000, onRetry = (_err: unknown, _attempt: number) => {}, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw new Error(`Database not reachable after ${timeoutMs} ms: ${(err as Error).message}`);
      onRetry(err, attempt);
      await sleep(Math.min(250 * attempt, 2000));
    }
  }
}
