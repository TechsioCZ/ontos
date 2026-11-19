#!/usr/bin/env bash
# The Actions cache key of a cache whose content is decided by unit identities: <prefix><sha256 of the identity lines>.
# Reads `<unit><TAB><identity>` lines on stdin (rows of the stage deploy's unit identity table) and prints
# `key=<prefix><digest>` for $GITHUB_OUTPUT. Unchanged units name the same entry on every run and every commit, so a
# run whose units did not change finds its entry and saves nothing; a changed unit names a new one. No identity lines,
# a line without an identity, or a failed hash prints nothing and fails, so a caller never saves under a key that
# proves nothing.
#
#   … | bash scripts/ci/cache-entry-key.sh <prefix>
set -euo pipefail

prefix="${1:?usage: cache-entry-key.sh <prefix>}"
lines="$(LC_ALL=C sort)"
if [ -z "$lines" ]; then
  echo 'cache-entry-key.sh: no unit identities on stdin' >&2
  exit 1
fi
while IFS= read -r line; do
  if ! [[ "$line" =~ ^[a-z0-9./_-]+$'\t'[a-f0-9]{64}([[:space:]].*)?$ ]]; then
    echo "cache-entry-key.sh: not a unit identity: $line" >&2
    exit 1
  fi
done <<<"$lines"
digest="$(printf '%s\n' "$lines" | sha256sum)"
digest="${digest%% *}"
if ! [[ "$digest" =~ ^[a-f0-9]{64}$ ]]; then
  echo 'cache-entry-key.sh: the identity hash failed' >&2
  exit 1
fi
printf 'key=%s%s\n' "$prefix" "$digest"
