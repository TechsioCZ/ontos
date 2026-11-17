#!/usr/bin/env bash
# A schema-only PostgreSQL template: no source rows, journals or sealing keys.
# Every acquisition still verifies empty tables and creates fresh trust entropy.
set -euo pipefail
container="${1:?PostgreSQL container}"
: "${POSTGRES_USER:?}"
archive="${2:?same-run database archive}"
docker exec "$container" psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE ontos_ci_schema_template' >/dev/null
docker exec -i "$container" pg_restore -U "$POSTGRES_USER" -d ontos_ci_schema_template \
  --schema-only --exit-on-error --single-transaction <"$archive"
docker exec "$container" psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c 'ALTER DATABASE ontos_ci_schema_template IS_TEMPLATE true ALLOW_CONNECTIONS false' >/dev/null
