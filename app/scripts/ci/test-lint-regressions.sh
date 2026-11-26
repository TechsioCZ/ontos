#!/usr/bin/env bash
# Real pinned Lefthook, tiny commands: no workspace linter or whole-tree check.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
hook="$root/app/node_modules/.bin/lefthook"
runner="$root/app/scripts/ci/lint-files.sh"
selector="$root/app/scripts/ci/lint-shard-files.sh"
# Reproduce the real global job's root filter: root affects selection as well as working directory.
global_root="$("$hook" dump --format json | jq -r '."pre-commit".jobs[] | select(.name == "shell-ui-candidates") | .root // ""')"
work="$(mktemp -d "${TMPDIR:-/tmp}/lint-regressions.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cd "$work"
git init --quiet
mkdir -p app/fixtures app/node_modules/.bin
printf 'fixture\n' >app/fixtures/excluded.ts
printf 'generated\n' >app/projection.ts
export FIXTURE_PROJECTION="$work/app/projection.ts"
git add app
git -c user.name='Lint fixture' -c user.email='lint@example.invalid' commit --quiet -m 'Create lint fixture'
ln -s "$hook" app/node_modules/.bin/lefthook
no_match() {
  cat >lefthook.yml <<'CONFIG'
pre-commit:
  jobs:
    - name: global
      run: echo GLOBAL; test -f "$FIXTURE_PROJECTION"
    - name: lint
      glob: 'app/*.ts'
      exclude: 'app/fixtures/*'
      run: echo FILE {staged_files}
CONFIG
  if [[ -n "$global_root" ]]; then
    awk -v root="$global_root" '{print; if ($0 ~ /name: global$/) print "      root: " root}' lefthook.yml >next.yml
    mv next.yml lefthook.yml
  fi
  for input in excluded workflow empty; do
    case "$input" in
      excluded) printf 'app/fixtures/excluded.ts\0' >files ;;
      workflow) printf '.github/workflows/zerops-stage.yml\0' >files ;;
      empty) : >files ;;
    esac
    status=0
    bash "$runner" <files >"$input.log" 2>&1 || status=$?
    test "$status" -eq 0
    grep -q '^GLOBAL' "$input.log"
    if grep -q '^FILE' "$input.log"; then exit 1; fi
  done
  # The all-deletion commit has no tracked file left in its changed-path selection. Deleting a
  # generated projection still invalidates the global invariant, even with no linter arguments.
  git rm --quiet app/projection.ts
  git -c user.name='Lint fixture' -c user.email='lint@example.invalid' commit --quiet -m 'Delete generated projection'
  printf 'app/projection.ts\0' >changed
  bash "$selector" 0 changed >files
  test ! -s files
  status=0
  bash "$runner" <files >global-failure.log 2>&1 || status=$?
  test "$status" -eq 1
  grep -q '^GLOBAL' global-failure.log
  echo 'Excluded paths, workflow-only and empty stdin run the global job; its failure is not hidden.'
}
quoted_boundary() {
  # 176 apostrophes per path: +4 bytes each, not +3. The old 160-path estimate fits 120 kB,
  # but the escaped list exceeds Linux's 130 kB limit. Pad macOS to test that same boundary.
  quotes="$(printf '%176s' '' | tr ' ' "'")"
  mkdir -p "app/$quotes"
  : >files
  for number in {000..159}; do
    file="app/$quotes/${number}xxxxxxxxxxxxxxxxxxxxxxxxxx.ts"
    printf 'fixture\n' >"$file"
    printf '%s\0' "$file" >>files
  done
  git add app
  git -c user.name='Lint fixture' -c user.email='lint@example.invalid' commit --quiet -m 'Create quoted paths'
  cat >report.sh <<'REPORT'
#!/bin/sh
for file; do printf 'FINDING %s\n' "$file"; done
exit 1
REPORT
  case "$(uname -s)" in Darwin) padding_length=130000 ;; Linux) padding_length=0 ;; *) exit 1 ;; esac
  padding="$(head -c "$padding_length" /dev/zero | tr '\0' x)"
  for placement in run args both; do
    case "$placement" in
      run) run_files='{staged_files}'; args=''; expected=160 ;;
      args) run_files=''; args='{staged_files}'; expected=160 ;;
      both) run_files='{staged_files}'; args='{staged_files}'; expected=320 ;;
    esac
    printf 'pre-commit:\n  jobs:\n    - name: quoted\n      root: app/\n      run: ": %s; sh ../report.sh %s"\n      args: "%s"\n' \
      "$padding" "$run_files" "$args" >lefthook.yml
    status=0
    bash "$runner" <files >"$placement.log" 2>&1 || status=$?
    test "$status" -eq 1
    actual="$(grep -c '^FINDING ' "$placement.log")"
    test "$actual" -eq "$expected" || { echo "$placement: $actual/$expected escaped-path findings" >&2; exit 1; }
  done
  echo 'Escaped-byte boundary: every quoted path reported through run, args and both; exit 1.'
}
unsupported_templates() {
  for template in all_files push_files files; do
    for placement in run args; do
      printf 'pre-commit:\n  jobs:\n    - name: unsafe\n      run: "echo UNSAFE %s"\n      args: "%s"\n' \
        "$([[ "$placement" == run ]] && echo "{$template}")" \
        "$([[ "$placement" == args ]] && echo "{$template}")" >lefthook.yml
      status=0
      bash "$runner" </dev/null >unsafe.log 2>&1 || status=$?
      test "$status" -ne 0
      grep -q 'unsupported.*template' unsafe.log
      if grep -q '^UNSAFE' unsafe.log; then exit 1; fi
    done
  done
  echo 'Unsupported file templates in run and args fail closed before executing the hook.'
}
case "${1:-all}" in
  no-match) no_match ;;
  quotes) quoted_boundary ;;
  templates) unsupported_templates ;;
  all) no_match; quoted_boundary; unsupported_templates ;;
  *) exit 1 ;;
esac
