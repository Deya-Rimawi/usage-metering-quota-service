import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(3000),
  ADMIN_TOKEN: z.string().min(8),
  LOG_LEVEL: z.string().default('info'),
  PG_POOL_MAX: z.coerce.number().int().default(20),
  /** Max concurrent consumes per account per instance (see services/accountGate.ts). */
  ACCOUNT_CONCURRENCY: z.coerce.number().int().min(1).default(1),
});

export type Config = z.infer<typeof schema>;

/** Fails fast at boot with a readable message if the environment is wrong. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}
