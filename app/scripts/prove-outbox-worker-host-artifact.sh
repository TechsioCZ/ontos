#!/bin/sh
# Materialize the Outbox Worker host exactly as its zerops.yaml build does, assemble only its
# deployFiles, and run its real start command until every hosted loop has polled the database and
# /ready answers. Then stop it with SIGTERM and require a clean exit. A hosted owner whose layer
# cannot start, a runtime dependency the bundle does not ship, or a shutdown that hangs fails here
# instead of after the Cloudflare stage deploys it.
#
# Usage: sh scripts/prove-outbox-worker-host-artifact.sh <empty-artifact-directory>
# The caller supplies the migrated database and SpiceDB environment (see the service-integration job).
set -eu

artifact="${1:?usage: prove-outbox-worker-host-artifact.sh <empty-artifact-directory>}"
app_directory="$(cd "$(dirname "$0")/.." && pwd)"
repository="$(cd "$app_directory/.." && pwd)"
timeout_seconds="${OUTBOX_WORKER_HOST_READY_TIMEOUT_SECONDS:-120}"
setup='outbox-worker-host'

mkdir -p "$artifact"
if [ -n "$(ls -A "$artifact")" ]; then
  echo "Outbox Worker host artifact directory $artifact must be empty" >&2
  exit 1
fi
artifact="$(cd "$artifact" && pwd)"

# One line per field: the materialize command, the deployFiles, the health port, and the start command.
service="$(cd "$app_directory" && node --input-type=module --eval "
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
const service = parse(readFileSync('zerops.yaml', 'utf-8')).zerops.find(({ setup }) => setup === '$setup');
if (service === undefined) {
  throw new Error('zerops.yaml has no $setup setup');
}
const materialize = service.build.buildCommands.find((command) => command.includes('zerops:materialize'));
process.stdout.write([
  materialize.slice(materialize.indexOf('pnpm run zerops:materialize')),
  service.build.deployFiles.join(' '),
  service.run.envVariables.OUTBOX_WORKER_HEALTH_PORT,
  service.run.start,
].join('\n'));
")"
materialize="$(printf '%s\n' "$service" | sed -n 1p)"
deploy_files="$(printf '%s\n' "$service" | sed -n 2p)"
port="$(printf '%s\n' "$service" | sed -n 3p)"
start="$(printf '%s\n' "$service" | sed -n 4p)"

(cd "$app_directory" && ULTRAMODERN_SOURCE_REVISION="$(git rev-parse HEAD)" sh -c "$materialize")

for deploy_file in $deploy_files; do
  if [ ! -e "$repository/$deploy_file" ]; then
    echo "Outbox Worker host deployFiles entry $deploy_file does not exist in the build" >&2
    exit 1
  fi
  mkdir -p "$artifact/$(dirname "$deploy_file")"
  cp -Rp "$repository/$deploy_file" "$artifact/$deploy_file"
done

# The Zerops build ships its own Node in the runtime's node/; this proof runs the start command with
# the pinned workspace Node on PATH instead. The start preflight only checks that Zerops delivered the
# published snapshot variable; no hosted worker reads it.
log="$artifact/outbox-worker-host.log"
(
  cd "$artifact"
  exec env \
    NODE_ENV=production \
    OUTBOX_WORKER_HEALTH_PORT="$port" \
    OUTBOX_WORKER_POLL_INTERVAL_MS=250 \
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON="${ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON:-proof}" \
    ULTRAMODERN_ZEROPS_SERVICE="$setup" \
    sh -c "$start"
) >"$log" 2>&1 &
host=$!
stop_host() {
  kill "$host" 2>/dev/null || true
  wait "$host" 2>/dev/null || true
}
trap stop_host EXIT INT TERM

elapsed=0
until curl --silent --fail --output /dev/null "http://127.0.0.1:$port/ready"; do
  if ! kill -0 "$host" 2>/dev/null; then
    cat "$log"
    echo "The assembled Outbox Worker host exited before serving /ready" >&2
    exit 1
  fi
  if [ "$elapsed" -ge "$timeout_seconds" ]; then
    cat "$log"
    echo "The assembled Outbox Worker host did not serve /ready within ${timeout_seconds}s" >&2
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

loops="$(grep -c 'Outbox Worker loop started' "$log" || true)"
owners="$(grep -c 'outboxWorkerEntry as ' "$app_directory/scripts/outbox-worker-host.generated.mts")"
if [ "$loops" -ne "$owners" ]; then
  cat "$log"
  echo "The Outbox Worker host started $loops polling loops for $owners hosted owners" >&2
  exit 1
fi

trap - EXIT INT TERM
kill -TERM "$host"
shutdown_status=0
elapsed=0
while kill -0 "$host" 2>/dev/null; do
  if [ "$elapsed" -ge 30 ]; then
    kill -KILL "$host" 2>/dev/null || true
    cat "$log"
    echo "The Outbox Worker host did not stop within 30s of SIGTERM" >&2
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done
wait "$host" || shutdown_status=$?
cat "$log"
if [ "$shutdown_status" -ne 0 ]; then
  echo "The Outbox Worker host exited with status $shutdown_status after SIGTERM" >&2
  exit 1
fi
if ! grep -q 'Outbox Worker host received SIGTERM; shutting down' "$log"; then
  echo "The Outbox Worker host did not report a graceful SIGTERM shutdown" >&2
  exit 1
fi
echo "The assembled Outbox Worker host ran $owners hosted loops against the migrated database, served /ready and stopped cleanly"
