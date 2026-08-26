#!/bin/sh

set -eu

docker run --rm --network=host \
  -e SPICEDB_DATASTORE_ENGINE \
  -e SPICEDB_DATASTORE_CONN_URI \
  authzed/spicedb:v1.56.0 datastore migrate head

schema_count="$(
  docker run --rm --network=host \
    -e SPICEDB_DATASTORE_CONN_URI \
    postgres:17-alpine sh -c \
    'psql "$SPICEDB_DATASTORE_CONN_URI" --no-psqlrc --tuples-only --no-align --command "select count(*) from namespace_config"'
)"

if [ "$schema_count" = '0' ]; then
  exec docker run --rm --network=host \
    -e SPICEDB_DATASTORE_ENGINE \
    -e SPICEDB_DATASTORE_CONN_URI \
    -e SPICEDB_GRPC_PRESHARED_KEY \
    -v /var/www/app/packages/core-runtime/spicedb/stage-bootstrap.yaml:/bootstrap/stage-bootstrap.yaml:ro \
    authzed/spicedb:v1.56.0 serve \
    --datastore-bootstrap-files=/bootstrap/stage-bootstrap.yaml \
    --http-enabled
fi

exec docker run --rm --network=host \
  -e SPICEDB_DATASTORE_ENGINE \
  -e SPICEDB_DATASTORE_CONN_URI \
  -e SPICEDB_GRPC_PRESHARED_KEY \
  authzed/spicedb:v1.56.0 serve \
  --http-enabled
