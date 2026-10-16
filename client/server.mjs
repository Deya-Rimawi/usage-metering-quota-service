// Demo "document processing" backend. Browsers talk to this server; this server talks to the metering
// service with the account API key, which the browser never sees.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { MeteringError } from './metering-client.mjs';
import { runScenario, setupDemo, waitForService } from './demo.mjs';

const SERVICE_URL = process.env.SERVICE_URL ?? 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const PORT = Number(process.env.PORT ?? 8080);

let demo; // { metering, accountPlanId }
const reset = async () => { demo = await setupDemo(SERVICE_URL, ADMIN_TOKEN); };

async function state() {
  const { metering } = demo;
  const [usage, plans, history] = await Promise.all([metering.usage(), metering.plans(), metering.history(8)]);
  return { usage, plans: plans.plans, history: history.requests, accountPlanId: demo.accountPlanId };
}

const routes = {
  'GET /api/state': () => state(),
  'POST /api/reset': async () => { await reset(); return state(); },
  'POST /api/scenario': async () => { await reset(); const steps = await runScenario(demo); return { steps, ...(await state()) }; },
  // The business action (simulated). The ONLY metering call it makes is consume().
  'POST /api/process': async ({ userId, units, requestId }) => {
    const decision = await demo.metering.consume(userId, Number(units), requestId || undefined);
    const result = decision.accepted ? `Processed a ${units}-page document for ${userId}` : null;
    return { decision, result };
  },
  'POST /api/user-plan': async ({ userId, planId }) => { await demo.metering.setUserPlan(userId, planId); return state(); },
  'POST /api/account-limits': async ({ monthlyAllowance, maxPerRequest }) => {
    const toLimit = (v) => (v === '' || v === null ? null : Number(v));
    await demo.metering.editPlan(demo.accountPlanId, { monthlyAllowance: toLimit(monthlyAllowance), maxPerRequest: toLimit(maxPerRequest) });
    return state();
  },
};

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('./public/index.html', import.meta.url)));
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return json(res, 404, { error: 'not found' });
    let body = {};
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString());
    }
    json(res, 200, await handler(body));
  } catch (e) {
    const status = e instanceof MeteringError ? e.status : 500;
    json(res, status, { error: e.message, code: e.code });
  }
}).listen(PORT, async () => {
  console.log(`demo client on :${PORT}, metering service at ${SERVICE_URL}`);
  await waitForService(SERVICE_URL);
  await reset();
  console.log('demo account ready');
});
