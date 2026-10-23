#!/usr/bin/env bash
# Called by rebuild-one.sh AFTER committing. Builds only the workspace storefront.
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(dirname "$APP")"
export TMPDIR="${TMPDIR:-/Volumes/DevWork/agent-scratch/ontos-demo}"
export NEXT_TELEMETRY_DISABLED=1
mkdir -p "$TMPDIR" "$ROOT/.scratch/demo-logs" "$ROOT/.scratch/demo-pids" "$ROOT/.scratch/demo-build"
cd "$APP"
# One lockfile and install policy for the entire app workspace.
lock="$(shasum "$ROOT/pnpm-lock.yaml" "$ROOT/pnpm-workspace.yaml" | shasum | cut -d' ' -f1)"
stamp="$ROOT/.scratch/demo-build/akros-install"
if [ ! -d node_modules ] || [ "$(cat "$stamp" 2>/dev/null || true)" != "$lock" ]; then
  (cd "$ROOT" && mise exec -- pnpm install --frozen-lockfile)
  printf '%s' "$lock" > "$stamp"
fi
mise exec -- node scripts/with-demo-env.mjs build > "$ROOT/.scratch/demo-logs/build-akros-storefront.log" 2>&1 || { tail -70 "$ROOT/.scratch/demo-logs/build-akros-storefront.log"; exit 1; }
# Check the actual secret without echoing it; a leaked key makes startup fail closed.
mise exec -- node --input-type=module - "$ROOT/.env.demo.local" <<'NODE'
import {existsSync,readdirSync,readFileSync} from 'node:fs';
if(existsSync(process.argv[2]))process.loadEnvFile(process.argv[2]);
const key=process.env.ONTOS_AKROS_STOREFRONT_API_KEY;
function scan(path){for(const item of readdirSync(path,{withFileTypes:true})){const file=`${path}/${item.name}`;if(item.isDirectory())scan(file);else if(key&&readFileSync(file).includes(Buffer.from(key)))throw new Error('API key found in browser output');}}
scan('.next/static');console.log('[akros] Browser output: no API key');
NODE
pidfile="$ROOT/.scratch/demo-pids/akros-storefront.pid"
if [ -f "$pidfile" ]; then
  pid="$(cat "$pidfile")"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep .3; done
fi
if lsof -nP -iTCP:3070 -sTCP:LISTEN >/dev/null 2>&1; then echo '[akros] Port 3070 belongs to another process; refusing to stop it' >&2; exit 1; fi
set -m
nohup mise exec -- node scripts/with-demo-env.mjs start > "$ROOT/.scratch/demo-logs/akros-storefront.log" 2>&1 </dev/null &
echo $! > "$pidfile"
for _ in $(seq 1 60); do
 if curl -fsS --max-time 10 http://127.0.0.1:3070/ >/dev/null; then echo '[akros] Ready http://localhost:3070'; exit 0; fi
 sleep 1
done
echo "[akros] Startup failed; see $ROOT/.scratch/demo-logs/akros-storefront.log" >&2
exit 1
