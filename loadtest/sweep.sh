#!/usr/bin/env bash
# Sweeps ACCOUNT_CONCURRENCY (the per-account in-process limit) and records spread / hot / noisy-neighbor each time.
# Run from the repo root:  bash loadtest/sweep.sh        (about 8 minutes)  then:  node loadtest/summarize.mjs sweep-c
set -euo pipefail
for c in ${LIMITS:-1 2 4 8}; do
  echo "== ACCOUNT_CONCURRENCY=$c" >&2
  ACCOUNT_CONCURRENCY=$c docker compose up -d --force-recreate service >/dev/null
  until curl -sf localhost:3000/ready >/dev/null; do sleep 1; done
  for s in spread hot noisy-neighbor; do
    docker compose --profile tools run --rm loadtest "$s" --runs 3 --duration 10 --label "sweep-c$c-$s" >/dev/null
  done
done
docker compose up -d --force-recreate service >/dev/null   # back to the default
