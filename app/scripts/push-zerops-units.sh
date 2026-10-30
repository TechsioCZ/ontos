#!/usr/bin/env bash
# Pushes planned stage units in order and keeps every public unit reachable on its Zerops subdomain.
# Provider units come from the topology, so their service ids are looked up by the variable name the
# topology implies (publish-active-application-composition.mts stage-service-id) instead of a hand-kept
# list that silently misses new units.
#
# The Outbox Worker host never builds on Zerops. CI builds it once (scripts/ci/build-outbox-host.sh) and
# this script only deploys that artifact with `zcli service deploy`. The archive holds the runtime at
# app/.zerops/runtime/outbox-worker-host/ (worker.mjs, worker-artifact.json, node/), which is exactly where
# the setup's start command expects it under /var/www.
#
# Environment: UNITS_JSON (JSON array of zerops.yaml setups), ZEROPS_YAML_PATH (the deploying environment's
# zerops.yaml, from `zerops:materialize-environment`), STAGE_VARIABLES_JSON, ZEROPS_PROJECT_ID, GITHUB_SHA,
# and ZEROPS_TOKEN for the subdomain check. The host also needs OUTBOX_HOST_ARTIFACT (its outbox-host.tar.zst)
# and OUTBOX_HOST_DIGEST (the plan's host digest the artifact must carry). Run from the repository root.
set -euo pipefail

: "${ZEROPS_YAML_PATH:?ZEROPS_YAML_PATH (the materialized zerops.yaml) is required}"
# zcli resolves a relative zerops.yaml path against --working-dir, which differs for the host deploy.
if [[ "$ZEROPS_YAML_PATH" != /* ]]; then
  echo "ZEROPS_YAML_PATH must be absolute, not $ZEROPS_YAML_PATH" >&2
  exit 1
fi

readonly host_setup='outbox-worker-host'
readonly host_runtime="app/.zerops/runtime/$host_setup"
host_staging=''
trap '[[ -z "$host_staging" ]] || rm -rf "$host_staging"' EXIT

# Unpacks the prebuilt host and refuses any archive that is not the artifact the plan expects. It runs under
# `if !`, where errexit is off, so every step returns its own failure.
stage_outbox_host() {
  : "${OUTBOX_HOST_ARTIFACT:?OUTBOX_HOST_ARTIFACT (the prebuilt outbox-host.tar.zst) is required for $host_setup}"
  : "${OUTBOX_HOST_DIGEST:?OUTBOX_HOST_DIGEST (the plan host digest) is required for $host_setup}"
  host_staging="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/outbox-host-deploy.XXXXXX")" || return 1
  zstd --quiet --decompress --stdout -- "$OUTBOX_HOST_ARTIFACT" | tar -x -f - -C "$host_staging" || return 1
  local runtime="$host_staging/$host_runtime"
  if [[ ! -f "$runtime/worker.mjs" || ! -x "$runtime/node/bin/node" ]]; then
    echo "The outbox host artifact lacks $host_runtime/worker.mjs or its shipped node/bin/node" >&2
    return 1
  fi
  if ! jq -e --arg digest "$OUTBOX_HOST_DIGEST" --arg setup "$host_setup" \
    '.schemaVersion == 3 and .serviceId == $setup and .artifactDigest == $digest' \
    "$runtime/worker-artifact.json" >/dev/null; then
    echo "The outbox host artifact does not carry host digest $OUTBOX_HOST_DIGEST" >&2
    return 1
  fi
}

deploy_unit() {
  local unit="$1" service_id="$2"
  if [[ "$unit" == "$host_setup" ]]; then
    stage_outbox_host || return 1
    zcli service deploy \
      --working-dir "$host_staging" \
      --path-to-file-or-dir "$host_runtime" \
      --zerops-yaml-path "$ZEROPS_YAML_PATH" \
      --project-id "$ZEROPS_PROJECT_ID" \
      --service-id "$service_id" \
      --setup "$unit" \
      --version-name "$GITHUB_SHA"
    return
  fi
  zcli push \
    --working-dir . \
    --zerops-yaml-path "$ZEROPS_YAML_PATH" \
    --workspace-state clean \
    --deploy-git-folder \
    --project-id "$ZEROPS_PROJECT_ID" \
    --service-id "$service_id" \
    --setup "$unit" \
    --version-name "$GITHUB_SHA"
}

while IFS= read -r unit; do
  # The publisher owns the setup-to-service-ID rule; it fails when the stage variable is missing.
  service_id="$(cd app && mise exec -- pnpm --silent active-composition:publish stage-service-id --setup "$unit")"
  if ! deploy_unit "$unit" "$service_id"; then
    zcli service log \
      --project-id "$ZEROPS_PROJECT_ID" \
      --service-id "$service_id" \
      --limit 200 \
      --minimum-severity DEBUG || true
    echo "Deployment failed for planned unit $unit" >&2
    exit 1
  fi
  # Dedicated workers and the combined Outbox Worker host serve no public traffic and stay internal,
  # as zerops-import.yaml declares. Every other unit must answer on its subdomain after each deploy.
  case "$unit" in
    *-worker | outbox-worker-host) ;;
    *) (cd app && mise exec -- pnpm --silent active-composition:publish ensure-public-access --setup "$unit") ;;
  esac
done < <(jq -r '.[]' <<<"$UNITS_JSON")
