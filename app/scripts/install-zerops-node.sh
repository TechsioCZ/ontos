#!/bin/sh
set -eu

node_version='26.5.0'
node_archive="node-v${node_version}-linux-x64-musl.tar.gz"
node_checksum='00f1398411a4216c5a6ecaad3b825a0da5ec00e79ee8c173ab65a094d97b9ad8'
node_directory="${HOME:-/var/www}/.local/node-${node_version}"
temporary_directory="$(mktemp -d)"
archive_path="${temporary_directory}/${node_archive}"
archive_url="https://unofficial-builds.nodejs.org/download/release/v${node_version}/${node_archive}"
trap 'rm -rf "${temporary_directory}"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "${archive_url}" -o "${archive_path}"
else
  node -e '
    const [url, output] = process.argv.slice(1);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Node archive download failed with HTTP ${response.status}`);
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(output, Buffer.from(await response.arrayBuffer()));
  ' "${archive_url}" "${archive_path}"
fi
printf '%s  %s\n' "${node_checksum}" "${archive_path}" | sha256sum -c -
mkdir -p "${node_directory}"
tar -xzf "${archive_path}" -C "${node_directory}" --strip-components=1

if [ "${1:-}" = '--with-pnpm' ]; then
  PATH="${node_directory}/bin:${PATH}" "${node_directory}/bin/npm" install --global --prefix "${node_directory}" pnpm@11.17.0
fi

"${node_directory}/bin/node" --version
