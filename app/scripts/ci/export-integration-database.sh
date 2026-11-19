#!/usr/bin/env bash
# Publish only this run's fresh, migrated CI baseline, before any browser test starts.
set -euo pipefail
umask 077
: "${RUNNER_TEMP:?}"
: "${GITHUB_SHA:?}"
: "${POSTGRES_USER:?}"
: "${POSTGRES_DB:?}"
[[ "$POSTGRES_USER" =~ ^[a-z_][a-z0-9_]*$ ]]
[[ "$POSTGRES_DB" =~ ^[a-z_][a-z0-9_]*$ ]]
directory="$RUNNER_TEMP/integration-database"
mkdir -p "$directory"
# Never print this archive: roles and technical state are development-only but private inputs.
docker exec ontos-db pg_dumpall --username "$POSTGRES_USER" --roles-only \
  | sed "/^CREATE ROLE $POSTGRES_USER;$/d" >"$directory/roles.sql"
docker exec ontos-db pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --format=custom >"$directory/database.dump"
docker exec -i ontos-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At \
  <scripts/ci/integration-database-acl.sql >"$directory/database.acl"
jq -n --arg revision "$GITHUB_SHA" --arg database "$POSTGRES_DB" --arg user "$POSTGRES_USER" \
  '{revision: $revision, database: $database, user: $user}' >"$directory/manifest.json"
(
  cd "$directory"
  sha256sum roles.sql database.dump database.acl manifest.json >checksums.sha256
)
