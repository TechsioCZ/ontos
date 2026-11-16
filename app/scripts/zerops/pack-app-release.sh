#!/bin/sh
# Packs the app container's runtime tree into the release archives at the end of the Zerops `app` build, from the
# repository root (/build/source). Zerops then moves two compressed files from the build to the runtime container
# instead of the whole tree file by file (858.8 MiB, 176 s on 2026-11-15); `run.initCommands` unpacks them with
# scripts/zerops/unpack-app-release.sh, which this script ships beside the archives.
#
#   sh app/scripts/zerops/pack-app-release.sh [<command that builds the Outbox Worker host> …]
#
# With a command, the host builds while the rest of the runtime tree packs, and its runtime is packed on its own
# once it is done (zerops.yaml runs `build-app.sh --outbox-host` here). Without one, the host must already be built.
#
#   .zerops-release/app.tar.zst                       the paths of scripts/zerops/app-runtime-paths.txt, as built,
#                                                     without the Outbox Worker host runtime and without the
#                                                     installed packages of app-runtime-excluded-packages.txt (proven
#                                                     complete without them by scripts/zerops/prove-app-runtime.mts)
#   .zerops-release/outbox-worker-host.tar.zst        app/.zerops/runtime/outbox-worker-host
#   .zerops-release/<archive>.sha256                  each archive's SHA-256, checked before anything is unpacked
#   .zerops-release/unpack.sh                         the unpack step
set -eu

list='app/scripts/zerops/app-runtime-paths.txt'
excluded='app/scripts/zerops/app-runtime-excluded-packages.txt'
host='app/.zerops/runtime/outbox-worker-host'
release='.zerops-release'
# Staged in the git-ignored app/.zerops and renamed in at the end: the host build beside this pack names its release
# identity from a clean Git tree, and a pack that fails leaves no .zerops-release at all, so the build fails on
# deployFiles even if a caller ignored this script's status.
staging='app/.zerops/release.next'
host_pid=''

fail() {
  if [ -n "$host_pid" ]; then kill "$host_pid" 2>/dev/null || true; fi
  rm -rf "$staging"
  echo "$1" >&2
  exit 1
}

paths="$(grep -v -e '^#' -e '^$' "$list")"
for path in $paths; do
  # The host runtime is built beside the pack when a command builds it.
  if [ ! -e "$path" ] && { [ "$#" -eq 0 ] || [ "$path" != "$host" ]; }; then
    echo "app runtime path $path is missing from the build" >&2
    exit 1
  fi
done
if [ ! -f "$excluded" ]; then
  echo "the list of left-out packages $excluded is missing" >&2
  exit 1
fi

started="$(date +%s)"
rm -rf "$release" "$staging"
mkdir -p "$staging"
if [ "$#" -gt 0 ]; then
  "$@" &
  host_pid=$!
fi

# One archive: <name>.tar.zst of the given tar arguments, and its SHA-256 record. /bin/sh has no pipefail, so tar's
# status is checked explicitly.
pack() {
  name="$1"
  shift
  status="$staging/$name.tar-status"
  # GNU tar (build prepareCommands): long pnpm paths and relative symlinks stay as they are.
  if ! { tar --create --file - "$@"; echo "$?" >"$status"; } | zstd -q -T0 -3 -o "$staging/$name.tar.zst" ||
    [ "$(cat "$status" 2>/dev/null || true)" != 0 ]; then
    fail "the app runtime tree could not be packed into $name.tar.zst (tar status $(cat "$status" 2>/dev/null || echo none))"
  fi
  rm -f "$status"
  if ! digest="$(sha256sum "$staging/$name.tar.zst")"; then
    fail "the app release digest could not be computed ($name.tar.zst)"
  fi
  digest="${digest%% *}"
  case "$digest" in
    *[!0-9a-f]* | '') fail "the app release digest '$digest' is not a SHA-256 ($name.tar.zst)" ;;
  esac
  [ "${#digest}" -eq 64 ] || fail "the app release digest '$digest' is not a SHA-256 ($name.tar.zst)"
  printf '%s\n' "$digest" >"$staging/$name.tar.zst.sha256"
}

# Every left-out package is its pnpm store directories, `@scope/name` stored as `@scope+name@<version…>`. GNU tar
# matches exclusions anywhere unless anchored; bsdtar (local tests) always anchors them at the member name.
set --
if tar --version 2>/dev/null | grep -q 'GNU tar'; then set -- --anchored; fi
set -- "$@" "--exclude=$host"
# Names hold no spaces; `set -f` keeps their `*` from matching files here.
set -f
# shellcheck disable=SC2013 # one package name per line, no spaces.
for name in $(grep -v -e '^#' -e '^[[:space:]]*$' "$excluded"); do
  set -- "$@" "--exclude=app/node_modules/.pnpm/$(printf '%s' "$name" | sed 's#/#+#')@*"
done
set +f
# The host runtime is its own archive below; it may not exist yet.
main_paths="$(printf '%s\n' "$paths" | grep -vxF "$host")"
# shellcheck disable=SC2086 # main_paths is a list of repository-relative paths without spaces.
pack app "$@" $main_paths
main_seconds=$(($(date +%s) - started))

if [ -n "$host_pid" ]; then
  if ! wait "$host_pid"; then
    host_pid=''
    fail 'the Outbox Worker host build failed; nothing was released'
  fi
  host_pid=''
fi
[ -f "$host/worker.mjs" ] || fail "the Outbox Worker host build left no $host/worker.mjs"
pack outbox-worker-host "$host"

cp app/scripts/zerops/unpack-app-release.sh "$staging/unpack.sh"
mv "$staging" "$release"
echo "packed the app runtime tree into $release/app.tar.zst: $(du -h "$release/app.tar.zst" | cut -f 1), sha256 $(cat "$release/app.tar.zst.sha256"), ${main_seconds}s"
echo "packed the Outbox Worker host into $release/outbox-worker-host.tar.zst: $(du -h "$release/outbox-worker-host.tar.zst" | cut -f 1), sha256 $(cat "$release/outbox-worker-host.tar.zst.sha256"), $(($(date +%s) - started))s in all"
