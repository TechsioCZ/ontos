#!/usr/bin/env bash
# Runner-local lanes, each owning one whole cluster and one SpiceDB datastore.
# Package processes keep their own working directory and Rstest configuration.
set -euo pipefail

if [[ "${1:-}" == --task ]]; then
  task="${2:?}"
  [[ "${ONTOS_CI_WORKER_SLOT:?}" =~ ^[0-3]$ ]] || exit 2
  export ONTOS_CI_WORKER_SLOT="$((ONTOS_CI_WORKER_SLOT + 1))"
  if [[ -n "${ONTOS_CI_ISOLATED_WORKERS:-}" ]]; then
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
    whole:party-worker)
      exec mise exec -- pnpm --filter ./verticals/party-registry run test:integration:worker-cycle --pool.maxWorkers 1 ;;
    whole:migrations)
      exec mise exec -- pnpm exec rstest --project integration \
        scripts/integration/scoped-owner-migrations.test.mts --pool.maxWorkers 1 ;;
    whole:organization)
      exec mise exec -- pnpm exec rstest --project integration \
        scripts/integration/organization-source-customer-owner-conformance.test.mts --pool.maxWorkers 1 ;;
    whole:organization-identity)
      exec mise exec -- pnpm exec rstest --project integration \
        scripts/integration/organization-source-customer-identity-conformance.test.mts --pool.maxWorkers 1 ;;
    whole:customer-readback)
      exec mise exec -- pnpm exec rstest --project integration \
        scripts/integration/symmy-c14-customer-owner-conformance.test.mts --pool.maxWorkers 1 ;;
    whole:customer-roundtrip)
      exec mise exec -- pnpm exec rstest --project integration \
        scripts/integration/symmy-c14-customer-roundtrip-conformance.test.mts --pool.maxWorkers 1 ;;
    whole:pricing-recovery)
      exec mise exec -- pnpm exec rstest --project integration \
        scripts/integration/symmy-c14-pricing-routes-conformance.test.mts --pool.maxWorkers 1 ;;
    whole:pricing-revisions)
      exec mise exec -- pnpm exec rstest --project integration \
        scripts/integration/symmy-c14-pricing-revisions-conformance.test.mts --pool.maxWorkers 1 ;;
    whole:privacy)
      exec mise exec -- pnpm --filter ./verticals/privacy run test:integration \
        tests/integration/privacy-composition-drain.test.ts --pool.maxWorkers 1 \
        -t '^(?!Privacy message-bound completion recovery)' ;;
    whole:privacy-recovery)
      exec mise exec -- pnpm --filter ./verticals/privacy run test:integration \
        tests/integration/privacy-composition-drain.test.ts --pool.maxWorkers 1 \
        -t '^Privacy message-bound completion recovery' ;;
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
      --exclude scripts/integration/organization-source-customer-identity-conformance.test.mts \
      --exclude scripts/integration/symmy-c14-customer-owner-conformance.test.mts \
      --exclude scripts/integration/symmy-c14-customer-roundtrip-conformance.test.mts \
      --exclude scripts/integration/symmy-c14-pricing-routes-conformance.test.mts \
      --exclude scripts/integration/symmy-c14-pricing-revisions-conformance.test.mts \
      --exclude scripts/integration/scoped-owner-migrations.test.mts
  fi
  if [[ "$task" == ./verticals/party-registry#* ]]; then
    exec mise exec -- pnpm --filter ./verticals/party-registry run test:integration:shared --pool.maxWorkers 1 --shard "${task##*#}"
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

# ci-matrices.json lists every row's tasks explicitly; the planner only removes unaffected ones.
tasks=()
task_lines="$(jq -er '.[]' <<<"${INTEGRATION_TASKS:?}")"
while IFS= read -r task; do tasks+=("$task"); done <<<"$task_lines"
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
# These tasks hold tests that start several native owners inside their unchanged 30 s Rstest deadline and
# need most of it even beside a light lane: whole Current Pricing 14-22 s, the eight Market Actions 15-25 s,
# and the governed Party source lifecycle of reviewed-match-reuse 12-23 s, which took 27.6 s and then timed
# out at 30.1 s beside the Privacy whole proof. Give them the runner before admitting independent lanes, so
# no packing can pair them with a heavy proof. Proofs with minutes-long budgets share it with one lane.
exclusive_tasks=(whole:pricing ./verticals/commerce-market-catalog#1/4 ./verticals/party-registry#4/4)
parallel_tasks=()
for task in "${tasks[@]}"; do
  if [[ " ${exclusive_tasks[*]} " == *" $task "* ]]; then
    ONTOS_CI_WORKER_SLOT=0 bash scripts/ci/run-integration-suites.sh --task "$task" || status=$?
  else
    parallel_tasks+=("$task")
  fi
done
if [[ ${#parallel_tasks[@]} -gt 0 ]]; then
  printf '%s\0' "${parallel_tasks[@]}" |
    xargs -0 --max-procs="$lanes" --max-args=1 --process-slot-var=ONTOS_CI_WORKER_SLOT \
      bash scripts/ci/run-integration-suites.sh --task || status=$?
fi
read -ra cpu_after < /proc/stat
total=0
for ((field = 1; field <= 8; field++)); do
  total=$((total + cpu_after[field] - cpu_before[field]))
done
idle=$((cpu_after[4] + cpu_after[5] - cpu_before[4] - cpu_before[5]))
awk -v idle="$idle" -v total="$total" -v wall="$((SECONDS - started))" -v cores="$(nproc)" \
  'BEGIN { printf "Integration CPU: wall=%ss cores=%s idle-core-seconds=%.1f idle-cores-average=%.2f\n", wall, cores, wall*cores*idle/total, cores*idle/total }'
exit "$status"
