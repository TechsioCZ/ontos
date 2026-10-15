#!/usr/bin/env bash
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v mise >/dev/null 2>&1 || { echo '[demo] Install mise and run mise install in app/.' >&2; exit 1; }
cd "$APP"
export MISE_ARGV0=
exec mise exec -- node scripts/demo/lifecycle.mts "$@"
