#!/usr/bin/env bash
# The stage proofs of the delivery (.github/actions/deliver-stage), run from app/ against the live app.
#
#   stage-proofs.sh start    starts the warm-up and the MCP OAuth proof side by side in the background and returns
#   stage-proofs.sh finish   verifies every service against the live app while they run, then waits for both, prints
#                            their logs and fails when the verification or either proof failed, or none was started
#
# The background proofs do not read a storefront; finish also verifies N1 checkout in quote-only mode. A run that
# pushes the app starts them once the app is live; a run that does not starts them as soon as the browsers are installed,
# while its storefronts deploy. `finish` runs once every
# push of the run has finished: the storefronts sign in through the app, so each service is verified against the live
# app, and a kept service deploys nothing and is verified all the same.
#
# The warm-up keeps its full persona and destination coverage, and its personas sweep side by side, one browser context
# each (scripts/ops/stage-warmup.mts). Its budget there is a wall-clock cap, not an expected cost. However the sweep
# ends, a declared persona or destination left unread fails the warm-up, so the visible-identifier gate never passes
# unread.
# The warm-up accounts, the OAuth proof's sessions and the verification account are independent and read-only, so
# all three run together. No result is ignored.
set -euo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${STAGE_SHELL_URL:?STAGE_SHELL_URL is required}"
# All proof logs and N1 checkout evidence land in the proof artifact the delivery uploads (mcp-oauth-e2e).
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
  local verified=0 checkout=0 warmup oauth
  local checkout_args=(--origin "${STAGE_N1_URL:?STAGE_N1_URL is required}")
  if [ ! -d "$state" ]; then
    echo '::error::the warm-up and the MCP OAuth proof never started in this job'
    return 1
  fi
  verify_services || verified=$?
  # All selected services are live here in both delivery paths. Quote never confirms a stock-debiting order.
  E2E_PLAYWRIGHT_MODULE="$(cd apps/shell-super-app && mise exec -- node -p "require.resolve('@playwright/test')")"
  export E2E_PLAYWRIGHT_MODULE
  if [ "${PUSH_N1:-false}" = true ]; then
    checkout_args+=(--expect-build-id "${STAGE_N1_BUILD_ID:?packaged N1 build id is required}")
  else
    echo 'N1 kept: checkout is not verified yet; a VALID quote is required for the currently served build and live owner contract, not this commit.'
  fi
  # A bound on the check, not a retry: the probe also owns a 10-minute total deadline (exit 4).
  timeout --kill-after=3s 10m mise exec -- node scripts/ops/stage-n1-checkout.mts quote "${checkout_args[@]}" >"$E2E_OUT_DIR/n1-checkout.log" 2>&1 || checkout=$?
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
  echo '::group::N1 checkout quote'
  cat "$E2E_OUT_DIR/n1-checkout.log"
  echo "N1 checkout quote exit: $checkout"
  # A push of N1 needs a VALID quote. A kept N1 with no fixture is also NOT verified: exit 3 fails
  # this verification, without rolling back already-pushed services, and stays distinct in the log.
  # Broken transport/contracts/build identity (1), probe deadline (4), and caller timeout (124/137)
  # always fail delivery, after pushes, without rollback.
  if [ "$checkout" -eq 3 ]; then
    echo '::error title=N1 checkout not proved::No purchasable fixture within the check bounds; checkout verification failed (including when N1 was kept). Catalogue/stock or coverage needs attention; no rollback is attempted.'
  fi
  echo '::endgroup::'
  echo "Service verification exit: $verified"
  test "$verified" -eq 0 && test "$checkout" -eq 0 && test "$warmup" -eq 0 && test "$oauth" -eq 0
}

case "${1:-}" in
  start) start ;;
  finish) finish ;;
  *) echo 'usage: stage-proofs.sh start|finish' >&2; exit 2 ;;
esac
