#!/bin/sh
# Builds the prebuilt Outbox Worker host artifact. It runs inside alpine:3.23, the libc (musl) of the host's Zerops
# runtime, so the bundle's production dependencies and the Node it ships run there unchanged:
#
#   docker run --rm -v "$PWD":/src -w /src alpine:3.23 sh app/scripts/ci/build-outbox-host.sh
#
# Environment: ONTOS_OUTBOX_HOST_DIGEST (the plan's host digest, compiled into the bundle and served on /status),
# ONTOS_OUTBOX_HOST_OWNER_REVISIONS (the plan's JSON object of every hosted owner's identity revision: HEAD for an
# owner this run builds, its kept release's revision otherwise), ULTRAMODERN_SOURCE_REVISION (the clean Git HEAD the
# host is built from) and RUNNER_TEMP, where it writes outbox-host.tar.zst. The archive holds app/.zerops/runtime/outbox-worker-host/ (worker.mjs,
# worker-artifact.json and node/bin/node), which scripts/push-zerops-units.sh deploys without a Zerops build.
set -eu

: "${ONTOS_OUTBOX_HOST_DIGEST:?ONTOS_OUTBOX_HOST_DIGEST (the plan host digest) is required}"
: "${ONTOS_OUTBOX_HOST_OWNER_REVISIONS:?ONTOS_OUTBOX_HOST_OWNER_REVISIONS (the plan owner identities) is required}"
: "${ULTRAMODERN_SOURCE_REVISION:?ULTRAMODERN_SOURCE_REVISION (the clean Git HEAD) is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP (where outbox-host.tar.zst is written) is required}"
if [ "${#ONTOS_OUTBOX_HOST_DIGEST}" -ne 64 ] || [ -n "$(printf '%s' "$ONTOS_OUTBOX_HOST_DIGEST" | tr -d '0-9a-f')" ]; then
  echo 'ONTOS_OUTBOX_HOST_DIGEST must be 64 lowercase hex characters' >&2
  exit 1
fi

cd "$(dirname "$0")/../../.."
setup='outbox-worker-host'
runtime="app/.zerops/runtime/$setup"

apk add --no-cache binutils curl git jq libstdc++ tar zstd >/dev/null
# The checkout belongs to the runner user, not to this container's root; Git must still read it, or the release
# identity would silently fall back to the configured revision without the clean-tree check.
git config --global --add safe.directory "$PWD"
head="$(git rev-parse HEAD)"
if [ "$head" != "$ULTRAMODERN_SOURCE_REVISION" ]; then
  echo "ULTRAMODERN_SOURCE_REVISION $ULTRAMODERN_SOURCE_REVISION is not the checked-out HEAD $head" >&2
  exit 1
fi

# The workspace toolchain, as app/.mise.toml pins it, in its linux-musl build.
node_version="$(sed -n 's/^node = "\([^"]*\)"$/\1/p' app/.mise.toml)"
pnpm_version="$(sed -n 's/^pnpm = { version = "\([^"]*\)".*$/\1/p' app/.mise.toml)"
if [ -z "$node_version" ] || [ -z "$pnpm_version" ]; then
  echo 'app/.mise.toml must pin node and pnpm' >&2
  exit 1
fi
sh app/scripts/install-zerops-node.sh "$node_version" "$pnpm_version"
node_home="$HOME/.local/node-$node_version"
PATH="$node_home/bin:$PATH"
# Git hook installers skip CI; the container does not inherit the runner's CI variable. pnpm would put its store at
# the root of the checkout's mount, which leaves the tree dirty and the release identity unresolvable.
CI=true
pnpm_config_store_dir="$HOME/.local/share/pnpm/store"
export CI PATH pnpm_config_store_dir

# release-script-tests ran this run's supply-chain policy check; a build job holds no secrets and trusts the lockfile.
(cd app && pnpm install --frozen-lockfile --trust-lockfile --reporter append-only)
(cd app && node scripts/verify-zerops-workspace-install.mts)
(cd app && pnpm run zerops:materialize --app "$setup" --package 'app' --package-dir '.' --worker)

# No silent downgrade: a dirty tree resolves the `workspace` identity, which no published owner marker matches. Every
# hosted owner carries exactly its planned revision, and the host itself names the HEAD it was built from.
if ! jq -e --arg digest "$ONTOS_OUTBOX_HOST_DIGEST" --arg revision "$head" --arg setup "$setup" \
    --argjson owners "$ONTOS_OUTBOX_HOST_OWNER_REVISIONS" '
    .schemaVersion == 3 and .serviceId == $setup and .artifactDigest == $digest and .sourceRevision == $revision
    and (.ownerBuildIdentities | length > 0
      and ([.[].appId] | sort) == ($owners | keys)
      and all(.sourceRevision == $owners[.appId]))' \
    "$runtime/worker-artifact.json" >/dev/null; then
  echo "The materialized host does not carry digest $ONTOS_OUTBOX_HOST_DIGEST and every planned owner identity" >&2
  jq '{schemaVersion, serviceId, artifactDigest, sourceRevision, ownerBuildIdentities}' "$runtime/worker-artifact.json" >&2
  exit 1
fi

# The start command runs node/bin/node; npm, corepack and pnpm are build tooling the host never runs.
mkdir -p "$runtime/node/bin"
cp "$node_home/bin/node" "$runtime/node/bin/node"

# Zerops keeps no data of a package upload that runs longer than about 30 seconds (scripts/zerops-public-api.mts),
# so the host ships only what it runs, about 63 MB instead of 115 MB gzipped. The musl Node carries its debug
# information. Node never strips types under node_modules and the start command enables no source maps, so type
# declarations, TypeScript sources, source maps and Markdown are never read. Only the modern.js plugin CLI imports
# @rsbuild/core (and through it @rspack's 70 MB native binding), and nothing the bundle loads imports that CLI.
strip --strip-all "$runtime/node/bin/node"
find "$runtime/node_modules" -type f \( -name '*.map' -o -name '*.ts' -o -name '*.mts' -o -name '*.cts' \
  -o -name '*.md' \) -delete
rm -rf "$runtime/node_modules/@rsbuild" "$runtime/node_modules/@rspack"
tar --create --owner=0 --group=0 --numeric-owner --file - "$runtime" | zstd --quiet -T0 -o "$RUNNER_TEMP/outbox-host.tar.zst" -f
ls -l "$RUNNER_TEMP/outbox-host.tar.zst"
