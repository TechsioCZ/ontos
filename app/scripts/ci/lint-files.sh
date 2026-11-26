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
# Reject a hook shape we cannot exhaust rather than silently omitting a new job.
jq -e '.["pre-commit"] | (.jobs | length > 0) and
  all(.jobs[]; (.name | type == "string") and (.run | type == "string") and (has("jobs") | not)) and
  (has("commands") | not) and (has("scripts") | not)' "$work/config.json" >/dev/null
jq -r '.["pre-commit"].jobs[] | [.name, (.run | utf8bytelength),
  (.run | [scan("\\{staged_files\\}")] | length)] | @tsv' "$work/config.json" >"$work/jobs"
failed=0
run_batch() {
  echo "::group::pre-commit / $job / batch $batch"
  "$hook" run pre-commit --files-from-stdin --no-auto-install --no-stage-fixed --job "$job" \
    <"$work/batch" || failed=1
  echo '::endgroup::'
}
# These are Lefthook's own command-string limits (internal/system/limits.go), not ARG_MAX.
# Budget for worst-case shell escaping (one quote becomes four bytes), the configured command and its templates.
case "$(uname -s)" in
  Darwin) limit=260000 ;;
  Linux) limit=130000 ;;
  *) echo '::error::CI hook batching supports Linux and macOS only.'; exit 1 ;;
esac
while IFS=$'\t' read -r job command_length templates; do
  batch=1
  : >"$work/batch"
  if ((templates == 0)); then
    cp "$work/files" "$work/batch"
    run_batch
    continue
  fi
  budget=$(((limit - command_length - 2048) / templates))
  ((budget <= 120000)) || budget=120000
  bytes=0
  while IFS= read -r -d '' file; do
    quotes="${file//[^\']/}"
    cost=$((${#file} + ${#quotes} * 3 + 3))
    if ((cost > budget)); then
      echo "::error::The hook command leaves no safe command-line space for $file ($job)."
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
  if [[ -s "$work/batch" ]]; then run_batch; fi
done <"$work/jobs"
# --fix can make a failing finding disappear from the tool's exit status. Print every resulting diff even when
# another batch/job failed, and compare both the worktree and index with the exact checked-out commit.
git diff --exit-code HEAD || failed=1
exit "$failed"
