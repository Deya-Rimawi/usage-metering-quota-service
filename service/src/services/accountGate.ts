/**
 * Per-account, in-process limit on concurrent consumes: at most `limit` run at once per account in this
 * process; the rest wait here, in memory, in arrival order.
 *
 * WHY: consumption for one account is serialized by a row lock in the database anyway. Without a limit, a
 * hot account's requests each check out a pooled database connection and then sit waiting on that lock, so
 * a handful of busy tenants can use up the whole pool and starve everyone else (measured in docs/PERFORMANCE.md).
 * A limit of 1 is strictest but stops same-account requests from overlapping their round trips; a small
 * number keeps that overlap while still capping how many connections one tenant can hold.
 *
 * This is a performance guard, NOT the correctness mechanism: the database lock stays authoritative, so
 * several service instances (each with its own gate) remain correct.
 */
export type Gate = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/** One gate per service instance (tests build several to simulate several instances). */
export function createGate(limit: number): Gate {
  const accounts = new Map<string, { active: number; waiting: Array<() => void> }>();
  return async (key, fn) => {
    let s = accounts.get(key);
    if (!s) accounts.set(key, (s = { active: 0, waiting: [] }));
    if (s.active < limit) s.active++;
    else await new Promise<void>((resolve) => s.waiting.push(resolve)); // slot is handed over by whoever finishes
    try {
      return await fn();
    } finally {
      const next = s.waiting.shift();
      if (next) next(); // hand the slot straight to the next in line (active count unchanged)
      else if (--s.active === 0) accounts.delete(key); // no leak for idle accounts
    }
  };
}
