#!/usr/bin/env bash
# Writes the stage credentials that cross services: the owner secret bundle, SpiceDB's key and datastore password,
# the migrator's identity passwords, and the two storefront keys. Every value is a GitHub secret of the stage-edge
# environment. sync-service-secret.sh rewrites a Zerops variable only when it differs and prints only its key.
#
# The migrator's bootstrap authenticates each identity login with its URL before it sets any role password, so a
# rotated password must already be set in PostgreSQL when the app starts. This script aligns those roles from the
# Zerops values with the admin URL, then restarts what changed (or what FORCE_RESTART names) and waits for the app.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
api='https://api.app-prg1.zerops.io/api/rest/public'
declare -A changed=()

# <service id> <KEY> <name of the env var holding the value> <service whose restart applies it>
sync() {
  local output
  output="$(bash "$script_dir/sync-service-secret.sh" "$1" "$2" "$3")"
  echo "$output"
  if [[ "$output" == *' was written' ]]; then
    changed["$4"]=1
  fi
}

# The value Zerops currently stores for one service variable, read the same way sync-service-secret.sh reads it.
stored_value() {
  curl -fsS -H "Authorization: Bearer $ZEROPS_TOKEN" "$api/service-stack/$1/user-data?limit=1000&offset=0" |
    jq -r --arg key "$2" '[.list[] | select(.key == $key)] | first | .content // empty'
}

# One ALTER ROLE statement for an identity login. Values are hex, so the quoted literal needs no escaping.
align_role() { # <role> <service id> <KEY>
  local value
  value="$(stored_value "$2" "$3")"
  if [[ -z "$value" || ! "$value" =~ ^[0-9a-f]+$ ]]; then
    echo "$3 is missing or not hex in Zerops" >&2
    exit 1
  fi
  echo "::add-mask::$value"
  printf "ALTER ROLE %s PASSWORD '%s';\n" "$1" "$value"
}

sync "$ZEROPS_APP_SERVICE_ID" ONTOS_OWNER_SECRETS_JSON DEMO_IMMUTABLE_RELEASE_SECRETS app
sync "$ZEROPS_SPICEDB_SERVICE_ID" SPICEDB_GRPC_PRESHARED_KEY ROTATED_SPICEDB_PRESHARED_KEY spicedb
sync "$ZEROPS_SPICEDB_SERVICE_ID" SPICEDB_DATABASE_PASSWORD ROTATED_SPICEDB_DATABASE_PASSWORD spicedb
sync "$ZEROPS_MIGRATOR_SERVICE_ID" PARTY_REGISTRY_DB_PASSWORD ROTATED_PARTY_REGISTRY_DB_PASSWORD app
sync "$ZEROPS_MIGRATOR_SERVICE_ID" PARTY_REGISTRY_WORKER_DB_PASSWORD ROTATED_PARTY_REGISTRY_WORKER_DB_PASSWORD app
sync "$ZEROPS_MIGRATOR_SERVICE_ID" SHELL_GATEWAY_ISSUER_DB_PASSWORD ROTATED_SHELL_GATEWAY_ISSUER_DB_PASSWORD app
sync "$ZEROPS_STOREFRONT_SERVICE_ID" ONTOS_AKROS_STOREFRONT_API_KEY ROTATED_AKROS_STOREFRONT_API_KEY storefront
sync "$ZEROPS_SHOP_STOREFRONT_SERVICE_ID" ONTOS_AKROS_STOREFRONT_API_KEY ROTATED_SHOP_AKROS_STOREFRONT_API_KEY shop

if [[ -n "${changed[spicedb]:-}" ]]; then
  changed[app]=1
fi
for name in $FORCE_RESTART; do
  changed["$name"]=1
done

# Align the database roles with the stored values on every run, so a role never lags its Zerops secret.
if ! command -v psql >/dev/null; then
  sudo apt-get update -qq >/dev/null && sudo apt-get install -y -qq postgresql-client >/dev/null
fi
{
  align_role spicedb "$ZEROPS_SPICEDB_SERVICE_ID" SPICEDB_DATABASE_PASSWORD
  align_role party_registry_runtime "$ZEROPS_MIGRATOR_SERVICE_ID" PARTY_REGISTRY_DB_PASSWORD
  align_role party_registry_worker "$ZEROPS_MIGRATOR_SERVICE_ID" PARTY_REGISTRY_WORKER_DB_PASSWORD
  align_role shell_gateway_issuer "$ZEROPS_MIGRATOR_SERVICE_ID" SHELL_GATEWAY_ISSUER_DB_PASSWORD
} | psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -q
echo "database identity passwords aligned"

restart() {
  echo "restarting $1"
  # zcli reports an error when a service does not pass its readiness check, which the wait below decides instead.
  zcli service stop -P "$ZEROPS_PROJECT_ID" -S "$2" >/dev/null || true
  zcli service start -P "$ZEROPS_PROJECT_ID" -S "$2" >/dev/null || true
}

if [[ -n "${changed[spicedb]:-}" ]]; then
  restart spicedb "$ZEROPS_SPICEDB_SERVICE_ID"
fi
if [[ -n "${changed[storefront]:-}" ]]; then
  restart storefront "$ZEROPS_STOREFRONT_SERVICE_ID"
fi
if [[ -n "${changed[shop]:-}" ]]; then
  restart shop "$ZEROPS_SHOP_STOREFRONT_SERVICE_ID"
fi
if [[ -n "${changed[app]:-}" ]]; then
  restart app "$ZEROPS_APP_SERVICE_ID"
fi

if [[ -n "${changed[app]:-}" ]]; then
  ready=0
  for _ in $(seq 1 90); do
    if [[ "$(curl -s -o /dev/null -w '%{http_code}' "$STAGE_SHELL_URL/_host/ready")" == 200 ]]; then
      ready=1
      break
    fi
    sleep 10
  done
  if [[ "$ready" != 1 ]]; then
    echo "app did not answer /_host/ready after the credential restart" >&2
    exit 1
  fi
  echo "app answers /_host/ready"
fi
