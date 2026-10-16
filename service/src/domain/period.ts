/** Usage is bucketed by UTC calendar month, identified by its first day: '2026-10-01'. */
export type Clock = () => Date;

export const periodOf = (d: Date): string => `${d.toISOString().slice(0, 7)}-01`;

/** '2026-10' (API format) -> '2026-10-01'. Returns null if malformed. */
export function parsePeriod(s: string): string | null {
  const m = /^(19[7-9]\d|[2-9]\d{3})-(0[1-9]|1[0-2])$/.exec(s); // 1970-9999: years Postgres can store as a date
  return m ? `${m[1]}-${m[2]}-01` : null;
}

/** The UTC calendar day a daily allowance is counted in: '2026-10-16'. */
export const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/** '2026-10-01' -> '2026-10' */
export const periodLabel = (p: string): string => p.slice(0, 7);
