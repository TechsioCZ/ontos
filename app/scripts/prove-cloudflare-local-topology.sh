#!/usr/bin/env bash
# Run the built Shell and every vertical as Workers in workerd, together, against a local
# PostgreSQL (through each Worker's HYPERDRIVE binding) and SpiceDB (through its SPICEDB binding
# to the HTTP gateway), then prove the paths the Cloudflare topology depends on:
#   - repeated database-backed requests (a Worker's Effect runtime never outlives its request);
#   - Shell authentication, and a Shell read authorized by SpiceDB over HTTP;
#   - the Shell's module discovery over Worker service bindings;
#   - Shell SSR, each UI vertical's own SSR route, and a vertical API reached through the Shell
#     with a Shell-issued gateway assertion.
#
# Each Worker runs in its own `wrangler dev` session (so each serves its own static assets) and
# the sessions reach each other through a private dev registry. Workers VPC services have no local
# mode, so the SPICEDB binding points at a tiny local gateway Worker that forwards to SpiceDB's
# HTTPS gateway port, which is what the tunnel does in the account. workerd trusts the local
# SpiceDB certificate (`pnpm spicedb:tls:local`) through NODE_EXTRA_CA_CERTS.
#
# Usage: bash scripts/prove-cloudflare-local-topology.sh
# Needs: `pnpm cloudflare:build` outputs, a migrated database with `pnpm local:initialize` data,
# SpiceDB serving its HTTPS gateway with the local certificate, and the environment named below
# (the values the proving Cloudflare build shards set).
set -euo pipefail

app_directory="$(cd "$(dirname "$0")/.." && pwd)"
cd "$app_directory"

: "${DATABASE_URL:?DATABASE_URL (the runtime role) is required}"
: "${SPICEDB_HTTP_PORT:?SPICEDB_HTTP_PORT is required}"
: "${SPICEDB_PRESHARED_KEY:?SPICEDB_PRESHARED_KEY is required}"
: "${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET is required}"
: "${ONTOS_GATEWAY_PRIVATE_JWK:?ONTOS_GATEWAY_PRIVATE_JWK is required}"
: "${ONTOS_GATEWAY_PUBLIC_JWKS:?ONTOS_GATEWAY_PUBLIC_JWKS is required}"
shell_port="${CLOUDFLARE_LOCAL_SHELL_PORT:-8787}"
first_vertical_port="${CLOUDFLARE_LOCAL_FIRST_PORT:-8790}"
demo_email="${CLOUDFLARE_LOCAL_DEMO_EMAIL:-demo@test.com}"
demo_password="${CLOUDFLARE_LOCAL_DEMO_PASSWORD:-password1234}"
spicedb_certificate="$app_directory/.spicedb-tls/cert.pem"
[ -f "$spicedb_certificate" ] || { echo "$spicedb_certificate is missing; run pnpm spicedb:tls:local" >&2; exit 1; }
# The gateway issuer accepts plain HTTP only for localhost.
shell_origin="http://localhost:${shell_port}"

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ontos-cloudflare-local.XXXXXX")"
pids=()
dev_vars_outputs=()
shell_grant_withdrawn=false
cleanup() {
  status=$?
  # Run once: the exit below would otherwise fire the EXIT trap again after a signal.
  trap - EXIT INT TERM
  # The denial check withdraws the demo principal's Shell grant; never leave it withdrawn.
  if [ "$shell_grant_withdrawn" = true ]; then
    shell_grant OPERATION_TOUCH || echo "Could not restore the Shell grant in SpiceDB" >&2
  fi
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    for log in "$work"/logs/*.log; do
      echo "::group::$(basename "$log")"
      grep -v -E 'Environment Variable|Duplicate key|^\s*$' "$log" | tail -n 80 || true
      echo "::endgroup::"
    done
  fi
  # Put back each output's own .dev.vars (for example the SSR proof's), or remove the one this run wrote.
  for index in "${!dev_vars_outputs[@]}"; do
    if [ -f "$work/dev-vars/$index" ]; then
      cp -p "$work/dev-vars/$index" "${dev_vars_outputs[$index]}/.dev.vars"
    else
      rm -f "${dev_vars_outputs[$index]}/.dev.vars"
    fi
  done
  find apps/*/.output verticals/*/.output -maxdepth 1 -name wrangler.local-topology.json -delete
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT INT TERM
mkdir -p "$work/logs" "$work/registry" "$work/spicedb-gateway"

# The local stand-in for the SPICEDB Workers VPC service.
cat > "$work/spicedb-gateway/index.mjs" <<'EOF'
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const origin = new URL(env.SPICEDB_GATEWAY_ORIGIN);
    url.protocol = origin.protocol;
    url.host = origin.host;
    return fetch(new Request(url, request));
  },
};
EOF
cat > "$work/spicedb-gateway/wrangler.json" <<EOF
{
  "name": "ontos-local-spicedb-gateway",
  "main": "index.mjs",
  "compatibility_date": "2026-06-02",
  "vars": { "SPICEDB_GATEWAY_ORIGIN": "https://localhost:${SPICEDB_HTTP_PORT}" }
}
EOF

export WRANGLER_REGISTRY_PATH="$work/registry"
export NODE_EXTRA_CA_CERTS="$spicedb_certificate"
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$DATABASE_URL"
wrangler="$app_directory/apps/shell-super-app/node_modules/.bin/wrangler"
ready_logs=()

start_worker() { # <name> <config> <port>
  local log="$work/logs/$1.log"
  "$wrangler" dev --config "$2" --port "$3" --inspector-port "$(($3 + 1000))" --ip 127.0.0.1 --local \
    --show-interactive-dev-session=false >"$log" 2>&1 &
  pids+=("$!")
  ready_logs+=("$log")
}

# Worker secrets, as `wrangler secret put` sets them in the account. SPICEDB_ENDPOINT names the
# HTTP gateway (the binding ignores the host); the Workers' own DATABASE_URL is their HYPERDRIVE.
write_dev_vars() {
  mkdir -p "$work/dev-vars"
  if [ -f "$1/.dev.vars" ]; then
    cp -p "$1/.dev.vars" "$work/dev-vars/${#dev_vars_outputs[@]}"
  fi
  dev_vars_outputs+=("$1")
  {
    printf 'BETTER_AUTH_SECRET=%s\n' "$BETTER_AUTH_SECRET"
    printf 'BETTER_AUTH_URL=%s\n' "$shell_origin"
    printf 'BETTER_AUTH_TRUSTED_ORIGINS=%s,http://127.0.0.1:%s\n' "$shell_origin" "$shell_port"
    printf 'ONTOS_GATEWAY_ISSUER=%s\n' "$shell_origin"
    printf 'ONTOS_GATEWAY_PRIVATE_JWK=%s\n' "$ONTOS_GATEWAY_PRIVATE_JWK"
    printf 'ONTOS_GATEWAY_PUBLIC_JWKS=%s\n' "$ONTOS_GATEWAY_PUBLIC_JWKS"
    printf 'SPICEDB_ENDPOINT=localhost:%s\n' "$SPICEDB_HTTP_PORT"
    printf 'SPICEDB_PRESHARED_KEY=%s\n' "$SPICEDB_PRESHARED_KEY"
  } >|"$1/.dev.vars"
}

start_worker spicedb-gateway "$work/spicedb-gateway/wrangler.json" "$((first_vertical_port - 1))"
port="$first_vertical_port"
for output in verticals/*/.output apps/shell-super-app/.output; do
  [ -f "$output/wrangler.json" ] || { echo "$output has no wrangler.json; run pnpm cloudflare:build" >&2; exit 1; }
  write_dev_vars "$output"
  node --input-type=module --eval '
    import { readFileSync, writeFileSync } from "node:fs";
    const [output] = process.argv.slice(1);
    const config = JSON.parse(readFileSync(`${output}/wrangler.json`, "utf8"));
    const vpcServices = config.vpc_services ?? [];
    delete config.vpc_services;
    config.services = [
      ...(config.services ?? []),
      ...vpcServices.map(({ binding }) => ({ binding, service: "ontos-local-spicedb-gateway" })),
    ];
    writeFileSync(`${output}/wrangler.local-topology.json`, JSON.stringify(config, null, 2));
  ' "$output"
  if [ "$output" = apps/shell-super-app/.output ]; then
    start_worker shell-super-app "$output/wrangler.local-topology.json" "$shell_port"
  else
    name="$(basename "$(dirname "$output")")"
    eval "port_${name//-/_}=$port"
    start_worker "$name" "$output/wrangler.local-topology.json" "$port"
    port=$((port + 1))
  fi
done

deadline=$((SECONDS + 180))
for log in "${ready_logs[@]}"; do
  until grep -q 'Ready on' "$log"; do
    if grep -q '✘' "$log" || [ "$SECONDS" -ge "$deadline" ]; then
      echo "Worker session $(basename "$log" .log) did not start" >&2
      exit 1
    fi
    sleep 1
  done
done
echo "Started $((${#ready_logs[@]} - 1)) Workers and the local SPICEDB gateway"

check() { # <description> <expected status> <actual status>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 (expected HTTP $2, got $3)" >&2
    exit 1
  fi
  echo "ok: $1"
}
jar="$work/cookies"
request() { # <output file> <curl args...>; prints the status
  local output="$1"
  shift
  curl --silent --show-error --max-time 30 --output "$output" --write-out '%{http_code}' \
    --cookie "$jar" --cookie-jar "$jar" -H "origin: $shell_origin" "$@"
}

# 1. Database through HYPERDRIVE, twice: a runtime kept across requests would hang the second.
for attempt in 1 2 3; do
  status="$(request "$work/sign-in.json" -H 'content-type: application/json' \
    --data "{\"email\":\"$demo_email\",\"password\":\"$demo_password\"}" "$shell_origin/shell-super-app-api/auth/sign-in")"
  check "Shell sign-in $attempt reads PostgreSQL through HYPERDRIVE" 200 "$status"
done
principal_id="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).identity.principalId)' "$work/sign-in.json")"
session_status="$(request "$work/session.json" "$shell_origin/shell-super-app-api/auth/session")"
check "Shell session read" 200 "$session_status"
read -r tenant_id legal_entity_id < <(node -e '
  const { identity } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(identity.tenantId, identity.legalEntityId);' "$work/session.json")

# 2. SpiceDB over HTTP decides the Shell's governed read: denied without the Shell grant, allowed
#    with it (the grant the e2e fixture writes for its principals).
spicedb() { # <path> <json body>
  curl --silent --show-error --fail --max-time 10 -H "authorization: Bearer $SPICEDB_PRESHARED_KEY" \
    -H 'content-type: application/json' --cacert "$spicedb_certificate" --data "$2" \
    "https://localhost:${SPICEDB_HTTP_PORT}$1"
}
context_id() { printf 'ctx_%s' "$(printf '%s' "$1" | base64 | tr '+/' '-_' | tr -d '=\n')"; }
shell_access="$(context_id "[\"$tenant_id\",\"$legal_entity_id\",\"core.shell\"]")"
legal_entity_access="$(context_id "[\"$tenant_id\",\"$legal_entity_id\"]")"
shell_grant() { # <OPERATION_DELETE|OPERATION_TOUCH>
  spicedb /v1/relationships/write "{\"updates\":[
    {\"operation\":\"$1\",\"relationship\":{\"resource\":{\"objectType\":\"module_access\",\"objectId\":\"$shell_access\"},\"relation\":\"accessor\",\"subject\":{\"object\":{\"objectType\":\"principal\",\"objectId\":\"$principal_id\"}}}},
    {\"operation\":\"$1\",\"relationship\":{\"resource\":{\"objectType\":\"module_access\",\"objectId\":\"$shell_access\"},\"relation\":\"legal_entity\",\"subject\":{\"object\":{\"objectType\":\"legal_entity\",\"objectId\":\"$legal_entity_access\"}}}}]}" >/dev/null
}
shell_grant_withdrawn=true
shell_grant OPERATION_DELETE
check "Shell composition is denied by SpiceDB over HTTP without the Shell grant" 403 \
  "$(request "$work/composition-denied.json" "$shell_origin/shell-super-app-api/shell/composition")"
shell_grant OPERATION_TOUCH
shell_grant_withdrawn=false

# 3. Module discovery over service bindings: every UI vertical's contract answers through its
#    VERTICAL_*_WORKER binding, so no deployment is reported unavailable.
check "Shell composition is allowed by SpiceDB over HTTP" 200 \
  "$(request "$work/composition.json" "$shell_origin/shell-super-app-api/shell/composition")"
node -e '
  const composition = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (composition.state !== "available" || composition.unavailableDeployments.length !== 0) {
    console.error("FAIL: module discovery over service bindings", JSON.stringify(composition));
    process.exit(1);
  }
  if (!composition.navigation.some(({ appId }) => appId === "party-registry")) {
    console.error("FAIL: Party Registry is missing from the Shell navigation", JSON.stringify(composition));
    process.exit(1);
  }
  console.log("ok: every UI vertical contract answered over its service binding");' "$work/composition.json"

# 4. SSR: the Shell renders the authenticated Party Registry page frame; each UI vertical Worker
#    renders its own route.
check "Shell SSR of /en/contacts" 200 "$(request "$work/shell-contacts.html" "$shell_origin/en/contacts")"
grep -q 'Techsio Demo\|aria-label="Dashboard header"' "$work/shell-contacts.html" ||
  { echo "FAIL: Shell SSR did not render the authenticated frame" >&2; exit 1; }
for page in "party-registry:/en/contacts:Party Registry" "catalog:/en:Catalog" "commerce-market-catalog:/en:Commerce Market Catalog"; do
  IFS=: read -r name route marker <<<"$page"
  port_variable="port_${name//-/_}"
  check "$name Worker SSR of $route" 200 "$(request "$work/$name.html" "http://127.0.0.1:${!port_variable}$route")"
  grep -q "$marker" "$work/$name.html" || { echo "FAIL: $name SSR did not render $marker" >&2; exit 1; }
done

# 5. A vertical API through the Shell's service binding: Party Registry refuses a governed read
#    without an assertion and answers it with the one the Shell issued (assertions are single-use).
#    The answer needs the vertical's own registration of the staff namespace the assertion names.
check "Shell issues a Party Registry gateway assertion" 200 \
  "$(request "$work/gateway.json" -H 'content-type: application/json' --data '{"audience":"party-registry"}' \
    "$shell_origin/shell-super-app-api/auth/gateway-context")"
assertion="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).token)' "$work/gateway.json")"
party_search() { # <output file> [curl args...]
  local output="$1"
  shift
  request "$output" -H 'content-type: application/json' -H "x-correlation-id: $(node -e 'console.log(crypto.randomUUID())')" \
    "$@" --data '{"query":"acme"}' "$shell_origin/party-registry-api/party.registry/search/parties"
}
check "Party Registry refuses a governed read without an assertion" 401 "$(party_search "$work/party-anonymous.json")"
asserted_status="$(party_search "$work/party-asserted.json" -H "authorization: Bearer $assertion")"
[ "$asserted_status" = 200 ] || echo "Party Registry answered: $(cat "$work/party-asserted.json")" >&2
check "Party Registry answers a governed read with the Shell-issued assertion over the Shell service binding" 200 \
  "$asserted_status"
node -e '
  const results = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(results)) {
    console.error("FAIL: the Party Registry read did not answer its result list", JSON.stringify(results));
    process.exit(1);
  }
  console.log(`ok: the Party Registry read answered ${results.length} result(s)`);' "$work/party-asserted.json"
echo "Cloudflare local topology proof passed"
