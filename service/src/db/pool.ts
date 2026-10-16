import pg from 'pg';

// BIGINT (OID 20) arrives as string by default. All units/limits are capped far below
// Number.MAX_SAFE_INTEGER (see docs/ASSUMPTIONS.md), so parsing to number is safe.
pg.types.setTypeParser(20, (v) => Number(v));
// DATE (OID 1082) stays a 'YYYY-MM-DD' string: no timezone surprises for usage periods.
pg.types.setTypeParser(1082, (v) => v);

export function createPool(url: string, max: number): pg.Pool {
  return new pg.Pool({ connectionString: url, max });
}
