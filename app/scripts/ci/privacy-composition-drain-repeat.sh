#!/usr/bin/env bash
# Run from app/ against the CI integration database. Each execution owns a fresh fixture.
set -euo pipefail

count="${1:-16}"
if ! [[ "$count" =~ ^[1-9][0-9]*$ ]]; then
  echo 'Expected a positive repeat count.' >&2
  exit 2
fi

failures=0
for ((iteration = 1; iteration <= count; iteration++)); do
  echo "Privacy composition drain repetition $iteration/$count"
  if ! pnpm --filter ./verticals/privacy exec rstest --project integration \
    --pool.maxWorkers 1 --retry 0 \
    --testNamePattern 'recovers a real committed report|waits for an in-flight matcher' \
    tests/integration/privacy-composition-drain.test.ts; then
    failures=$((failures + 1))
  fi
done

echo "Privacy composition drain: $((count - failures))/$count executions passed; $failures failed."
test "$failures" -eq 0
