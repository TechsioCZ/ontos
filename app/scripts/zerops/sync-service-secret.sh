#!/usr/bin/env bash
# Writes one sensitive Zerops service variable from an environment variable, replacing a different stored value.
# Prints only the key and whether it changed, never the value.
#
#   ZEROPS_TOKEN=… sync-service-secret.sh <service-id> <KEY> <NAME_OF_ENV_VAR_WITH_THE_VALUE>
set -euo pipefail

service_id="${1:?service id is required}"
key="${2:?variable key is required}"
source_variable="${3:?name of the environment variable holding the value is required}"
value="${!source_variable:?$source_variable is empty}"
: "${ZEROPS_TOKEN:?ZEROPS_TOKEN is required}"
api='https://api.app-prg1.zerops.io/api/rest/public'
auth=(-H "Authorization: Bearer $ZEROPS_TOKEN")

existing="$(curl -fsS "${auth[@]}" "$api/service-stack/$service_id/user-data?limit=1000&offset=0" |
  jq -c --arg key "$key" '[.list[] | select(.key == $key)] | first // empty')"
if [[ -n "$existing" ]]; then
  if [[ "$(jq -r '.content' <<<"$existing")" == "$value" ]]; then
    echo "$key is unchanged"
    exit 0
  fi
  curl -fsS -X DELETE "${auth[@]}" "$api/user-data/$(jq -r '.id' <<<"$existing")" >/dev/null
fi
jq -n --arg key "$key" --arg content "$value" '{key: $key, content: $content, sensitive: true}' |
  curl -fsS -X POST "${auth[@]}" -H 'content-type: application/json' "$api/service-stack/$service_id/user-data" -d @- >/dev/null
echo "$key was written"
