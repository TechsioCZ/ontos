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

key_url="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces/$namespace_id/values/active"
# Each request is bounded, so a stalled Cloudflare connection fails the job instead of holding it.
bounded_curl=(curl --silent --show-error --connect-timeout 10 --max-time 30 --retry 3 --retry-delay 2 --retry-all-errors)

# The deploy (sync-edge-composition) and the scheduled refresh (refresh-stage-edge) both write the key,
# outside the stage deploy lock. Neither may replace a newer observation with an older one, so the key
# only moves forward in observedAt. Both values are UTC ISO-8601 strings with milliseconds (DateTime.formatIso), one width, which compare
# lexically. A read-then-write window remains; the next publication closes it.
iso_utc='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
observed_at="$(jq -r '.observedAt // empty' <<<"$SNAPSHOT_JSON")"
if [[ ! "$observed_at" =~ $iso_utc ]]; then
  echo "The snapshot to write has no UTC observedAt: '$observed_at'" >&2
  exit 1
fi
current_file="$(mktemp)"
trap 'rm -f "$current_file"' EXIT
status="$("${bounded_curl[@]}" --output "$current_file" --write-out '%{http_code}' \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$key_url")"
case "$status" in
  200)
    current_observed_at="$(jq -r '.observedAt // empty' "$current_file" 2>/dev/null || true)"
    if [[ "$current_observed_at" =~ $iso_utc && "$current_observed_at" > "$observed_at" ]]; then
      echo "Composition KV namespace $namespace_id already holds a newer snapshot ($current_observed_at, not $observed_at); left it"
      exit 0
    fi
    ;;
  404) ;;
  *)
    echo "Reading key active of composition KV namespace $namespace_id returned HTTP $status" >&2
    exit 1
    ;;
esac

printf '%s' "$SNAPSHOT_JSON" | "${bounded_curl[@]}" --fail-with-body --request PUT \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header 'Content-Type: text/plain' \
  --data-binary @- \
  "$key_url" >/dev/null
echo "Wrote the active Application Composition observed at $observed_at to composition KV namespace $namespace_id"
