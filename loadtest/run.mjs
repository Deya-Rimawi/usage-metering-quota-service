// Usage: node run.mjs <scenario|all> [--duration 15] [--connections 64] [--runs 3] [--label baseline]
// Runs the scenario(s), verifies the database invariants after each run, prints a markdown table and saves JSON.
import autocannon from 'autocannon';
import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { SERVICE_URL } from './lib.mjs';
import { scenarios } from './scenarios.mjs';
import { verify } from './verify.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i === -1 ? dflt : args[i + 1]; };
const which = args[0] && !args[0].startsWith('--') ? args[0] : 'all';
const duration = Number(flag('duration', 15));
const connections = Number(flag('connections', 64));
const runs = Number(flag('runs', 3));
const label = flag('label', 'adhoc');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:metering@localhost:5433/metering';

/** Samples what database sessions are waiting on, ~10x/second: shows WHERE time goes (lock queue vs I/O vs idle in tx). */
function sampleWaits() {
  const db = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  const counts = {};
  let samples = 0;
  const timer = setInterval(async () => {
    try {
      const { rows } = await db.query(`SELECT coalesce(wait_event_type || ':' || wait_event, state) AS w, count(*)::int n
        FROM pg_stat_activity WHERE datname = 'metering' AND pid <> pg_backend_pid() AND state <> 'idle' GROUP BY 1`);
      samples++;
      for (const r of rows) counts[r.w] = (counts[r.w] ?? 0) + r.n;
    } catch { /* ignore */ }
  }, 100);
  return async () => { clearInterval(timer); await db.end().catch(() => {}); return { samples, avgSessions: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, +(v / Math.max(samples, 1)).toFixed(2)])) }; };
}

async function runOnce(name) {
  const s = scenarios[name];
  const prepared = await s.prepare();
  let accepted = 0, rejected = 0, replayed = 0, bad = 0;
  const requests = prepared.requests.map((r) => r.method === 'POST'
    ? { ...r, onResponse(status, body) { if (status !== 200) return void bad++; const j = JSON.parse(body); j.accepted ? accepted++ : rejected++; if (j.replayed) replayed++; } }
    : r);
  prepared.start?.();
  const stopSampling = sampleWaits();
  // A "background" load (the noisy neighbour) runs at the same time; only the main load is reported.
  const bg = prepared.background && autocannon({ url: SERVICE_URL, connections: prepared.background.connections, duration, requests: prepared.background.requests });
  const r = await autocannon({ url: SERVICE_URL, connections: prepared.background ? 16 : connections, duration, requests });
  const bgResult = await bg;
  prepared.stop?.();
  const waits = await stopSampling();
  const allAccounts = [...prepared.accounts, ...(prepared.background?.accounts ?? [])];
  const check = await verify(DATABASE_URL, allAccounts.map((a) => a.id), { expectAccountUsed: prepared.expectAccountUsed });
  if (prepared.expectDuplicates && replayed === 0) check.problems.push('expected replays but saw none');
  return {
    scenario: name, rps: Math.round(r.requests.average), p50: r.latency.p50, p97_5: r.latency.p97_5, p99: r.latency.p99, max: r.latency.max,
    total: r.requests.total, non2xx: r.non2xx, errors: r.errors + r.timeouts, accepted, rejected, replayed, bad,
    backgroundRps: bgResult ? Math.round(bgResult.requests.average) : undefined,
    invariantsOk: check.ok && check.problems.length === 0, problems: check.problems, logged: check.loggedRequests, waits: waits.avgSessions,
  };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const names = which === 'all' ? Object.keys(scenarios) : [which];
const summary = [];
for (const name of names) {
  console.error(`\n== ${name}: ${scenarios[name].about}`);
  const results = [];
  for (let i = 0; i < runs; i++) {
    const r = await runOnce(name);
    console.error(`  run ${i + 1}: ${r.rps} rps${r.backgroundRps ? ` (hot neighbour ${r.backgroundRps} rps)` : ''}  p50 ${r.p50}ms  p99 ${r.p99}ms  non2xx ${r.non2xx}  errors ${r.errors}  invariants ${r.invariantsOk ? 'OK' : 'FAILED ' + r.problems.join('; ')}`);
    results.push(r);
  }
  summary.push({
    scenario: name, runs: results,
    rps: median(results.map((r) => r.rps)), p50: median(results.map((r) => r.p50)), p99: median(results.map((r) => r.p99)),
    allInvariantsOk: results.every((r) => r.invariantsOk), anyErrors: results.some((r) => r.non2xx || r.errors),
  });
}

console.log(`\n| scenario | req/s (median of ${runs}) | p50 ms | p99 ms | errors | invariants |\n|---|---:|---:|---:|---|---|`);
for (const s of summary) console.log(`| ${s.scenario} | ${s.rps.toLocaleString()} | ${s.p50} | ${s.p99} | ${s.anyErrors ? 'YES' : 'none'} | ${s.allInvariantsOk ? 'hold' : '**FAILED**'} |`);
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL(`./results/${label}.json`, import.meta.url), JSON.stringify({ label, duration, connections, runs, when: new Date().toISOString(), summary }, null, 2));
process.exit(summary.every((s) => s.allInvariantsOk) ? 0 : 1);
