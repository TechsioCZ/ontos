#!/bin/sh

set -eu

minimum_locki_version='0.0.27'
development_branch='main'

usage() {
  printf '%s\n' 'Usage: mise exec -- pnpm sandbox:new -- <feature-slug> [--no-ai]'
}

recovery() {
  sandbox_id=$1
  worktree_path=$2
  printf '\nSandbox preserved for diagnosis.\n'
  printf 'Retry preparation: locki exec --match %s -- sh app/scripts/locki-feature.sh --prepare\n' "$sandbox_id"
  printf 'Open a shell:       locki exec --match %s\n' "$sandbox_id"
  printf 'Resume AI:          locki ai --match %s\n' "$sandbox_id"
  printf 'Open in your IDE:   %s\n' "$worktree_path"
  printf 'Remove sandbox:     locki rm --match %s\n' "$sandbox_id"
}

prepare() {
  script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
  application_root=$(CDPATH= cd -- "$script_directory/.." && pwd -P)
  cd "$application_root"

  if [ ! -f .env ]; then
    printf '%s\n' 'The sandbox worktree is missing app/.env.' >&2
    exit 1
  fi

  LOCKI_SANDBOX_ID= mise install
  ULTRAMODERN_SKIP_CODEX_SKILLS=1 mise exec -- pnpm install --frozen-lockfile
  mise exec -- pnpm env:local:ensure
  docker compose up --detach --wait
  mise exec -- pnpm db:migrate
  mise exec -- pnpm local:initialize
  mise exec -- pnpm db:verify
}

if [ "${1-}" = '--prepare' ]; then
  if [ "$#" -ne 1 ]; then
    usage >&2
    exit 2
  fi
  prepare
  exit 0
fi

feature_slug=''
launch_ai=true
for argument in "$@"; do
  case "$argument" in
    --)
      ;;
    --no-ai)
      launch_ai=false
      ;;
    --*)
      printf 'Unknown option: %s\n' "$argument" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$feature_slug" ]; then
        usage >&2
        exit 2
      fi
      feature_slug=$argument
      ;;
  esac
done

if [ -z "$feature_slug" ]; then
  usage >&2
  exit 2
fi

case "$feature_slug" in
  *[!a-z0-9-]* | -* | *- | *--*)
    printf '%s\n' 'Feature slug must be lower-kebab-case.' >&2
    exit 2
    ;;
esac

if ! command -v locki >/dev/null 2>&1; then
  printf 'Locki %s or newer is required. Install it with: uv tool install locki==%s\n' \
    "$minimum_locki_version" "$minimum_locki_version" >&2
  exit 1
fi

installed_locki_version=$(locki --version 2>/dev/null || true)
if ! node -e '
const actual = process.argv[1].match(/([0-9]+)\.([0-9]+)\.([0-9]+)/u)?.slice(1).map(Number);
const minimum = process.argv[2].split(".").map(Number);
if (actual === undefined) process.exit(1);
for (let index = 0; index < minimum.length; index += 1) {
  if (actual[index] > minimum[index]) process.exit(0);
  if (actual[index] < minimum[index]) process.exit(1);
}
process.exit(0);
' "$installed_locki_version" "$minimum_locki_version"; then
  printf 'Locki %s or newer is required; found: %s\n' \
    "$minimum_locki_version" "${installed_locki_version:-unknown}" >&2
  exit 1
fi

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
application_root=$(CDPATH= cd -- "$script_directory/.." && pwd -P)
repository_root=$(git -C "$application_root" rev-parse --show-toplevel)
source_environment="$application_root/.env"

if [ ! -f "$source_environment" ]; then
  printf '%s\n' 'Source app/.env is required; .env.example is not used.' >&2
  exit 1
fi

required_development_files='app/.mise.toml
app/scripts/locki-feature.sh
app/scripts/initialize-local-development.mts
app/package.json
app/pnpm-lock.yaml'
for required_file in $required_development_files; do
  if ! git -C "$repository_root" cat-file -e "$development_branch:$required_file" 2>/dev/null; then
    printf 'The workflow is not yet committed on %s (%s is missing).\n' \
      "$development_branch" "$required_file" >&2
    printf 'Commit the workflow files to %s before creating a Locki sandbox.\n' \
      "$development_branch" >&2
    exit 1
  fi
done
if ! git -C "$repository_root" diff --quiet "$development_branch" -- \
  app/.mise.toml \
  app/scripts/locki-feature.sh \
  app/scripts/initialize-local-development.mts \
  app/package.json \
  app/pnpm-lock.yaml; then
  printf 'The working-copy workflow differs from the committed %s version.\n' \
    "$development_branch" >&2
  printf 'Commit the workflow files to %s before creating a Locki sandbox.\n' \
    "$development_branch" >&2
  exit 1
fi

result_file=$(mktemp "${TMPDIR:-/tmp}/ontos-locki-result.XXXXXX")
trap 'rm -f "$result_file"' EXIT HUP INT TERM

if ! locki new --from "$development_branch" --branch "codex/$feature_slug" --json >"$result_file"; then
  printf '%s\n' 'Locki could not create the feature sandbox.' >&2
  exit 1
fi

sandbox_id=$(node -e "const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(typeof value.id!=='string'||value.id.length===0)process.exit(1);process.stdout.write(value.id)" "$result_file")
returned_path=$(node -e "const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(typeof value.path!=='string'||value.path.length===0)process.exit(1);process.stdout.write(value.path)" "$result_file")

case "$returned_path" in
  /*) ;;
  *)
    printf '%s\n' 'Locki returned a non-absolute worktree path.' >&2
    exit 1
    ;;
esac

if [ ! -d "$returned_path/app" ]; then
  printf '%s\n' 'Locki returned a worktree without app/.' >&2
  recovery "$sandbox_id" "$returned_path"
  exit 1
fi

worktree_path=$(CDPATH= cd -- "$returned_path" && pwd -P)
target_application=$(CDPATH= cd -- "$returned_path/app" && pwd -P)
case "$target_application" in
  "$worktree_path/app") ;;
  *)
    printf '%s\n' 'Refusing to copy .env outside the Locki worktree.' >&2
    recovery "$sandbox_id" "$worktree_path"
    exit 1
    ;;
esac

target_environment="$target_application/.env"
install -m 600 "$source_environment" "$target_environment"
if ! git -C "$worktree_path" check-ignore -q app/.env; then
  printf '%s\n' 'Refusing to continue because app/.env is not ignored by Git.' >&2
  recovery "$sandbox_id" "$worktree_path"
  exit 1
fi

if ! locki exec --match "$sandbox_id" -- sh app/scripts/locki-feature.sh --prepare; then
  printf '%s\n' 'Sandbox preparation failed.' >&2
  recovery "$sandbox_id" "$worktree_path"
  exit 1
fi

printf 'Prepared sandbox %s at %s\n' "$sandbox_id" "$worktree_path"
if [ "$launch_ai" = true ]; then
  if ! locki ai --match "$sandbox_id"; then
    recovery "$sandbox_id" "$worktree_path"
    exit 1
  fi
else
  recovery "$sandbox_id" "$worktree_path"
fi
