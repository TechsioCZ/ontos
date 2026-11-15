#!/usr/bin/env bash
# Pushes the current checkout, as it is on disk (prebuilt dist/ included), to one Zerops service and waits for its
# build and deploy. Like `zcli push`, but the package uploads over HTTP/1.1 with curl: Zerops silently drops a zcli
# upload that runs longer than about 30 s.
#
#   ZEROPS_TOKEN=… [PUSH_EXCLUDE=<path>] push-service.sh <service-id> <setup> <version-name>   (from the repository root)
#
# The `storefront` and `n1` setups ship only app/zerops.yaml and the storefront the runner built (zerops-stage.yml,
# build_storefronts): app/.zerops-storefront.tar.gz and its manifest app/.zerops-storefront.json. Zerops unpacks it.
#
# Diagnostics of the upload (no secret reaches the log):
#   PUSH_PROJECT_HOSTS="<host> …"   the project's public hostnames; each attempt says whether the upload host resolves to
#                                   the same address, i.e. whether the upload enters through the project's own balancer.
#   ONTOS_PUSH_UPLOAD_LIMIT_RATE=8M an experiment, off unless set: curl --limit-rate for the upload, to test whether a
#                                   slower, steadier upload avoids the project-wide stall. A rate below package size / 25 s
#                                   (about 10M for the 230 MB app package) makes every attempt slower than the limit
#                                   below, so the upload goes three times and the push fails.
#   ONTOS_PUSH_UPLOAD_WARMUP=true   an experiment, off unless set: before the first real upload of this service (once
#                                   per push-service.sh run, so up to four times per push step), one tiny throwaway HEAD
#                                   to the same upload host. The first upload of a service stops every hostname of the
#                                   project for 20-30 s whatever the package size (86 MB and 230 MB alike) and a second
#                                   upload is clean, so this tells whether the first transfer, rather than the first
#                                   large transfer, is what stalls. The warm-up can never fail the push: any answer,
#                                   curl error or timeout (cap 15 s) is logged and the push carries on unchanged.
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
# EPOCHREALTIME and printf's %(…)T need bash 5 or later (GitHub's Ubuntu runners have it; macOS ships bash 3.2).
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
# Stage a service-specific package, never mutate the runner's shared Git index.
mkdir -p "$work/source"
case "$setup" in
  storefront | n1)
    # A storefront setup builds nothing on Zerops: the package is its zerops.yaml and the runner's archive. No source,
    # no Git history and no other service's files travel with it.
    for file in app/zerops.yaml app/.zerops-storefront.tar.gz app/.zerops-storefront.json; do
      if [ ! -f "$file" ]; then
        log_error "the $setup push needs $file (the build_storefronts artifact)"
        exit 1
      fi
    done
    mkdir -p "$work/source/app"
    cp app/zerops.yaml app/.zerops-storefront.tar.gz app/.zerops-storefront.json "$work/source/app/"
    ;;
  app)
    # Keep manifests/configs for the frozen workspace install. A storefront archive in the checkout never ships here.
    exclude=(--exclude='*/node_modules' --exclude='*/.output' --exclude='*.map'
      --exclude='*/tests' --exclude='docs' --exclude='app/docs' --exclude='*/.codex'
      --exclude='app/.zerops' --exclude='*/.next' --exclude='*/.cache' --exclude='app/.zerops-storefront.*'
      --exclude='app/akros-storefront/src' --exclude='app/akros-storefront/public'
      --exclude='app/n1-storefront/src' --exclude='app/n1-storefront/public'
      --exclude="${PUSH_EXCLUDE:-}")
    mapfile -t entries < <(find . -mindepth 1 -maxdepth 1 -printf '%P\n' | sort)
    tar --format=pax --anchored "${exclude[@]}" -cf - -- "${entries[@]}" | tar -xf - -C "$work/source"
    # Merchandise's catalog operator reads these JSON inputs directly, even in the app workspace.
    if [ -d app/akros-storefront/src/catalog-import ]; then
      mkdir -p "$work/source/app/akros-storefront/src"
      cp -a app/akros-storefront/src/catalog-import "$work/source/app/akros-storefront/src/"
    fi
    if [ -d "$work/source/.git" ]; then
      # Omitted tracked files must not turn every release identity into `workspace`. Git objects remain available
      # to the committed-input planner; skip-worktree affects only the service package's working-tree presence.
      git -C "$work/source" ls-files --deleted -z |
        git -C "$work/source" update-index --skip-worktree -z --stdin
    fi
    ;;
  *)
    log_error "unknown zerops.yaml setup: $setup"
    exit 1
    ;;
esac
mapfile -t entries < <(find "$work/source" -mindepth 1 -maxdepth 1 -printf '%P\n' | sort)
tar --format=pax -C "$work/source" -czf "$work/package.tar.gz" -- "${entries[@]}"
log "package: $(du -h "$work/package.tar.gz" | cut -f1) ($(wc -c <"$work/package.tar.gz" | tr -d ' ') bytes)"

# One Zerops API request: <method> <path under the API> [curl arguments...]. A 2xx answer's body goes to stdout. Any
# other answer fails the push with the status and the body Zerops sent, which carries its reason (a refused zerops.yaml
# names the field); the token travels only in the Authorization header and is never printed.
zerops_api() {
  local method="$1" path="$2" body code exit_code=0
  shift 2
  body="$(mktemp "$work/response.XXXXXX")"
  code="$(curl -sS -o "$body" -w '%{http_code}' -X "$method" "${auth[@]}" "$@" "$api$path")" || exit_code=$?
  if ((exit_code != 0)); then
    log_error "Zerops $method $path got no answer (curl exit $exit_code)"
    return 1
  fi
  if [[ "$code" != 2?? ]]; then
    log_error "Zerops $method $path answered HTTP $code: $(head -c 8192 "$body")"
    return 1
  fi
  cat "$body"
}

# The host of a URL, nothing else: no scheme, user info, port, path, query or fragment (the signed query is a secret).
url_host() {
  local rest="${1#*://}"
  rest="${rest%%[/?#]*}"
  rest="${rest##*@}"
  if [[ "$rest" == \[* ]]; then
    rest="${rest#\[}"
    rest="${rest%%]*}"
  elif [[ "$rest" =~ ^(.*):[0-9]+$ ]]; then
    rest="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$rest"
}

# A host's addresses, one per line (none when it does not resolve). An address literal is its own address.
host_addresses() {
  if [[ "$1" =~ ^[0-9.]+$ || "$1" == *:* ]]; then
    printf '%s\n' "$1"
  elif command -v getent >/dev/null; then
    getent ahosts "$1" | awk '{ print $1 }' | sort -u
  else
    { dig +short A "$1"; dig +short AAAA "$1"; } | grep -E '^[0-9A-Fa-f:.]+$' | sort -u
  fi
}

# The scheme and authority of a URL and nothing else: no user info, path, query or fragment (the signed query is a
# secret). The warm-up request below goes here: the same host and port the real upload reaches, without a credential.
url_origin() {
  local scheme="${1%%://*}" authority="${1#*://}"
  authority="${authority%%[/?#]*}"
  authority="${authority##*@}"
  printf '%s://%s/' "$scheme" "$authority"
}

# "family IPv4+IPv6, same address as project entry: yes" for the upload host; never an address or a URL.
upload_route() {
  local addresses project='' family='' entry=unknown
  addresses="$(host_addresses "$1" || true)"
  grep -q '\.' <<<"$addresses" && family=IPv4
  grep -q ':' <<<"$addresses" && family="${family:+$family+}IPv6"
  if [ -n "${PUSH_PROJECT_HOSTS:-}" ] && [ -n "$addresses" ]; then
    for host in $PUSH_PROJECT_HOSTS; do project+="$(host_addresses "$host" || true)"$'\n'; done
    entry=no
    if [ -n "$(comm -12 <(sort -u <<<"$addresses") <(grep -v '^$' <<<"$project" | sort -u))" ]; then entry=yes; fi
  fi
  printf 'family %s, same address as project entry: %s' "${family:-unresolved}" "$entry"
}

# Off unless set; see the header.
rate_args=()
if [ -n "${ONTOS_PUSH_UPLOAD_LIMIT_RATE:-}" ]; then
  if ! [[ "$ONTOS_PUSH_UPLOAD_LIMIT_RATE" =~ ^[0-9]+[kKmMgG]?$ ]]; then
    log_error "ONTOS_PUSH_UPLOAD_LIMIT_RATE must be a curl rate such as 8M"
    exit 1
  fi
  rate_args=(--limit-rate "$ONTOS_PUSH_UPLOAD_LIMIT_RATE")
  log "upload rate limited to $ONTOS_PUSH_UPLOAD_LIMIT_RATE (experiment)"
fi

# Off unless set; see the header. Only the words below are accepted, so a typo can neither turn the experiment on by
# accident nor read as a warm-up that ran. The value is checked before any remote mutation.
warmup_enabled=''
case "${ONTOS_PUSH_UPLOAD_WARMUP:-}" in
  '') ;;
  true | TRUE | True | 1 | yes | YES | on | ON) warmup_enabled=1 ;;
  false | FALSE | False | 0 | no | NO | off | OFF) ;;
  *)
    log_error "ONTOS_PUSH_UPLOAD_WARMUP must be true or false"
    exit 1
    ;;
esac

timing_format='namelookup=%{time_namelookup} connect=%{time_connect} appconnect=%{time_appconnect} pretransfer=%{time_pretransfer} starttransfer=%{time_starttransfer} total=%{time_total} speed_upload=%{speed_upload} size_upload=%{size_upload} http_code=%{http_code}'

# One tiny throwaway request to the host the upload goes to, before the first real upload of this service. A HEAD to the
# host root: the same address, TLS and proxy entry the upload reaches, but no path, no signed query, no user info and
# never the token, so it cannot consume the signed upload URL, cannot store anything and sends no credential anywhere
# new. Any answer, curl error or timeout is logged on the one fact line and the push continues unchanged. The cap is
# shorter than UPLOAD_LIMIT_SECONDS below, so a warm-up that hangs cannot eat the attempt's truncation budget.
warmup_timeout_seconds=15
warmup_upload() {
  local attempt="$1" host="$2" url="$3" started timing exit_code=0 note=''
  started="$(stamp)"
  timing="$(curl -sS -I --http1.1 --max-time "$warmup_timeout_seconds" -o /dev/null \
    -w "$timing_format curl_exit=%{exitcode}" "$url" 2>/dev/null)" || exit_code=$?
  ((exit_code == 0)) || note=" (the warm-up failed; the push continues)"
  log "upload warm-up (attempt $attempt, 0 bytes): host $host, started $started, ${timing:-curl_exit=$exit_code}$note"
}

# An upload that took longer than the limit is assumed truncated and goes again to a fresh app version. Zerops
# answered 2xx to a curl that sent every byte and still kept a truncated package (2026-10-30), and the API reports no
# stored size or checksum, so neither the status nor the byte count can replace this rule.
upload_limit_seconds="${UPLOAD_LIMIT_SECONDS:-25}"
package_bytes="$(wc -c <"$work/package.tar.gz" | tr -d ' ')"
for attempt in 1 2 3; do
  log "app version create started (attempt $attempt)"
  created="$(jq -n --arg name "$version_name" '{name: $name}' |
    zerops_api POST "/service-stack/$service_id/app-version" -H 'content-type: application/json' -d @-)"
  version_id="$(jq -er '.id' <<<"$created")"
  upload_url="$(jq -er '.uploadUrl' <<<"$created")"
  log "app version create ended (attempt $attempt): version $version_id"
  upload_host="$(url_host "$upload_url")"
  log "upload started (attempt $attempt, $package_bytes bytes): host $upload_host, $(upload_route "$upload_host")"
  if ((attempt == 1)) && [ -n "$warmup_enabled" ]; then
    warmup_upload "$attempt" "$upload_host" "$(url_origin "$upload_url")"
  fi
  # The clock starts after the warm-up: only the real upload is judged by the limit below, and "uploaded in N s" means
  # the upload's own duration.
  started="$(date +%s)"
  # The signed upload URL is a secret: a refused upload names its status and Zerops's answer, never the URL.
  timing="$(curl -sS --http1.1 --retry 2 "${rate_args[@]}" -X PUT -T "$work/package.tar.gz" "$upload_url" \
    -o "$work/upload-response" -w "$timing_format")"
  upload_code="${timing##*http_code=}"
  if [[ "$upload_code" != 2?? ]]; then
    log_error "upload refused (attempt $attempt): HTTP $upload_code: $(head -c 8192 "$work/upload-response")"
    exit 1
  fi
  took=$(($(date +%s) - started))
  log "upload timing (attempt $attempt): $timing"
  log "upload ended (attempt $attempt, $package_bytes bytes): uploaded in ${took}s (attempt $attempt)"
  ((took <= upload_limit_seconds)) && break
  if ((attempt == 3)); then
    log_error "every upload took longer than ${upload_limit_seconds}s; Zerops would build a truncated package"
    exit 1
  fi
done

log "build and deploy request started"
process="$(jq -n --rawfile yaml app/zerops.yaml --arg setup "$setup" '{zeropsYaml: $yaml, zeropsYamlSetup: $setup}' |
  zerops_api PUT "/app-version/$version_id/build-and-deploy" -H 'content-type: application/json' -d @-)"
process_id="$(jq -er '.id' <<<"$process")"
log "build and deploy request ended"
log "build and deploy process $process_id for app version $version_id"
# Polling only reads, so a transient answer (408, 429, 5xx, a timeout) is asked again with back-off; Zerops finishes the
# deploy regardless. The deadline bounds the whole wait (DEPLOY_LIMIT_SECONDS, default one hour).
deadline=$((SECONDS + ${DEPLOY_LIMIT_SECONDS:-3600}))
previous_status=''
while true; do
  state="$(zerops_api GET "/process/$process_id" --retry 6 --retry-max-time 180)"
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
