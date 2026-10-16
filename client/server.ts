// Demo "document processing" backend. Browsers talk to this server; this server talks to the metering
// service with the account API key, which the browser never sees.
import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { MeteringError } from './metering-client.ts';
import { runScenario, setupDemo, waitForService, type Demo } from './demo.ts';

const SERVICE_URL = process.env.SERVICE_URL ?? 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const PORT = Number(process.env.PORT ?? 8080);

let demo!: Demo; // set by reset() before the server accepts traffic

// reset and scenario replace the whole demo account: run them one at a time so two clicks cannot interleave.
let exclusiveChain: Promise<unknown> = Promise.resolve();
const exclusive = <T>(fn: () => Promise<T>): Promise<T> => { const run = exclusiveChain.then(fn); exclusiveChain = run.catch(() => {}); return run; };
const reset = async () => { demo = await setupDemo(SERVICE_URL, ADMIN_TOKEN); };

async function state() {
  const { metering } = demo;
  const [usage, plans, history] = await Promise.all([metering.usage(), metering.plans(), metering.history(8)]);
  return { usage, plans: plans.plans, history: history.requests, accountPlanId: demo.accountPlanId };
}

type Body = Record<string, unknown>;
const routes: Record<string, (body: Body) => Promise<unknown>> = {
  'GET /api/state': () => state(),
  'POST /api/reset': () => exclusive(async () => { await reset(); return state(); }),
  'POST /api/scenario': () => exclusive(async () => { await reset(); const steps = await runScenario(demo); return { steps, ...(await state()) }; }),
  // The business action (simulated). The ONLY metering call it makes is consume().
  'POST /api/process': async ({ userId, units, requestId }) => {
    const decision = await demo.metering.consume(String(userId), Number(units), requestId ? String(requestId) : undefined);
    const result = decision.accepted ? `Processed a ${units}-page document for ${userId}` : null;
    return { decision, result };
  },
  'POST /api/user-plan': async ({ userId, planId }) => { await demo.metering.setUserPlan(String(userId), String(planId)); return state(); },
  'POST /api/account-limits': async ({ monthlyAllowance, dailyAllowance, maxPerRequest }) => {
    const toLimit = (v: unknown) => (v === '' || v === null ? null : Number(v));
    await demo.metering.editPlan(demo.accountPlanId, { monthlyAllowance: toLimit(monthlyAllowance), dailyAllowance: toLimit(dailyAllowance), maxPerRequest: toLimit(maxPerRequest) });
    return state();
  },
};

const MAX_BODY = 10_000; // bytes: the biggest legitimate request here is a few hundred

const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('./public/index.html', import.meta.url)));
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return json(res, 404, { error: 'not found' });
    let body = {};
    if (req.method === 'POST') {
      // These endpoints act with the account's API key, so a web page on another origin must not be able to
      // trigger them: require a JSON content type (forces a CORS preflight, which we never grant) and refuse
      // requests whose Origin is not this server.
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'content-type must be application/json' });
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: 'cross-origin request refused' });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) return json(res, 413, { error: 'request body too large' });
        chunks.push(c);
      }
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString());
    }
    json(res, 200, await handler(body));
  } catch (e) {
    const err = e as Error & { code?: string };
    json(res, e instanceof MeteringError ? e.status : 500, { error: err.message, code: err.code });
  }
}).listen(PORT, async () => {
  console.log(`demo client on :${PORT}, metering service at ${SERVICE_URL}`);
  await waitForService(SERVICE_URL);
  await reset();
  console.log('demo account ready');
});
