#!/usr/bin/env bash
# The VAT deploy rehearsal: a fresh clone of the integration database at its deployed state, the deploy-sequence test
# against it (which applies the deploy's migrations itself), and the clone dropped afterwards.
#
#   . <integration env>; scripts/integration/vat-deploy-rehearsal.sh
#
# Needs the integration stack's environment (DATABASE_URL, DATABASE_ADMIN_URL naming the deployed database, SpiceDB,
# gateway keys) and a database container named by ONTOS_TEST_DB_CONTAINER (default ontos-itest-db).
set -euo pipefail
cd "$(dirname "$0")/../.."
container="${ONTOS_TEST_DB_CONTAINER:-ontos-itest-db}"
deployed="$(node -e 'console.log(new URL(process.env.DATABASE_ADMIN_URL).pathname.slice(1))')"
clone="ontos_test_party_gateway_vat_rehearsal_$(date +%s)"
psql_admin() { docker exec "$container" sh -c "psql -v ON_ERROR_STOP=1 -U \"\${POSTGRES_USER:-postgres}\" -d postgres -c \"$1\""; }
psql_admin "create database ${clone} template ${deployed}"
trap 'psql_admin "drop database if exists ${clone} with (force)"' EXIT
swap() { node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.href)' "$1" "$clone"; }
# Every database identity of the environment names the clone.
for name in DATABASE_URL DATABASE_ADMIN_URL PARTY_REGISTRY_DATABASE_URL PARTY_REGISTRY_WORKER_DATABASE_URL \
  SHELL_GATEWAY_ISSUER_DATABASE_URL; do
  if [ -n "${!name:-}" ]; then export "$name=$(swap "${!name}")"; fi
done
ONTOS_VAT_DEPLOY_REHEARSAL=1 pnpm exec rstest run --project integration --reporter=default \
  scripts/integration/vat-deploy-sequence.test.mts
