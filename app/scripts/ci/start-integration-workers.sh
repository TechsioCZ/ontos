#!/usr/bin/env bash
# Run from app/. Starts each integration worker's own empty PostgreSQL cluster and SpiceDB datastore and
# waits until both accept connections; restore-integration-workers.sh then loads this run's migrated
# and verified database archive into every cluster. Starting needs no archive, so an owner row starts
# its clusters after its build and before the archive lands instead of after it.
# Separate clusters, not merely separate databases: bootstrap proofs and role-boundary
# tests issue ALTER ROLE, which is cluster-global. SpiceDB has a separate datastore too.
set -euo pipefail
umask 077

: "${RUNNER_TEMP:?}"
: "${POSTGRES_USER:?}"
: "${POSTGRES_PASSWORD:?}"
: "${SPICEDB_PRESHARED_KEY:?}"
: "${ONTOS_CI_ISOLATED_WORKERS:?}"
[[ "$ONTOS_CI_ISOLATED_WORKERS" == 2 || "$ONTOS_CI_ISOLATED_WORKERS" == 4 ]]
[[ "$POSTGRES_USER" =~ ^[a-z_][a-z0-9_]*$ ]]

scratch="$(mktemp -d "$RUNNER_TEMP/integration-workers.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
docker compose config --format json >"$scratch/compose.json"
postgres_image="$(jq -er '.services["ontos-db"].image' "$scratch/compose.json")"
spicedb_image="$(jq -er '.services["ontos-spicedb"].image' "$scratch/compose.json")"

start_worker() {
  local worker="$1" database="ontos-ci-db-$1" spice="ontos-ci-spicedb-$1"
  # These allocations are discarded after the job; keep native WAL/fsync/commit
  # semantics, without paying the hosted runner disk latency for disposable pages.
  docker run --detach --name "$database" --label ontos-ci-worker \
    --tmpfs /var/lib/postgresql:rw,size=2g \
    --env POSTGRES_USER --env POSTGRES_PASSWORD --env POSTGRES_DB=postgres \
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

  for ((attempt = 0; attempt < 60; attempt++)); do
    # initdb's temporary server accepts Unix sockets before shutting down. Only
    # the final postmaster accepts TCP; restoring into the temporary one races its restart.
    if docker exec "$database" pg_isready --host 127.0.0.1 --username "$POSTGRES_USER" --dbname postgres >/dev/null 2>&1 \
      && docker exec "$spice" /usr/local/bin/grpc_health_probe -addr=localhost:50051 \
        -tls -tls-ca-cert=/tls/cert.pem >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "::error::Integration worker $worker did not become ready."
  return 1
}

pids=()
for ((worker = 1; worker <= ONTOS_CI_ISOLATED_WORKERS; worker++)); do
  start_worker "$worker" &
  pids+=("$!")
done
failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=1
done
[[ "$failed" == 0 ]]
echo "$ONTOS_CI_ISOLATED_WORKERS empty PostgreSQL clusters and SpiceDB datastores accept connections."
