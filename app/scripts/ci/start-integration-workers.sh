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

  local ready=false
  for ((attempt = 0; attempt < 60; attempt++)); do
    # initdb's temporary server accepts Unix sockets before shutting down. Only
    # the final postmaster accepts TCP; restoring into the temporary one races its restart.
    if docker exec "$database" pg_isready --host 127.0.0.1 --username "$POSTGRES_USER" --dbname postgres >/dev/null 2>&1 \
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
  docker exec --interactive "$database" psql --username "$POSTGRES_USER" --dbname postgres \
    --set ON_ERROR_STOP=1 <"$scratch/roles.sql" >/dev/null
  # Restoring into an existing database copies its contents, not its database-level ACL. Let the
  # archive create the database too, including the source's REVOKE TEMPORARY FROM PUBLIC.
  docker exec --interactive "$database" pg_restore --username "$POSTGRES_USER" --dbname postgres \
    --create --exit-on-error <"$scratch/database.dump"
}

pids=()
for worker in 1 2; do
  start_worker "$worker" &
  pids+=("$!")
done
failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=1
done
[[ "$failed" == 0 ]]

# Assert that every worker owns a different cluster, not just a different port.
identifiers=()
acl_query="select coalesce(grantor_role.rolname, 'PUBLIC'), coalesce(grantee_role.rolname, 'PUBLIC'),
  acl.privilege_type, acl.is_grantable
  from pg_database d
  cross join lateral aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) acl
  left join pg_roles grantor_role on grantor_role.oid = acl.grantor
  left join pg_roles grantee_role on grantee_role.oid = acl.grantee
  where d.datname = '$POSTGRES_DB' order by 1, 2, 3, 4"
source_acl="$(docker exec ontos-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$acl_query")"
for worker in 1 2; do
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
done
echo 'Two independent PostgreSQL clusters and SpiceDB datastores are ready.'
