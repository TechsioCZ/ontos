#!/usr/bin/env bash
# Where the app's Zerops runtime phase goes: the boot stages the new app container logged ([boot-timing], from
# scripts/zerops/boot-stage-timing.mts), its release unpack and its first traffic, read from the service's runtime log
# once the app push has FINISHED (.github/actions/deliver-stage). Measurement only: it never fails the delivery.
#
#   app-boot-stages.sh start    reads the log in the background into $RUNNER_TEMP/app-boot-stages.txt and returns
#   app-boot-stages.sh report   waits for that read (at most 120 s), prints it and adds it to the step summary
#
# The runtime log keeps only its newest 1000 lines (zcli's limit), so it is read right after FINISHED, while the boot
# is among them. The container whose boot ended last is the new one; its lines are told apart by their host name.
set -uo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
out="$RUNNER_TEMP/app-boot-stages.txt"

read_stages() {
  local log node
  log="$(mktemp)"
  if ! npm install --global @zerops/zcli@1.1.3 >/dev/null 2>&1 ||
    ! zcli login "${ZEROPS_TOKEN:?}" >/dev/null 2>&1 ||
    ! zcli service log --project-id "${ZEROPS_PROJECT_ID:?}" --service-id "${ZEROPS_APP_SERVICE_ID:?}" \
      --limit 1000 --format FULL >"$log" 2>/dev/null; then
    echo 'the app runtime log could not be read'
    return 0
  fi
  # `<pri>1 <time> <host> …`: the host of the newest completed boot.
  node="$(grep -a 'stage=host.start-to-serving' "$log" | tail -n 1 | awk '{print $3}')"
  if [ -z "$node" ]; then
    echo 'no completed app container boot among the newest 1000 runtime log lines'
    return 0
  fi
  echo "app container $node:"
  grep -aF " $node " "$log" |
    grep -aE '\[boot-timing\]|unpacked app release|app release .* is already unpacked|accepting application traffic' |
    awk '{ time = $2; sub(/^[^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ /, ""); print time "  " $0 }'
}

case "${1:-}" in
  start)
    rm -f "$out" "$out.done"
    ( read_stages >"$out" 2>&1; touch "$out.done" ) </dev/null >/dev/null 2>&1 &
    ;;
  report)
    for _ in $(seq 120); do [ -e "$out.done" ] && break; sleep 1; done
    if [ ! -e "$out.done" ]; then
      echo 'the app boot stages were not read within 120 s'
      exit 0
    fi
    cat "$out"
    { echo '### App container boot stages'; echo '```'; cat "$out"; echo '```'; } >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
    ;;
  *) echo 'usage: app-boot-stages.sh start|report' >&2; exit 2 ;;
esac
exit 0
