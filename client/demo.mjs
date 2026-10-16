// Demo data and the scripted scenario. The scenario uses ONLY Metering.consume for business actions;
// plan changes are configuration calls, so the "client code" is identical before and after them.
import { createAccount } from './metering-client.mjs';

export const DEMO_ACCOUNT_LIMITS = { monthlyAllowance: 100, maxPerRequest: 40 };

export async function waitForService(baseUrl, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(baseUrl + '/ready')).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Metering service not reachable at ${baseUrl}`);
}

/**
 * A fresh account with a deliberately small custom plan so limits are easy to hit:
 *   account "Demo Account": 100 units/month, 40 per request   (custom, editable)
 *   alice: Basic   (500/month, 20 per request)                (predefined)
 *   bob:   Premium (5,000/month, 200 per request)             (predefined)
 */
export async function setupDemo(baseUrl, adminToken) {
  const metering = await createAccount(baseUrl, adminToken, `Demo ${new Date().toISOString()}`);
  const accountPlan = await metering.createPlan({ kind: 'account', name: 'Demo Account', ...DEMO_ACCOUNT_LIMITS });
  await metering.setAccountPlan(accountPlan.id);
  await metering.addUser('alice', 'basic');
  await metering.addUser('bob', 'premium');
  return { metering, accountPlanId: accountPlan.id };
}

/** Runs the story from the brief. Each step says what it expects, so the page (and the e2e test) can check it. */
export async function runScenario({ metering, accountPlanId }) {
  const steps = [];
  const act = async (title, userId, units, expect, requestId) => {
    const decision = await metering.consume(userId, units, requestId);
    const ok = decision.accepted === expect.accepted && (decision.rule ?? null) === (expect.rule ?? null) &&
      (decision.level ?? null) === (expect.level ?? null) && (expect.replayed === undefined || decision.replayed === expect.replayed);
    steps.push({ kind: 'consume', title, userId, units, expect, decision, ok });
    return decision;
  };
  const config = async (title, fn) => { await fn(); steps.push({ kind: 'config', title, ok: true }); };

  const first = await act('alice processes a 10-unit document', 'alice', 10, { accepted: true });
  const tooBig = await act('alice tries 25 units: her Basic plan allows 20 per request', 'alice', 25, { accepted: false, rule: 'max_per_request', level: 'user' });
  await act('bob (Premium) processes 40 units', 'bob', 40, { accepted: true });
  await act('bob processes another 40 units (account total is now 90 of 100)', 'bob', 40, { accepted: true });
  await act('bob asks for 20: his plan has thousands left, but the shared account has only 10', 'bob', 20, { accepted: false, rule: 'monthly_allowance', level: 'account' });

  await config('CONFIGURE: raise the account plan allowance from 100 to 500 (PATCH /plans, no client change)', () =>
    metering.editPlan(accountPlanId, { monthlyAllowance: 500 }));
  await act('the same request for bob (new requestId) is now accepted', 'bob', 20, { accepted: true });

  await config("CONFIGURE: switch alice from Basic to Premium (PUT /users/alice/plan, no client change)", () =>
    metering.setUserPlan('alice', 'premium'));
  await act('alice retries 25 units with a new requestId: now accepted', 'alice', 25, { accepted: true });

  await act("network retry of alice's ORIGINAL rejected request returns the same stored answer", 'alice', 25, { accepted: false, rule: 'max_per_request', level: 'user', replayed: true }, tooBig.requestId);
  await act('network retry of her first accepted request does not count twice', 'alice', 10, { accepted: true, replayed: true }, first.requestId);
  return steps;
}
