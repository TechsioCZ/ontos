#!/usr/bin/env bash
# Unpack the build outputs that the node-artifact-build shards packed (one `units.tar.zst` per shard, each in its own
# downloaded artifact directory) into this app workspace, then check that every delivery unit the caller requires has
# its built output directory, so a unit missing from every shard fails here, by name, instead of later in a proof.
#
# Usage: bash scripts/unpack-unit-build-outputs.sh <downloaded-artifacts-directory> <output-directory-name> [unit-path ...]
#
# With no unit paths every delivery unit of the reference topology is required (the Node proof job always asks for
# all of them). A consumer that reads only some units' outputs names exactly those (for example
# `apps/shell-super-app verticals/catalog`); a name that is no topology unit fails, so a typo cannot pass vacuously.
set -euo pipefail

artifacts_directory="${1:?the downloaded artifacts directory is required}"
output_name="${2:?the output directory name of a built unit (for example .output) is required}"
shift 2

app_directory="$(cd "$(dirname "$0")/.." && pwd)"
cd "$app_directory"

shopt -s nullglob
archives=("$artifacts_directory"/*/units.tar.zst)
if [ "${#archives[@]}" -eq 0 ]; then
  echo "No shard build outputs (*/units.tar.zst) found under $artifacts_directory." >&2
  exit 1
fi
for archive in "${archives[@]}"; do
  echo "Unpacking $archive"
  tar --extract --zstd --file "$archive"
done

topology_units="$(node -e '
  const topology = require("./topology/reference-topology.json");
  for (const unit of [topology.shell, ...topology.verticals]) console.log(unit.path);
')"
required=("$@")
if [ "${#required[@]}" -eq 0 ]; then
  while IFS= read -r unit; do
    required+=("$unit")
  done <<<"$topology_units"
fi

missing=0
for unit in "${required[@]}"; do
  if ! grep -qxF -- "$unit" <<<"$topology_units"; then
    echo "Required unit $unit is no delivery unit of topology/reference-topology.json." >&2
    missing=1
  elif [ ! -d "$unit/$output_name" ]; then
    echo "Delivery unit $unit has no $output_name: no build shard built it." >&2
    missing=1
  fi
done
exit "$missing"
