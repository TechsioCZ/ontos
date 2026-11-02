#!/bin/sh
# Reviewed prepare-apply of scripts/demo/pseudonymize-akros-demo.mts with the new storefront key handoff.
# The key never reaches the terminal, a log, an argument or the environment: the operator writes it into a private
# container-local file (~/.ontos-operator-handoff, mode 600), a second SSH streams that file straight into
# ~/.ontos-stage-secrets/sroubshop-storefront-api-key (mode 600, never overwritten), then the remote copy is deleted.
# Usage: sh scripts/demo/pseudonymize-akros-key.sh apply <remote-plan /tmp/pseudonym-*.json> <reviewed-sha256>
#        sh scripts/demo/pseudonymize-akros-key.sh fetch   # only after an apply whose fetch step failed
set -eu
umask 077
ROUTER=/Users/satan/workspace/techsio/agent-scratch/eshop-markets
DEST="$HOME/.ontos-stage-secrets/sroubshop-storefront-api-key"
REMOTE_FILE='.ontos-operator-handoff/sroubshop-storefront-api-key'
NODE=/var/www/app/.zerops/node/bin/node
remote() {
  ssh -o UserKnownHostsFile="$ROUTER/known_hosts.app" -o StrictHostKeyChecking=yes -o BatchMode=yes app "$1"
}
usage() {
  printf 'Usage: %s apply <remote-plan> <reviewed-sha256> | fetch\n' "$0" >&2
  exit 2
}
[ "$#" -ge 1 ] || usage
MODE=$1
case "$MODE" in
  apply)
    [ "$#" -eq 3 ] || usage
    case "$2" in /tmp/pseudonym-*.json) ;; *) printf 'Use a /tmp/pseudonym-*.json reviewed plan\n' >&2; exit 2 ;; esac
    case "$3" in *[!a-f0-9]* | '') printf 'Invalid fingerprint\n' >&2; exit 2 ;; esac
    [ "${#3}" -eq 64 ] || { printf 'Invalid fingerprint\n' >&2; exit 2; }
    ;;
  fetch) [ "$#" -eq 1 ] || usage ;;
  *) usage ;;
esac
[ ! -e "$DEST" ] || { printf 'Destination already exists; the existing managed key is preserved\n' >&2; exit 1; }
mkdir -p "$HOME/.ontos-stage-secrets"
chmod 700 "$HOME/.ontos-stage-secrets"
# This exact temporary file belongs to this run and is removed on success, failure and interruption.
TEMP=$(mktemp "$HOME/.ontos-stage-secrets/.sroubshop-key.XXXXXXXX")
cleanup() { rm -f "$TEMP"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
if [ "$MODE" = apply ]; then
  "$ROUTER/run-remote.sh" scripts/demo/pseudonymize-akros-demo.mts --mode apply --phase prepare \
    --plan "$2" --reviewed-plan-sha256 "$3" --issue-key
fi
# stdout of this SSH is the key only and goes directly into the private file.
remote "$NODE --input-type=module -e 'import fs from \"node:fs\";import os from \"node:os\";process.stdout.write(fs.readFileSync(os.homedir()+\"/$REMOTE_FILE\"))'" >"$TEMP"
[ -s "$TEMP" ] || { printf 'Empty key handoff; no local key installed\n' >&2; exit 1; }
chmod 600 "$TEMP"
# ln is no-clobber and atomic, so a concurrent operator cannot overwrite an existing secret.
ln "$TEMP" "$DEST"
remote "$NODE --input-type=module -e 'import fs from \"node:fs\";import os from \"node:os\";fs.rmSync(os.homedir()+\"/$REMOTE_FILE\",{force:true})'"
printf 'Managed key installed at ~/.ontos-stage-secrets/sroubshop-storefront-api-key (mode 600); value withheld\n'
