#!/usr/bin/env bash
# Builds one storefront on the runner and stages its push (zerops-stage.yml, the delivery job), from app/.
#
#   build-storefront.sh <package> <setup>     akros-storefront storefront | n1-storefront n1
#
# tsrs typecheck, then `next build` with the build-time environment the setup declares in zerops.yaml. The Zerops
# `storefront` and `n1` setups only check and unpack this archive (app/zerops.yaml); they never install or build.
# `storefront` and `shop` deploy the same AKROS archive: brand, key and app id are runtime service variables.
# Staged as $RUNNER_TEMP/storefront-push/<setup>/app/{zerops.yaml,.zerops-storefront.tar.gz,.zerops-storefront.json},
# which is all a storefront push carries (scripts/zerops/push-service.sh).
set -euo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
package="${1:?package is required}"
setup="${2:?setup is required}"
case "$package:$setup" in
  akros-storefront:storefront | n1-storefront:n1) ;;
  *) echo "unknown storefront $package with setup $setup" >&2; exit 2 ;;
esac
started="$(date +%s)"
export NEXT_TELEMETRY_DISABLED=1

# `next typegen`, then tsrs over Next's tsconfig.json with the generated route types. The build still runs Next's own
# type step too, until the storefronts emit declarations cleanly under the workspace typecheck.
mise exec -- pnpm --filter "$package" run typecheck
# AKROS reads STOREFRONT_IMAGE_HOSTS (empty) in next.config.ts; N1 reads nothing at build. No secret is present.
# Next's type check holds the owner API types the storefronts import: a cold N1 build peaks near 3.3 GiB, past Node's
# default heap (about 2 GiB), so the build gets 4 GiB of the runner's 16 GB. AKROS gets the same.
if [ "$package" = akros-storefront ]; then export STOREFRONT_IMAGE_HOSTS=''; fi
NODE_OPTIONS=--max-old-space-size=4096 mise exec -- pnpm --filter "$package" run build
# Identity of the exact Next output packaged below, not the workflow commit or a separate build.
if [ "$setup" = n1 ]; then
  build_id="$(cat "$package/.next/BUILD_ID")"
  test -n "$build_id"
  printf 'STAGE_N1_BUILD_ID=%s\n' "$build_id" >>"${GITHUB_ENV:?GITHUB_ENV is required}"
fi

# The archive unpacks to app/.zerops/runtime/<package> on Zerops, where `start` runs <package>/server.js. Zerops runs
# Alpine (musl) and this runner is glibc: a native addon would load on neither side safely, so any `.node` file fails
# here. Symlinks must stay relative so they resolve after the move.
out="$RUNNER_TEMP/storefront-runtime/$setup"
push="$RUNNER_TEMP/storefront-push/$setup/app"
rm -rf "$out" "$push"
mkdir -p "$out" "$push"
mv "$package/.next/standalone" "$out/$package"
cp -a "$package/.next/static" "$out/$package/$package/.next/static"
cp -a "$package/public" "$out/$package/$package/public"
test -f "$out/$package/$package/server.js"
native="$(find "$out" -name '*.node' -print)"
if [ -n "$native" ]; then echo "::error::native addons in the standalone server:"; echo "$native"; exit 1; fi
absolute="$(find "$out" -type l -lname '/*' -print)"
if [ -n "$absolute" ]; then echo "::error::absolute symlinks in the standalone server:"; echo "$absolute"; exit 1; fi
tar --create --gzip --sort=name --owner=0 --group=0 --numeric-owner \
  --file "$push/.zerops-storefront.tar.gz" -C "$out" "$package"
# The committed inputs of this build: the storefront, the workspace sources N1 imports, and the install.
case "$package" in
  akros-storefront) inputs=(akros-storefront) ;;
  n1-storefront) inputs=(n1-storefront apps packages verticals tsconfig.json tsconfig.base.json) ;;
esac
inputs+=(package.json pnpm-lock.yaml pnpm-workspace.yaml patches .mise.toml)
input_digest="$(git ls-files -s -- "${inputs[@]}" | sha256sum | cut -d' ' -f1)"
jq -n --arg setup "$setup" --arg package "$package" --arg sourceRevision "$GITHUB_SHA" \
  --arg inputDigest "$input_digest" \
  --arg archiveSha256 "$(sha256sum "$push/.zerops-storefront.tar.gz" | cut -d' ' -f1)" \
  --arg node "$(mise exec -- node -p process.versions.node)" \
  --arg arch "$(mise exec -- node -p process.arch)" \
  '{setup: $setup, package: $package, sourceRevision: $sourceRevision, inputDigest: $inputDigest,
    archiveSha256: $archiveSha256, node: $node, arch: $arch, platform: "linux", builtLibc: "glibc",
    nativeAddons: 0}' >"$push/.zerops-storefront.json"
cp zerops.yaml "$push/zerops.yaml"
ls -lh "$push" "$push"/.zerops-storefront.*
cat "$push/.zerops-storefront.json"
echo "built and staged $package for the $setup setup in $(($(date +%s) - started))s"
