#!/bin/sh
# Packs the app container's runtime tree into one release archive at the end of the Zerops `app` build, from the
# repository root (/build/source). Zerops then moves one compressed file from the build to the runtime container
# instead of the whole tree file by file (858.8 MiB, 176 s on 2026-11-15); `run.initCommands` unpacks it with
# scripts/zerops/unpack-app-release.sh, which this script ships beside the archive.
#
#   .zerops-release/app.tar.zst          the paths of scripts/zerops/app-runtime-paths.txt, as built, without the
#                                        installed packages of scripts/zerops/app-runtime-excluded-packages.txt
#                                        (proven complete without them by scripts/zerops/prove-app-runtime.mts)
#   .zerops-release/app.tar.zst.sha256   its SHA-256, checked before anything is unpacked
#   .zerops-release/unpack.sh            the unpack step
set -eu

list='app/scripts/zerops/app-runtime-paths.txt'
excluded='app/scripts/zerops/app-runtime-excluded-packages.txt'
release='.zerops-release'
archive="$release/app.tar.zst"

paths="$(grep -v -e '^#' -e '^$' "$list")"
for path in $paths; do
  if [ ! -e "$path" ]; then
    echo "app runtime path $path is missing from the build" >&2
    exit 1
  fi
done

# Every left-out package is its pnpm store directories, `@scope/name` stored as `@scope+name@<version…>`. GNU tar
# matches exclusions anywhere unless anchored; bsdtar (local tests) always anchors them at the member name.
if [ ! -f "$excluded" ]; then
  echo "the list of left-out packages $excluded is missing" >&2
  exit 1
fi
set --
if tar --version 2>/dev/null | grep -q 'GNU tar'; then set -- --anchored; fi
# Names hold no spaces; `set -f` keeps their `*` from matching files here.
set -f
# shellcheck disable=SC2013 # one package name per line, no spaces.
for name in $(grep -v -e '^#' -e '^[[:space:]]*$' "$excluded"); do
  set -- "$@" "--exclude=app/node_modules/.pnpm/$(printf '%s' "$name" | sed 's#/#+#')@*"
done
set +f

started="$(date +%s)"
rm -rf "$release"
# Built beside and renamed in: a pack that fails leaves no .zerops-release at all, so the build fails on deployFiles
# even if a caller ignored this script's status. /bin/sh has no pipefail, so tar's status is checked explicitly.
staging="$release.next"
rm -rf "$staging"
mkdir -p "$staging"
status="$staging.tar-status"
rm -f "$status"
# GNU tar (build prepareCommands): long pnpm paths and relative symlinks stay as they are.
# shellcheck disable=SC2086 # paths is a list of repository-relative paths without spaces.
if ! { tar --create --file - "$@" $paths; echo "$?" >"$status"; } | zstd -q -T0 -3 -o "$staging/app.tar.zst" ||
  [ "$(cat "$status" 2>/dev/null || true)" != 0 ]; then
  tar_status="$(cat "$status" 2>/dev/null || echo none)"
  rm -rf "$staging" "$status"
  echo "the app runtime tree could not be packed (tar status $tar_status)" >&2
  exit 1
fi
rm -f "$status"
if ! digest="$(sha256sum "$staging/app.tar.zst")"; then
  rm -rf "$staging"
  echo 'the app release digest could not be computed' >&2
  exit 1
fi
digest="${digest%% *}"
case "$digest" in
  *[!0-9a-f]* | '') digest_ok=false ;;
  *) [ "${#digest}" -eq 64 ] && digest_ok=true || digest_ok=false ;;
esac
if [ "$digest_ok" != true ]; then
  rm -rf "$staging"
  echo "the app release digest '$digest' is not a SHA-256" >&2
  exit 1
fi
printf '%s\n' "$digest" >"$staging/app.tar.zst.sha256"
cp app/scripts/zerops/unpack-app-release.sh "$staging/unpack.sh"
mv "$staging" "$release"
echo "packed the app runtime tree into $archive: $(du -h "$archive" | cut -f 1), sha256 $(cat "$archive.sha256"), $(($(date +%s) - started))s"
