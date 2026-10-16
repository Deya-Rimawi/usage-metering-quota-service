// End-to-end: runs the demo scenario against a live metering service (docker compose up -d first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, setupDemo, waitForService } from '../demo.ts';

const url = process.env.SERVICE_URL ?? 'http://localhost:3000';
const admin = process.env.ADMIN_TOKEN ?? 'dev-admin-token';

test('scenario: every step behaves as the brief describes', async () => {
  await waitForService(url, 15);
  const demo = await setupDemo(url, admin);
  const steps = await runScenario(demo);
  for (const s of steps) assert.ok(s.ok, `step failed: ${s.title}\n${JSON.stringify(s.kind === 'consume' ? s.decision : s, null, 2)}`);
  assert.equal(steps.length, 15);
});

test('scenario: final balances add up (account = sum of users)', async () => {
  const demo = await setupDemo(url, admin);
  await runScenario(demo);
  const usage = await demo.metering.usage();
  const sum = usage.users.reduce((n, u) => n + u.used, 0);
  assert.equal(usage.account.used, sum);
  assert.equal(usage.account.used, 10 + 40 + 40 + 20 + 25 + 20); // retries and rejections counted nothing
  assert.equal(usage.account.usedToday, usage.account.used); // everything happened today (UTC)
});
