#!/bin/sh
set -eu

# Compile the local Node artifact from app:
# ONTOS_INTERNAL_SYMMY_INGRESS=1 mise exec -- pnpm --filter @app/shell-super-app exec modern build --deploy-target node
# mise exec -- node scripts/generate-ontos-shell-runtime-contract.mts --shell-directory apps/shell-super-app --target dist
# Then run from the Shell package:
# Start ONTOS_INTERNAL_SYMMY_INGRESS=1 PORT=14328 mise exec -- pnpm serve, then run
# sh tests/support/symmy-node-ingress-smoke.sh 14328
# For the authenticated compiled poll, run the Product conformance suite with
# ONTOS_C14_COMPILED_SHELL_SMOKE=true against the isolated native fixture.
port=${1:?Supply the compiled Shell loopback port.}
case "$port" in
  *[!0-9]*) printf 'The Shell port must be numeric.\n' >&2; exit 1 ;;
esac
origin="http://127.0.0.1:$port"
shell_prefix='/shell-super-app-api'
symmy_prefix='/api/symmy/v1'
job_path="$symmy_prefix/jobs/10000000-0000-4000-8000-000000000001"
batch_path='/_data/batch'
batch_body='{"batchId":"ordinary-shell","items":[{"id":"session","method":"GET","path":"/auth/session"}],"protocolVersion":2,"sentAt":0}'
response_dir=$(mktemp -d)
trap 'rm -rf "$response_dir"' EXIT

request() (
  expected=$1
  path=$2
  shift 2
  status=$(curl --path-as-is --silent --show-error --max-time 10 \
    --dump-header "$response_dir/headers" --output "$response_dir/body" --write-out '%{http_code}' \
    "$@" "$origin$path")
  if [ "$status" != "$expected" ]; then
    printf 'Expected %s for %s, got %s\n' "$expected" "$path" "$status" >&2
    exit 1
  fi
)

batch() {
  request "$1" "$2" --header 'content-type: application/json' --data-binary "$batch_body"
}

request 401 "$job_path"
grep -qi '^content-type: application/problem+json' "$response_dir/headers"
grep -qi '^www-authenticate: ApiKey ' "$response_dir/headers"
request 405 "$job_path" --request POST
grep -qi '^allow: GET' "$response_dir/headers"
request 404 "$symmy_prefix/admin/not-enrolled"
request 404 "$shell_prefix$job_path"
request 404 "$symmy_prefix/openapi.json"
batch 404 "$symmy_prefix$batch_path"
grep -qi '^content-type: application/problem+json' "$response_dir/headers"
jq -e '.type == "https://ontos.dev/problems/symmy-route-not-found" and .status == 404' "$response_dir/body" >/dev/null
batch 404 "$symmy_prefix/%5Fdata/batch"
batch 404 "$symmy_prefix//_data/batch"
batch 200 "$shell_prefix$batch_path"
jq -e '
  .batchId == "ordinary-shell" and .protocolVersion == 2 and
  (.items | length) == 1 and .items[0].id == "session" and
  (.items[0].status | type) == "number"
' "$response_dir/body" >/dev/null
printf 'Internal Shell Symmy ingress and ordinary Shell batch passed.\n'
