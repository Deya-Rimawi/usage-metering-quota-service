import { z } from 'zod';
import { parsePeriod } from '../domain/period';

// Caps keep every BIGINT safely inside a JS number (see docs/ASSUMPTIONS.md).
export const MAX_ALLOWANCE = 1_000_000_000_000;
export const MAX_PER_REQUEST = 1_000_000_000;

/** Text from clients: no control characters (NUL makes Postgres throw) and a bounded length. */
export const text = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001F\u007F]+$/, 'Control characters are not allowed');
export const planIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/, 'Invalid plan id');
export const requestIdSchema = text(200);

export const userIdSchema = z.string().regex(/^[A-Za-z0-9._:@-]{1,200}$/, 'Use 1-200 characters from A-Z a-z 0-9 . _ : @ -');
export const allowanceSchema = z.number().int().min(1).max(MAX_ALLOWANCE).nullable();
export const perRequestSchema = z.number().int().min(1).max(MAX_PER_REQUEST).nullable();

export const planSchema = z.object({
  id: z.string(),
  kind: z.enum(['account', 'user']),
  name: z.string(),
  monthlyAllowance: allowanceSchema,
  maxPerRequest: perRequestSchema,
  predefined: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const accountSchema = z.object({ id: z.string(), name: z.string(), plan: planSchema, createdAt: z.string() });
export const userSchema = z.object({ userId: z.string(), plan: planSchema, createdAt: z.string() });

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(300).optional(),
});

export const violationSchema = z.object({
  level: z.enum(['account', 'user']), rule: z.enum(['max_per_request', 'monthly_allowance']),
  limit: z.number(), requested: z.number(), remaining: z.number().nullable(),
});

export const side = z.object({
  planId: z.string(), planName: z.string(),
  monthlyAllowance: z.number().nullable(), maxPerRequest: z.number().nullable(),
  used: z.number(), remaining: z.number().nullable(),
});

export const consumeResponse = z.object({
  requestId: z.string(), userId: z.string(), units: z.number(), period: z.string(),
  accepted: z.boolean(),
  rule: z.enum(['max_per_request', 'monthly_allowance']).nullable(),
  level: z.enum(['account', 'user']).nullable(),
  message: z.string(),
  violations: z.array(violationSchema),
  account: side, user: side, replayed: z.boolean(),
});

export const periodQuery = z.string().refine((s) => parsePeriod(s) !== null, 'Use YYYY-MM, e.g. 2026-10');

export const usageResponse = z.object({
  period: z.string(), current: z.boolean(), account: side,
  users: z.array(side.extend({ userId: z.string() })), nextCursor: z.string().nullable(),
});

export const userUsageResponse = z.object({
  userId: z.string(), period: z.string(), current: z.boolean(), account: side, user: side,
});

export const historyItem = z.object({
  requestId: z.string(), userId: z.string(), units: z.number(), period: z.string(), accepted: z.boolean(),
  rule: z.enum(['max_per_request', 'monthly_allowance']).nullable(), level: z.enum(['account', 'user']).nullable(),
  message: z.string(), violations: z.array(violationSchema),
  account: side, user: side, createdAt: z.string(),
});
