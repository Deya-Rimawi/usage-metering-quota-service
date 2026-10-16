import { invalid } from '../domain/errors';

export interface Cursor { t: string; id: string }

/** Opaque to clients: base64url(JSON). Carries the sort key of the last row returned. */
export const encodeCursor = (c: Cursor | null) => (c ? Buffer.from(JSON.stringify(c)).toString('base64url') : null);

export function decodeCursor(s: string | undefined): Cursor | undefined {
  if (!s) return undefined;
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString());
    if (typeof c.t === 'string' && typeof c.id === 'string') return c;
  } catch { /* fall through */ }
  throw invalid('bad_cursor', 'Invalid pagination cursor');
}
