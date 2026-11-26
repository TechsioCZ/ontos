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
  all(.jobs[]; (.name | type == "string") and (.run | type == "string") and
    ((.args // "") | type == "string") and (has("jobs") | not)) and
  (has("commands") | not) and (has("scripts") | not)' "$work/config.json" >/dev/null
if ! jq -e '[."pre-commit".jobs[] | .run + " " + (.args // "") |
  scan("\\{[a-zA-Z0-9_]+\\}") | select(. != "{staged_files}")] | length == 0' "$work/config.json" >/dev/null; then
  echo '::error::CI hook batching encountered an unsupported file template; only {staged_files} is bounded.'
  exit 1
fi
jq -r '."pre-commit".jobs[] | .run + " " + (.args // "") |
  [utf8bytelength, ([scan("\\{staged_files\\}")] | length)] | @tsv' "$work/config.json" >"$work/jobs"
failed=0
batch=1
run_batch() {
  echo "::group::pre-commit / batch $batch"
  # --job exits 1 for a legitimate empty glob in Lefthook 2.1.15. The ordinary hook skips that
  # job and still checks global invariants, even when an all-deletion diff supplies no paths.
  "$hook" run pre-commit --files-from-stdin --no-auto-install --no-stage-fixed \
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
# Run once even for empty input: global jobs have no file substitution and must still prove the tree.
run_batch
# --fix can make a failing finding disappear from the tool's exit status. Print every resulting diff even when
# another batch/job failed, and compare both the worktree and index with the exact checked-out commit.
git diff --exit-code HEAD || failed=1
exit "$failed"
