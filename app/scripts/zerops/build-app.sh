#!/usr/bin/env sh
# Builds every unit the app host serves (the Shell plus each module of topology/application-release-intent.json)
# for the Node target, BUILD_JOBS at a time, with each unit's own package `build` script. Its `modern deploy` step
# emits .output/index.js, which scripts/zerops/owner-entry.mts turns into the unit's dist/zerops-entry.mjs: the app
# host serves every unit in-process from dist/ inside the installed workspace (.output itself is never deployed).
#
#   ONTOS_PUBLIC_ORIGIN=https://… ONTOS_STOREFRONT_ORIGIN=https://… sh scripts/zerops/build-app.sh [unit ...]
#
# Browser assets are served by the host under /_m/<appId>/, so every unit's public URL is that prefix on the one
# public origin. The AKROS storefront origin is baked into the bundles that link to it or load its product images.
# Logs: $BUILD_LOG_DIR/<unit>.log (default .zerops/build-logs, git-ignored). Run from app/.
#
# A unit whose inputs did not change keeps its previous build: dist/.zerops-build-digest records the digest of its
# committed inputs (its own directory, every workspace vertical it depends on, packages/, the root build
# configuration and the public origins). Each built dist/ is copied to $UNIT_CACHE_DIR (default .zerops/unit-cache),
# which zerops.yaml keeps in the Zerops build cache together with the Rspack caches, and restored from there.
set -eu
root="$PWD"

: "${ONTOS_PUBLIC_ORIGIN:?ONTOS_PUBLIC_ORIGIN (the public HTTPS origin of the Shell) is required}"
: "${ONTOS_STOREFRONT_ORIGIN:?ONTOS_STOREFRONT_ORIGIN (the public HTTPS origin of the AKROS storefront) is required}"
jobs_limit="${BUILD_JOBS:-2}"
log_dir="${BUILD_LOG_DIR:-.zerops/build-logs}"
entry='dist/zerops-entry.mjs'
unit_cache="${UNIT_CACHE_DIR:-.zerops/unit-cache}"
mkdir -p "$log_dir" "$unit_cache"

env_name() { printf 'ULTRAMODERN_PUBLIC_URL_%s' "$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')"; }
unit_dir() { [ "$1" = shell-super-app ] && printf 'apps/shell-super-app' || printf 'verticals/%s' "$1"; }

all_units="shell-super-app $(node -e 'for (const m of require("./topology/application-release-intent.json").modules) console.log(m.appId)')"
if [ "${1:-}" = --unit ]; then
  units="$2"
elif [ "$#" -gt 0 ]; then
  units="$*"
else
  units="$all_units"
fi

export ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP="$ONTOS_PUBLIC_ORIGIN"
export ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT="$ONTOS_STOREFRONT_ORIGIN"
# Every unit sees every public URL: the Shell build names each remote.
for unit in $all_units; do
  [ "$unit" = shell-super-app ] || export "$(env_name "$unit")=$ONTOS_PUBLIC_ORIGIN/_m/$unit"
done
export ULTRAMODERN_DISABLE_BUILD_TS_CHECKER="${ULTRAMODERN_DISABLE_BUILD_TS_CHECKER:-1}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"

# Workspace verticals one unit depends on, transitively (packages/ is hashed whole).
unit_inputs() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const seen = new Set();
    const visit = (dir) => {
      if (seen.has(dir)) return;
      seen.add(dir);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
        if (String(range).startsWith("workspace:")) {
          visit(path.relative(process.cwd(), fs.realpathSync(path.join(dir, "node_modules", name))));
        }
      }
    };
    visit(process.argv[1]);
    for (const dir of seen) if (!dir.startsWith("packages/")) console.log(dir);
  ' "$1"
}

# The committed Git object ids of every input of one unit, hashed with the public origins.
unit_digest() {
  inputs="$(unit_inputs "$1")"
  {
    printf '%s\n' "$ONTOS_PUBLIC_ORIGIN" "$ONTOS_STOREFRONT_ORIGIN"
    for input in $inputs packages scripts/zerops/owner-entry.mts scripts/generate-ontos-module-contract.mts topology \
      package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json module-federation.shared.ts; do
      printf '%s %s\n' "$input" "$(git rev-parse "HEAD:app/$input")"
    done
  } | sha256sum | cut -d' ' -f1
}

# Restores a unit's cached build when its inputs are unchanged; succeeds only when the unit can be kept.
keep_unit() {
  unit="$1"
  dir="$(unit_dir "$unit")"
  digest="$(unit_digest "$dir")" || { echo "cannot compute the input digest of $unit" >&2; return 2; }
  if [ "$(cat "$unit_cache/$unit/.zerops-build-digest" 2>/dev/null || true)" = "$digest" ]; then
    rm -rf "$dir/dist" && cp -a "$unit_cache/$unit" "$dir/dist"
  fi
  [ -f "$dir/$entry" ] && [ "$(cat "$dir/dist/.zerops-build-digest" 2>/dev/null || true)" = "$digest" ]
}

build_unit() {
  started="$(date +%s)"
  status=0
  keep_unit "$1" || status=$?
  [ "$status" -eq 0 ] && return 0
  [ "$status" -eq 1 ] || return 1
  if (cd "$dir" && pnpm run build && node "$root/scripts/zerops/owner-entry.mts" "$dir") >"$log_dir/$unit.log" 2>&1; then
    printf '%s\n' "$digest" >"$dir/dist/.zerops-build-digest"
    rm -rf "${unit_cache:?}/$unit" && cp -a "$dir/dist" "$unit_cache/$unit"
    echo "built $unit in $(($(date +%s) - started))s"
  else
    tail -60 "$log_dir/$unit.log" >&2
    echo "build failed: $unit (log $log_dir/$unit.log)" >&2
    return 1
  fi
}

if [ "${1:-}" = --unit ]; then
  build_unit "$2"
  exit $?
fi

started_all="$(date +%s)"
pending=''
for unit in $units; do
  status=0
  keep_unit "$unit" || status=$?
  case "$status" in
    0) echo "kept $unit (inputs unchanged)" ;;
    1) pending="$pending $unit" ;;
    *) exit 1 ;;
  esac
done

if [ -n "$pending" ]; then
  # The shared contract and design-token declarations every unit's declaration build references (as `pnpm build`).
  for project in packages/shared-contracts packages/shared-design-tokens; do
    pnpm exec ultramodern-create ultramodern typecheck --build "$project/tsconfig.json"
  done
  # xargs bounds the parallel builds (a POSIX shell cannot count its own background jobs from a subshell).
  # shellcheck disable=SC2086
  if ! printf '%s\n' $pending | xargs -P "$jobs_limit" -n 1 sh "$root/scripts/zerops/build-app.sh" --unit; then
    echo "one or more unit builds failed" >&2
    exit 1
  fi
fi
echo "built$pending ($(echo "$units" | wc -w | tr -d ' ') units ready) in $(($(date +%s) - started_all))s"

# The Outbox Worker host bundles every hosted owner's worker under the release identity that owner's dist was built
# with, so the composition admits each owner's outbox subscriptions (scripts/materialize-outbox-worker.mjs).
if [ "$units" = "$all_units" ]; then
  revisions="$(node -e '
    const fs = require("node:fs");
    const hosted = [...fs.readFileSync("scripts/outbox-worker-host.generated.mts", "utf8").matchAll(/from '"'"'@app\/([a-z-]+)\/outbox-worker-host'"'"'/gu)].map((m) => m[1]);
    const dir = (id) => (id === "shell-super-app" ? "apps/shell-super-app" : `verticals/${id}`);
    const revision = (id) => JSON.parse(fs.readFileSync(`${dir(id)}/dist/ultramodern-build.json`, "utf8")).deliveryUnit.sourceRevision;
    console.log(JSON.stringify(Object.fromEntries(hosted.map((id) => [id, revision(id)]))));
  ')"
  started="$(date +%s)"
  # The host bundle names this checkout's revision only from a clean tree; show what makes it dirty.
  dirty="$(git status --porcelain --untracked-files=all | head -20)"
  [ -z "$dirty" ] || printf 'the Git tree is not clean, so the host build reads as workspace:\n%s\n' "$dirty" >&2
  ONTOS_OUTBOX_HOST_OWNER_REVISIONS="$revisions" ULTRAMODERN_SOURCE_REVISION="$(git rev-parse HEAD)" \
    pnpm run zerops:materialize --app outbox-worker-host --package app --package-dir . --worker >"$log_dir/outbox-worker-host.log" 2>&1 ||
    { tail -60 "$log_dir/outbox-worker-host.log" >&2; echo 'outbox worker host build failed' >&2; exit 1; }
  echo "built outbox-worker-host in $(($(date +%s) - started))s"
fi
