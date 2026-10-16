import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(3000),
  ADMIN_TOKEN: z.string().min(8),
  LOG_LEVEL: z.string().default('info'),
  PG_POOL_MAX: z.coerce.number().int().default(20),
  /** Max concurrent consumes per account per instance (see services/accountGate.ts). */
  ACCOUNT_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  /** Max consumes waiting behind the gate for one account; beyond it the service answers 503 instead of queueing forever. */
  ACCOUNT_QUEUE_MAX: z.coerce.number().int().min(1).default(1000),
  /** Per-IP limit on the admin endpoints (account creation / key recovery) for callers with a VALID admin token. */
  ADMIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(600),
  /** Let anyone create an account without the admin token (self-service signup; the key comes back in the response). */
  OPEN_SIGNUP: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Per-IP limit for everyone WITHOUT a valid admin token on those endpoints: self-service signups and wrong-token guesses. */
  SIGNUP_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(10),
  /** Most self-service accounts that may exist; beyond it signup answers 403 `signup_closed` (admin creation is unaffected). */
  SIGNUP_MAX_ACCOUNTS: z.coerce.number().int().min(1).default(10_000),
  /** Serve Swagger UI and /docs/json. Turn off if the API surface should not be browsable. */
  DOCS_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
});

/** The token docker-compose uses when none is configured. Fine for a demo; the service warns when it sees it. */
export const DEMO_ADMIN_TOKEN = 'dev-admin-token';

export type Config = z.infer<typeof schema>;

/** Fails fast at boot with a readable message if the environment is wrong. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}
