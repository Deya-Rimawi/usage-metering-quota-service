// Helpers shared by the load scenarios: talk to the service's public API to build test data.
const SERVICE_URL = process.env.SERVICE_URL ?? 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
export { SERVICE_URL };

async function call(method, path, headers, body) {
  const res = await fetch(SERVICE_URL + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/** Runs `fn` over `items` with a bounded number of concurrent calls (seeding thousands of users quickly). */
async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) await fn(items[i++]); }));
}

/**
 * Creates `accounts` accounts, each with `users` users.
 * Limits: null = unlimited. Returns [{ id, key, plan, userPlan, users: ['u0', ...] }].
 */
export async function seed({ accounts, users, accountLimits = {}, userLimits = {} }) {
  const out = [];
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

export const patchPlan = (key, planId, body) => call('PATCH', `/plans/${planId}`, { 'x-api-key': key }, body);
