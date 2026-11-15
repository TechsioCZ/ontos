#!/bin/sh
# Unpacks the app's release archive (scripts/zerops/pack-app-release.sh) into /var/www/app before the start command,
# as the `app` setup's `run.initCommands`. Zerops runs it on every start of a runtime container, a restart included.
#
# It never leaves a tree the start command could run from half-written: the archive goes into a scratch directory, and
# only a complete tree, stamped with the archive's digest, is renamed to app/. A tree that already carries this
# release's digest is kept as it is (a restart of a container whose disk outlived the process); anything else is
# replaced. The archive is removed only after the rename, so a start interrupted at any point unpacks again. /bin/sh has
# no pipefail: zstd's status and tar's are both checked, and a failed unpack removes its scratch tree, keeps the archive
# for the next start and stops this one.
#
#   sh .zerops-release/unpack.sh            (from /var/www)
set -eu

release='.zerops-release'
archive="$release/app.tar.zst"
stamp='app/.zerops-release-digest'
scratch='.zerops-release-unpack'

# A SHA-256 as 64 lowercase hex digits, or nothing.
hex64() {
  case "$1" in
    *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 64 ]
}

expected="$(cat "$archive.sha256")"
if ! hex64 "$expected"; then
  echo "app release digest record '$expected' is not a SHA-256; refusing to start" >&2
  exit 1
fi
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$expected" ]; then
  rm -rf app.previous "$scratch" "$archive"
  echo "app release $expected is already unpacked"
  exit 0
fi
if [ ! -f "$archive" ]; then
  echo "app release $expected: no archive and no complete tree to start from" >&2
  exit 1
fi

started="$(date +%s)"
if ! actual="$(sha256sum "$archive")"; then
  echo "app release archive digest could not be computed; refusing to unpack" >&2
  exit 1
fi
actual="${actual%% *}"
if ! hex64 "$actual"; then
  echo "app release archive digest '$actual' is not a SHA-256; refusing to unpack" >&2
  exit 1
fi
if [ "$actual" != "$expected" ]; then
  echo "app release archive digest $actual differs from $expected; refusing to unpack" >&2
  exit 1
fi
rm -rf "$scratch"
mkdir -p "$scratch"
status="$scratch.zstd-status"
rm -f "$status"
if ! { zstd -q -dc "$archive"; echo "$?" >"$status"; } | tar --extract --file - -C "$scratch" ||
  [ "$(cat "$status" 2>/dev/null || true)" != 0 ]; then
  zstd_status="$(cat "$status" 2>/dev/null || echo none)"
  rm -rf "$scratch" "$status"
  echo "app release $expected could not be unpacked (zstd status $zstd_status); the archive stays for the next start" >&2
  exit 1
fi
rm -f "$status"
test -f "$scratch/app/scripts/zerops/app-host.mts"
printf '%s\n' "$expected" >"$scratch/$stamp"
rm -rf app.previous
if [ -e app ]; then mv app app.previous; fi
mv "$scratch/app" app
rm -rf app.previous "$scratch" "$archive"
echo "unpacked app release $expected in $(($(date +%s) - started))s"
