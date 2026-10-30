#!/usr/bin/env bash
# Pushes the current checkout, as it is on disk (prebuilt dist/ included), to one Zerops service and waits for its
# build and deploy. Like `zcli push`, but the package uploads over HTTP/1.1 with curl: Zerops silently drops a zcli
# upload that runs longer than about 30 s.
#
#   ZEROPS_TOKEN=… push-service.sh <service-id> <setup> <version-name>      (run from the repository root)
set -euo pipefail

service_id="${1:?service id is required}"
setup="${2:?zerops.yaml setup is required}"
version_name="${3:?version name is required}"
: "${ZEROPS_TOKEN:?ZEROPS_TOKEN is required}"
api='https://api.app-prg1.zerops.io/api/rest/public'
auth=(-H "Authorization: Bearer $ZEROPS_TOKEN")
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/zerops-push.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# POSIX (pax) headers like zcli's Go archive/tar; Zerops rejects the GNU format. node_modules is never shipped.
tar --format=pax --exclude='node_modules' --exclude='.output' --exclude='*.map' -czf "$work/package.tar.gz" .
echo "package: $(du -h "$work/package.tar.gz" | cut -f1)"

created="$(jq -n --arg name "$version_name" '{name: $name}' |
  curl -fsS -X POST "${auth[@]}" -H 'content-type: application/json' "$api/service-stack/$service_id/app-version" -d @-)"
version_id="$(jq -er '.id' <<<"$created")"
upload_url="$(jq -er '.uploadUrl' <<<"$created")"
started="$(date +%s)"
curl -fsS --http1.1 --retry 2 -X PUT -T "$work/package.tar.gz" "$upload_url" -o /dev/null
echo "uploaded in $(($(date +%s) - started))s"

process="$(jq -n --rawfile yaml app/zerops.yaml --arg setup "$setup" '{zeropsYaml: $yaml, zeropsYamlSetup: $setup}' |
  curl -fsS -X PUT "${auth[@]}" -H 'content-type: application/json' "$api/app-version/$version_id/build-and-deploy" -d @-)"
process_id="$(jq -er '.id' <<<"$process")"
echo "build and deploy process $process_id for app version $version_id"
while true; do
  status="$(curl -fsS "${auth[@]}" "$api/process/$process_id" | jq -r '.status')"
  case "$status" in
    FINISHED) echo "$setup deployed in $(($(date +%s) - started))s"; exit 0 ;;
    FAILED | CANCELED) echo "$setup build and deploy $status" >&2; exit 1 ;;
  esac
  sleep 15
done
