/** Usage is bucketed by UTC calendar month, identified by its first day: '2026-10-01'. */
export type Clock = () => Date;

export const periodOf = (d: Date): string => `${d.toISOString().slice(0, 7)}-01`;

/** '2026-10' (API format) -> '2026-10-01'. Returns null if malformed. */
export function parsePeriod(s: string): string | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(s);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

/** '2026-10-01' -> '2026-10' */
export const periodLabel = (p: string): string => p.slice(0, 7);
