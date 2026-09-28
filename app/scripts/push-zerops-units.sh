#!/usr/bin/env bash
# Pushes planned stage units in order and keeps every public unit reachable on its Zerops subdomain.
# Provider units come from the topology, so their service ids are looked up by the variable name the
# topology implies instead of a hand-kept list that silently misses new units.
#
# Environment: UNITS_JSON (JSON array of zerops.yaml setups), STAGE_VARIABLES_JSON, ZEROPS_PROJECT_ID,
# GITHUB_SHA, and ZEROPS_TOKEN for the subdomain check. Run from the repository root.
set -euo pipefail

service_id_variable() {
  if [[ "$1" == 'shellsuperapp' ]]; then
    printf 'ZEROPS_SHELL_SERVICE_ID'
  else
    printf 'ZEROPS_%s_SERVICE_ID' "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"
  fi
}

while IFS= read -r unit; do
  environment_key="$(service_id_variable "$unit")"
  service_id="$(jq -r --arg key "$environment_key" '.[$key] // empty' <<<"$STAGE_VARIABLES_JSON")"
  if [[ -z "$service_id" ]]; then
    echo "Missing stage service variable $environment_key for planned unit $unit" >&2
    exit 1
  fi
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
