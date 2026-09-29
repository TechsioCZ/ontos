#!/usr/bin/env bash
# Pushes planned stage units in order and keeps every public unit reachable on its Zerops subdomain.
# Provider units come from the topology, so their service ids are looked up by the variable name the
# topology implies (publish-active-application-composition.mts stage-service-id) instead of a hand-kept
# list that silently misses new units.
#
# Environment: UNITS_JSON (JSON array of zerops.yaml setups), ZEROPS_YAML_PATH (the deploying environment's
# zerops.yaml, from `zerops:materialize-environment`), STAGE_VARIABLES_JSON, ZEROPS_PROJECT_ID, GITHUB_SHA,
# and ZEROPS_TOKEN for the subdomain check. Run from the repository root.
set -euo pipefail

: "${ZEROPS_YAML_PATH:?ZEROPS_YAML_PATH (the materialized zerops.yaml) is required}"

while IFS= read -r unit; do
  # The publisher owns the setup-to-service-ID rule; it fails when the stage variable is missing.
  service_id="$(cd app && mise exec -- pnpm --silent active-composition:publish stage-service-id --setup "$unit")"
  if ! zcli push \
    --working-dir . \
    --zerops-yaml-path "$ZEROPS_YAML_PATH" \
    --workspace-state clean \
    --deploy-git-folder \
    --project-id "$ZEROPS_PROJECT_ID" \
    --service-id "$service_id" \
    --setup "$unit" \
    --version-name "$GITHUB_SHA"; then
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
