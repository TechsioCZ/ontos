#!/usr/bin/env bash
# Where the app's Zerops runtime phase goes: the boot stages the new app container logged ([boot-timing], from
# scripts/zerops/boot-stage-timing.mts), its release unpack and its first traffic, read from the service's runtime log
# while the app push runs (.github/actions/deliver-stage). Measurement only: it never fails the delivery.
#
#   app-boot-stages.sh start    from the app push on, reads the log every 10 s in the background until a container
#                               that started serving after the push has logged its whole boot, and returns at once
#   app-boot-stages.sh report   prints what was read and adds it to the step summary; it never waits
#
# zcli returns only the newest 1000 runtime lines, and the app logs a few hundred a minute while two containers run,
# so the boot is collected as it happens: read once after FINISHED, the unpack and the first boot stages were gone
# (run 44155794576). The container whose boot ended last is the new one; its lines are told apart by their host name.
set -uo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
out="$RUNNER_TEMP/app-boot-stages"
POLL_SECONDS=10
# The app deploy's own limit (scripts/zerops/push-service.sh): a boot that has not ended by then never will here.
POLL_LIMIT_SECONDS=2700

# The newest completed boot among <log>'s lines: the host of its last start-to-serving line, or nothing.
newest_boot() { grep -a 'stage=host.start-to-serving' "$1" | tail -n 1 | awk '{print $3}'; }

# The lines of <node>'s boot in <log>, as `<time>  <message>`, in the log's order.
boot_lines() {
  grep -aF " $2 " "$1" |
    grep -aE '\[boot-timing\]|unpacked app release|app release .* is already unpacked|accepting application traffic' |
    awk '{ time = $2; sub(/^[^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ /, ""); print time "  " $0 }'
}

collect() {
  local started read_log before node
  started="$(date +%s)"
  : >"$out/log"
  if ! npm install --global @zerops/zcli@1.1.3 >/dev/null 2>&1 || ! zcli login "${ZEROPS_TOKEN:?}" >/dev/null 2>&1; then
    echo 'the app runtime log could not be read' >"$out/stages"
    return 0
  fi
  read_log="$(mktemp)"
  # The container that served before this push: its boot is already in the log and is not the one measured.
  zcli service log --project-id "${ZEROPS_PROJECT_ID:?}" --service-id "${ZEROPS_APP_SERVICE_ID:?}" \
    --limit 1000 --format FULL >"$read_log" 2>/dev/null || true
  before="$(newest_boot "$read_log")"
  while [ $(($(date +%s) - started)) -lt "$POLL_LIMIT_SECONDS" ]; do
    if zcli service log --project-id "$ZEROPS_PROJECT_ID" --service-id "$ZEROPS_APP_SERVICE_ID" \
      --limit 1000 --format FULL >"$read_log" 2>/dev/null; then
      cat "$read_log" >>"$out/log"
      node="$(newest_boot "$read_log")"
      if [ -n "$node" ] && [ "$node" != "$before" ]; then
        { echo "app container $node:"; LC_ALL=C sort -u "$out/log" | boot_lines /dev/stdin "$node"; } >"$out/stages"
        return 0
      fi
    fi
    sleep "$POLL_SECONDS"
  done
  echo "no app container finished its boot within ${POLL_LIMIT_SECONDS}s of the push" >"$out/stages"
}

case "${1:-}" in
  start)
    rm -rf "$out"
    mkdir -p "$out"
    ( collect; touch "$out/done" ) </dev/null >/dev/null 2>&1 &
    ;;
  report)
    if [ ! -e "$out/done" ]; then
      echo 'the new app container had not finished its boot when the delivery ended'
      exit 0
    fi
    cat "$out/stages"
    { echo '### App container boot stages'; echo '```'; cat "$out/stages"; echo '```'; } >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
    ;;
  *) echo 'usage: app-boot-stages.sh start|report' >&2; exit 2 ;;
esac
exit 0
