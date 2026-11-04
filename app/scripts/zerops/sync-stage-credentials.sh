#!/usr/bin/env bash
# Writes the stage credentials that cross services: the owner secret bundle, SpiceDB's key and datastore password,
# the migrator's identity passwords, and the two storefront keys. Every value is a GitHub secret of the stage-edge
# environment. sync-service-secret.sh rewrites a Zerops variable only when it differs and prints only its key, so a
# push that changes nothing restarts nothing. A service restarts only when one of its variables changed.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
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

# The app container reads SpiceDB's key and the migrator's passwords through Zerops references, so each of those
# changes needs an app restart as well.
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

restart() {
  echo "restarting $1"
  zcli service stop -P "$ZEROPS_PROJECT_ID" -S "$2" >/dev/null
  zcli service start -P "$ZEROPS_PROJECT_ID" -S "$2" >/dev/null
}

if [[ -n "${changed[spicedb]:-}" ]]; then
  restart spicedb "$ZEROPS_SPICEDB_SERVICE_ID"
fi
if [[ -n "${changed[app]:-}" ]]; then
  restart app "$ZEROPS_APP_SERVICE_ID"
fi
if [[ -n "${changed[storefront]:-}" ]]; then
  restart storefront "$ZEROPS_STOREFRONT_SERVICE_ID"
fi
if [[ -n "${changed[shop]:-}" ]]; then
  restart shop "$ZEROPS_SHOP_STOREFRONT_SERVICE_ID"
fi

# The app's startup runs the migrator pass that re-sets the identity passwords, so wait for it before the deploy.
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
