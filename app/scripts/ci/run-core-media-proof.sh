#!/usr/bin/env bash
# Run from app/. The Core Media proof of one integration lane: the Shell end-to-end suites (#1446), the
# core-runtime S3 provider suites and the real Catalog-to-Core chain against a real S3-compatible emulator
# (MinIO, NOT Cloudflare R2), with D20_E2E_REQUIRED=1 so a case this run cannot execute fails instead of
# skipping. Needs the lane's PostgreSQL and SpiceDB, the emulator of start-core-media-object-store.sh, the
# gateway keys of the environment and this commit's built Catalog, Market Catalog and Shell artifacts.
# It ends by writing the evidence record from the reports of this very run, also when a suite failed.
set -euo pipefail

: "${ONTOS_CI_MINIO_ROOT_USER:?}"
: "${ONTOS_CI_MINIO_ROOT_PASSWORD:?}"
: "${ONTOS_CI_MINIO_BUCKET:?}"
: "${ONTOS_CI_MINIO_PORT:?}"
: "${ONTOS_CI_CORE_MEDIA_S3_RELAY_PORT:?}"
: "${ONTOS_CI_CORE_MEDIA_ENGINE_RELAY_PORT:?}"
: "${ONTOS_CI_CORE_MEDIA_COMPOSITION_PORT:?}"
: "${CORE_MEDIA_EVIDENCE_DIR:?}"
: "${ONTOS_GATEWAY_ISSUER:?}"
: "${ONTOS_GATEWAY_PRIVATE_JWK:?}"
: "${ONTOS_GATEWAY_PUBLIC_JWKS:?}"
: "${SPICEDB_ENDPOINT:?}"

shell_package=apps/shell-super-app
core_package=packages/core-runtime
digest_guard=tests/integration/core-media-e2e-digest-step-guard.test.ts

export D20_E2E_REQUIRED=1
export CORE_MEDIA_S3_ACCESS_KEY_ID="$ONTOS_CI_MINIO_ROOT_USER"
export CORE_MEDIA_S3_SECRET_ACCESS_KEY="$ONTOS_CI_MINIO_ROOT_PASSWORD"
export CORE_MEDIA_S3_BUCKET="$ONTOS_CI_MINIO_BUCKET"
export CORE_MEDIA_S3_REGION=us-east-1
export CORE_MEDIA_S3_ADDRESSING_STYLE=path
export CORE_MEDIA_S3_CONDITIONAL_CREATE=supported
unset CORE_MEDIA_DIGEST_STEP_TIMEOUT_MS CORE_MEDIA_S3_ALLOW_REMOTE CORE_MEDIA_S3_PART_SIZE_BYTES CORE_MEDIA_S3_REQUEST_TIMEOUT_MS

emulator="http://127.0.0.1:$ONTOS_CI_MINIO_PORT"
# The record names the emulator image that actually answered, not the one a file pins.
ONTOS_CI_MINIO_IMAGE="$(docker inspect --format '{{.Config.Image}}' "${ONTOS_CI_MINIO_CONTAINER:-ontos-ci-minio}")"
export ONTOS_CI_MINIO_IMAGE
# The Shell suites reach the emulator and the engine through relays their harness starts, so it can cut them.
shell_environment=(
  "CORE_MEDIA_S3_ENDPOINT=http://127.0.0.1:$ONTOS_CI_CORE_MEDIA_S3_RELAY_PORT"
  "D20_E2E_S3_UPSTREAM=$emulator"
  "D20_E2E_ENGINE_UPSTREAM=$SPICEDB_ENDPOINT"
  "SPICEDB_ENDPOINT=localhost:$ONTOS_CI_CORE_MEDIA_ENGINE_RELAY_PORT"
  # With isolated workers the Rstest setup assigns the lane's engine; this keeps the relay in front of it.
  "ONTOS_CI_ENGINE_RELAY_PORT=$ONTOS_CI_CORE_MEDIA_ENGINE_RELAY_PORT"
  "ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL=http://127.0.0.1:$ONTOS_CI_CORE_MEDIA_COMPOSITION_PORT/composition"
  "D20_E2E_GATEWAY_PRIVATE_JWK=$ONTOS_GATEWAY_PRIVATE_JWK"
)

shell_files=()
for file in "$shell_package"/tests/integration/core-media-e2e-*.test.ts; do
  file="${file#"$shell_package"/}"
  if [[ "$file" != "$digest_guard" ]]; then shell_files+=("$file"); fi
done
core_files=(
  tests/integration/core-media-s3-storage.test.ts
  tests/integration/core-media-recovery-s3.test.ts
  tests/integration/core-media-upload-edge.test.ts
)
chain_file=scripts/integration/core-media-catalog-handoff.test.mts

rm -rf "$CORE_MEDIA_EVIDENCE_DIR/runs" "$CORE_MEDIA_EVIDENCE_DIR/core-media-evidence.json"
mkdir -p "$CORE_MEDIA_EVIDENCE_DIR/runs"
runs="$(cd "$CORE_MEDIA_EVIDENCE_DIR/runs" && pwd)"

# Every run is declared before any of them starts: a run that never reports stays NOT VERIFIED in the record.
# A package of `.` is app/ itself, whose files are already named from there.
declare_run() {
  local name="$1" package="$2" prefix="$2/"
  shift 2
  if [[ "$package" == . ]]; then prefix=''; fi
  printf '%s\n' "$@" | sed "s|^|$prefix|" >"$runs/$name.files"
}
declare_run shell-e2e "$shell_package" "${shell_files[@]}"
declare_run shell-digest-step-guard "$shell_package" "$digest_guard"
declare_run core-runtime-s3-providers "$core_package" "${core_files[@]}"
declare_run catalog-chain . "$chain_file"

# What a run was configured with, without any credential: only these names reach the evidence record.
# shellcheck disable=SC2016 # $ENV is jq's, not the shell's.
recorded_settings='["CORE_MEDIA_S3_ENDPOINT","CORE_MEDIA_S3_BUCKET","CORE_MEDIA_S3_REGION",
  "CORE_MEDIA_S3_ADDRESSING_STYLE","CORE_MEDIA_S3_CONDITIONAL_CREATE","CORE_MEDIA_DIGEST_STEP_TIMEOUT_MS",
  "D20_E2E_REQUIRED","D20_E2E_S3_UPSTREAM","ONTOS_CI_MINIO_IMAGE"]
  | map({ key: ., value: $ENV[.] }) | map(select(.value != null)) | from_entries'

status=0
# One case builds a whole world (a cloned database, two installed tenants, real grants), which passed the packages'
# 30 s default on a loaded host. This is the deadline of the root integration project; no case is retried.
test_timeout_ms=120000
# Arguments: run name, package, then NAME=value settings, `--`, and the test files.
run_suites() {
  local name="$1" package="$2"
  shift 2
  local settings=()
  while [[ "$1" != -- ]]; do
    settings+=("$1")
    shift
  done
  shift
  echo "Core Media run: $name"
  env "${settings[@]}" jq --null-input "$recorded_settings" >"$runs/$name.settings.json"
  local launcher=(pnpm --filter "./$package" run test:integration)
  if [[ "$package" == . ]]; then
    launcher=(pnpm exec rstest --project integration)
  fi
  env "${settings[@]}" "ONTOS_RSTEST_JSON_REPORT=$runs/$name.report.json" \
    mise exec -- "${launcher[@]}" "$@" --pool.maxWorkers 1 --testTimeout "$test_timeout_ms" || status=1
}

run_suites shell-e2e "$shell_package" "${shell_environment[@]}" -- "${shell_files[@]}"
# The configured digest step guard must reach the Shell; the other suites keep the built-in 5 s.
run_suites shell-digest-step-guard "$shell_package" "${shell_environment[@]}" \
  CORE_MEDIA_DIGEST_STEP_TIMEOUT_MS=50 -- "$digest_guard"
run_suites core-runtime-s3-providers "$core_package" "CORE_MEDIA_S3_ENDPOINT=$emulator" -- "${core_files[@]}"
run_suites catalog-chain . "CORE_MEDIA_S3_ENDPOINT=$emulator" -- "$chain_file"

# Fails on a failed, skipped or unreported case, whatever Rstest itself exited with.
mise exec -- node scripts/ci/core-media-evidence.mts \
  --runs "$runs" --output "$CORE_MEDIA_EVIDENCE_DIR/core-media-evidence.json" || status=1
exit "$status"
