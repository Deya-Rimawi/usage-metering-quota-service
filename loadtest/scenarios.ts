// Each scenario: how to seed data, what requests to fire, and what to check afterwards.
// Units are 1 unless stated. `pick(n)` is a cheap random index.
import type autocannon from 'autocannon';
import { patchPlan, seed, type SeededAccount } from './lib.ts';

type LoadRequest = autocannon.Request;

/** What a scenario hands to the runner. */
export interface Prepared {
  accounts: SeededAccount[];               // verified afterwards (and reported)
  requests: LoadRequest[];                 // what autocannon fires
  expectAccountUsed?: number;              // exact monthly total the accepted usage must reach
  expectAccountUsedToday?: number;         // exact daily total the accepted usage must reach
  expectDuplicates?: boolean;              // the run must contain replayed requests
  background?: { accounts: SeededAccount[]; requests: LoadRequest[]; connections: number }; // a noisy neighbour
  start?: () => void;                      // side activity during the run (e.g. plan edits)
  stop?: () => void;
}

export interface Scenario {
  about: string;
  prepare: () => Promise<Prepared>;
}

const pick = (n: number) => Math.floor(Math.random() * n);
const consumeBody = (user: string, units: number, requestId: string) => JSON.stringify({ userId: user, units, requestId });

/** Builds an autocannon request that consumes for a random account/user. `idFor(n)` maps the call counter to a requestId. */
function consumeRequest(
  accounts: SeededAccount[],
  { units = 1, idFor, weight = 1 }: { units?: number; idFor?: (run: string, n: number) => string; weight?: number } = {},
): LoadRequest[] {
  let n = 0;
  const run = Math.random().toString(36).slice(2, 8);
  return Array.from({ length: weight }, () => ({
    method: 'POST',
    path: '/consume',
    headers: { 'content-type': 'application/json' },
    setupRequest(req: LoadRequest) {
      const a = accounts[pick(accounts.length)]!;
      const id = idFor ? idFor(run, n++) : `${run}-${n++}`;
      return { ...req, headers: { ...req.headers, 'x-api-key': a.key }, body: consumeBody(a.users[pick(a.users.length)]!, units, id) };
    },
  }));
}

export const scenarios: Record<string, Scenario> = {
  spread: {
    about: '50 accounts x 20 users, nothing ever rejected. Measures raw throughput when accounts do not contend.',
    async prepare() {
      const accounts = await seed({ accounts: 50, users: 20 });
      return { accounts, requests: consumeRequest(accounts) };
    },
  },
  hot: {
    about: '1 account, 200 users, nothing rejected. Worst case: every request contends for the same account counter.',
    async prepare() {
      const accounts = await seed({ accounts: 1, users: 200 });
      return { accounts, requests: consumeRequest(accounts) };
    },
  },
  'hot-limited': {
    about: '1 account with a 5,000-unit allowance and 5-unit requests: ~1,000 accepted, everything after that rejected. Accepted usage must equal the allowance exactly.',
    async prepare() {
      const accounts = await seed({ accounts: 1, users: 200, accountLimits: { monthlyAllowance: 5_000 } });
      return { accounts, requests: consumeRequest(accounts, { units: 5 }), expectAccountUsed: 5_000 };
    },
  },
  'daily-limited': {
    about: '1 account with a 5,000-unit DAILY allowance (monthly unlimited) and 5-unit requests: ~1,000 accepted, everything after that rejected by the daily rule. Accepted usage must equal the daily allowance exactly.',
    async prepare() {
      const accounts = await seed({ accounts: 1, users: 200, accountLimits: { dailyAllowance: 5_000 } });
      return { accounts, requests: consumeRequest(accounts, { units: 5 }), expectAccountUsedToday: 5_000 };
    },
  },
  'retry-storm': {
    about: '10 accounts x 20 users; every requestId is sent twice, nearly simultaneously. Each id must count once.',
    async prepare() {
      const accounts = await seed({ accounts: 10, users: 20 });
      // Two consecutive calls share an id but pick random users, so a repeat may hit a different user: ids are
      // therefore reused only with the same (account, user, units) by deriving the target from the id itself.
      const run = Math.random().toString(36).slice(2, 8);
      let n = 0;
      const requests: LoadRequest[] = [{
        method: 'POST', path: '/consume', headers: { 'content-type': 'application/json' },
        setupRequest(req: LoadRequest) {
          const k = Math.floor(n++ / 2); // calls 2k and 2k+1 are the same logical request
          const a = accounts[k % accounts.length]!;
          const user = a.users[(k * 7) % a.users.length]!;
          return { ...req, headers: { ...req.headers, 'x-api-key': a.key }, body: consumeBody(user, 1, `${run}-${k}`) };
        },
      }];
      return { accounts, requests, expectDuplicates: true };
    },
  },
  'noisy-neighbor': {
    about: 'Quiet tenants (reported) share the service with one hot account hammering it with 48 connections. Does the hot tenant slow everyone else?',
    async prepare() {
      const quiet = await seed({ accounts: 20, users: 10 });
      const hot = (await seed({ accounts: 1, users: 200 }))[0]!;
      return {
        accounts: quiet, // only the quiet tenants' numbers are reported
        requests: consumeRequest(quiet),
        background: { accounts: [hot], requests: consumeRequest([hot]), connections: 48 },
      };
    },
  },
  'plan-edits': {
    about: '1 account, 50 users; the user plan is edited every 50 ms during the run. Counters must stay consistent.',
    async prepare() {
      const accounts = await seed({ accounts: 1, users: 50, userLimits: { monthlyAllowance: 1_000_000 } });
      const a = accounts[0]!;
      let timer: ReturnType<typeof setInterval>;
      return {
        accounts,
        requests: consumeRequest(accounts),
        start() { timer = setInterval(() => patchPlan(a.key, a.userPlanId, { monthlyAllowance: 1000 + pick(2_000_000) }).catch(() => {}), 50); },
        stop() { clearInterval(timer); },
      };
    },
  },
  'mixed-reads': {
    about: '1 hot account: 70% consume, 10% each of /usage, /requests, /users/{id}/limits. Reads must not stall writes.',
    async prepare() {
      const accounts = await seed({ accounts: 1, users: 100 });
      const a = accounts[0]!;
      const get = (path: string): LoadRequest => ({ method: 'GET', path, headers: { 'x-api-key': a.key } });
      const requests: LoadRequest[] = [
        ...consumeRequest(accounts, { weight: 7 }),
        get('/usage?limit=20'),
        get('/requests?limit=20'),
        get('/users/u1/limits'),
      ];
      return { accounts, requests };
    },
  },
};
