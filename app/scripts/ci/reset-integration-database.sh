#!/usr/bin/env bash
# A lane owns its cluster; a task owns its database. Never carry a previous
# package's durable work or composition authority into the next package.
set -euo pipefail
worker="${1:?worker slot}"
[[ "$worker" =~ ^[1-4]$ ]]
: "${POSTGRES_USER:?}"
: "${POSTGRES_DB:?}"
[[ "$POSTGRES_DB" =~ ^[a-z_][a-z0-9_]*$ ]]
container="ontos-ci-db-$worker"
docker exec -i "$container" psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -v target="$POSTGRES_DB" -v baseline="${POSTGRES_DB}_baseline" <<'SQL'
DROP DATABASE IF EXISTS :"target" WITH (FORCE);
CREATE DATABASE :"target" TEMPLATE :"baseline";
-- CREATE DATABASE copies contents, but not database-level ACLs.
REVOKE ALL ON DATABASE :"target" FROM PUBLIC;
SELECT format('GRANT %s ON DATABASE %I TO %s%s',
  acl.privilege_type,
  :'target',
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(role.rolname) END,
  CASE WHEN acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
FROM pg_database d
CROSS JOIN LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) acl
LEFT JOIN pg_roles role ON role.oid = acl.grantee
WHERE d.datname = :'baseline'
\gexec
SQL
