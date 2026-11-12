#!/usr/bin/env bash
# The VAT deploy rehearsal, each part on its own fresh clone of the integration database at its deployed state, every
# clone dropped afterwards:
#
# 1. The window: the deploy's migrations run on the clone while the release before them keeps serving, as on stage
#    (the new container migrates minutes before it publishes). The OLD release's own code, from a checkout of the trunk
#    the deploy replaces, reads the storefront, places an order and writes products, orders and Finance ledgers on the
#    migrated clone (`tests/vat-window.old-release.mts`); then the new release reads every row it wrote
#    (`vat-window-new-release.test.mts`).
# 2. The deploy sequence: migrations, the storefront without Tax, the release install, the seed, the first sync and
#    Finance (`vat-deploy-sequence.test.mts`, which applies the migrations itself); then the release's BUILT Merchandise
#    under the owners process, its module key handed over only on fd 3, reading Tax through the Shell.
# 3. Through the REAL Shell (`apps/shell-super-app/tests/integration/vat-real-shell-native.test.ts`): the export's
#    packaged Shell and its built Tax, Finance and Merchandise under the owners process, every key from the platform's
#    provisioning on fd 3; each persona (owner, Skladník, e-shop administrator, Účetní, Obchodník) and the registered
#    storefront client, on a migrated clone.
#
#   . <integration env>; ONTOS_VAT_OLD_RELEASE_DIR=<trunk checkout>/app ONTOS_VAT_BUILT_APP=<built export>/app \
#     scripts/integration/vat-deploy-rehearsal.sh
#
# ONTOS_VAT_BUILT_APP names the app folder of an export of this tree with Merchandise built (`pnpm run build` in
# verticals/merchandise, then `node scripts/zerops/owner-entry.mts verticals/merchandise`), as the deploy builds it.
#
# Needs the integration stack's environment (DATABASE_URL, DATABASE_ADMIN_URL naming the deployed database, SpiceDB,
# gateway keys), a database container named by ONTOS_TEST_DB_CONTAINER (default ontos-itest-db), and the trunk
# checkout with its dependencies installed in ONTOS_VAT_OLD_RELEASE_DIR.
set -euo pipefail
cd "$(dirname "$0")/../.."
app="$PWD"
old_release="${ONTOS_VAT_OLD_RELEASE_DIR:?ONTOS_VAT_OLD_RELEASE_DIR must name the app directory of a trunk checkout}"
built_app="${ONTOS_VAT_BUILT_APP:?ONTOS_VAT_BUILT_APP must name the app directory of a built export of this tree}"
container="${ONTOS_TEST_DB_CONTAINER:-ontos-itest-db}"
deployed="$(node -e 'console.log(new URL(process.env.DATABASE_ADMIN_URL).pathname.slice(1))')"
stamp="$(date +%s)"
window_clone="ontos_test_party_gateway_vat_window_${stamp}"
sequence_clone="ontos_test_party_gateway_vat_rehearsal_${stamp}"
shell_clone="ontos_test_party_gateway_vat_real_shell_${stamp}"
window_test="${old_release}/scripts/integration/vat-window-old-release.test.mts"
report="$(mktemp -t vat-window-report)"
psql_admin() { docker exec "$container" sh -c "psql -v ON_ERROR_STOP=1 -U \"\${POSTGRES_USER:-postgres}\" -d postgres -c \"$1\""; }
cleanup() {
  rm -f "$window_test" "$report"
  psql_admin "drop database if exists ${window_clone} with (force)" || true
  psql_admin "drop database if exists ${sequence_clone} with (force)" || true
  psql_admin "drop database if exists ${shell_clone} with (force)" || true
}
trap cleanup EXIT
deployed_env() {
  for name in DATABASE_URL DATABASE_ADMIN_URL PARTY_REGISTRY_DATABASE_URL PARTY_REGISTRY_WORKER_DATABASE_URL \
    SHELL_GATEWAY_ISSUER_DATABASE_URL; do
    if [ -n "${!name:-}" ]; then printf '%s=%s\n' "$name" "${!name}"; fi
  done
}
# Every database identity of the environment names the given clone.
on_clone() {
  local clone=$1
  shift
  env $(deployed_env | while IFS='=' read -r name value; do
    printf '%s=%s ' "$name" "$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.href)' "$value" "$clone")"
  done) "$@"
}

# The deploy's migrations on a clone, exactly as `db:migrate` runs them.
migrate_clone() {
  local clone=$1
  (cd packages/core-runtime && on_clone "$clone" node ../../scripts/migration-convergence-cli.mts core)
  for owner in tax finance-billing merchandise; do
    (cd "verticals/$owner" && on_clone "$clone" pnpm exec drizzle-kit migrate --config drizzle.config.ts)
  done
}

# 1. The window.
psql_admin "create database ${window_clone} template ${deployed}"
migrate_clone "$window_clone"
cp scripts/integration/tests/vat-window.old-release.mts "$window_test"
(cd "$old_release" && on_clone "$window_clone" \
  ONTOS_VAT_WINDOW_REPORT="$report" \
  ONTOS_VAT_WINDOW_FIXTURE="$app/verticals/merchandise/tests/fixtures/vat-transition-pre-migration.json" \
  pnpm exec rstest run --project integration --reporter=default scripts/integration/vat-window-old-release.test.mts)
on_clone "$window_clone" ONTOS_VAT_WINDOW_REPORT="$report" \
  pnpm exec rstest run --project integration --reporter=default scripts/integration/vat-window-new-release.test.mts

# 2. The deploy sequence.
psql_admin "create database ${sequence_clone} template ${deployed}"
on_clone "$sequence_clone" ONTOS_VAT_DEPLOY_REHEARSAL=1 ONTOS_VAT_BUILT_APP="$built_app" \
  pnpm exec rstest run --project integration --reporter=default scripts/integration/vat-deploy-sequence.test.mts

# 3. Through the real Shell.
psql_admin "create database ${shell_clone} template ${deployed}"
migrate_clone "$shell_clone"
(cd apps/shell-super-app && on_clone "$shell_clone" ONTOS_VAT_BUILT_APP="$built_app" \
  pnpm exec rstest run --project integration --reporter=default tests/integration/vat-real-shell-native.test.ts)
