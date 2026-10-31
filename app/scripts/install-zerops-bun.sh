#!/bin/sh
# Installs only the pinned Bun JIT runtime. No compilation or runtime downloads.
# Usage: install-zerops-bun.sh <bun-version>
set -eu

bun_version="${1:?Bun version is required}"
# Published release asset digest, also listed in bun-v1.4.4/SHASUMS256.txt.
case "${bun_version}" in
  1.4.4) bun_checksum='6e9c37098b293920aed28bfb51ab240e26d23bfdd9bbfecb3ad428ac166549bc' ;;
  *)
    printf 'No pinned checksum for Bun %s\n' "${bun_version}" >&2
    exit 1
    ;;
esac
bun_target='bun-linux-x64-musl-baseline'
bun_directory="${HOME}/.local/bun-${bun_version}"
temporary_directory="$(mktemp -d)"
trap 'rm -rf "${temporary_directory}"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
archive_path="${temporary_directory}/${bun_target}.zip"

curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${bun_version}/${bun_target}.zip" -o "${archive_path}"
printf '%s  %s\n' "${bun_checksum}" "${archive_path}" | sha256sum -c -
unzip -q "${archive_path}" -d "${temporary_directory}"
installed_bun_version="$("${temporary_directory}/${bun_target}/bun" --version)"
if [ "${installed_bun_version}" != "${bun_version}" ]; then
  printf 'Expected Bun %s, installed %s\n' "${bun_version}" "${installed_bun_version}" >&2
  exit 1
fi
mkdir -p "${bun_directory}/bin"
cp "${temporary_directory}/${bun_target}/bun" "${bun_directory}/bin/bun"
printf 'Bun %s installed\n' "${installed_bun_version}"
