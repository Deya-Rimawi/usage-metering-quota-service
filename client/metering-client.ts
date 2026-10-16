// The integration pattern in ~100 lines: a tiny typed wrapper a backend uses to talk to the metering service.
// The API key never leaves this server process, so browsers and end users never see it.
import { randomUUID } from 'node:crypto';

// ---- Shapes of the service's responses (see docs/API.md) ----
export type Rule = 'max_per_request' | 'daily_allowance' | 'monthly_allowance';
export type Level = 'account' | 'user';

export interface SideReport {
  planId: string;
  planName: string;
  monthlyAllowance: number | null;
  maxPerRequest: number | null;
  used: number;
  remaining: number | null;
  /** The daily allowance: the limit, units used on this UTC day, and units left today (null = no daily limit). */
  dailyAllowance: number | null;
  usedToday: number | null;
  remainingToday: number | null;
}

export interface Violation {
  level: Level;
  rule: Rule;
  limit: number;
  requested: number;
  remaining: number | null;
}

export interface Decision {
  requestId: string;
  userId: string;
  units: number;
  period: string;
  accepted: boolean;
  rule: Rule | null;
  level: Level | null;
  message: string;
  violations: Violation[];
  account: SideReport;
  user: SideReport;
  replayed: boolean;
}

export interface Plan {
  id: string;
  kind: 'account' | 'user';
  name: string;
  monthlyAllowance: number | null;
  dailyAllowance: number | null;
  maxPerRequest: number | null;
  predefined: boolean;
}

export interface Usage {
  period: string;
  current: boolean;
  account: SideReport;
  users: Array<SideReport & { userId: string }>;
  nextCursor: string | null;
}

export interface HistoryItem extends Omit<Decision, 'replayed' | 'requestId'> {
  requestId: string;
  createdAt: string;
}

/** A limit to set on a plan; `null` = unlimited, omitted = unchanged. */
export interface PlanPatch {
  name?: string;
  monthlyAllowance?: number | null;
  dailyAllowance?: number | null;
  maxPerRequest?: number | null;
}

export class MeteringError extends Error {
  status: number;
  code: string | undefined;

  constructor(status: number, body: { error?: { message?: string; code?: string } } | undefined) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
  }
}

export class Metering {
  baseUrl: string;
  apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as T;
    if (!res.ok) throw new MeteringError(res.status, json as { error?: { message?: string; code?: string } });
    return json;
  }

  /** Ask before doing the work. Reuse the same requestId when retrying the same action. */
  consume(userId: string, units: number, requestId: string = randomUUID()): Promise<Decision> {
    return this.#call('POST', '/consume', { userId, units, requestId });
  }
  usage(): Promise<Usage> { return this.#call('GET', '/usage'); }
  history(limit = 8): Promise<{ requests: HistoryItem[]; nextCursor: string | null }> { return this.#call('GET', `/requests?limit=${limit}`); }
  plans(): Promise<{ plans: Plan[] }> { return this.#call('GET', '/plans'); }
  setUserPlan(userId: string, planId: string): Promise<unknown> { return this.#call('PUT', `/users/${encodeURIComponent(userId)}/plan`, { planId }); }
  addUser(userId: string, planId: string): Promise<unknown> { return this.#call('POST', '/users', { userId, planId }); }
  createPlan(plan: PlanPatch & { kind: 'account' | 'user'; name: string }): Promise<Plan> { return this.#call('POST', '/plans', plan); }
  editPlan(planId: string, patch: PlanPatch): Promise<Plan> { return this.#call('PATCH', `/plans/${encodeURIComponent(planId)}`, patch); }
  setAccountPlan(planId: string): Promise<unknown> { return this.#call('PUT', '/account/plan', { planId }); }
}

/** Admin-only bootstrap: creates an account and returns a client bound to its new key. */
export async function createAccount(baseUrl: string, adminToken: string, name: string): Promise<Metering> {
  const res = await fetch(baseUrl + '/accounts', {
    method: 'POST',
    headers: { 'x-admin-token': adminToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const json = (await res.json()) as { apiKey?: string; error?: { message?: string; code?: string } };
  if (!res.ok || !json.apiKey) throw new MeteringError(res.status, json);
  return new Metering(baseUrl, json.apiKey);
}
