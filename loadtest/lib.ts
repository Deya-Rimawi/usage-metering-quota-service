// Helpers shared by the load scenarios: talk to the service's public API to build test data.
const SERVICE_URL = process.env.SERVICE_URL ?? 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
export { SERVICE_URL };

type Headers = Record<string, string>;

/** Limits to set on a plan; `null` = unlimited. */
export interface PlanLimits {
  monthlyAllowance?: number | null;
  maxPerRequest?: number | null;
}

/** An account created for a load run, with the pieces the scenarios need. */
export interface SeededAccount {
  id: string;
  key: string;
  planId: string;
  userPlanId: string;
  users: string[];
}

async function call<T = any>(method: string, path: string, headers: Headers, body?: unknown): Promise<T> {
  const res = await fetch(SERVICE_URL + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/** Runs `fn` over `items` with a bounded number of concurrent calls (seeding thousands of users quickly). */
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) await fn(items[i++] as T); }));
}

/**
 * Creates `accounts` accounts, each with `users` users.
 * Limits: null = unlimited. Returns each account's id, API key, plan ids and user ids ('u0', 'u1', ...).
 */
export async function seed(
  { accounts, users, accountLimits = {}, userLimits = {} }: { accounts: number; users: number; accountLimits?: PlanLimits; userLimits?: PlanLimits },
): Promise<SeededAccount[]> {
  const out: SeededAccount[] = [];
  await pool(Array.from({ length: accounts }, (_, i) => i), 8, async (i) => {
    const { account, apiKey } = await call('POST', '/accounts', { 'x-admin-token': ADMIN_TOKEN }, { name: `load-${Date.now()}-${i}` });
    const h = { 'x-api-key': apiKey };
    const plan = await call('POST', '/plans', h, { kind: 'account', name: 'load-account', monthlyAllowance: null, maxPerRequest: null, ...accountLimits });
    await call('PUT', '/account/plan', h, { planId: plan.id });
    const userPlan = await call('POST', '/plans', h, { kind: 'user', name: 'load-user', monthlyAllowance: null, maxPerRequest: null, ...userLimits });
    const ids = Array.from({ length: users }, (_, u) => `u${u}`);
    await pool(ids, 16, (userId) => call('POST', '/users', h, { userId, planId: userPlan.id }));
    out.push({ id: account.id, key: apiKey, planId: plan.id, userPlanId: userPlan.id, users: ids });
  });
  return out;
}

export const patchPlan = (key: string, planId: string, body: PlanLimits) => call('PATCH', `/plans/${planId}`, { 'x-api-key': key }, body);
