// After every run, re-derive the truth from the database and compare it with the counters.
// A throughput number only counts if these invariants hold (see docs/CONCURRENCY.md).
import pg from 'pg';

export async function verify(databaseUrl, accountIds, { expectAccountUsed } = {}) {
  pg.types.setTypeParser(20, Number);
  const db = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const q = async (sql) => (await db.query(sql, [accountIds])).rows;
    const problems = [];

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

    const pending = await q(`SELECT 1 FROM requests WHERE account_id = ANY($1) AND accepted IS NULL`);
    if (pending.length) problems.push(`${pending.length} requests left without a decision`);

    const [{ total, accepted }] = await q(`SELECT count(*)::int total, count(*) FILTER (WHERE accepted)::int accepted FROM requests WHERE account_id = ANY($1)`);
    const [{ used }] = await q(`SELECT COALESCE(sum(units), 0) used FROM account_usage WHERE account_id = ANY($1)`);
    if (expectAccountUsed !== undefined && Number(used) !== expectAccountUsed) problems.push(`expected exactly ${expectAccountUsed} units used, found ${used}`);
    return { ok: problems.length === 0, problems, loggedRequests: total, loggedAccepted: accepted, unitsUsed: Number(used) };
  } finally {
    await db.end();
  }
}
