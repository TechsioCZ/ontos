#!/usr/bin/env sh
# Builds every unit the app host serves (the Shell plus each module of topology/application-release-intent.json)
# for the Node target, BUILD_JOBS at a time, with each unit's own package `build` script. Its `modern deploy` step
# emits .output/index.js, which scripts/zerops/owner-entry.mts turns into the unit's dist/zerops-entry.mjs: the app
# host serves every unit in-process from dist/ inside the installed workspace (.output itself is never deployed).
#
#   ONTOS_PUBLIC_ORIGIN=https://… sh scripts/zerops/build-app.sh [unit ...]
#
# Browser assets are served by the host under /_m/<appId>/, so every unit's public URL is that prefix on the one
# public origin. Logs: $BUILD_LOG_DIR/<unit>.log (default .zerops/build-logs). Run from app/.
#
# A unit whose inputs did not change keeps its previous build: dist/.zerops-build-digest records the digest of its
# committed inputs (its own directory, every workspace vertical it depends on, packages/, the root build
# configuration and the public origin). Each built dist/ is copied to $UNIT_CACHE_DIR (default .zerops/unit-cache),
# which zerops.yaml keeps in the Zerops build cache together with the Rspack caches, and restored from there.
set -eu
root="$PWD"

: "${ONTOS_PUBLIC_ORIGIN:?ONTOS_PUBLIC_ORIGIN (the public HTTPS origin of the Shell) is required}"
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

# The committed Git object ids of every input of one unit, hashed with the public origin.
unit_digest() {
  inputs="$(unit_inputs "$1")"
  {
    printf '%s\n' "$ONTOS_PUBLIC_ORIGIN"
    for input in $inputs packages scripts/zerops scripts/generate-ontos-module-contract.mts topology \
      package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json module-federation.shared.ts; do
      printf '%s %s\n' "$input" "$(git rev-parse "HEAD:app/$input")"
    done
  } | sha256sum | cut -d' ' -f1
}

build_unit() {
  unit="$1"
  dir="$(unit_dir "$unit")"
  started="$(date +%s)"
  digest="$(unit_digest "$dir")" || { echo "cannot compute the input digest of $unit" >&2; return 1; }
  if [ "$(cat "$unit_cache/$unit/.zerops-build-digest" 2>/dev/null || true)" = "$digest" ]; then
    rm -rf "$dir/dist" && cp -a "$unit_cache/$unit" "$dir/dist"
  fi
  if [ -f "$dir/$entry" ] && [ "$(cat "$dir/dist/.zerops-build-digest" 2>/dev/null || true)" = "$digest" ]; then
    echo "kept $unit (inputs unchanged)"
    return 0
  fi
  if (cd "$dir" && pnpm run build && node "$root/scripts/zerops/owner-entry.mts" "$dir") >"$log_dir/$unit.log" 2>&1; then
    printf '%s\n' "$digest" >"$dir/dist/.zerops-build-digest"
    rm -rf "$unit_cache/$unit" && cp -a "$dir/dist" "$unit_cache/$unit"
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

# The shared contract and design-token declarations every unit's declaration build references (as `pnpm build`).
for project in packages/shared-contracts packages/shared-design-tokens; do
  pnpm exec ultramodern-create ultramodern typecheck --build "$project/tsconfig.json"
done

started_all="$(date +%s)"
# xargs bounds the parallel builds (a POSIX shell cannot count its own background jobs from a subshell).
if ! printf '%s\n' $units | xargs -P "$jobs_limit" -n 1 sh "$root/scripts/zerops/build-app.sh" --unit; then
  echo "one or more unit builds failed" >&2
  exit 1
fi
echo "built $(echo "$units" | wc -w | tr -d ' ') units in $(($(date +%s) - started_all))s"
