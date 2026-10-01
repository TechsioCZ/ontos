#!/bin/sh

set -eu

# SpiceDB never receives an externally supplied URL string: the datastore URI is built from the
# structured host, port and password this service is configured with.
SPICEDB_DATASTORE_CONN_URI="$(sh "$(dirname "$0")/spicedb-datastore-uri.sh")"
export SPICEDB_DATASTORE_CONN_URI

# Both listeners serve TLS. The certificates are this service's secrets, written by the `spicedb-tls`
# step of `scripts/ops/cloudflare-stage-cutover.mts` (stage) or `scripts/ops/production-environment.mts`
# (production): gRPC uses a self-signed certificate the runtimes pin through SPICEDB_CA_CERT, and the
# HTTP gateway uses a Cloudflare Origin CA certificate that Workers VPC verifies.
for name in SPICEDB_GRPC_TLS_CERT SPICEDB_GRPC_TLS_KEY SPICEDB_HTTP_TLS_CERT SPICEDB_HTTP_TLS_KEY; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "$name is required" >&2
    exit 1
  fi
done

# The SpiceDB image runs as an unprivileged user, so the files must be readable by it. The
# directory stays unlistable; the keys are already in this service's environment.
tls_dir=/var/www/spicedb-tls
mkdir -p "$tls_dir"
chmod 0711 "$tls_dir"
printf '%s\n' "$SPICEDB_GRPC_TLS_CERT" > "$tls_dir/grpc-cert.pem"
printf '%s\n' "$SPICEDB_GRPC_TLS_KEY" > "$tls_dir/grpc-key.pem"
printf '%s\n' "$SPICEDB_HTTP_TLS_CERT" > "$tls_dir/http-cert.pem"
printf '%s\n' "$SPICEDB_HTTP_TLS_KEY" > "$tls_dir/http-key.pem"
chmod 0644 "$tls_dir"/*.pem

docker run --rm --network=host \
  -e SPICEDB_DATASTORE_ENGINE \
  -e SPICEDB_DATASTORE_CONN_URI \
  authzed/spicedb:v1.56.0 datastore migrate head

schema_count="$(
  docker run --rm --network=host \
    -e SPICEDB_DATASTORE_CONN_URI \
    postgres:18.6-alpine sh -c \
    'psql "$SPICEDB_DATASTORE_CONN_URI" --no-psqlrc --tuples-only --no-align --command "select count(*) from namespace_config"'
)"

bootstrap_mount=''
bootstrap_flag=''
if [ "$schema_count" = '0' ]; then
  bootstrap_mount='/var/www/app/packages/core-runtime/spicedb/stage-bootstrap.yaml:/bootstrap/stage-bootstrap.yaml:ro'
  bootstrap_flag='--datastore-bootstrap-files=/bootstrap/stage-bootstrap.yaml'
fi

# The health checks run grpc_health_probe inside this named container.
docker rm --force spicedb > /dev/null 2>&1 || true

exec docker run --rm --name spicedb --network=host \
  -e SPICEDB_DATASTORE_ENGINE \
  -e SPICEDB_DATASTORE_CONN_URI \
  -e SPICEDB_GRPC_PRESHARED_KEY \
  -v "$tls_dir:/tls:ro" \
  ${bootstrap_mount:+-v "$bootstrap_mount"} \
  authzed/spicedb:v1.56.0 serve \
  ${bootstrap_flag:+"$bootstrap_flag"} \
  --grpc-tls-cert-path=/tls/grpc-cert.pem \
  --grpc-tls-key-path=/tls/grpc-key.pem \
  --http-enabled \
  --http-tls-cert-path=/tls/http-cert.pem \
  --http-tls-key-path=/tls/http-key.pem
