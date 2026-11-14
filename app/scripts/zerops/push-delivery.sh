#!/usr/bin/env bash
# Uploads only planned services. Uploads serialize, builds overlap, and readiness remains push-service.sh's gate.
# This is a rolling service deployment, not an atomic cross-service swap.
set -euo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
plan="${1:?plan.json is required}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
services="$(jq -er --arg head "$GITHUB_SHA" '
  if .sourceRevision == $head and (.services | type == "array") and
     (.services | length > 0) and (.services | unique | length) == (.services | length) and
     (.services | all(. == "app" or . == "storefront" or . == "shop" or . == "n1"))
  then .services | join(" ") else error("invalid delivery plan") end' "$plan")"
# Validate every selected target before starting the first remote mutation.
for service in $services; do
  case "$service" in
    app) : "${ZEROPS_APP_SERVICE_ID:?app service id is required}" ;;
    storefront) : "${ZEROPS_STOREFRONT_SERVICE_ID:?storefront service id is required}" ;;
    shop) : "${ZEROPS_SHOP_STOREFRONT_SERVICE_ID:?shop service id is required}" ;;
    n1) : "${ZEROPS_N1_STOREFRONT_SERVICE_ID:?n1 service id is required}" ;;
  esac
done
# The project's public hostnames (the workflow's STAGE_*_URL), so each upload says whether it enters through them.
if [ -z "${PUSH_PROJECT_HOSTS:-}" ]; then
  PUSH_PROJECT_HOSTS=''
  for url in "${STAGE_SHELL_URL:-}" "${STAGE_STOREFRONT_URL:-}" "${STAGE_SHOP_URL:-}" "${STAGE_N1_URL:-}"; do
    host="${url#*://}"
    if [ -n "$url" ]; then PUSH_PROJECT_HOSTS+="${host%%[/:?#]*} "; fi
  done
fi
export PUSH_PROJECT_HOSTS
pids=()
started="$(date +%s)"
for service in $services; do
  case "$service" in
    app) id="${ZEROPS_APP_SERVICE_ID:?app service id is required}"; setup=app ;;
    storefront) id="${ZEROPS_STOREFRONT_SERVICE_ID:?storefront service id is required}"; setup=storefront ;;
    shop) id="${ZEROPS_SHOP_STOREFRONT_SERVICE_ID:?shop service id is required}"; setup=storefront ;;
    n1) id="${ZEROPS_N1_STOREFRONT_SERVICE_ID:?n1 service id is required}"; setup=n1 ;;
    *) echo "unknown delivery service: $service" >&2; exit 1 ;;
  esac
  # Each push's timestamped lines reach the job log as they happen (and its own log file, which gates the next upload).
  if [ "$service" = app ]; then
    PUSH_SERVICE_NAME="$service" bash "$script_dir/push-service.sh" "$id" "$setup" "$GITHUB_SHA" > >(tee "$RUNNER_TEMP/push-$service.log") 2>&1 &
  else
    PUSH_SERVICE_NAME="$service" PUSH_EXCLUDE=app/.zerops-prebuilt.tar.zst bash "$script_dir/push-service.sh" "$id" "$setup" "$GITHUB_SHA" > >(tee "$RUNNER_TEMP/push-$service.log") 2>&1 &
  fi
  pid=$!
  pids+=("$pid")
  until grep -q 'build and deploy process' "$RUNNER_TEMP/push-$service.log" 2>/dev/null || ! kill -0 "$pid" 2>/dev/null; do sleep 1; done
done
status=0
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
# The same lines once more, one collapsed group per service, so each push reads whole after the parallel run.
for service in $services; do
  echo "::group::push $service"
  cat "$RUNNER_TEMP/push-$service.log"
  echo "::endgroup::"
done
echo "Zerops selected build and deploy took $(( $(date +%s) - started ))s" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit "$status"
