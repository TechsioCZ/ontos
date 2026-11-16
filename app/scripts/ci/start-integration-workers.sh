#!/usr/bin/env bash
# Run from app/, after the job's source database has been migrated and verified.
# Separate clusters, not merely separate databases: bootstrap proofs and role-boundary
# tests issue ALTER ROLE, which is cluster-global. SpiceDB has a separate datastore too.
set -euo pipefail
umask 077

: "${RUNNER_TEMP:?}"
: "${POSTGRES_USER:?}"
: "${POSTGRES_PASSWORD:?}"
: "${POSTGRES_DB:?}"
: "${SPICEDB_PRESHARED_KEY:?}"
[[ "$POSTGRES_USER" =~ ^[a-z_][a-z0-9_]*$ ]]
[[ "$POSTGRES_DB" =~ ^[a-z_][a-z0-9_]*$ ]]

scratch="$(mktemp -d "$RUNNER_TEMP/integration-workers.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
docker compose config --format json >"$scratch/compose.json"
postgres_image="$(jq -er '.services["ontos-db"].image' "$scratch/compose.json")"
spicedb_image="$(jq -er '.services["ontos-spicedb"].image' "$scratch/compose.json")"

# Never print the dump: it carries the role passwords that the restored runtime URLs use.
docker exec ontos-db pg_dumpall --username "$POSTGRES_USER" --roles-only \
  | sed "/^CREATE ROLE $POSTGRES_USER;$/d" >"$scratch/roles.sql"
docker exec ontos-db pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --format=custom >"$scratch/database.dump"

start_worker() {
  local worker="$1" database="ontos-ci-db-$1" spice="ontos-ci-spicedb-$1"
  docker run --detach --name "$database" --label ontos-ci-worker \
    --env POSTGRES_USER --env POSTGRES_PASSWORD --env POSTGRES_DB \
    --publish "127.0.0.1:$((5540 + worker)):5432" "$postgres_image" >/dev/null
  docker run --detach --name "$spice" --label ontos-ci-worker \
    --env "SPICEDB_GRPC_PRESHARED_KEY=$SPICEDB_PRESHARED_KEY" \
    --publish "127.0.0.1:$((55050 + worker)):50051" \
    --publish "127.0.0.1:$((58440 + worker)):8443" \
    --volume "$PWD/packages/core-runtime/spicedb/bootstrap.yaml:/bootstrap/bootstrap.yaml:ro" \
    --volume "$PWD/.spicedb-tls:/tls:ro" \
    "$spicedb_image" serve --datastore-engine=memory \
    --datastore-bootstrap-files=/bootstrap/bootstrap.yaml --http-enabled=true \
    --grpc-tls-cert-path=/tls/cert.pem --grpc-tls-key-path=/tls/key.pem \
    --http-tls-cert-path=/tls/cert.pem --http-tls-key-path=/tls/key.pem >/dev/null

  local ready=false
  for ((attempt = 0; attempt < 60; attempt++)); do
    # initdb's temporary server accepts Unix sockets before shutting down. Only
    # the final postmaster accepts TCP; restoring into the temporary one races its restart.
    if docker exec "$database" pg_isready --host 127.0.0.1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" >/dev/null 2>&1 \
      && docker exec "$spice" /usr/local/bin/grpc_health_probe -addr=localhost:50051 \
        -tls -tls-ca-cert=/tls/cert.pem >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then
    echo "::error::Integration worker $worker did not become ready."
    return 1
  fi
  # The initdb-created administrator already exists; its ALTER ROLE from the dump
  # remains. All other login roles, role memberships, ownership and grants are restored.
  docker exec --interactive "$database" psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set ON_ERROR_STOP=1 <"$scratch/roles.sql" >/dev/null
  docker exec --interactive "$database" pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --exit-on-error --single-transaction <"$scratch/database.dump"
}

start_worker 1 &
first=$!
start_worker 2 &
second=$!
failed=0
wait "$first" || failed=1
wait "$second" || failed=1
[[ "$failed" == 0 ]]

# Assert the isolation that makes two workers safe, against the actual clusters.
one="$(docker exec ontos-ci-db-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'select system_identifier from pg_control_system()')"
two="$(docker exec ontos-ci-db-2 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'select system_identifier from pg_control_system()')"
[[ -n "$one" && -n "$two" && "$one" != "$two" ]]
echo 'Two independent PostgreSQL clusters and SpiceDB datastores are ready.'
