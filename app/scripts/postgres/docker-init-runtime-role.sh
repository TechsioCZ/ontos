#!/bin/sh
set -eu

runtime_password="${ONTOS_RUNTIME_DB_PASSWORD:-ontos_runtime}"
psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set runtime_password="$runtime_password" --set database_name="$POSTGRES_DB" <<'SQL'
SELECT format('CREATE ROLE ontos_runtime LOGIN PASSWORD %L', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ontos_runtime') \gexec
ALTER ROLE ontos_runtime LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
SELECT format('GRANT CONNECT ON DATABASE %I TO ontos_runtime', :'database_name') \gexec
GRANT USAGE ON SCHEMA public TO ontos_runtime;
SQL
