#!/usr/bin/env bash
# Check the pinned tools' actual implicit inputs, not just the selector's filename patterns.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
fmt="$root/app/node_modules/.bin/oxfmt"
lint="$root/app/node_modules/.bin/oxlint"
work="$(mktemp -d "${TMPDIR:-/tmp}/lint-configuration.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cd "$work"
git init --quiet
mkdir nested
file=nested/file.ts
expect_status() {
  local expected="$1" actual=0
  shift
  "$@" >tool.log 2>&1 || actual=$?
  if [[ "$actual" != "$expected" ]]; then
    cat tool.log >&2
    echo "Expected $expected, got $actual: $*" >&2
    exit 1
  fi
}
printf 'export const value = {\n  nested: true,\n};\n' >"$file"
printf 'root = true\n[*]\nindent_style = space\nindent_size = 2\n' >.editorconfig
expect_status 0 "$fmt" --check "$file"
sed 's/indent_size = 2/indent_size = 4/' .editorconfig >next
mv next .editorconfig
expect_status 1 "$fmt" --check "$file"
rm .editorconfig
printf '{"tabWidth":4}\n' >.oxfmtrc.json
expect_status 1 "$fmt" --check "$file"
printf '{"tabWidth":2}\n' >.oxfmtrc.json
expect_status 0 "$fmt" --check "$file"
rm .oxfmtrc.json
printf 'debugger;\n' >"$file"
printf '{"rules":{"no-debugger":"error"}}\n' >.oxlintrc.json
expect_status 1 "$lint" "$file"
printf '{"rules":{"no-debugger":"off"}}\n' >.oxlintrc.json
expect_status 0 "$lint" "$file"
rm .oxlintrc.json
printf 'const value={nested:true};\n' >"$file"
expect_status 1 "$fmt" --check "$file"
printf '%s\n' "$file" >.prettierignore
expect_status 0 "$fmt" --check --no-error-on-unmatched-pattern "$file"
rm .prettierignore
# .gitignore changes directory discovery, even though explicit formatter filenames override it.
printf '%s\n' "$file" >.gitignore
expect_status 0 "$fmt" --check --no-error-on-unmatched-pattern nested
rm .gitignore
printf 'const value = ;\n' >"$file"
expect_status 1 "$lint" "$file"
printf '%s\n' "$file" >.eslintignore
expect_status 0 "$lint" --no-error-on-unmatched-pattern "$file"
rm .eslintignore
# Neither pinned tool reads ripgrep's .ignore as an implicit configuration source.
printf '%s\n' "$file" >.ignore
expect_status 2 "$fmt" --check "$file"
expect_status 1 "$lint" "$file"
printf 'Pinned tools: editorconfig, oxfmtrc, oxlintrc, prettierignore, eslintignore and gitignore discovery change unchanged-file results; .ignore does not.\n'
