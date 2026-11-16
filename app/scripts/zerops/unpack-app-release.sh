#!/bin/sh
# Unpacks the app's release archives (scripts/zerops/pack-app-release.sh) into /var/www/app before the start command,
# as the `app` setup's `run.initCommands`. Zerops runs it on every start of a runtime container, a restart included.
#
# It never leaves a tree the start command could run from half-written: both archives (the runtime tree and the
# Outbox Worker host) go into one scratch directory, and only a complete tree, stamped with both archives' digests,
# is renamed to app/. A tree that already carries this release's digests is kept as it is (a restart of a container
# whose disk outlived the process); anything else is replaced. The archives are removed only after the rename, so a
# start interrupted at any point unpacks again. /bin/sh has no pipefail: zstd's status and tar's are both checked, and
# a failed unpack removes its scratch tree, keeps the archives for the next start and stops this one.
#
#   sh .zerops-release/unpack.sh            (from /var/www)
set -eu

release='.zerops-release'
archives='app outbox-worker-host'
stamp='app/.zerops-release-digest'
scratch='.zerops-release-unpack'

# A SHA-256 as 64 lowercase hex digits, or nothing.
hex64() {
  case "$1" in
    *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 64 ]
}

# The release's identity: each archive's recorded digest, one per line, in archive order.
expected=''
for name in $archives; do
  digest="$(cat "$release/$name.tar.zst.sha256" 2>/dev/null || true)"
  if ! hex64 "$digest"; then
    echo "app release digest record '$digest' of $name.tar.zst is not a SHA-256; refusing to start" >&2
    exit 1
  fi
  expected="$expected$digest
"
done
remove_archives() {
  for name in $archives; do rm -f "$release/$name.tar.zst"; done
}
if [ -f "$stamp" ] && [ "$(cat "$stamp")
" = "$expected" ]; then
  rm -rf app.previous "$scratch"
  remove_archives
  echo "app release $(printf '%s' "$expected" | head -n 1) is already unpacked"
  exit 0
fi
for name in $archives; do
  if [ ! -f "$release/$name.tar.zst" ]; then
    echo "app release $(printf '%s' "$expected" | head -n 1): no $name.tar.zst and no complete tree to start from" >&2
    exit 1
  fi
done

started="$(date +%s)"
for name in $archives; do
  archive="$release/$name.tar.zst"
  recorded="$(cat "$archive.sha256")"
  if ! actual="$(sha256sum "$archive")"; then
    echo "app release archive $name.tar.zst digest could not be computed; refusing to unpack" >&2
    exit 1
  fi
  actual="${actual%% *}"
  if ! hex64 "$actual"; then
    echo "app release archive $name.tar.zst digest '$actual' is not a SHA-256; refusing to unpack" >&2
    exit 1
  fi
  if [ "$actual" != "$recorded" ]; then
    echo "app release archive $name.tar.zst digest $actual differs from $recorded; refusing to unpack" >&2
    exit 1
  fi
done
rm -rf "$scratch"
mkdir -p "$scratch"
status="$scratch.zstd-status"
for name in $archives; do
  archive="$release/$name.tar.zst"
  rm -f "$status"
  if ! { zstd -q -dc "$archive"; echo "$?" >"$status"; } | tar --extract --file - -C "$scratch" ||
    [ "$(cat "$status" 2>/dev/null || true)" != 0 ]; then
    zstd_status="$(cat "$status" 2>/dev/null || echo none)"
    rm -rf "$scratch" "$status"
    echo "app release $name.tar.zst could not be unpacked (zstd status $zstd_status); the archive stays for the next start" >&2
    exit 1
  fi
done
rm -f "$status"
test -f "$scratch/app/scripts/zerops/app-host.mts"
test -f "$scratch/app/.zerops/runtime/outbox-worker-host/worker.mjs"
printf '%s' "$expected" >"$scratch/$stamp"
rm -rf app.previous
if [ -e app ]; then mv app app.previous; fi
mv "$scratch/app" app
rm -rf app.previous "$scratch"
remove_archives
echo "unpacked app release $(printf '%s' "$expected" | head -n 1) with its Outbox Worker host in $(($(date +%s) - started))s"
