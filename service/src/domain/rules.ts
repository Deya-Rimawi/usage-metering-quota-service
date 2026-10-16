/**
 * Pure decision logic: no database, no clock, no I/O.
 * Given the plans' limits and the units already used today and this month, say which rules a request breaks.
 */
export type Level = 'account' | 'user';
export type RuleName = 'max_per_request' | 'daily_allowance' | 'monthly_allowance';

/** `null` = no limit for that rule. */
export interface Limits {
  monthlyAllowance: number | null;
  dailyAllowance: number | null;
  maxPerRequest: number | null;
}

/** One side of the decision: a plan's limits plus what that account/user already consumed (UTC today / UTC month). */
export interface Side {
  limits: Limits;
  used: number;
  usedToday: number;
}

export interface Violation {
  level: Level;
  rule: RuleName;
  limit: number;
  requested: number;
  /** Units still available under that allowance (the two allowance rules; per-request has no running balance). */
  remaining: number | null;
}

/** Units left this month. Never negative: a cut allowance below existing usage shows 0, not a debt. */
export const remainingUnits = ({ limits, used }: Side): number | null =>
  limits.monthlyAllowance === null ? null : Math.max(0, limits.monthlyAllowance - used);

/** Units left today (UTC day), with the same never-negative rule. */
export const remainingToday = ({ limits, usedToday }: Side): number | null =>
  limits.dailyAllowance === null ? null : Math.max(0, limits.dailyAllowance - usedToday);

/**
 * Evaluation order is fixed so the "primary" reason is predictable. Cheap, request-local checks come first;
 * then the balances, shortest time window first, and within each the user before the account:
 *   1. user per-request   2. account per-request
 *   3. user daily         4. account daily
 *   5. user monthly       6. account monthly
 * Every rule must pass. Returns every violated rule, primary first. Empty array = accepted.
 */
const ORDER: ReadonlyArray<readonly [Level, RuleName]> = [
  ['user', 'max_per_request'], ['account', 'max_per_request'],
  ['user', 'daily_allowance'], ['account', 'daily_allowance'],
  ['user', 'monthly_allowance'], ['account', 'monthly_allowance'],
];

export function evaluate(units: number, user: Side, account: Side): Violation[] {
  const violations: Violation[] = [];
  for (const [level, rule] of ORDER) {
    const side = level === 'user' ? user : account;
    const { limits } = side;
    const [limit, used] =
      rule === 'max_per_request' ? [limits.maxPerRequest, 0]
      : rule === 'daily_allowance' ? [limits.dailyAllowance, side.usedToday]
      : [limits.monthlyAllowance, side.used];
    if (limit === null) continue;
    const broken = rule === 'max_per_request' ? units > limit : used + units > limit;
    if (broken) {
      violations.push({ level, rule, limit, requested: units, remaining: rule === 'max_per_request' ? null : Math.max(0, limit - used) });
    }
  }
  return violations;
}

export function describe(v: Violation): string {
  const who = v.level === 'account' ? "The account's" : "The user's";
  switch (v.rule) {
    case 'max_per_request':
      return `${who} plan allows at most ${v.limit} units per request; ${v.requested} requested`;
    case 'daily_allowance':
      return `${who} daily allowance has ${v.remaining} units remaining today; ${v.requested} requested`;
    case 'monthly_allowance':
      return `${who} monthly allowance has ${v.remaining} units remaining; ${v.requested} requested`;
  }
}
