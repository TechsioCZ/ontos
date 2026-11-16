#!/usr/bin/env bash
# Two runner-local lanes, each owning one whole cluster and one SpiceDB datastore.
# Package processes keep their own working directory and Rstest configuration.
set -euo pipefail

if [[ "${1:-}" == --task ]]; then
  task="${2:?}"
  [[ "${ONTOS_CI_WORKER_SLOT:?}" =~ ^[0-1]$ ]] || exit 2
  export ONTOS_CI_WORKER_SLOT="$((ONTOS_CI_WORKER_SLOT + 1))"
  if [[ "$task" == root:* ]]; then
    exec mise exec -- pnpm exec rstest --project integration --pool.maxWorkers 1 --shard "${task#root:}" \
      --exclude scripts/integration/organization-source-customer-owner-conformance.test.mts
  fi
  if [[ "$task" == *#* ]]; then
    exec mise exec -- pnpm --filter "${task%#*}" run test:integration --pool.maxWorkers 1 --shard "${task##*#}"
  fi
  if [[ "$task" == ./verticals/pricing ]]; then
    exec mise exec -- pnpm --filter "$task" run test:integration --pool.maxWorkers 1 \
      --exclude tests/integration/market-revision-whole-current-pricing-postgres.test.ts
  fi
  exec mise exec -- pnpm --filter "$task" run test:integration --pool.maxWorkers 1
fi

tasks=()
if [[ "${ROOT_SUITE:-}" == true ]]; then
  tasks+=("root:${ROOT_RSTEST_SHARD:?}")
fi
read -ra filters <<<"${PACKAGE_FILTERS:-}"
for ((index = 0; index < ${#filters[@]}; index += 2)); do
  [[ "${filters[index]}" == --filter ]] || exit 2
  package="${filters[index + 1]:?}"
  [[ "$package" =~ ^\./(apps|packages|verticals)/[a-z0-9-]+$ ]] || exit 2
  case "$package" in
    ./verticals/commerce-customer-context | ./verticals/privacy)
      # File-sized tasks let another lane take over when one long package remains.
      # These owners run Rstest directly; compound scripts such as Party's stay whole.
      for shard in 1 2 3 4; do
        tasks+=("$package#$shard/4")
      done
      ;;
    *) tasks+=("$package") ;;
  esac
done
if [[ ${#tasks[@]} -eq 0 ]]; then
  # Affected selection can retain this row solely for the standalone native proof.
  [[ "${NATIVE_PREPROPOSAL:-}" == true ]] || exit 2
  exit 0
fi
printf '%s\0' "${tasks[@]}" |
  xargs -0 --max-procs=2 --max-args=1 --process-slot-var=ONTOS_CI_WORKER_SLOT \
    bash scripts/ci/run-integration-suites.sh --task
