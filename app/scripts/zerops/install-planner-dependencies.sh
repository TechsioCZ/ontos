#!/usr/bin/env bash
# The stage plan job's install (zerops-stage.yml, job `plan`): only the root importer, frozen. Its own file so the
# planner dependency cache key can hash exactly this command and its flags, not the whole workflow (an unrelated
# workflow edit wrote another 545 MiB entry). Run from app/.
set -euo pipefail
exec mise exec -- pnpm --config.verify-deps-before-run=false install --frozen-lockfile --trust-lockfile --filter app
