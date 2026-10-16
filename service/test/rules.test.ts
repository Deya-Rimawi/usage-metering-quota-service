import { describe, expect, it } from 'vitest';
import { evaluate, remainingToday, remainingUnits, type Side } from '../src/domain/rules';
import { dayOf, parsePeriod, periodOf } from '../src/domain/period';

const side = (monthly: number | null, perRequest: number | null, used = 0, daily: number | null = null, usedToday = 0): Side => ({
  limits: { monthlyAllowance: monthly, dailyAllowance: daily, maxPerRequest: perRequest }, used, usedToday,
});
const rules = (units: number, user: Side, account: Side) => evaluate(units, user, account).map((v) => `${v.level}:${v.rule}`);

describe('evaluate', () => {
  it('accepts when every rule passes', () => {
    expect(rules(10, side(1000, 20), side(10_000, 100))).toEqual([]);
  });

  it('brief example: 25 units breaks only the user per-request limit', () => {
    expect(rules(25, side(1000, 20), side(10_000, 100))).toEqual(['user:max_per_request']);
  });

  it('brief example: 10 units with 5 left on the account breaks the account monthly limit', () => {
    expect(rules(10, side(1000, 20), side(10_000, 100, 9995))).toEqual(['account:monthly_allowance']);
  });

  it('boundaries: exactly at the limit is allowed, one over is not', () => {
    expect(rules(20, side(null, 20), side(null, null))).toEqual([]);
    expect(rules(21, side(null, 20), side(null, null))).toEqual(['user:max_per_request']);
    expect(rules(5, side(100, null, 95), side(null, null))).toEqual([]);
    expect(rules(6, side(100, null, 95), side(null, null))).toEqual(['user:monthly_allowance']);
  });

  it('null limits mean unlimited', () => {
    expect(rules(1_000_000_000, side(null, null, 5e11), side(null, null, 5e11))).toEqual([]);
  });

  it('reports every broken rule, primary first, in the documented order', () => {
    const v = rules(500, side(100, 20, 90, 50, 40), side(100, 100, 95, 60, 55));
    expect(v).toEqual([
      'user:max_per_request', 'account:max_per_request',
      'user:daily_allowance', 'account:daily_allowance',
      'user:monthly_allowance', 'account:monthly_allowance',
    ]);
  });

  it('monthly violation carries the remaining balance', () => {
    const [v] = evaluate(10, side(100, null, 95), side(null, null));
    expect(v).toMatchObject({ level: 'user', rule: 'monthly_allowance', limit: 100, requested: 10, remaining: 5 });
  });

  it('allowance reduced below usage: remaining is 0 and everything is rejected', () => {
    const over = side(50, null, 80);
    expect(remainingUnits(over)).toBe(0);
    expect(rules(1, over, side(null, null))).toEqual(['user:monthly_allowance']);
  });
});

describe('daily allowance (the extra rule)', () => {
  it('a request inside every other limit is rejected by the daily allowance alone', () => {
    // user: 1000/month, 100/day, 30 used today; account unlimited. 80 requested: month and per-request fine, day not.
    expect(rules(80, side(1000, null, 30, 100, 30), side(null, null))).toEqual(['user:daily_allowance']);
    expect(rules(80, side(null, null), side(10_000, null, 0, 100, 30))).toEqual(['account:daily_allowance']);
  });

  it('boundaries: exactly the remaining units today is allowed, one more is not', () => {
    expect(rules(70, side(null, null, 0, 100, 30), side(null, null))).toEqual([]);
    expect(rules(71, side(null, null, 0, 100, 30), side(null, null))).toEqual(['user:daily_allowance']);
  });

  it('is checked before the monthly allowance (shorter window first) but after per-request', () => {
    expect(rules(50, side(10, null, 0, 20, 0), side(null, null))).toEqual(['user:daily_allowance', 'user:monthly_allowance']);
    expect(rules(50, side(null, 10, 0, 20, 0), side(null, null))).toEqual(['user:max_per_request', 'user:daily_allowance']);
  });

  it('a daily allowance bigger than the monthly one changes nothing (the monthly rule still binds)', () => {
    expect(rules(60, side(50, null, 0, 1000, 0), side(null, null))).toEqual(['user:monthly_allowance']);
  });

  it('null daily limit means unlimited, and a cut below usage today shows 0 remaining and rejects', () => {
    expect(rules(1_000_000, side(null, null, 0, null, 5e11), side(null, null))).toEqual([]);
    const over = side(null, null, 0, 50, 80);
    expect(remainingToday(over)).toBe(0);
    expect(rules(1, over, side(null, null))).toEqual(['user:daily_allowance']);
  });

  it('the violation reports the balance left today', () => {
    const [v] = evaluate(10, side(null, null, 0, 100, 95), side(null, null));
    expect(v).toMatchObject({ level: 'user', rule: 'daily_allowance', limit: 100, requested: 10, remaining: 5 });
  });
});

describe('period', () => {
  it('buckets by UTC calendar month', () => {
    expect(periodOf(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10-01');
    expect(periodOf(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11-01');
    expect(periodOf(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-01');
    expect(periodOf(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01-01');
  });
  it('buckets daily usage by UTC day', () => {
    expect(dayOf(new Date('2026-10-16T23:59:59.999Z'))).toBe('2026-10-16');
    expect(dayOf(new Date('2026-10-17T00:00:00.000Z'))).toBe('2026-10-17');
    expect(dayOf(new Date('2026-12-31T23:30:00Z'))).toBe('2026-12-31');
  });
  it('parses the API format', () => {
    expect(parsePeriod('2026-10')).toBe('2026-10-01');
    for (const bad of ['2026-13', '2026-1', '26-10', '2026-10-01', '']) expect(parsePeriod(bad)).toBeNull();
  });
});
