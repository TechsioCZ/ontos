#!/bin/sh
# Packs the app container's runtime tree into one release archive at the end of the Zerops `app` build, from the
# repository root (/build/source). Zerops then moves one compressed file from the build to the runtime container
# instead of the whole tree file by file (858.8 MiB, 176 s on 2026-11-15); `run.initCommands` unpacks it with
# scripts/zerops/unpack-app-release.sh, which this script ships beside the archive.
#
#   .zerops-release/app.tar.zst          the paths of scripts/zerops/app-runtime-paths.txt, exactly as built
#   .zerops-release/app.tar.zst.sha256   its SHA-256, checked before anything is unpacked
#   .zerops-release/unpack.sh            the unpack step
set -eu

list='app/scripts/zerops/app-runtime-paths.txt'
release='.zerops-release'
archive="$release/app.tar.zst"

paths="$(grep -v -e '^#' -e '^$' "$list")"
for path in $paths; do
  if [ ! -e "$path" ]; then
    echo "app runtime path $path is missing from the build" >&2
    exit 1
  fi
done

started="$(date +%s)"
rm -rf "$release"
mkdir -p "$release"
# GNU tar (build prepareCommands): long pnpm paths and relative symlinks stay as they are.
# shellcheck disable=SC2086 # paths is a list of repository-relative paths without spaces.
tar --create --file - $paths | zstd -q -T0 -3 -o "$archive"
sha256sum "$archive" | cut -d ' ' -f 1 >"$archive.sha256"
cp app/scripts/zerops/unpack-app-release.sh "$release/unpack.sh"
echo "packed the app runtime tree into $archive: $(du -h "$archive" | cut -f 1), sha256 $(cat "$archive.sha256"), $(($(date +%s) - started))s"
