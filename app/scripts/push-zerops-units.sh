#!/usr/bin/env bash
# Pushes planned stage units in order and keeps every public unit reachable on its Zerops subdomain.
# Provider units come from the topology, so their service ids are looked up by the variable name the
# topology implies (publish-active-application-composition.mts stage-service-id) instead of a hand-kept
# list that silently misses new units.
#
# Environment: UNITS_JSON (JSON array of zerops.yaml setups), STAGE_VARIABLES_JSON, ZEROPS_PROJECT_ID,
# GITHUB_SHA, and ZEROPS_TOKEN for the subdomain check. Run from the repository root.
set -euo pipefail

while IFS= read -r unit; do
  # The publisher owns the setup-to-service-ID rule; it fails when the stage variable is missing.
  service_id="$(cd app && mise exec -- pnpm --silent active-composition:publish stage-service-id --setup "$unit")"
  if ! zcli push \
    --working-dir . \
    --zerops-yaml-path app/zerops.yaml \
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
  # Workers serve no public traffic. Every other unit must answer on its subdomain after each deploy.
  if [[ "$unit" != *-worker ]]; then
    (cd app && mise exec -- pnpm --silent active-composition:publish ensure-public-access --setup "$unit")
  fi
done < <(jq -r '.[]' <<<"$UNITS_JSON")
