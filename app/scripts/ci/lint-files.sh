#!/usr/bin/env bash
# CI owns the batches: Lefthook 2.1's executor returns on the first failing command of a split job.
# Never change the hook's fix/glob policy here; local pre-commit still uses lefthook.yml directly.
set -euo pipefail
export LC_ALL=C
cd "$(git rev-parse --show-toplevel)"
hook="$PWD/app/node_modules/.bin/lefthook"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lint-files.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cat >"$work/files"
"$hook" dump --format json >"$work/config.json"
# Reject a hook shape or substitution we cannot exhaust rather than silently omitting a job.
# buildCommand (Lefthook 2.1.15, internal/run/controller/command/build_command.go) joins run AND args.
jq -e '."pre-commit" | (.jobs | length > 0) and
  all(.jobs[]; (.name | type == "string" and test("^[a-zA-Z0-9_-]+$")) and (.run | type == "string") and
    ((.args // "") | type == "string") and (has("jobs") | not)) and
  ([.jobs[].name] | length == (unique | length)) and
  (has("commands") | not) and (has("scripts") | not)' "$work/config.json" >/dev/null
if ! jq -e '[."pre-commit".jobs[] | .run + " " + (.args // "") |
  scan("\\{[a-zA-Z0-9_]+\\}") | select(. != "{staged_files}")] | length == 0' "$work/config.json" >/dev/null; then
  echo '::error::CI hook batching encountered an unsupported file template; only {staged_files} is bounded.'
  exit 1
fi
jq -r '."pre-commit".jobs[] | .run + " " + (.args // "") |
  [utf8bytelength, ([scan("\\{staged_files\\}")] | length)] | @tsv' "$work/config.json" >"$work/jobs"
# A named --job with no matching files is an error, but --force makes a no-template job
# run even when its root/glob sees nothing. Execute each global job separately so one failure
# cannot skip another; no sentinel path or synthetic file argument can leak into the file jobs.
jq -r '."pre-commit".jobs[] | select((.run + " " + (.args // "") | contains("{staged_files}")) | not) | .name' \
  "$work/config.json" >"$work/global-jobs"
globals="$(paste -sd, "$work/global-jobs")"
# Lefthook v2.1.15 internal/run/controller/job.go skipReason matches exact accumulated tags AND
# PrintableName (internal/config/job.go); scope.go extend accumulates job/group tags. The shape
# check above disallows groups and requires unique explicit names, so PrintableName is .name.
# https://github.com/evilmartians/lefthook/blob/v2.1.15/internal/run/controller/job.go#L190-L203
# https://github.com/evilmartians/lefthook/blob/v2.1.15/internal/config/job.go#L40-L52
# Reject even a global's own colliding tag: exclusions must have one meaning before any job runs.
if ! jq -e --rawfile globals "$work/global-jobs" '
  ($globals | split("\n") | map(select(length > 0))) as $names |
  [."pre-commit".jobs[] | (.tags // [])[] | select(. as $tag | $names | index($tag))] |
  length == 0' "$work/config.json" >/dev/null; then
  echo '::error::CI global-job names intersect job tags; LEFTHOOK_EXCLUDE would silently skip jobs.'
  exit 1
fi
failed=0
while IFS= read -r job; do
  echo "::group::pre-commit / global $job"
  LEFTHOOK_EXCLUDE='' "$hook" run pre-commit --files-from-stdin --no-auto-install --no-stage-fixed \
    --job "$job" --force </dev/null || failed=1
  echo '::endgroup::'
done <"$work/global-jobs"
batch=1
run_batch() {
  echo "::group::pre-commit / batch $batch"
  # Exclude only the globals already exhausted above. The ordinary hook skips legitimate empty
  # file globs without --job's spurious nonzero exit. File jobs keep the hook's exact filters.
  LEFTHOOK_EXCLUDE="$globals" "$hook" run pre-commit --files-from-stdin --no-auto-install --no-stage-fixed \
    <"$work/batch" || failed=1
  echo '::endgroup::'
}
# Lefthook 2.1.15 internal/system/limits.go, MaxCmdLen: command-string limits, not ARG_MAX.
case "$(uname -s)" in
  Darwin) limit=260000 ;;
  Linux) limit=130000 ;;
  *) echo '::error::CI hook batching supports Linux and macOS only.'; exit 1 ;;
esac
# One shared batch must fit the tightest file-consuming job, including repeated substitutions.
# Reserve 2048 bytes for command expansion; cap at 120 kB to keep each type-program set bounded.
budget=120000
while IFS=$'\t' read -r command_length templates; do
  available=$((limit - command_length - 2048))
  if ((available <= 0)); then
    echo '::error::The hook command leaves no safe command-line space.'
    exit 1
  fi
  if ((templates > 0)); then
    available=$((available / templates))
    if ((available < budget)); then budget=$available; fi
  fi
done <"$work/jobs"
: >"$work/batch"
bytes=0
while IFS= read -r -d '' file; do
  quotes="${file//[^\']/}"
  # Replacer.escapeFiles (internal/run/controller/command/replacer/replacer.go) uses
  # al.essio.dev/pkg/shellescape v1.6.0 shellescape.go Quote: each apostrophe becomes 5 bytes (+4), plus 2 outer quotes
  # and a separating space. Count UTF-8 bytes via LC_ALL=C; root trimming can only shorten it.
  cost=$((${#file} + ${#quotes} * 4 + 3))
  if ((cost > budget)); then
    echo "::error::The hook command leaves no safe command-line space for $file."
    failed=1
    continue
  fi
  if ((bytes + cost > budget)); then
    run_batch
    batch=$((batch + 1))
    : >"$work/batch"
    bytes=0
  fi
  printf '%s\0' "$file" >>"$work/batch"
  bytes=$((bytes + cost))
done <"$work/files"
# Empty, all-deletion and proof inputs have no file work; globals already ran exactly once.
if [[ -s "$work/batch" ]]; then run_batch; fi
# The shell-ui-candidates global generates ignored output and fails on invalid utilities. Its success does not
# prove a committed projection was fresh: no projection is committed. The diff below covers tracked files only.
# --fix can make a failing finding disappear from the tool's exit status. Print every resulting diff even when
# another batch/job failed, and compare both the worktree and index with the exact checked-out commit.
git diff --exit-code HEAD || failed=1
exit "$failed"
