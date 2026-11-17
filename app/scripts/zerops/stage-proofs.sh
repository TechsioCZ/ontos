#!/usr/bin/env bash
# The stage proofs of the delivery (.github/actions/deliver-stage), run from app/ against the live app.
#
#   stage-proofs.sh start    starts the warm-up and the MCP OAuth proof side by side in the background and returns
#   stage-proofs.sh finish   verifies every service against the live app while they run, then waits for both, prints
#                            their logs and fails when the verification or either proof failed, or none was started
#
# Neither proof reads a storefront. A run that pushes the app starts them once the app is live; a run that does not
# push it starts them as soon as the browsers are installed, while its storefronts deploy. `finish` runs once every
# push of the run has finished: the storefronts sign in through the app, so each service is verified against the live
# app, and a kept service deploys nothing and is verified all the same.
#
# The warm-up keeps its full persona and destination coverage, and its personas sweep side by side, one browser context
# each (scripts/ops/stage-warmup.mts). Its budget there is a wall-clock cap, not an expected cost: when it expires with
# any declared persona or destination unread, the warm-up fails, so the visible-identifier gate never passes unread.
# The warm-up accounts, the OAuth proof's sessions and the verification account are independent and read-only, so
# all three run together. No result is ignored.
set -euo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${STAGE_SHELL_URL:?STAGE_SHELL_URL is required}"
# Both logs land in the proof artifact the delivery uploads (mcp-oauth-e2e).
export E2E_OUT_DIR="$RUNNER_TEMP/mcp-oauth-e2e"
export E2E_SHOTS_DIR="$E2E_OUT_DIR/shots"
state="$RUNNER_TEMP/stage-proofs"

# Detached from the step's output, so the step ends while the proof goes on; its exit status lands in a file.
detach() {
  local name="$1"
  shift
  (
    code=0
    "$@" || code=$?
    echo "$code" >"$state/$name.status.next"
    mv "$state/$name.status.next" "$state/$name.status"
  ) </dev/null >"$E2E_OUT_DIR/$name.log" 2>&1 &
}

start() {
  if [ -e "$state" ]; then
    echo 'the stage proofs already started in this job' >&2
    return 1
  fi
  mkdir -p "$state" "$E2E_OUT_DIR"
  # The workflow's STAGE_SHELL_URL: the Shell both proofs sign in to, and the OAuth issuer it serves.
  export ONTOS_SHELL_URL="$STAGE_SHELL_URL"
  export ONTOS_OAUTH_ISSUER="$STAGE_SHELL_URL/shell-super-app-api/oauth"
  export ONTOS_STAGE_WARMUP_ENABLED=true
  E2E_PLAYWRIGHT_MODULE="$(cd apps/shell-super-app && mise exec -- node -p "require.resolve('@playwright/test')")"
  export E2E_PLAYWRIGHT_MODULE
  detach warmup mise exec -- node scripts/ops/stage-warmup.mts
  detach oauth mise exec -- node scripts/demo/prove-mcp-oauth.mts --variant=1 --verification
  echo "started the warm-up and the MCP OAuth proof against $STAGE_SHELL_URL"
}

verify_services() {
  local service
  mise exec -- node scripts/zerops/verify-service.mjs app || return
  for service in storefront shop n1; do
    mise exec -- node scripts/zerops/verify-service.mjs "$service" || return
  done
}

finish() {
  local verified=0 warmup oauth
  if [ ! -d "$state" ]; then
    echo '::error::the warm-up and the MCP OAuth proof never started in this job'
    return 1
  fi
  verify_services || verified=$?
  until [ -e "$state/warmup.status" ] && [ -e "$state/oauth.status" ]; do sleep 1; done
  warmup="$(cat "$state/warmup.status")"
  oauth="$(cat "$state/oauth.status")"
  echo '::group::Stage warm-up'
  cat "$E2E_OUT_DIR/warmup.log"
  echo "Warm-up exit: $warmup"
  echo '::endgroup::'
  echo '::group::MCP OAuth proof'
  cat "$E2E_OUT_DIR/oauth.log"
  echo "MCP OAuth exit: $oauth"
  echo '::endgroup::'
  echo "Service verification exit: $verified"
  test "$verified" -eq 0 && test "$warmup" -eq 0 && test "$oauth" -eq 0
}

case "${1:-}" in
  start) start ;;
  finish) finish ;;
  *) echo 'usage: stage-proofs.sh start|finish' >&2; exit 2 ;;
esac
