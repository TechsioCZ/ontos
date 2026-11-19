#!/usr/bin/env bash
# Called under its own ten-second bound before terminating a Shell shard. No command lines, queries or secrets.
set -euo pipefail
printf 'Integration hang snapshot: %s slot=%s task=%s\n' "$(date -u +%FT%TZ)" "$ONTOS_CI_WORKER_SLOT" "$1"
ps -eo pid,ppid,pgid,stat,etimes,comm --forest
# Kernel wait channels and FD counts identify blocked children without dumping argv, environment or FD contents.
for pid in $(ps -eo pid=,comm= | awk '$2 ~ /^(node|pnpm|mise)$/ {print $1}'); do
  printf 'pid=%s fd-count=%s wait=' "$pid" "$(find "/proc/$pid/fd" -maxdepth 1 -type l 2>/dev/null | wc -l || true)"
  cat "/proc/$pid/wchan" 2>/dev/null || true
  echo
done
if [[ -n "${ONTOS_CI_ISOLATED_WORKERS:-}" ]]; then
  database_command=(docker exec -i "ontos-ci-db-$ONTOS_CI_WORKER_SLOT")
else
  database_command=(docker compose exec --no-TTY ontos-db)
fi
"${database_command[@]}" psql -U "${POSTGRES_USER:?}" -d postgres -v ON_ERROR_STOP=1 -v target="${POSTGRES_DB:?}" <<'SQL'
SET statement_timeout = '3s';
-- The task also creates p14_access_admin_* clones. Include their sessions and idle-in-transaction owners.
SELECT pid, datname, application_name, backend_type, state, wait_event_type, wait_event,
       clock_timestamp() - xact_start AS transaction_age,
       clock_timestamp() - query_start AS query_age, pg_blocking_pids(pid) AS blocking_pids
FROM pg_stat_activity
WHERE datname = :'target' OR datname LIKE 'p14_access_admin_%'
ORDER BY datname, pid;
SELECT l.pid, a.datname, l.locktype, l.database, l.relation, l.page, l.tuple,
       l.virtualxid, l.transactionid, l.mode, l.granted, l.waitstart
FROM pg_locks l LEFT JOIN pg_stat_activity a USING (pid)
WHERE a.datname = :'target' OR a.datname LIKE 'p14_access_admin_%'
   OR l.database IN (SELECT oid FROM pg_database WHERE datname = :'target' OR datname LIKE 'p14_access_admin_%')
ORDER BY l.pid, l.granted;
SQL
