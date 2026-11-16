#!/bin/sh
# Assemble the deployed app's files and run its native migrator until it serves /ready.
# The app host uses this same migration chain before publishing the new application.
# The caller supplies an isolated stage-shaped CI database, never a live database.
# Usage: sh scripts/prove-zerops-migrator-artifact.sh <empty-artifact-directory>
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

# The app container's runtime tree: the paths the Zerops build packs into its release archive.
deploy_files="$(grep -v -e '^#' -e '^$' "$app_directory/scripts/zerops/app-runtime-paths.txt")"

printf '%s\n' "$deploy_files" | while IFS= read -r deploy_file; do
  if [ ! -e "$repository/$deploy_file" ]; then
    echo "App runtime path $deploy_file does not exist in the build" >&2
    exit 1
  fi
  mkdir -p "$artifact/$(dirname "$deploy_file")"
  # CI's installed workspace stays cheap to assemble on the same filesystem; symlinks stay relative.
  if ! cp -al "$repository/$deploy_file" "$artifact/$deploy_file" 2>/dev/null; then
    rm -rf "${artifact:?}/${deploy_file:?}"
    cp -Rp "$repository/$deploy_file" "$artifact/$deploy_file"
  fi
done

# The release pack leaves these installed packages out (scripts/zerops/pack-app-release.sh); so does this artifact, so
# the migrator is proven on the tree that ships. The copies are links or copies: removing them touches no source.
grep -v -e '^#' -e '^[[:space:]]*$' "$app_directory/scripts/zerops/app-runtime-excluded-packages.txt" |
  while IFS= read -r excluded_package; do
    find "$artifact/app/node_modules/.pnpm" -mindepth 1 -maxdepth 1 \
      -name "$(printf '%s' "$excluded_package" | sed 's#/#+#')@*" -exec rm -rf {} +
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
echo "The assembled app artifact migrated, verified and served /ready"
