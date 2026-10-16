// Copies the migration .sql files next to the compiled JavaScript (tsc only emits .js).
const { cpSync } = require('node:fs') as typeof import('node:fs');

cpSync('src/db/sql', 'dist/db/sql', { recursive: true });
