#!/bin/sh
# Packs the runner-built unit outputs into the one archive the app push carries (app/.zerops-prebuilt.tar.zst). The
# Zerops app build unpacks it with a plain `zstd -dc … | tar -x -C app` (zerops.yaml) and keeps every unit whose digest
# matches. The archive is most of the app package, and Zerops silently truncates an upload slower than about 30 s.
#
#   sh pack-prebuilt-units.sh <units-directory> <archive>   (the directory holds apps/<unit>/dist and verticals/<unit>/dist)
#
# The units bundle the same framework and workspace code over and over (about 870 MB of tar, of which -12 alone made
# 151 MB). A 128 MiB long-distance window finds those copies: --long=27 is the largest window every zstd decodes
# without a flag, so the Zerops build's plain `zstd -dc` reads it. Members are ordered by their path below dist/ and
# then by unit, so each unit's copy of a file sits next to the others' (30 MB measured on run 43700204071's units; any
# order stays below 45 MB). The order is fixed, so every deploy packs the same way.
#
# Before anything is pushed, the archive is decoded exactly as the Zerops build decodes it and its members are compared
# with the units on disk: an archive Zerops cannot read, or one missing a file, fails here.
set -eu

units="${1:?the directory holding the unit outputs is required}"
archive="${2:?the archive path is required}"
work="$(mktemp -d "${TMPDIR:-/tmp}/prebuilt-units.XXXXXX")"
trap 'rm -rf "$work"' EXIT HUP INT TERM

# Files and links only: tar creates the directories on extraction. Paths are relative and sorted in the C locale.
(cd "$units" && find . \( -type f -o -type l \) -print) | sed 's#^\./##' >"$work/members"
if [ ! -s "$work/members" ]; then
  echo "no unit outputs under $units" >&2
  exit 1
fi
if grep -vqE '^(apps|verticals)/[a-z0-9-]+/dist/' "$work/members"; then
  echo "not a unit output: $(grep -vE '^(apps|verticals)/[a-z0-9-]+/dist/' "$work/members" | head -1)" >&2
  exit 1
fi
awk '{ print substr($0, index($0, "/dist/") + 6) "\t" $0 }' "$work/members" | LC_ALL=C sort | cut -f 2 >"$work/order"

started="$(date +%s)"
tar -cf - -C "$units" --no-recursion -T "$work/order" | zstd -q -12 --long=27 -T0 -o "$archive" -f

# Decode as the Zerops build does (no window flag) and require every member, and nothing else.
zstd -dc "$archive" | tar -tf - | LC_ALL=C sort >"$work/packed"
LC_ALL=C sort "$work/members" >"$work/expected"
if ! cmp -s "$work/packed" "$work/expected"; then
  echo "the unit archive does not decode to the unit outputs:" >&2
  diff "$work/expected" "$work/packed" | head -20 >&2 || true
  exit 1
fi
echo "packed $(wc -l <"$work/members" | tr -d ' ') unit files into $archive: $(($(wc -c <"$archive") / 1000000)) MB, checked with a plain zstd -dc, $(($(date +%s) - started))s"
