#!/usr/bin/env bash
# Four runner-local lanes, each owning one whole cluster and one SpiceDB datastore.
# Package processes keep their own working directory and Rstest configuration.
set -euo pipefail

if [[ "${1:-}" == --task ]]; then
  task="${2:?}"
  [[ "${ONTOS_CI_WORKER_SLOT:?}" =~ ^[0-3]$ ]] || exit 2
  export ONTOS_CI_WORKER_SLOT="$((ONTOS_CI_WORKER_SLOT + 1))"
  if [[ "$task" == root:* ]]; then
    exec mise exec -- pnpm exec rstest --project integration --pool.maxWorkers 1 --shard "${task#root:}"
  fi
  exec mise exec -- pnpm --filter "$task" run test:integration --pool.maxWorkers 1
fi

tasks=()
if [[ "${ROOT_SUITE:-}" == true ]]; then
  for shard in 1 2 3 4; do
    tasks+=("root:$shard/4")
  done
fi
read -ra filters <<<"${PACKAGE_FILTERS:-}"
for ((index = 0; index < ${#filters[@]}; index += 2)); do
  [[ "${filters[index]}" == --filter ]] || exit 2
  package="${filters[index + 1]:?}"
  [[ "$package" =~ ^\./(apps|packages|verticals)/[a-z0-9-]+$ ]] || exit 2
  tasks+=("$package")
done
if [[ ${#tasks[@]} -eq 0 ]]; then
  # Affected selection can retain this row solely for the standalone native proof.
  [[ "${NATIVE_PREPROPOSAL:-}" == true ]] || exit 2
  exit 0
fi
printf '%s\0' "${tasks[@]}" |
  xargs -0 --max-procs=4 --max-args=1 --process-slot-var=ONTOS_CI_WORKER_SLOT \
    bash scripts/ci/run-integration-suites.sh --task
