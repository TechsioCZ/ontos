#!/bin/sh
# Provision the pinned STORMWARE POHODA XML dataPack 2.0 schemas the finance-billing POHODA export
# tests validate against. The repository does not redistribute the third-party schemas: this script
# downloads them from the official https://www.stormware.cz/schema/version_2/ location and checks
# every file against the SHA-256 pins in
# verticals/finance-billing/tests/fixtures/pohoda-xsd/version-2.sha256.
#
# The files land in the directory POHODA_XSD_DIR names, or in the workspace cache
# node_modules/.cache/pohoda-xsd/version_2 that the tests read by default. A file that already
# matches its pin is left in place, so a warm cache needs no network. `--check` verifies an existing
# directory without downloading.
#
# Usage: provision-pohoda-xsd.sh [--check]
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_root=$(CDPATH= cd -- "${script_directory}/.." && pwd)
manifest="${app_root}/verticals/finance-billing/tests/fixtures/pohoda-xsd/version-2.sha256"
source_base='https://www.stormware.cz/schema/version_2'
directory="${POHODA_XSD_DIR:-${app_root}/node_modules/.cache/pohoda-xsd/version_2}"

check_only=0
if [ "${1:-}" = '--check' ]; then
  check_only=1
fi

if [ ! -f "${manifest}" ]; then
  printf 'Missing the POHODA schema pin manifest: %s\n' "${manifest}" >&2
  exit 1
fi

# `sha256sum` is GNU coreutils (CI); macOS ships the same format in `shasum -a 256`.
if command -v sha256sum >/dev/null 2>&1; then
  verify() { printf '%s  %s\n' "$1" "$2" | sha256sum --check --status -; }
elif command -v shasum >/dev/null 2>&1; then
  verify() { printf '%s  %s\n' "$1" "$2" | shasum -a 256 --check --status -; }
else
  printf 'Neither sha256sum nor shasum is available to verify the POHODA schemas\n' >&2
  exit 1
fi

mkdir -p "${directory}"

missing=0
while read -r checksum name; do
  [ -n "${checksum}" ] || continue
  target="${directory}/${name}"
  if [ -f "${target}" ] && verify "${checksum}" "${target}"; then
    continue
  fi
  if [ "${check_only}" -eq 1 ]; then
    printf 'Missing or mismatched POHODA schema: %s\n' "${target}" >&2
    missing=1
    continue
  fi
  partial="${target}.download"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "${source_base}/${name}" --output "${partial}"
  if ! verify "${checksum}" "${partial}"; then
    rm -f "${partial}"
    printf 'POHODA schema %s did not match its pinned SHA-256\n' "${name}" >&2
    exit 1
  fi
  mv "${partial}" "${target}"
done <"${manifest}"

if [ "${missing}" -ne 0 ]; then
  exit 1
fi

printf 'POHODA dataPack 2.0 schemas ready at %s\n' "${directory}"
