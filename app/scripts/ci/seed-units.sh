#!/usr/bin/env bash
# A build shard of the gates starts from the unit outputs of the run that proved the commit this run compares with, so
# it builds only the units whose inputs changed since then. Two subcommands:
#
#   find           In ci-plan, with BASE_SHA the commit the plan compares with: run=<id> of the seed run, or nothing.
#   unpack <file>  In a build shard, with SHARD_UNITS: moves the dist/ and .output/ of each of the shard's units out of
#                  the seed archive (node-units-<shard> of the seed run) into the checkout, both or neither.
#                  scripts/ci/unit-output-cache.mts plan then keeps a unit only when its receipt matches this checkout,
#                  and build-units.sh builds the rest.
#
# Trust. The receipts plan checks travel inside the archive, written by whatever built it, so a seed is exactly as
# trustworthy as the code of the run that built it. find accepts a run only when it
#   1. is a run of this workflow file (the workflow id of this very run) in this repository (repository and head
#      repository), so its node-units-* artifacts were uploaded by this workflow's own jobs: only the jobs of a run can
#      upload into it;
#   2. ran on the exact commit being checked (head_sha), so the workflow definition and the tree it built are that
#      commit's;
#   3. is a push to the demo trunk or a workflow_dispatch on a candidate/* ref, completed with conclusion success;
#   4. ran on a commit of the demo trunk's history (an ancestor of origin/demo/sales-crm), so what it built is code that
#      landed on the trunk, never an unlanded fix round whose later commits could hide what an earlier one planted;
#   5. still holds unexpired node-units-* artifacts of its own (their workflow_run id and head_sha).
# Nothing comes from user input: BASE_SHA is computed by git in ci-plan (the merge base with the dispatch's base ref, or
# the trunk's newest green push), the trunk name is fixed here, and the workflow id is read from this run.
# The base commit is tried first, then its first-parent ancestors, nearest first, SEED_COMMITS commits in all: a commit
# whose runs built nothing (a run whose plan needed no build) leaves the outputs of an earlier one.
# Every failed lookup is no seed: every unit of the shard builds. Neither subcommand fails a job over a seed.
set -euo pipefail

readonly TRUNK=demo/sales-crm
readonly SEED_COMMITS=5
staging=''

no_seed() {
  echo "$1 Every unit of the build shards builds."
  exit 0
}

find_seed() {
  : "${GITHUB_OUTPUT:?Actions output file is required}"
  local repository="${GITHUB_REPOSITORY:-}" base="${BASE_SHA:-}"
  [[ "$base" =~ ^[0-9a-f]{40}$ ]] || no_seed 'This run compares with no commit.'
  local workflow_id
  workflow_id="$(gh api "repos/$repository/actions/runs/${GITHUB_RUN_ID:-}" --jq '.workflow_id')" || workflow_id=''
  [[ "$workflow_id" =~ ^[0-9]+$ ]] || no_seed 'The workflow of this run is unreadable.'
  local commits
  commits="$(git rev-list --first-parent --max-count="$SEED_COMMITS" "$base" --)" ||
    no_seed "The history of $base is unreadable."

  local sha runs seeds run_id url artifacts count
  for sha in $commits; do
    if ! git merge-base --is-ancestor "$sha" "refs/remotes/origin/$TRUNK" 2>/dev/null; then
      echo "$sha is not in the history of $TRUNK; its runs do not count."
      continue
    fi
    runs="$(gh api --method GET "repos/$repository/actions/workflows/$workflow_id/runs" \
      -f "head_sha=$sha" -f per_page=100 </dev/null)" || {
      echo "The runs of $sha are unreadable."
      continue
    }
    seeds="$(jq -r --arg sha "$sha" --arg repository "$repository" --arg trunk "$TRUNK" \
      --argjson workflow "$workflow_id" \
      '.workflow_runs | map(select(.workflow_id == $workflow and .head_sha == $sha
        and .repository.full_name == $repository and .head_repository.full_name == $repository
        and .status == "completed" and .conclusion == "success"
        and ((.event == "push" and .head_branch == $trunk)
          or (.event == "workflow_dispatch" and (.head_branch | startswith("candidate/"))))))
      | sort_by(.created_at) | reverse | .[] | select((.id | type) == "number") | "\(.id) \(.html_url)"' <<<"$runs")" ||
      seeds=''
    while read -r run_id url; do
      [[ -n "$run_id" ]] || continue
      artifacts="$(gh api --method GET "repos/$repository/actions/runs/$run_id/artifacts" \
        -f per_page=100 </dev/null)" || {
        echo "The artifacts of $url are unreadable; it does not count."
        continue
      }
      count="$(jq -r --arg sha "$sha" --argjson run "$run_id" '[.artifacts[]
        | select((.name | test("^node-units-[0-9]+$")) and .expired == false
          and .workflow_run.id == $run and .workflow_run.head_sha == $sha)] | length' <<<"$artifacts")" || count=0
      if [[ "$count" =~ ^[1-9][0-9]*$ ]]; then
        echo "The build shards start from the unit outputs of $url, a successful run of this workflow on $sha."
        printf 'run=%s\n' "$run_id" >>"$GITHUB_OUTPUT"
        return 0
      fi
      echo "$url holds no unexpired unit outputs; it does not count."
    done <<<"$seeds"
  done
  no_seed "No successful run of this workflow on $base or its $((SEED_COMMITS - 1)) nearest ancestors holds unit outputs."
}

unpack_seed() {
  local archive="${1:?Pass the seed archive}"
  : "${SHARD_UNITS:?The units of the shard are required}"
  staging="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/seed-units.XXXXXX")"
  trap 'rm -rf "$staging"' EXIT
  # Unpacked aside first: an archive that does not unpack whole leaves nothing in the checkout.
  if ! tar --extract --zstd --file "$archive" --directory "$staging"; then
    echo "::warning title=No seed::The seed archive does not unpack; every unit of this shard builds."
    return 0
  fi
  local unit placed=0 total=0
  for unit in $SHARD_UNITS; do
    total=$((total + 1))
    if [[ -e "$unit/dist" || -e "$unit/.output" ]]; then
      echo "$unit already has outputs in this checkout; the seed's are not used."
      continue
    fi
    if [[ ! -d "$staging/$unit/dist" || -L "$staging/$unit/dist" ||
      ! -d "$staging/$unit/.output" || -L "$staging/$unit/.output" ]]; then
      echo "The seed holds no whole outputs of $unit; it builds."
      continue
    fi
    if mv "$staging/$unit/dist" "$unit/dist" && mv "$staging/$unit/.output" "$unit/.output"; then
      placed=$((placed + 1))
    else
      rm -rf -- "$unit/dist" "$unit/.output"
      echo "::warning title=Seed unit skipped::Moving the seed outputs of $unit failed; it builds."
    fi
  done
  echo "Placed the seed outputs of $placed of $total units; the plan keeps those whose receipts match this checkout."
}

case "${1:-}" in
  find) find_seed ;;
  unpack) unpack_seed "${2:-}" ;;
  *)
    echo 'Usage: seed-units.sh find | unpack <archive>' >&2
    exit 2
    ;;
esac
