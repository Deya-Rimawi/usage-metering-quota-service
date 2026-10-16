// Writes the generated OpenAPI document to docs/openapi.json (run: npm run openapi).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { createPool } from '../src/db/pool';
import { buildApp } from '../src/http/app';

(async () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://unused/unused', ADMIN_TOKEN: 'unused-token', LOG_LEVEL: 'silent' });
  const pool = createPool(config.DATABASE_URL, 1); // never connects: building the app does no queries
  const app = buildApp({ pool, config });
  await app.ready();
  writeFileSync(join(__dirname, '../../docs/openapi.json'), JSON.stringify(app.swagger(), null, 2) + '\n');
  await app.close();
  await pool.end();
})();
