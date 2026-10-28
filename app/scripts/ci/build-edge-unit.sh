#!/usr/bin/env bash
# Builds one served unit of the stage demo deploy for Cloudflare on its own CI runner and packs its output.
#
# The plan job hashed the unit's inputs (scripts/ci/deploy-plan.mts); this build first recomputes that digest at its
# own checkout with the plan's HMAC of the unit's release secrets, so a build whose checkout or environment differs
# from the plan's stops before it starts. The digest goes beside the output as inputs.json: a later release may
# upload this exact output under its original identity only while the digest still matches its clean HEAD.
#
# Environment: UNIT_ID, UNIT_PACKAGE, UNIT_PATH (the topology unit), ONTOS_UNIT_INPUT_DIGEST (the planned digest),
# ONTOS_UNIT_SECRET_FINGERPRINT (the planned secret HMAC, `unavailable` without a fingerprint key),
# ULTRAMODERN_SOURCE_REVISION (the clean HEAD), WORKERS_DEV_SUBDOMAIN, RUNNER_TEMP and the deploy-plan.mts
# DIGEST_ENV_KEYS. Writes $RUNNER_TEMP/edge-unit.tar.zst. Run from the repository root.
set -euo pipefail

: "${UNIT_ID:?UNIT_ID (the topology unit id) is required}"
: "${UNIT_PACKAGE:?UNIT_PACKAGE (the unit package name) is required}"
: "${UNIT_PATH:?UNIT_PATH (the workspace-relative unit directory) is required}"
: "${ONTOS_UNIT_INPUT_DIGEST:?ONTOS_UNIT_INPUT_DIGEST (the planned unit digest) is required}"
: "${ONTOS_UNIT_SECRET_FINGERPRINT:?ONTOS_UNIT_SECRET_FINGERPRINT (the planned secret fingerprint) is required}"
: "${ULTRAMODERN_SOURCE_REVISION:?ULTRAMODERN_SOURCE_REVISION (the clean Git HEAD) is required}"
: "${WORKERS_DEV_SUBDOMAIN:?WORKERS_DEV_SUBDOMAIN is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

# Inherited Git selectors (GIT_DIR, GIT_WORK_TREE, hook-exported GIT_INDEX_FILE) would let the digest recomputation and
# the output listing below read another checkout than the one this script builds.
while IFS= read -r name; do
  unset "$name"
done < <(compgen -e | grep '^GIT_' || true)

cd "$(dirname "$0")/../.."
releases=".codex/reports/releases/$UNIT_ID"
mkdir -p "$releases"

# Fails when the recomputed digest differs from the planned one; inputs.json is written only when it matches.
mise exec -- node scripts/ci/deploy-plan.mts unit-digest --unit "$UNIT_ID" \
  --secret-fingerprint "$ONTOS_UNIT_SECRET_FINGERPRINT" \
  --expect-digest "$ONTOS_UNIT_INPUT_DIGEST" \
  --output "$RUNNER_TEMP/edge-unit-inputs.json"

if [[ "$UNIT_ID" == shell-super-app ]]; then
  mise exec -- pnpm exec node scripts/immutable-shell-release.mts plan \
    --workers-dev-subdomain "$WORKERS_DEV_SUBDOMAIN" \
    --plan-file "$releases/plan.json"
else
  mise exec -- pnpm exec node scripts/immutable-application-release.mts plan \
    --vertical "$UNIT_ID" --workers-dev-subdomain "$WORKERS_DEV_SUBDOMAIN" \
    --plan-file "$releases/plan.json"
fi

# Project-mode checks in modern build consume declarations but do not build references. This reference build is
# the unit's type check (it fails on a transitive dependency's type error), so the bundler's checker stays off
# under ULTRAMODERN_DISABLE_BUILD_TS_CHECKER=1.
mise exec -- pnpm exec ultramodern-create ultramodern typecheck --build "$UNIT_PATH/tsconfig.json"

(
  while IFS=$'\t' read -r key value; do
    export "$key=$value"
  done < <(jq -r '.buildEnvironment | to_entries[] | [.key, .value] | @tsv' topology/cloudflare-placement.json)
  while IFS=$'\t' read -r key value; do
    export "$key=$value"
  done < <(jq -r '.buildEnvironment | to_entries[] | [.key, .value] | @tsv' "$releases/plan.json")
  mise exec -- pnpm --filter "$UNIT_PACKAGE" run cloudflare:build
  mise exec -- pnpm --filter "$UNIT_PACKAGE" exec ultramodern-create ultramodern cloudflare-output-verify \
    --app "$UNIT_ID" --require-public-urls
)

files="$RUNNER_TEMP/edge-unit-files"
git ls-files --others --ignored --exclude-standard --directory -z -- "$UNIT_PATH" \
  | grep -zv '/node_modules/$' >"$files"

# Kept units are reused by digest, so an output that names another unit's immutable Worker would go stale when that
# unit changes. Only this unit's own release Worker may appear in its output.
own="$(jq -er '.backendScriptName' "$releases/plan.json")"
foreign="$(xargs -0 -r grep -rhoE --binary-files=text 'ontos-[0-9a-f]{56}' <"$files" | sort -u | grep -vxF "$own" || true)"
if [[ -n "$foreign" ]]; then
  echo "::error title=Foreign release identity::$UNIT_ID's build output names another unit's immutable Workers:" >&2
  echo "$foreign" >&2
  exit 1
fi

cp "$RUNNER_TEMP/edge-unit-inputs.json" "$releases/inputs.json"
printf '%s\0' "$releases" >>"$files"
tar --null --files-from="$files" --create --zstd --file "$RUNNER_TEMP/edge-unit.tar.zst"
ls -lh "$RUNNER_TEMP/edge-unit.tar.zst"
