#!/bin/sh
# Assemble the stage migrator exactly from its zerops.yaml deployFiles and run its start entry
# point until it serves /ready. Anything the deployed migrator cannot reach (an unshipped owner
# package, a role the deployment never provisions, a schema the whole-deployment verifier expects
# but no owner migrates) fails here instead of after merge to main.
#
# Usage: sh scripts/prove-zerops-migrator-artifact.sh <empty-artifact-directory>
# The caller supplies the stage-shaped database environment (see the service-integration job).
set -eu

artifact="${1:?usage: prove-zerops-migrator-artifact.sh <empty-artifact-directory>}"
app_directory="$(cd "$(dirname "$0")/.." && pwd)"
repository="$(cd "$app_directory/.." && pwd)"
port="${MIGRATOR_PORT:-8080}"
timeout_seconds="${MIGRATOR_READY_TIMEOUT_SECONDS:-600}"

mkdir -p "$artifact"
if [ -n "$(ls -A "$artifact")" ]; then
  echo "Migrator artifact directory $artifact must be empty" >&2
  exit 1
fi
artifact="$(cd "$artifact" && pwd)"

deploy_files="$(cd "$app_directory" && node --input-type=module --eval "
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
const migrator = parse(readFileSync('zerops.yaml', 'utf-8')).zerops.find(({ setup }) => setup === 'migrator');
process.stdout.write(migrator.build.deployFiles.join('\n'));
")"

# The Zerops build copies its own Node into app/.zerops/node; this proof runs the same entry point
# with the pinned workspace Node on PATH instead, so that single build-only path is not shipped here.
printf '%s\n' "$deploy_files" | while IFS= read -r deploy_file; do
  if [ "$deploy_file" = 'app/.zerops/node' ]; then
    continue
  fi
  if [ ! -e "$repository/$deploy_file" ]; then
    echo "Migrator deployFiles entry $deploy_file does not exist in the build" >&2
    exit 1
  fi
  mkdir -p "$artifact/$(dirname "$deploy_file")"
  # Hard links keep the gigabyte-sized installed workspace cheap to assemble; symlinks stay relative.
  if ! cp -al "$repository/$deploy_file" "$artifact/$deploy_file" 2>/dev/null; then
    rm -rf "${artifact:?}/${deploy_file:?}"
    cp -Rp "$repository/$deploy_file" "$artifact/$deploy_file"
  fi
done

log="$artifact/migrator.log"
(cd "$artifact/app" && exec node scripts/run-zerops-migrator.mjs) >"$log" 2>&1 &
migrator=$!
stop_migrator() {
  kill "$migrator" 2>/dev/null || true
  wait "$migrator" 2>/dev/null || true
}
trap stop_migrator EXIT INT TERM

elapsed=0
until curl --silent --fail --output /dev/null "http://127.0.0.1:$port/ready"; do
  if ! kill -0 "$migrator" 2>/dev/null; then
    cat "$log"
    echo "The assembled migrator exited before serving /ready" >&2
    exit 1
  fi
  if [ "$elapsed" -ge "$timeout_seconds" ]; then
    cat "$log"
    echo "The assembled migrator did not serve /ready within ${timeout_seconds}s" >&2
    exit 1
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

cat "$log"
echo "The assembled migrator artifact migrated, verified and served /ready"
