#!/usr/bin/env bash
# Run from app/, after start-integration-workers.sh, with this run's migrated and verified database
# archive. The archive is checked before anything is written into a worker cluster.
set -euo pipefail
umask 077

: "${POSTGRES_USER:?}"
: "${POSTGRES_DB:?}"
: "${INTEGRATION_DATABASE_ARCHIVE:?}"
: "${GITHUB_SHA:?}"
: "${ONTOS_CI_ISOLATED_WORKERS:?}"
[[ "$ONTOS_CI_ISOLATED_WORKERS" == 2 || "$ONTOS_CI_ISOLATED_WORKERS" == 4 ]]
[[ "$POSTGRES_USER" =~ ^[a-z_][a-z0-9_]*$ ]]
[[ "$POSTGRES_DB" =~ ^[a-z_][a-z0-9_]*$ ]]
for file in roles.sql database.dump database.acl manifest.json checksums.sha256; do
  [[ -s "$INTEGRATION_DATABASE_ARCHIVE/$file" ]] || {
    echo "::error::The same-run integration database archive is missing $file."
    exit 1
  }
done
(
  cd "$INTEGRATION_DATABASE_ARCHIVE"
  sha256sum --check checksums.sha256 >/dev/null
)
jq -e --arg revision "$GITHUB_SHA" --arg database "$POSTGRES_DB" --arg user "$POSTGRES_USER" \
  '.revision == $revision and .database == $database and .user == $user' \
  "$INTEGRATION_DATABASE_ARCHIVE/manifest.json" >/dev/null

restore_worker() {
  local database="ontos-ci-db-$1"
  # The initdb-created administrator already exists; its ALTER ROLE from the dump
  # remains. All other login roles, role memberships, ownership and grants are restored.
  docker exec --interactive "$database" psql --username "$POSTGRES_USER" --dbname postgres \
    --set ON_ERROR_STOP=1 <"$INTEGRATION_DATABASE_ARCHIVE/roles.sql" >/dev/null
  # Restoring into an existing database copies its contents, not its database-level ACL. Let the
  # archive create the database too, including the source's REVOKE TEMPORARY FROM PUBLIC.
  docker exec --interactive "$database" pg_restore --username "$POSTGRES_USER" --dbname postgres \
    --create --exit-on-error <"$INTEGRATION_DATABASE_ARCHIVE/database.dump"
  bash scripts/ci/prepare-schema-template.sh "$database" "$INTEGRATION_DATABASE_ARCHIVE/database.dump"
}

pids=()
for ((worker = 1; worker <= ONTOS_CI_ISOLATED_WORKERS; worker++)); do
  restore_worker "$worker" &
  pids+=("$!")
done
failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=1
done
[[ "$failed" == 0 ]]

# Assert that every worker owns a different cluster, not just a different port.
identifiers=()
acl_query="$(cat scripts/ci/integration-database-acl.sql)"
source_acl="$(cat "$INTEGRATION_DATABASE_ARCHIVE/database.acl")"
for ((worker = 1; worker <= ONTOS_CI_ISOLATED_WORKERS; worker++)); do
  durability="$(docker exec "ontos-ci-db-$worker" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc     "select current_setting('fsync') || ':' || current_setting('synchronous_commit') || ':' || current_setting('full_page_writes')")"
  [[ "$durability" == on:on:on ]]
  identifier="$(docker exec "ontos-ci-db-$worker" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'select system_identifier from pg_control_system()')"
  [[ -n "$identifier" ]]
  for existing in "${identifiers[@]}"; do
    [[ "$identifier" != "$existing" ]]
  done
  identifiers+=("$identifier")
  worker_acl="$(docker exec "ontos-ci-db-$worker" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$acl_query")"
  if [[ "$worker_acl" != "$source_acl" ]]; then
    echo "::error::Integration worker $worker did not preserve the source database privileges."
    exit 1
  fi
  docker exec -i "ontos-ci-db-$worker" psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -v source="$POSTGRES_DB" -v baseline="${POSTGRES_DB}_baseline" <<'SQL'
ALTER DATABASE :"source" RENAME TO :"baseline";
ALTER DATABASE :"baseline" IS_TEMPLATE true ALLOW_CONNECTIONS false;
SQL
done
echo "$ONTOS_CI_ISOLATED_WORKERS independent PostgreSQL clusters and SpiceDB datastores are ready."
