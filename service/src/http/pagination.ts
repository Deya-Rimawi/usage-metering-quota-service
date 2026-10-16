import { invalid } from '../domain/errors';

// Shapes of what Postgres produces for `created_at::text` and a uuid: anything else cannot be ours.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:?\d{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Cursor { t: string; id: string }

/** Opaque to clients: base64url(JSON). Carries the sort key of the last row returned. */
export const encodeCursor = (c: Cursor | null) => (c ? Buffer.from(JSON.stringify(c)).toString('base64url') : null);

export function decodeCursor(s: string | undefined): Cursor | undefined {
  if (!s) return undefined;
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString());
    if (typeof c.t === 'string' && TIMESTAMP.test(c.t) && typeof c.id === 'string' && UUID.test(c.id)) return c;
  } catch { /* fall through */ }
  throw invalid('bad_cursor', 'Invalid pagination cursor');
}
