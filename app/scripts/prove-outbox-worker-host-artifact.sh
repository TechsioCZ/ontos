#!/bin/sh
# Run the Outbox Worker host artifact with its real zerops.yaml start command until every hosted loop
# has polled the database, /ready answers and /status shows every owner admitting the served composition
# under the artifact's digest. Then stop it with SIGTERM and require a clean exit. A hosted owner whose
# layer cannot start, a runtime dependency the bundle does not ship, or a shutdown that hangs fails here
# instead of after the Cloudflare stage deploys it.
#
# Usage: sh scripts/prove-outbox-worker-host-artifact.sh <empty-artifact-directory> [<outbox-host.tar.zst>]
# With the prebuilt archive from scripts/ci/build-outbox-host.sh it runs that exact artifact on its shipped
# Node, so the machine must execute its linux-musl Node (an Alpine container). Without it, it materializes
# the host the way that build does and runs it on the workspace Node.
# The caller supplies the migrated database and SpiceDB environment (see the service-integration job).
set -eu

usage='usage: prove-outbox-worker-host-artifact.sh <empty-artifact-directory> [<outbox-host.tar.zst>]'
artifact="${1:?$usage}"
prebuilt="${2:-}"
app_directory="$(cd "$(dirname "$0")/.." && pwd)"
timeout_seconds="${OUTBOX_WORKER_HOST_READY_TIMEOUT_SECONDS:-120}"
setup='outbox-worker-host'
runtime="app/.zerops/runtime/$setup"

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

# One line per field: the health port and the start command. The host setup has no Zerops build.
service="$(cd "$app_directory" && node --input-type=module --eval "
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
const service = parse(readFileSync('zerops.yaml', 'utf-8')).zerops.find(({ setup }) => setup === '$setup');
if (service === undefined) {
  throw new Error('zerops.yaml has no $setup setup');
}
process.stdout.write([service.run.envVariables.OUTBOX_WORKER_HEALTH_PORT, service.run.start].join('\n'));
")"
port="$(printf '%s\n' "$service" | sed -n 1p)"
start="$(printf '%s\n' "$service" | sed -n 2p)"

if [ -n "$prebuilt" ]; then
  # Zerops places the archive's paths under /var/www, where the start command runs; this proof uses $artifact.
  zstd --quiet --decompress --stdout -- "$prebuilt" | tar -x -f - -C "$artifact"
else
  # The digest a source materialization compiles in; a prebuilt archive brings the plan's own.
  proof_digest="$(node --eval "process.stdout.write(require('node:crypto').createHash('sha256').update('outbox-worker-host-artifact-proof').digest('hex'))")"
  (
    cd "$app_directory"
    ULTRAMODERN_SOURCE_REVISION="$(git rev-parse HEAD)" ONTOS_OUTBOX_HOST_DIGEST="$proof_digest" \
      pnpm run zerops:materialize --app "$setup" --package 'app' --package-dir '.' --worker
  )
  mkdir -p "$artifact/$(dirname "$runtime")"
  cp -Rp "$app_directory/../$runtime" "$artifact/$runtime"
fi
if [ ! -f "$artifact/$runtime/worker.mjs" ]; then
  echo "The Outbox Worker host artifact has no $runtime/worker.mjs" >&2
  exit 1
fi
host_digest="$(node --input-type=module --eval "
import { readFileSync } from 'node:fs';
const { artifactDigest } = JSON.parse(readFileSync(process.argv[1], 'utf-8'));
if (typeof artifactDigest !== 'string') {
  throw new Error('The Outbox Worker host artifact names no artifact digest');
}
process.stdout.write(artifactDigest);
" "$artifact/$runtime/worker-artifact.json")"

# A source materialization has no node/, so its start command falls through to the pinned workspace Node
# on PATH; a prebuilt archive runs on the Node it ships. Both are exec'd so SIGTERM reaches the start
# command's own shell exactly as the platform delivers it (dash does not exec the last command of `sh -c`).
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
      if [ "$host" = "$pid" ]; then host=''; fi
      if [ "$fixture" = "$pid" ]; then fixture=''; fi
      cat "$process_log"
      echo "$name did not stop within 30s of SIGTERM" >&2
      return 1
    fi
    sleep 1
  done
  process_status=0
  wait "$pid" || process_status=$?
  if [ "$host" = "$pid" ]; then host=''; fi
  if [ "$fixture" = "$pid" ]; then fixture=''; fi
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
    --worker-artifact "$artifact/$runtime/worker-artifact.json" \
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

# Positive admission: the same check the stage release runs after it publishes a composition.
revision="$(curl --silent --fail --max-time 5 "$source_url" | node --input-type=module --eval "
let document = '';
for await (const chunk of process.stdin) {
  document += chunk;
}
process.stdout.write(JSON.parse(document).composition.revision);
")"
if ! (cd "$app_directory" && node scripts/ci/await-outbox-admission.mts --status-url "http://127.0.0.1:$port/status" \
  --revision "$revision" --host-digest "$host_digest" --timeout "$timeout_seconds"); then
  cat "$log"
  echo "The assembled Outbox Worker host did not report every owner admitting $revision" >&2
  exit 1
fi

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
