#!/usr/bin/env bash
# The Actions cache key of a CI artifact that is decided entirely by committed sources:
# `key=<prefix><sha256 over every tracked input of that artifact>`, for $GITHUB_OUTPUT.
#
#   bash scripts/ci/cache-entry-key.sh <set> <prefix> [<unit> ...]
#
# The input set is defined in this file so the breadth lives next to the digest and not in a workflow
# expression:
#
#   build-outputs <prefix> <unit> ...   One shard's Node build outputs (dist/ and .output/ of its units).
#                                       Covers the shard's own units plus everything every unit build
#                                       reads: all shared packages (including the shared-contracts and
#                                       shared-design-tokens reference builds the build step runs first),
#                                       root build configuration, the topology, the scripts a build runs,
#                                       the resolved dependency graph, and the workflow and install action
#                                       that define the build commands. A unit that is not in the shard is
#                                       NOT an input, so an unrelated vertical's commit still hits.
#
# The digest includes this file, so changing the input set invalidates the entries it described.
#
# The digest is taken over `git ls-files -s` output: path, mode and blob id of every tracked input, so it
# is exact content identity without reading a single file. Untracked and ignored files are build outputs,
# never inputs. Every include pathspec must match at least one tracked file: a renamed or mistyped input
# silently narrows a key, and a key that is too narrow ships a stale artifact into jobs that then test
# last run's code and pass. That is a hard failure here instead.
#
# Callers must use the printed key as an EXACT key with no restore-keys. A near-miss restore of build
# outputs is a wrong answer, not a cheaper one: on a miss, rebuild.
set -euo pipefail

usage='usage: cache-entry-key.sh build-outputs <prefix> <unit> [unit ...]'
set_name="${1:?$usage}"
prefix="${2:?$usage}"
shift 2
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repository_root"

# shellcheck disable=SC2016 # These are the literal characters of an unexpanded expression, not an expansion.
if [[ "$prefix" =~ [[:space:]] || "$prefix" == *'${'* || "$prefix" == *'--'* ]]; then
  echo "cache-entry-key.sh: suspicious prefix (empty expansion or unexpanded expression): $prefix" >&2
  exit 2
fi

# Tracked inputs, as git pathspecs from the repository root. `:(glob)` keeps `*` inside one path segment.
includes=()
excludes=()
# Extra digest lines that are not whole files: a named value read out of a file whose other contents are
# not an input. Each line is `<source>\t<name>=<value>`.
extra=()

case "$set_name" in
  build-outputs)
    if [ "$#" -eq 0 ]; then
      echo "cache-entry-key.sh: build-outputs needs the shard's units: $usage" >&2
      exit 2
    fi
    includes+=(
      # The toolchain, the resolution and every root file a unit build reads.
      app/.mise.toml
      app/module-federation.shared.ts
      app/package.json
      app/pnpm-lock.yaml
      app/pnpm-workspace.yaml
      app/tsconfig.base.json
      app/tsconfig.json
      ':(glob)app/patches/**'
      ':(glob)app/scripts/**'
      ':(glob)app/topology/**'
      # Typechecked at the top of the build step for every shard, whoever depends on them.
      ':(glob)app/packages/shared-contracts/**'
      ':(glob)app/packages/shared-design-tokens/**'
      # The commands that produce and pack the outputs, and the install they run on.
      .github/actions/install-app/action.yml
      .github/workflows/ultramodern-workspace-gates.yml
    )
    # A test file is compiled by the test runner from the checkout, never shipped in a build output, so a
    # test-only commit must still hit. Everything a build can import stays in the key.
    excludes+=(
      ':(exclude,glob)app/packages/*/tests/**'
      ':(exclude,glob)app/scripts/integration/**'
      ':(exclude,glob)app/scripts/tests/**'
    )
    for unit in "$@"; do
      if ! [[ "$unit" =~ ^(apps|packages|verticals)/[a-z0-9-]+$ ]]; then
        echo "cache-entry-key.sh: not a delivery unit path: $unit" >&2
        exit 2
      fi
    done
    # A unit does not build from its own directory alone: these builds are source builds, so a unit compiles the
    # SOURCE of every workspace package it declares, and those packages declare further ones. apps/shell-super-app
    # reads eleven other units, verticals/symmy-integration nine. Keying a shard on its own units only would let a
    # commit that changes verticals/catalog hit the shard that builds the shell, which would then ship last commit's
    # Catalog code into the integration rows and pass. So the key covers the transitive workspace-dependency closure
    # of the shard's units, from the manifests, which is the import graph: pnpm's isolated node_modules cannot
    # resolve an undeclared package at all. Development dependencies are in the closure too, because a unit's build
    # configuration may read one.
    mapfile -t manifests < <(git ls-files --full-name -- ':(glob)app/*/*/package.json')
    if [ "${#manifests[@]}" -eq 0 ]; then
      echo 'cache-entry-key.sh: no workspace manifests are tracked' >&2
      exit 1
    fi
    declare -A directory_of_package=()
    declare -A dependencies_of_directory=()
    declare -A is_workspace_directory=()
    while IFS=$'\t' read -r kind first second; do
      case "$kind" in
        N)
          directory_of_package["$first"]="$second"
          is_workspace_directory["$second"]=1
          ;;
        E) dependencies_of_directory["$first"]+=" $second" ;;
        *) ;;
      esac
    done < <(
      jq -r '
        input_filename as $file
        | ($file | sub("^app/"; "") | sub("/package\\.json$"; "")) as $directory
        | ["N", .name, $directory],
          (
            [(.dependencies // {}), (.devDependencies // {})]
            | add
            | to_entries[]
            | select((.value | tostring | startswith("workspace:")) and (.key | startswith("@app/")))
            | ["E", $directory, .key]
          )
        | @tsv
      ' "${manifests[@]}"
    )
    closed=()
    declare -A in_closure=()
    pending=("$@")
    while [ "${#pending[@]}" -gt 0 ]; do
      current="${pending[0]}"
      pending=("${pending[@]:1}")
      if [ -n "${in_closure[$current]:-}" ]; then
        continue
      fi
      if [ -z "${is_workspace_directory[$current]:-}" ]; then
        echo "cache-entry-key.sh: $current is not a workspace package directory" >&2
        exit 2
      fi
      in_closure["$current"]=1
      closed+=("$current")
      for package in ${dependencies_of_directory[$current]:-}; do
        target="${directory_of_package[$package]:-}"
        if [ -z "$target" ]; then
          echo "cache-entry-key.sh: $current depends on $package, which no workspace manifest declares" >&2
          exit 1
        fi
        pending+=("$target")
      done
    done
    echo "cache-entry-key.sh: ${#closed[@]} packages in the closure of $*" >&2
    for unit in "${closed[@]}"; do
      includes+=(":(glob)app/$unit/**")
      excludes+=(":(exclude,glob)app/$unit/tests/**")
    done
    ;;
  *)
    echo "cache-entry-key.sh: unknown input set $set_name. $usage" >&2
    exit 2
    ;;
esac

# Fails naming the first include pathspec that matches nothing tracked. Exclusions never match by design.
git ls-files --error-unmatch -- "${includes[@]}" >/dev/null

entries="$(git ls-files -s --full-name -- "${includes[@]}" "${excludes[@]}" | LC_ALL=C sort)"
if [ -z "$entries" ]; then
  echo "cache-entry-key.sh: the $set_name input set resolved to no tracked files" >&2
  exit 1
fi

digest="$(printf '%s\n' "set=$set_name" "$entries" ${extra[@]+"${extra[@]}"} | sha256sum)"
digest="${digest%% *}"
if ! [[ "$digest" =~ ^[a-f0-9]{64}$ ]]; then
  echo 'cache-entry-key.sh: the input hash failed' >&2
  exit 1
fi
echo "cache-entry-key.sh: $set_name over $(printf '%s\n' "$entries" | wc -l | tr -d ' ') tracked files" >&2
printf 'key=%s%s\n' "$prefix" "$digest"
