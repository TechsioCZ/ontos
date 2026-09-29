#!/usr/bin/env bash
# Hands a published active Application Composition snapshot to the placed Worker consumers. A Worker has
# no Zerops project variable, so it reads ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON from the
# Worker secret of that name. Putting a secret deploys the Worker's current version with the new value.
#
# Environment: EDGE_CONSUMERS_JSON (JSON array of {packageName, workerName}, from
# `active-composition:publish edge-consumers`), SNAPSHOT_JSON (the encoded snapshot just published),
# CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. Run from the repository root.
set -euo pipefail

: "${SNAPSHOT_JSON:?SNAPSHOT_JSON (the published snapshot) is required}"
readonly secret_name='ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON'

cd app
while IFS=$'\t' read -r package worker; do
  printf '%s' "$SNAPSHOT_JSON" | mise exec -- pnpm --filter "$package" exec wrangler secret put "$secret_name" --name "$worker"
  echo "Handed the active Application Composition to $worker"
done < <(jq -r '.[] | [.packageName, .workerName] | @tsv' <<<"$EDGE_CONSUMERS_JSON")
