import { z } from 'zod';

// Caps keep every BIGINT safely inside a JS number (see docs/ASSUMPTIONS.md).
export const MAX_ALLOWANCE = 1_000_000_000_000;
export const MAX_PER_REQUEST = 1_000_000_000;

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

export const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
