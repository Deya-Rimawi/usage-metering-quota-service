// After every run, re-derive the truth from the database and compare it with the counters.
// A throughput number only counts if these invariants hold (see docs/CONCURRENCY.md).
import pg from 'pg';

export interface Verification {
  ok: boolean;
  problems: string[];
  loggedRequests: number;
  loggedAccepted: number;
  unitsUsed: number;
}

export async function verify(
  databaseUrl: string, accountIds: string[],
  { expectAccountUsed, expectAccountUsedToday }: { expectAccountUsed?: number; expectAccountUsedToday?: number } = {},
): Promise<Verification> {
  pg.types.setTypeParser(20, Number);
  const db = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const q = async (sql: string) => (await db.query(sql, [accountIds])).rows;
    const problems: string[] = [];

    const userMismatch = await q(`
      SELECT uu.user_id FROM user_usage uu JOIN users u ON u.id = uu.user_id
      LEFT JOIN (SELECT user_id, period, sum(units) s FROM requests WHERE accepted GROUP BY 1, 2) r USING (user_id, period)
      WHERE u.account_id = ANY($1) AND uu.units <> COALESCE(r.s, 0)`);
    if (userMismatch.length) problems.push(`I1: ${userMismatch.length} user counters differ from the request log`);

    const accMismatch = await q(`
      SELECT au.account_id FROM account_usage au
      LEFT JOIN (SELECT account_id, period, sum(units) s FROM requests WHERE accepted GROUP BY 1, 2) r USING (account_id, period)
      WHERE au.account_id = ANY($1) AND au.units <> COALESCE(r.s, 0)`);
    if (accMismatch.length) problems.push(`I1: ${accMismatch.length} account counters differ from the request log`);

    const sumMismatch = await q(`
      SELECT au.account_id FROM account_usage au
      WHERE au.account_id = ANY($1) AND au.units <> (SELECT COALESCE(sum(uu.units), 0) FROM user_usage uu JOIN users u ON u.id = uu.user_id
                                                     WHERE u.account_id = au.account_id AND uu.period = au.period)`);
    if (sumMismatch.length) problems.push(`I5: ${sumMismatch.length} accounts where account usage != sum of users`);

    // I2 per decision: the balance after every accepted decision fits the allowance that applied to it.
    const overspent = await q(`
      SELECT request_id FROM requests WHERE account_id = ANY($1) AND accepted AND (
        ((applied->'user'->>'monthlyAllowance') IS NOT NULL AND (applied->'user'->>'used')::bigint > (applied->'user'->>'monthlyAllowance')::bigint)
        OR ((applied->'account'->>'monthlyAllowance') IS NOT NULL AND (applied->'account'->>'used')::bigint > (applied->'account'->>'monthlyAllowance')::bigint))`);
    if (overspent.length) problems.push(`I2: ${overspent.length} accepted decisions left a balance above their allowance`);

    // The other direction of I1: accepted requests that left no counter behind.
    const uncounted = await q(`
      SELECT 1 FROM (SELECT account_id, period FROM requests WHERE account_id = ANY($1) AND accepted GROUP BY 1, 2) r
      LEFT JOIN account_usage au USING (account_id, period) WHERE au.account_id IS NULL`);
    if (uncounted.length) problems.push(`I1: ${uncounted.length} account-months have accepted requests but no counter`);

    // The daily allowance gets the same guarantees as the monthly one, per UTC day.
    const userDay = await q(`
      SELECT ud.user_id FROM user_daily_usage ud JOIN users u ON u.id = ud.user_id
      LEFT JOIN (SELECT user_id, day, sum(units) s FROM requests WHERE accepted GROUP BY 1, 2) r USING (user_id, day)
      WHERE u.account_id = ANY($1) AND ud.units <> COALESCE(r.s, 0)`);
    if (userDay.length) problems.push(`I1 (daily): ${userDay.length} user daily counters differ from the request log`);
    const accountDay = await q(`
      SELECT ad.account_id FROM account_daily_usage ad
      LEFT JOIN (SELECT account_id, day, sum(units) s FROM requests WHERE accepted GROUP BY 1, 2) r USING (account_id, day)
      WHERE ad.account_id = ANY($1) AND ad.units <> COALESCE(r.s, 0)`);
    if (accountDay.length) problems.push(`I1 (daily): ${accountDay.length} account daily counters differ from the request log`);
    const sumsDay = await q(`
      SELECT ad.account_id FROM account_daily_usage ad
      WHERE ad.account_id = ANY($1) AND ad.units <> (SELECT COALESCE(sum(ud.units), 0) FROM user_daily_usage ud JOIN users u ON u.id = ud.user_id
                                                     WHERE u.account_id = ad.account_id AND ud.day = ad.day)`);
    if (sumsDay.length) problems.push(`I5 (daily): ${sumsDay.length} account-days where account usage != sum of users`);
    const overspentDay = await q(`
      SELECT request_id FROM requests WHERE account_id = ANY($1) AND accepted AND (
        ((applied->'user'->>'dailyAllowance') IS NOT NULL AND (applied->'user'->>'usedToday')::bigint > (applied->'user'->>'dailyAllowance')::bigint)
        OR ((applied->'account'->>'dailyAllowance') IS NOT NULL AND (applied->'account'->>'usedToday')::bigint > (applied->'account'->>'dailyAllowance')::bigint))`);
    if (overspentDay.length) problems.push(`I2 (daily): ${overspentDay.length} accepted decisions left a balance above their daily allowance`);

    const pending = await q(`SELECT 1 FROM requests WHERE account_id = ANY($1) AND accepted IS NULL`);
    if (pending.length) problems.push(`${pending.length} requests left without a decision`);

    const [{ total, accepted } = { total: 0, accepted: 0 }] = await q(`SELECT count(*)::int total, count(*) FILTER (WHERE accepted)::int accepted FROM requests WHERE account_id = ANY($1)`);
    const [{ used } = { used: 0 }] = await q(`SELECT COALESCE(sum(units), 0) used FROM account_usage WHERE account_id = ANY($1)`);
    if (expectAccountUsed !== undefined && Number(used) !== expectAccountUsed) problems.push(`expected exactly ${expectAccountUsed} units used, found ${used}`);
    const [{ usedDaily } = { usedDaily: 0 }] = await q(`SELECT COALESCE(sum(units), 0) "usedDaily" FROM account_daily_usage WHERE account_id = ANY($1)`);
    if (expectAccountUsedToday !== undefined && Number(usedDaily) !== expectAccountUsedToday) problems.push(`expected exactly ${expectAccountUsedToday} units used on the day, found ${usedDaily}`);
    return { ok: problems.length === 0, problems, loggedRequests: total, loggedAccepted: accepted, unitsUsed: Number(used) };
  } finally {
    await db.end();
  }
}
