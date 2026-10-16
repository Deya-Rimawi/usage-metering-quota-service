/**
 * Pure decision logic: no database, no clock, no I/O.
 * Given the plans' limits and the units already used this month, say which rules a request breaks.
 */
export type Level = 'account' | 'user';
export type RuleName = 'max_per_request' | 'monthly_allowance';

/** `null` = no limit for that rule. */
export interface Limits {
  monthlyAllowance: number | null;
  maxPerRequest: number | null;
}

/** One side of the decision: a plan's limits plus what that account/user already consumed this month. */
export interface Side {
  limits: Limits;
  used: number;
}

export interface Violation {
  level: Level;
  rule: RuleName;
  limit: number;
  requested: number;
  /** Units still available at that level (monthly rule only; per-request has no running balance). */
  remaining: number | null;
}

/** Units left this month. Never negative: a cut allowance below existing usage shows 0, not a debt. */
export const remainingUnits = ({ limits, used }: Side): number | null =>
  limits.monthlyAllowance === null ? null : Math.max(0, limits.monthlyAllowance - used);

/**
 * Evaluation order is fixed so the "primary" reason is predictable:
 *   1. user per-request  2. account per-request  3. user monthly  4. account monthly
 * (cheap, request-local checks first; then balances, narrowest scope first).
 * Returns every violated rule, primary first. Empty array = accepted.
 */
export function evaluate(units: number, user: Side, account: Side): Violation[] {
  const checks: Array<[Level, RuleName, Side]> = [
    ['user', 'max_per_request', user],
    ['account', 'max_per_request', account],
    ['user', 'monthly_allowance', user],
    ['account', 'monthly_allowance', account],
  ];
  const violations: Violation[] = [];
  for (const [level, rule, side] of checks) {
    const limit = rule === 'max_per_request' ? side.limits.maxPerRequest : side.limits.monthlyAllowance;
    if (limit === null) continue;
    const broken = rule === 'max_per_request' ? units > limit : side.used + units > limit;
    if (broken) violations.push({ level, rule, limit, requested: units, remaining: rule === 'monthly_allowance' ? remainingUnits(side) : null });
  }
  return violations;
}

export function describe(v: Violation): string {
  const who = v.level === 'account' ? "The account's" : "The user's";
  return v.rule === 'max_per_request'
    ? `${who} plan allows at most ${v.limit} units per request; ${v.requested} requested`
    : `${who} monthly allowance has ${v.remaining} units remaining; ${v.requested} requested`;
}
