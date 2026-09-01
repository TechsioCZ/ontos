#!/bin/sh
set -eu

if [ ! -t 0 ] || [ ! -t 1 ]; then
  printf '%s\n' 'Stage demo bootstrap passwords must be entered in an interactive terminal.' >&2
  exit 2
fi

script_directory="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
cd "${script_directory}/.."

terminal_echo_disabled='false'
restore_terminal_echo() {
  if [ "${terminal_echo_disabled}" = 'true' ]; then
    stty echo
    terminal_echo_disabled='false'
  fi
}
trap restore_terminal_echo EXIT HUP INT TERM

printf '%s' 'Password for demo@test.com: ' >&2
stty -echo
terminal_echo_disabled='true'
IFS= read -r techsio_password
restore_terminal_echo
printf '\n' >&2

printf '%s' 'Password for siampark01@test.com: ' >&2
stty -echo
terminal_echo_disabled='true'
IFS= read -r siampark_password
restore_terminal_echo
printf '\n' >&2

set +e
STAGE_DEMO_PASSWORD="${techsio_password}" \
  STAGE_SIAMPARK_PASSWORD="${siampark_password}" \
  node scripts/bootstrap-stage-demo.mts
bootstrap_status=$?
set -e

techsio_password=''
siampark_password=''
exit "${bootstrap_status}"
