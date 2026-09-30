#!/usr/bin/env bash
# Hands a published active Application Composition snapshot to the placed Worker consumers. A Worker has
# no Zerops project variable, and the snapshot outgrows a Worker secret, so every placed Worker reads it
# from key `active` of the composition KV namespace bound as ONTOS_ACTIVE_APPLICATION_COMPOSITION. The
# namespace id is the placement's ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID. Writing the key deploys nothing.
#
# Environment: SNAPSHOT_JSON (the encoded snapshot just published), CLOUDFLARE_ACCOUNT_ID and
# CLOUDFLARE_API_TOKEN. Run from the repository root.
set -euo pipefail

: "${SNAPSHOT_JSON:?SNAPSHOT_JSON (the published snapshot) is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

namespace_id="$(jq -r '.buildEnvironment.ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID // empty' app/topology/cloudflare-placement.json)"
if [[ -z "$namespace_id" ]]; then
  echo "app/topology/cloudflare-placement.json names no ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID; run cloudflare-stage-cutover provision" >&2
  exit 1
fi

printf '%s' "$SNAPSHOT_JSON" | curl --fail-with-body --silent --show-error --request PUT \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header 'Content-Type: text/plain' \
  --data-binary @- \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces/$namespace_id/values/active" >/dev/null
echo "Wrote the active Application Composition to composition KV namespace $namespace_id"
