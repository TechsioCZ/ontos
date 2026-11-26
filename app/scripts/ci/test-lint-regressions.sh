#!/usr/bin/env bash
# Real pinned Lefthook, tiny commands: no workspace linter or whole-tree check.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
hook="$root/app/node_modules/.bin/lefthook"
runner="$root/app/scripts/ci/lint-files.sh"
selector="$root/app/scripts/ci/lint-shard-files.sh"
# Reproduce the real global job's root filter: root affects selection as well as working directory.
global_root=app/
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
local_skip() {
  cp "$root/lefthook.yml" lefthook.yml
  mkdir -p .github
  printf 'workflow\n' >.github/a
  git add .github/a
  status=0
  mkdir -p no-dependencies
  ln -s "$(command -v node)" no-dependencies/node
  PATH="$work/no-dependencies:/usr/bin:/bin" "$hook" run pre-commit --no-auto-install >local.log 2>&1 || status=$?
  test "$status" -eq 0 || { cat local.log; return 1; }
  if grep -q 'pnpm:' local.log; then return 1; fi
  git reset --quiet
  echo 'Local workflow-only commit skips pnpm without installed dependencies.'
}
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
  for input in excluded workflow empty proof; do
    case "$input" in
      excluded) printf 'app/fixtures/excluded.ts\0' >files ;;
      workflow) printf '.github/workflows/fixture.yml\0' >files ;;
      empty) : >files ;;
      proof) bash "$selector" proof >files ;;
    esac
    status=0
    bash "$runner" <files >"$input.log" 2>&1 || status=$?
    test "$status" -eq 0
    test "$(grep -c '^GLOBAL' "$input.log")" -eq 1
    if grep -q '^FILE' "$input.log"; then exit 1; fi
  done
  # Deleting a generated projection invalidates the global invariant even when every
  # remaining tracked file in the whole-tree slice is excluded from the linter.
  git rm --quiet app/projection.ts
  git -c user.name='Lint fixture' -c user.email='lint@example.invalid' commit --quiet -m 'Delete generated projection'
  bash "$selector" 1 >files
  test "$(tr '\0' '\n' <files)" = app/fixtures/excluded.ts
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
docs_inputs() {
  for input in non-markdown unterminated empty; do
    case "$input" in
      non-markdown) printf 'deleted.md\0deleted.ts\0' >files ;;
      unterminated) printf 'deleted.md\0unterminated.md' >files ;;
      empty) : >files ;;
    esac
    status=0
    bash "$selector" docs "$work/files" >docs.out 2>docs.err || status=$?
    test "$status" -eq 1
    test ! -s docs.out
    grep -q 'Docs paths must' docs.err
  done
  printf 'deleted.md\0' >files
  bash "$selector" docs "$work/files" >docs.out
  test ! -s docs.out
  echo 'Invalid docs lists fail closed before deletion filtering; all-deleted lists succeed.'
}
exclusion_collisions() {
  for tagged in lint global; do
    cat >lefthook.yml <<CONFIG
pre-commit:
  jobs:
    - name: global
      tags: [$([[ "$tagged" == global ]] && echo global)]
      run: echo GLOBAL_EXECUTED
    - name: lint
      tags: [$([[ "$tagged" == lint ]] && echo global)]
      run: echo FILE_EXECUTED {staged_files}; exit 1
CONFIG
    status=0
    printf 'app/fixtures/excluded.ts\0' | bash "$runner" >collision.log 2>&1 || status=$?
    test "$status" -ne 0 || { cat collision.log; return 1; }
    grep -q 'global-job names intersect job tags' collision.log || { cat collision.log; return 1; }
    if grep -q '_EXECUTED' collision.log; then cat collision.log; exit 1; fi
  done
  echo 'Global-name/tag collisions fail closed before any job executes.'
}
case "${1:-all}" in
  local-skip) local_skip ;;
  no-match) no_match ;;
  quotes) quoted_boundary ;;
  templates) unsupported_templates ;;
  exclusions) exclusion_collisions ;;
  docs) docs_inputs ;;
  all) local_skip; no_match; quoted_boundary; unsupported_templates; exclusion_collisions; docs_inputs ;;
  *) exit 1 ;;
esac
