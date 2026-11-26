#!/usr/bin/env bash
# Small real-Lefthook reproduction: pad the command, not the file count, to cross its command-string limit.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
hook="$root/app/node_modules/.bin/lefthook"
runner="$root/app/scripts/ci/lint-files.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/lint-proof.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cd "$work"
git init --quiet
printf -v segment '%180s' ''
segment="${segment// /d}"
mkdir -p "app/$segment/$segment/$segment/$segment"
: >files
for number in {00..11}; do
  file="app/$segment/$segment/$segment/$segment/$number$segment.ts"
  printf 'bad\n' >"$file"
  printf '%s\0' "$file" >>files
done
git add app
git -c user.name='Lint fixture' -c user.email='lint@example.invalid' commit --quiet -m 'Create lint fixture'
mkdir -p app/node_modules/.bin
ln -s "$hook" app/node_modules/.bin/lefthook
cat >report.sh <<'REPORT'
#!/bin/sh
for file; do printf 'FINDING %s %s\n' "$HOOK_JOB" "${file##*/}"; done
exit 1
REPORT
case "$(uname -s)" in
  Darwin) padding_length=253000 ;;
  Linux) padding_length=123000 ;;
  *) echo 'The reproduction runs on Linux and macOS.' >&2; exit 1 ;;
esac
padding="$(head -c "$padding_length" /dev/zero | tr '\0' x)"
printf 'pre-commit:\n  jobs:\n' >lefthook.yml
for job in format lint; do
  printf '    - name: %s\n      root: app/\n      run: |\n        : %s; HOOK_JOB=%s sh ../report.sh {staged_files}\n' \
    "$job" "$padding" "$job" >>lefthook.yml
done
status=0
"$hook" run pre-commit --files-from-stdin --no-auto-install --no-stage-fixed <files >before.log 2>&1 || status=$?
test "$status" -eq 1
before="$(grep -c '^FINDING ' before.log)"
test "$before" -lt 24
status=0
bash "$runner" <files >after.log 2>&1 || status=$?
test "$status" -eq 1
for job in format lint; do
  test "$(grep -c "^FINDING $job " after.log)" -eq 12
  test "$(grep "^FINDING $job " after.log | sort -u | wc -l | tr -d ' ')" -eq 12
done
printf 'Real Lefthook: before %s/24 findings, after 24/24; both exit 1.\n' "$before"
# A fix-only finding still fails, and its diff is printed after another job fails.
cat >lefthook.yml <<'CONFIG'
pre-commit:
  jobs:
    - name: first-failure
      root: app/
      run: echo FIRST_FAILURE; exit 1
    - name: fix
      root: app/
      run: printf 'fixed\n' >"{staged_files}"
      stage_fixed: true
CONFIG
# read -d preserves the NUL terminator without requiring GNU head on the laptop.
IFS= read -r -d '' first <files
printf '%s\0' "$first" >one-file
status=0
bash "$runner" <one-file >fix.log 2>&1 || status=$?
test "$status" -eq 1
grep -q FIRST_FAILURE fix.log
grep -q '^+fixed' fix.log
git diff --cached --exit-code
printf 'Earlier job failure and later auto-fix both printed; index unchanged; exit 1.\n'
