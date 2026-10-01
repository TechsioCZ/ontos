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

# Echo stays off for every prompt; the prompt text is printed only after echo is disabled, so an
# operator tool may send each password as soon as it sees the prompt.
stty -echo
terminal_echo_disabled='true'

read_password() {
  printf 'Password for %s: ' "$1" >&2
  IFS= read -r password_value
  printf '\n' >&2
}

read_password 'demo@test.com'
techsio_demo_password="${password_value}"
read_password 'admin@techsio.test'
techsio_admin_password="${password_value}"
read_password 'demo@akros.test'
akros_demo_password="${password_value}"
read_password 'admin@akros.test'
akros_admin_password="${password_value}"
password_value=''
restore_terminal_echo

set +e
STAGE_TECHSIO_DEMO_PASSWORD="${techsio_demo_password}" \
  STAGE_TECHSIO_ADMIN_PASSWORD="${techsio_admin_password}" \
  STAGE_AKROS_DEMO_PASSWORD="${akros_demo_password}" \
  STAGE_AKROS_ADMIN_PASSWORD="${akros_admin_password}" \
  node scripts/bootstrap-stage-demo.mts
bootstrap_status=$?
set -e

techsio_demo_password=''
techsio_admin_password=''
akros_demo_password=''
akros_admin_password=''
exit "${bootstrap_status}"
