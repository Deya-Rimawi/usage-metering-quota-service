// Prints a markdown table of every results/<prefix>*.json:  node summarize.mjs sweep-c
import { readdirSync, readFileSync } from 'node:fs';
const prefix = process.argv[2] ?? '';
const dir = new URL('./results/', import.meta.url);
console.log('| run | scenario | req/s | p50 ms | p99 ms | invariants |\n|---|---|---:|---:|---:|---|');
for (const f of readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort()) {
  for (const s of JSON.parse(readFileSync(new URL(f, dir))).summary) {
    console.log(`| ${f.replace('.json', '')} | ${s.scenario} | ${s.rps.toLocaleString()} | ${s.p50} | ${s.p99} | ${s.allInvariantsOk ? 'hold' : 'FAILED'} |`);
  }
}
