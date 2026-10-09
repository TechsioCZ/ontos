#!/bin/sh
# Installs the pinned Node.js and pnpm into the Zerops build environment.
# Usage: install-zerops-node.sh <node-version> <pnpm-version>
# zerops.yaml passes both versions so a toolchain bump changes the cached prepare step.
set -eu

node_version="${1:?Node version from .mise.toml is required}"
pnpm_version="${2:?pnpm version from package.json#packageManager is required}"
case "${node_version}" in
  26.7.0) node_checksum='84fc4e29e5f86022a40bac50a28a1b9275dd1f32eebbf4db499e2573ff822124' ;;
  *)
    printf 'No pinned checksum for Node %s: add the linux-x64-musl SHA-256 from unofficial-builds SHASUMS256.txt to install-zerops-node.sh\n' "${node_version}" >&2
    exit 1
    ;;
esac
node_archive="node-v${node_version}-linux-x64-musl.tar.gz"
node_directory="${HOME}/.local/node-${node_version}"
temporary_directory="$(mktemp -d)"
archive_path="${temporary_directory}/${node_archive}"
trap 'rm -rf "${temporary_directory}"' EXIT

curl -fsSL "https://unofficial-builds.nodejs.org/download/release/v${node_version}/${node_archive}" -o "${archive_path}"
printf '%s  %s\n' "${node_checksum}" "${archive_path}" | sha256sum -c -
mkdir -p "${node_directory}"
tar -xzf "${archive_path}" -C "${node_directory}" --strip-components=1

PATH="${node_directory}/bin:${PATH}" "${node_directory}/bin/npm" install --global --prefix "${node_directory}" "pnpm@${pnpm_version}"
installed_pnpm_version="$(PATH="${node_directory}/bin:${PATH}" "${node_directory}/bin/pnpm" --version)"
if [ "${installed_pnpm_version}" != "${pnpm_version}" ]; then
  printf 'Expected pnpm %s, installed %s\n' "${pnpm_version}" "${installed_pnpm_version}" >&2
  exit 1
fi

"${node_directory}/bin/node" --version
