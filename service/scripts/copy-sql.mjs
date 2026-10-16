import { cpSync } from 'node:fs';
cpSync('src/db/sql', 'dist/db/sql', { recursive: true });
