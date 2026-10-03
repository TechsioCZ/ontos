#!/bin/sh
set -eu

proof_workspace="${ULTRAMODERN_WORKSPACE_ROOT:-$PWD}"
proof_artifact_root="${ULTRAMODERN_WORKERD_ARTIFACT_ROOT:-$proof_workspace}"
proof_directory="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ontos-workerd-proof.XXXXXX")"
trap 'rm -rf "$proof_directory"' EXIT

node scripts/cloudflare-local-topology-fixture.mts prepare --intent-file "$proof_workspace/topology/application-release-intent.json" --artifact-root "$proof_artifact_root" --shell-origin http://localhost:8787 --snapshot-file "$proof_directory/active.json" --paths-file "$proof_directory/paths.json" --workerd-proof-file "$proof_directory/workerd.json"

for output in "$proof_artifact_root"/apps/*/.output "$proof_artifact_root"/verticals/*/.output
do
  printf 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://workerd-proof:workerd-proof@127.0.0.1:5432/workerd-proof\nSPICEDB_ENDPOINT=localhost:8443\nSPICEDB_PRESHARED_KEY=workerd-proof\n' > "$output/.dev.vars"
done

ULTRAMODERN_WORKERD_PROOF_FIXTURE="$proof_directory/workerd.json" ultramodern-create ultramodern cloudflare-ssr-proof
