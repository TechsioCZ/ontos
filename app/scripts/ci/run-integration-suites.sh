#!/usr/bin/env bash
# Runner-local lanes, each owning one whole cluster and one SpiceDB datastore.
# Package processes keep their own working directory and Rstest configuration.
set -euo pipefail

if [[ "${1:-}" == --task ]]; then
  task="${2:?}"
  [[ "${ONTOS_CI_WORKER_SLOT:?}" =~ ^[0-3]$ ]] || exit 2
  export ONTOS_CI_WORKER_SLOT="$((ONTOS_CI_WORKER_SLOT + 1))"
  if [[ "${ONTOS_CI_ISOLATED_WORKERS:-}" == 4 ]]; then
    bash scripts/ci/reset-integration-database.sh "$ONTOS_CI_WORKER_SLOT"
  fi
  started=$SECONDS
  echo "Suite start: slot=$ONTOS_CI_WORKER_SLOT task=$task"
  status=0
  TIMEFORMAT="Suite CPU: task=$task user=%3Us system=%3Ss"
  time bash "${BASH_SOURCE[0]}" --execute "$task" || status=$?
  echo "Suite wall time: $((SECONDS - started))s slot=$ONTOS_CI_WORKER_SLOT task=$task status=$status"
  exit "$status"
fi

if [[ "${1:-}" == --execute ]]; then
  task="${2:?}"
  case "$task" in
    whole:migrations)
      exec mise exec -- pnpm exec rstest --project integration \
        scripts/integration/scoped-owner-migrations.test.mts --pool.maxWorkers 1 ;;
    whole:organization)
      exec mise exec -- pnpm exec rstest --project integration \
        scripts/integration/organization-source-customer-owner-conformance.test.mts --pool.maxWorkers 1 ;;
    whole:privacy)
      exec mise exec -- pnpm --filter ./verticals/privacy run test:integration \
        tests/integration/privacy-composition-drain.test.ts --pool.maxWorkers 1 ;;
    whole:pricing)
      exec mise exec -- pnpm --filter ./verticals/pricing run test:integration \
        tests/integration/market-revision-whole-current-pricing-postgres.test.ts --pool.maxWorkers 1 ;;
    whole:preproposal-basis)
      exec timeout --kill-after=3s 20m mise exec -- pnpm --filter @app/commerce-customer-context run test:integration:native-preproposal -t 'produces an exact preproposal basis' ;;
    whole:preproposal-approval)
      exec timeout --kill-after=3s 20m mise exec -- pnpm --filter @app/commerce-customer-context run test:integration:native-preproposal -t 'submits and approves' ;;
  esac
  if [[ "$task" == root:* ]]; then
    exec mise exec -- pnpm exec rstest --project integration --pool.maxWorkers 1 --shard "${task#root:}" \
      --exclude scripts/integration/organization-source-customer-owner-conformance.test.mts \
      --exclude scripts/integration/scoped-owner-migrations.test.mts
  fi
  if [[ "$task" == *#* ]]; then
    if [[ "${task%#*}" == ./verticals/privacy ]]; then
      exec mise exec -- pnpm --filter ./verticals/privacy run test:integration --pool.maxWorkers 1 \
        --shard "${task##*#}" --exclude tests/integration/privacy-composition-drain.test.ts
    fi
    if [[ "${task%#*}" == ./verticals/pricing ]]; then
      exec mise exec -- pnpm --filter ./verticals/pricing run test:integration --pool.maxWorkers 1 \
        --shard "${task##*#}" --exclude tests/integration/market-revision-whole-current-pricing-postgres.test.ts
    fi
    exec mise exec -- pnpm --filter "${task%#*}" run test:integration --pool.maxWorkers 1 --shard "${task##*#}"
  fi
  if [[ "$task" == ./verticals/pricing ]]; then
    exec mise exec -- pnpm --filter "$task" run test:integration --pool.maxWorkers 1 \
      --exclude tests/integration/market-revision-whole-current-pricing-postgres.test.ts
  fi
  exec mise exec -- pnpm --filter "$task" run test:integration --pool.maxWorkers 1
fi

tasks=()
if [[ "${NATIVE_PREPROPOSAL:-}" == true ]]; then
  case "${NATIVE_PREPROPOSAL_CASE:-both}" in
    basis) tasks+=("whole:preproposal-basis") ;;
    approval) tasks+=("whole:preproposal-approval") ;;
    both) tasks+=("whole:preproposal-basis" "whole:preproposal-approval") ;;
    *) exit 2 ;;
  esac
fi
if [[ -n "${WHOLE_OWNER_PROOFS:-}" ]]; then
  read -ra proofs <<<"$WHOLE_OWNER_PROOFS"
  for proof in "${proofs[@]}"; do
    [[ "$proof" =~ ^(organization|privacy|pricing)$ ]] || exit 2
    tasks+=("whole:$proof")
  done
fi
if [[ "${ROOT_SUITE:-}" == true ]]; then
  IFS=/ read -r row rows <<<"${ROOT_RSTEST_SHARD:?}"
  [[ "$row" =~ ^[1-9][0-9]*$ && "$rows" =~ ^[1-9][0-9]*$ && "$row" -le "$rows" ]] || exit 2
  files="$(find scripts/integration -type f -name '*.test.mts' \
    ! -path scripts/integration/organization-source-customer-owner-conformance.test.mts \
    ! -path scripts/integration/scoped-owner-migrations.test.mts | wc -l)"
  for ((lane = 0; lane < 4; lane++)); do
    shard=$((row + lane * rows))
    # Rstest assigns one file per shard when shards outnumber files, then exits
    # nonzero for the empty tail. Do not schedule nonexistent files.
    if [[ "$shard" -le "$files" ]]; then
      tasks+=("root:$shard/$((rows * 4))")
    fi
  done
fi
read -ra filters <<<"${PACKAGE_FILTERS:-}"
for ((index = 0; index < ${#filters[@]}; index += 2)); do
  [[ "${filters[index]}" == --filter ]] || exit 2
  package="${filters[index + 1]:?}"
  [[ "$package" =~ ^\./(apps|packages|verticals)/[a-z0-9-]+$ ]] || exit 2
  case "$package" in
    ./verticals/party-registry | ./verticals/promotion) tasks+=("$package") ;;
    *)
      # File-sized tasks let another lane take over when one long package remains.
      # These owners run Rstest directly; compound scripts such as Party's stay whole.
      files="$(find "$package/tests/integration" -name '*.test.ts' -type f | wc -l)"
      [[ "$files" -gt 0 ]] || exit 2
      shards=4
      [[ "$files" -ge "$shards" ]] || shards="$files"
      first=1
      stride=1
      # Native fixture cases dominate these owners. Partition
      # its files across two rows, with disjoint Rstest shards, not duplicate suites.
      if [[ "$package" =~ ^(\./verticals/(commerce-customer-context|privacy)|\./apps/shell-super-app)$ && -n "${PACKAGE_PARTITION:-}" ]]; then
        IFS=/ read -r first stride <<<"$PACKAGE_PARTITION"
        [[ "$first" =~ ^[1-9][0-9]*$ && "$stride" =~ ^[1-9][0-9]*$ && "$first" -le "$stride" ]] || exit 2
        shards=$((shards * stride))
      fi
      for ((shard = first; shard <= shards; shard += stride)); do
        tasks+=("$package#$shard/$shards")
      done
      ;;
  esac
done
if [[ ${#tasks[@]} -eq 0 ]]; then
  exit 2
fi
if [[ "${1:-}" == --list ]]; then
  printf '%s\0' "${tasks[@]}"
  exit 0
fi
# /proc/stat includes PostgreSQL, SpiceDB and all native child processes, unlike time(1).
# Idle core-seconds distinguishes blocked lanes from CPU saturation in the next CI run.
read -ra cpu_before < /proc/stat
lanes="${INTEGRATION_LANES:-4}"
[[ "$lanes" == 2 || "$lanes" == 4 ]] || exit 2
started=$SECONDS
status=0
printf '%s\0' "${tasks[@]}" |
  xargs -0 --max-procs="$lanes" --max-args=1 --process-slot-var=ONTOS_CI_WORKER_SLOT \
    bash scripts/ci/run-integration-suites.sh --task || status=$?
read -ra cpu_after < /proc/stat
total=0
for ((field = 1; field <= 8; field++)); do
  total=$((total + cpu_after[field] - cpu_before[field]))
done
idle=$((cpu_after[4] + cpu_after[5] - cpu_before[4] - cpu_before[5]))
awk -v idle="$idle" -v total="$total" -v wall="$((SECONDS - started))" -v cores="$(nproc)" \
  'BEGIN { printf "Integration CPU: wall=%ss cores=%s idle-core-seconds=%.1f idle-cores-average=%.2f\n", wall, cores, wall*cores*idle/total, cores*idle/total }'
exit "$status"
