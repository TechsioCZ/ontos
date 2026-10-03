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

case "$timeout_seconds" in
  ''|*[!0-9]*)
    echo 'OUTBOX_WORKER_HOST_READY_TIMEOUT_SECONDS must be a positive integer' >&2
    exit 1
    ;;
esac
if ! [ "$timeout_seconds" -ge 1 ] 2>/dev/null; then
  echo 'OUTBOX_WORKER_HOST_READY_TIMEOUT_SECONDS must be a positive integer' >&2
  exit 1
fi

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
# the pinned workspace Node on PATH instead, exec'd so SIGTERM reaches the start command's own shell
# exactly as the platform delivers it (dash does not exec the last command of `sh -c` itself).
# Readiness requires a successful cycle under the complete approved composition. The local proof
# owns an otherwise empty authority row and a loopback source; neither is a deployment receipt.
fixture_log="$artifact/outbox-worker-host-proof-fixture.log"
source_url_file="$artifact/outbox-worker-host-proof-source.url"
host_stopped_file="$artifact/outbox-worker-host-proof-stopped"
host=''
fixture=''
stop_process() {
  pid="$1"
  name="$2"
  process_log="$3"
  if [ -z "$pid" ]; then
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  stop_deadline=$(($(date +%s) + 30))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$stop_deadline" ]; then
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      cat "$process_log"
      echo "$name did not stop within 30s of SIGTERM" >&2
      return 1
    fi
    sleep 1
  done
  process_status=0
  wait "$pid" || process_status=$?
  if [ "$process_status" -ne 0 ]; then
    cat "$process_log"
    echo "$name exited with status $process_status" >&2
    return 1
  fi
}
cleanup() {
  original_status=$?
  trap - EXIT INT TERM
  cleanup_status=0
  stop_process "$host" 'Outbox Worker host' "$artifact/outbox-worker-host.log" || cleanup_status=1
  # The fixture may receive a process-group signal at the same time as the host. It cannot remove
  # authority until this parent confirms that the real host has been reaped.
  : >"$host_stopped_file" || cleanup_status=1
  stop_process "$fixture" 'Outbox Worker host proof fixture' "$fixture_log" || cleanup_status=1
  if [ "$original_status" -eq 0 ]; then
    exit "$cleanup_status"
  fi
  exit "$original_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

(
  cd "$app_directory"
  exec node scripts/outbox-worker-host-proof-fixture.mts \
    --worker-artifact "$artifact/app/.zerops/runtime/$setup/worker-artifact.json" \
    --source-url-file "$source_url_file" \
    --host-stopped-file "$host_stopped_file"
) >"$fixture_log" 2>&1 &
fixture=$!
deadline=$(($(date +%s) + timeout_seconds))
until [ -s "$source_url_file" ]; do
  if ! kill -0 "$fixture" 2>/dev/null; then
    cat "$fixture_log"
    echo 'The Outbox Worker host proof fixture exited before admitting its composition' >&2
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    cat "$fixture_log"
    echo "The Outbox Worker host proof fixture did not admit its composition within ${timeout_seconds}s" >&2
    exit 1
  fi
  sleep 1
done
source_url="$(cat "$source_url_file")"

log="$artifact/outbox-worker-host.log"
(
  cd "$artifact"
  exec env \
    NODE_ENV=production \
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL="$source_url" \
    OUTBOX_WORKER_HEALTH_PORT="$port" \
    OUTBOX_WORKER_POLL_INTERVAL_MS=250 \
    ULTRAMODERN_ZEROPS_SERVICE="$setup" \
    sh -c "exec $start"
) >"$log" 2>&1 &
host=$!

deadline=$(($(date +%s) + timeout_seconds))
until [ "$(curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/ready" || true)" = 200 ]; do
  if ! kill -0 "$fixture" 2>/dev/null; then
    cat "$fixture_log"
    echo 'The Outbox Worker host proof fixture stopped before worker readiness' >&2
    exit 1
  fi
  if ! kill -0 "$host" 2>/dev/null; then
    cat "$log"
    echo "The assembled Outbox Worker host exited before serving /ready" >&2
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    cat "$log"
    echo "The assembled Outbox Worker host did not serve /ready within ${timeout_seconds}s" >&2
    exit 1
  fi
  sleep 1
done

loops="$(grep -c 'Outbox Worker loop started' "$log" || true)"
owners="$(grep -c 'outboxWorkerEntry as ' "$app_directory/scripts/outbox-worker-host.generated.mts")"
if [ "$loops" -ne "$owners" ]; then
  cat "$log"
  echo "The Outbox Worker host started $loops polling loops for $owners hosted owners" >&2
  exit 1
fi

stop_process "$host" 'Outbox Worker host' "$log"
host=''
: >"$host_stopped_file"
cat "$log"
if ! grep -q 'Outbox Worker host received SIGTERM; shutting down' "$log"; then
  echo "The Outbox Worker host did not report a graceful SIGTERM shutdown" >&2
  exit 1
fi
stop_process "$fixture" 'Outbox Worker host proof fixture' "$fixture_log"
fixture=''
cat "$fixture_log"
echo "The assembled Outbox Worker host ran $owners hosted loops against the migrated database, served /ready and stopped cleanly"
