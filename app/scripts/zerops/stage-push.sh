#!/usr/bin/env bash
# The stage delivery's pushes (zerops-stage.yml), one service at a time, from the repository root. Uploads go one after
# another so each keeps the runner's bandwidth and the 25 s truncation rule of push-service.sh stays meaningful; the
# Zerops builds and deploys behind them overlap. This is a rolling service deployment, not an atomic cross-service swap.
#
#   stage-push.sh start <service>       starts the push in the background and returns once its upload is done (the
#                                       Zerops process exists) or the push has ended; a push that ended failed fails
#   stage-push.sh wait <service>...     waits for those pushes to end and prints each one's log; fails if any failed
#   stage-push.sh wait-started          the same for every push this job started (after a failed step)
#   stage-push.sh superseded            fails when the stage branch has moved past this run's commit
#
# Every push first checks that the stage branch still points at this run's commit: a run never deploys an older head.
#
# <service> is app, storefront, shop or n1. The app pushes the checkout itself (push-service.sh stages it). A storefront
# service pushes only app/zerops.yaml and the archive its setup built on this runner, staged by the storefront build
# under $RUNNER_TEMP/storefront-push/<setup>/app/.
set -euo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
state="$RUNNER_TEMP/stage-push"
mkdir -p "$state"

target() {
  case "$1" in
    app) printf '%s app' "${ZEROPS_APP_SERVICE_ID:?app service id is required}" ;;
    storefront) printf '%s storefront' "${ZEROPS_STOREFRONT_SERVICE_ID:?storefront service id is required}" ;;
    shop) printf '%s storefront' "${ZEROPS_SHOP_STOREFRONT_SERVICE_ID:?shop service id is required}" ;;
    n1) printf '%s n1' "${ZEROPS_N1_STOREFRONT_SERVICE_ID:?n1 service id is required}" ;;
    *) echo "unknown delivery service: $1" >&2; return 1 ;;
  esac
}

# The project's public hostnames (the workflow's STAGE_*_URL), so each upload says whether it enters through them.
project_hosts() {
  local url host hosts=''
  for url in "${STAGE_SHELL_URL:-}" "${STAGE_STOREFRONT_URL:-}" "${STAGE_SHOP_URL:-}" "${STAGE_N1_URL:-}"; do
    host="${url#*://}"
    if [ -n "$url" ]; then hosts+="${host%%[/:?#]*} "; fi
  done
  printf '%s' "$hosts"
}

branch_head() { git ls-remote origin refs/heads/demo/sales-crm | cut -f1; }

start() {
  local service="$1" id setup source log status resolved head
  resolved="$(target "$service")"
  read -r id setup <<<"$resolved"
  head="$(branch_head)"
  if [ "$head" != "$GITHUB_SHA" ]; then
    echo "::error::the stage branch points at ${head:-nothing readable}, not this run's $GITHUB_SHA; the $service push does not start"
    return 1
  fi
  source="$PWD"
  if [ "$service" != app ]; then source="$RUNNER_TEMP/storefront-push/$setup"; fi
  log="$state/$service.log"
  status="$state/$service.status"
  if [ -e "$status" ] || [ -e "$log" ]; then
    echo "the $service push already started in this job" >&2
    return 1
  fi
  : >"$log"
  # Detached from this step's output, so the step ends while the push goes on; its status lands in a file.
  (
    cd "$source"
    code=0
    PUSH_PROJECT_HOSTS="${PUSH_PROJECT_HOSTS:-$(project_hosts)}" PUSH_SERVICE_NAME="$service" \
      bash "$script_dir/push-service.sh" "$id" "$setup" "$GITHUB_SHA" || code=$?
    echo "$code" >"$status.next"
    mv "$status.next" "$status"
  ) </dev/null >>"$log" 2>&1 &
  until grep -q 'build and deploy process' "$log" || [ -e "$status" ]; do sleep 1; done
  cat "$log"
  # Once Zerops builds, the push's end is the wait's to report; before that, a push that ended failed.
  if ! grep -q 'build and deploy process' "$log" && [ "$(cat "$status")" != 0 ]; then
    echo "::error::the $service push failed before Zerops started building"
    return 1
  fi
}

wait_for() {
  local service failed=0 started
  started="$(date +%s)"
  for service in "$@"; do
    if [ ! -e "$state/$service.log" ]; then
      echo "::error::no $service push was started in this job"
      failed=1
      continue
    fi
    until [ -e "$state/$service.status" ]; do sleep 2; done
  done
  for service in "$@"; do
    [ -e "$state/$service.status" ] || continue
    echo "::group::push $service"
    cat "$state/$service.log"
    echo '::endgroup::'
    if [ "$(cat "$state/$service.status")" != 0 ]; then
      echo "::error::the $service push failed"
      failed=1
    fi
  done
  echo "waited $(($(date +%s) - started))s for the Zerops builds and deploys of: $*" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  return "$failed"
}

# A newer push to the stage branch replaces this run's release: the run that delivers it redeploys every service this
# run changed (its plan reads this run's plan artifact), and verifies stage. Ending here, after this run's own pushes
# have finished on Zerops, lets that run start without overlapping a Zerops process of this one.
superseded() {
  local head
  # Unreadable is not superseded: the run goes on to verify.
  head="$(branch_head)" || head=''
  if [ -n "$head" ] && [ "$head" != "$GITHUB_SHA" ]; then
    echo "::error::the stage branch moved on to $head; the run that delivers it verifies stage"
    return 1
  fi
}

case "${1:-}" in
  start) [ "$#" -eq 2 ] || { echo 'usage: stage-push.sh start <service>' >&2; exit 2; }; start "$2" ;;
  wait) [ "$#" -ge 2 ] || { echo 'usage: stage-push.sh wait <service>...' >&2; exit 2; }; shift; wait_for "$@" ;;
  wait-started)
    mapfile -t started < <(find "$state" -maxdepth 1 -name '*.log' -exec basename {} .log \; | LC_ALL=C sort)
    if [ "${#started[@]}" -eq 0 ]; then echo 'no push was started in this job'; exit 0; fi
    wait_for "${started[@]}"
    ;;
  superseded) superseded ;;
  *) echo 'usage: stage-push.sh start|wait|wait-started|superseded …' >&2; exit 2 ;;
esac
