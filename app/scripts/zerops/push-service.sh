#!/usr/bin/env bash
# Pushes the current checkout, as it is on disk (prebuilt dist/ included), to one Zerops service and waits for its
# build and deploy. Like `zcli push`, but the package uploads over HTTP/1.1 with curl: Zerops silently drops a zcli
# upload that runs longer than about 30 s.
#
#   ZEROPS_TOKEN=… [PUSH_EXCLUDE=<path>] push-service.sh <service-id> <setup> <version-name>   (from the repository root)
#
# Keep the package small and push one service at a time: Zerops silently truncates an upload that runs longer
# than about 30 s, so a slower upload goes again (UPLOAD_LIMIT_SECONDS, default 25).
set -euo pipefail

service_id="${1:?service id is required}"
setup="${2:?zerops.yaml setup is required}"
version_name="${3:?version name is required}"
: "${ZEROPS_TOKEN:?ZEROPS_TOKEN is required}"
api='https://api.app-prg1.zerops.io/api/rest/public'
auth=(-H "Authorization: Bearer $ZEROPS_TOKEN")
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/zerops-push.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# Every step line carries a UTC timestamp with milliseconds and the service name, written as it happens, so four
# parallel pushes stay readable and a stage freeze can be placed against the step that coincides with it. Lines never
# carry the token or the upload URL.
service_name="${PUSH_SERVICE_NAME:-$setup}"
stamp() {
  local now="${EPOCHREALTIME/,/.}"
  local fraction="${now#*.}000"
  TZ=UTC printf '%(%Y-%m-%dT%H:%M:%S)T.%sZ' "${now%.*}" "${fraction:0:3}"
}
log() { printf '%s [%s] %s\n' "$(stamp)" "$service_name" "$*"; }
log_error() { log "$@" >&2; }

# POSIX (pax) headers like zcli's Go archive/tar; Zerops rejects the GNU format. Installed node_modules are never
# shipped, but the two tracked files of the root node_modules are: a missing tracked file leaves the build's Git tree
# dirty, and every release identity then reads as `workspace`. Patterns are anchored at the member name, and `*`
# spans directories.
# Member names carry no './' prefix, as zcli writes them; Zerops cannot identify an archive of './…' members.
mapfile -t entries < <(find . -mindepth 1 -maxdepth 1 -printf '%P\n' | sort)
tar --format=pax --anchored --exclude='*/node_modules' --exclude='*/.output' --exclude='*.map' \
  --exclude="${PUSH_EXCLUDE:-}" -czf "$work/package.tar.gz" -- "${entries[@]}"
log "package: $(du -h "$work/package.tar.gz" | cut -f1) ($(wc -c <"$work/package.tar.gz" | tr -d ' ') bytes)"

# An upload that took longer than the limit is assumed truncated and goes again to a fresh app version.
upload_limit_seconds="${UPLOAD_LIMIT_SECONDS:-25}"
package_bytes="$(wc -c <"$work/package.tar.gz" | tr -d ' ')"
for attempt in 1 2 3; do
  log "app version create started (attempt $attempt)"
  created="$(jq -n --arg name "$version_name" '{name: $name}' |
    curl -fsS -X POST "${auth[@]}" -H 'content-type: application/json' "$api/service-stack/$service_id/app-version" -d @-)"
  version_id="$(jq -er '.id' <<<"$created")"
  upload_url="$(jq -er '.uploadUrl' <<<"$created")"
  log "app version create ended (attempt $attempt): version $version_id"
  started="$(date +%s)"
  log "upload started (attempt $attempt, $package_bytes bytes)"
  curl -fsS --http1.1 --retry 2 -X PUT -T "$work/package.tar.gz" "$upload_url" -o /dev/null
  took=$(($(date +%s) - started))
  log "upload ended (attempt $attempt, $package_bytes bytes): uploaded in ${took}s (attempt $attempt)"
  ((took <= upload_limit_seconds)) && break
  if ((attempt == 3)); then
    log_error "every upload took longer than ${upload_limit_seconds}s; Zerops would build a truncated package"
    exit 1
  fi
done

log "build and deploy request started"
process="$(jq -n --rawfile yaml app/zerops.yaml --arg setup "$setup" '{zeropsYaml: $yaml, zeropsYamlSetup: $setup}' |
  curl -fsS -X PUT "${auth[@]}" -H 'content-type: application/json' "$api/app-version/$version_id/build-and-deploy" -d @-)"
process_id="$(jq -er '.id' <<<"$process")"
log "build and deploy request ended"
log "build and deploy process $process_id for app version $version_id"
# Polling only reads, so a transient answer (408, 429, 5xx, a timeout) is asked again with back-off; Zerops finishes the
# deploy regardless. The deadline bounds the whole wait (DEPLOY_LIMIT_SECONDS, default one hour).
deadline=$((SECONDS + ${DEPLOY_LIMIT_SECONDS:-3600}))
previous_status=''
while true; do
  state="$(curl -fsS --retry 6 --retry-max-time 180 "${auth[@]}" "$api/process/$process_id")"
  status="$(jq -r '.status' <<<"$state")"
  if [ "$status" != "$previous_status" ]; then
    log "process state: $status"
    previous_status="$status"
  fi
  case "$status" in
    FINISHED) log "$setup deployed in $(($(date +%s) - started))s"; exit 0 ;;
    FAILED | CANCELED)
      log_error "$setup build and deploy $status"
      # The Actions log is public: print the failure fields and key names only, never the user who started it.
      jq -c '{keys: keys, actionName, finished, failReason, error, publicMeta}' <<<"$state" >&2 || true
      exit 1
      ;;
  esac
  if ((SECONDS >= deadline)); then
    log_error "service $service_id ($setup): build and deploy process $process_id still $status after ${DEPLOY_LIMIT_SECONDS:-3600}s"
    exit 1
  fi
  sleep 15
done
