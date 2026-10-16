// The integration pattern in ~50 lines: a tiny wrapper a backend uses to talk to the metering service.
// The API key never leaves this server process, so browsers and end users never see it.
import { randomUUID } from 'node:crypto';

export class MeteringError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
  }
}

export class Metering {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async #call(method, path, body) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new MeteringError(res.status, json);
    return json;
  }

  /** Ask before doing the work. Reuse the same requestId when retrying the same action. */
  consume(userId, units, requestId = randomUUID()) {
    return this.#call('POST', '/consume', { userId, units, requestId });
  }
  usage() { return this.#call('GET', '/usage'); }
  history(limit = 8) { return this.#call('GET', `/requests?limit=${limit}`); }
  plans() { return this.#call('GET', '/plans'); }
  setUserPlan(userId, planId) { return this.#call('PUT', `/users/${encodeURIComponent(userId)}/plan`, { planId }); }
  addUser(userId, planId) { return this.#call('POST', '/users', { userId, planId }); }
  createPlan(plan) { return this.#call('POST', '/plans', plan); }
  editPlan(planId, patch) { return this.#call('PATCH', `/plans/${encodeURIComponent(planId)}`, patch); }
  setAccountPlan(planId) { return this.#call('PUT', '/account/plan', { planId }); }
}

/** Admin-only bootstrap: creates an account and returns a client bound to its new key. */
export async function createAccount(baseUrl, adminToken, name) {
  const res = await fetch(baseUrl + '/accounts', {
    method: 'POST',
    headers: { 'x-admin-token': adminToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const json = await res.json();
  if (!res.ok) throw new MeteringError(res.status, json);
  return new Metering(baseUrl, json.apiKey);
}
