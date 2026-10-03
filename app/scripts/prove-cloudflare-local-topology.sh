#!/usr/bin/env bash
# Run the built Shell and every vertical as Workers in workerd, together, against a local
# PostgreSQL (through each Worker's HYPERDRIVE binding) and SpiceDB (through its SPICEDB binding
# to the HTTP gateway), then prove the paths the Cloudflare topology depends on:
#   - repeated database-backed requests (a Worker's Effect runtime never outlives its request);
#   - Shell authentication, and a Shell read authorized by SpiceDB over HTTP;
#   - the approved composition from local KV and matching Core database authority;
#   - Shell SSR, each UI vertical's own SSR route, and a vertical API reached through the Shell
#     through its full admitted release path with a Shell-issued gateway assertion.
#
# Each Worker runs in its own `wrangler dev` session (so each serves its own static assets) and
# owners execute at explicitly pinned local HTTPS origins. These are local transport fixtures, not
# Cloudflare provider receipts. Workers VPC services have no local
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
: "${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL (the local fixture administrator) is required}"
: "${SPICEDB_HTTP_PORT:?SPICEDB_HTTP_PORT is required}"
: "${SPICEDB_PRESHARED_KEY:?SPICEDB_PRESHARED_KEY is required}"
: "${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET is required}"
: "${ONTOS_GATEWAY_PRIVATE_JWK:?ONTOS_GATEWAY_PRIVATE_JWK is required}"
: "${ONTOS_GATEWAY_PUBLIC_JWKS:?ONTOS_GATEWAY_PUBLIC_JWKS is required}"
shell_port="${CLOUDFLARE_LOCAL_SHELL_PORT:-8787}"
first_vertical_port="${CLOUDFLARE_LOCAL_FIRST_PORT:-8790}"
demo_email="${CLOUDFLARE_LOCAL_DEMO_EMAIL:-demo@test.com}"
demo_password="${CLOUDFLARE_LOCAL_DEMO_PASSWORD:-password1234}"
artifact_root="${CLOUDFLARE_LOCAL_ARTIFACT_ROOT:-$app_directory}"
tls_directory="${CLOUDFLARE_LOCAL_TLS_DIRECTORY:-$app_directory/.spicedb-tls}"
owner_certificate="$tls_directory/cert.pem"
owner_private_key="$tls_directory/key.pem"
spicedb_certificate="${CLOUDFLARE_LOCAL_SPICEDB_CA_FILE:-$owner_certificate}"
[ -f "$spicedb_certificate" ] || { echo "$spicedb_certificate is missing; run pnpm spicedb:tls:local" >&2; exit 1; }
[ -f "$owner_certificate" ] || { echo "$owner_certificate is missing; run pnpm spicedb:tls:local" >&2; exit 1; }
[ -f "$owner_private_key" ] || { echo "$owner_private_key is missing; run pnpm spicedb:tls:local" >&2; exit 1; }
# The gateway issuer accepts plain HTTP only for localhost.
shell_origin="http://localhost:${shell_port}"

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ontos-cloudflare-local.XXXXXX")"
pids=()
dev_vars_outputs=()
local_configs=()
owner_names=()
owner_ports=()
authority_fixture_started=false
shell_grant_withdrawn=false
cleanup() {
  status=$?
  # Run once: the exit below would otherwise fire the EXIT trap again after a signal.
  trap - EXIT INT TERM
  # The denial check withdraws the demo principal's Shell grant; never leave it withdrawn.
  if [ "$shell_grant_withdrawn" = true ]; then
    shell_grant OPERATION_TOUCH || echo "Could not restore the Shell grant in SpiceDB" >&2
  fi
  for pid in ${pids[@]+"${pids[@]}"}; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [ "$authority_fixture_started" = true ]; then
    node scripts/cloudflare-local-topology-fixture.mts cleanup --snapshot-file "$work/active.json" ||
      { echo "Could not release the topology fixture's exact composition authority" >&2; status=1; }
  fi
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
  for config in ${local_configs[@]+"${local_configs[@]}"}; do rm -f "$config"; done
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
cat "$spicedb_certificate" "$owner_certificate" > "$work/trusted-local-certificates.pem"
export NODE_EXTRA_CA_CERTS="$work/trusted-local-certificates.pem"
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$DATABASE_URL"
wrangler="$app_directory/apps/shell-super-app/node_modules/.bin/wrangler"
ready_logs=()

start_worker() { # <name> <config> <port> [https]
  local log="$work/logs/$1.log"
  local tls_args=()
  if [ "${4:-}" = https ]; then
    tls_args=(--local-protocol https --https-key-path "$owner_private_key" --https-cert-path "$owner_certificate")
  fi
  (
    # Only the owning script may release the authority and shared run directory.
    trap - EXIT INT TERM
    exec "$wrangler" dev --config "$2" --port "$3" --inspector-port "$(($3 + 1000))" --ip 127.0.0.1 --local \
      --persist-to "$work/state" ${tls_args[@]+"${tls_args[@]}"} \
      --show-interactive-dev-session=false
  ) >"$log" 2>&1 &
  pids+=("$!")
  ready_logs+=("$log")
}

owner_port() { # <app id>
  local index
  for index in "${!owner_names[@]}"; do
    if [ "${owner_names[$index]}" = "$1" ]; then
      printf '%s' "${owner_ports[$index]}"
      return
    fi
  done
  echo "No admitted local owner port for $1" >&2
  return 1
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

# Derive one approved inventory from unmodified native output bytes before adding any local config.
printf '[]' > "$work/owners.json"
port="$first_vertical_port"
for output in "$artifact_root"/verticals/*/.output; do
  [ -f "$output/wrangler.json" ] || { echo "$output has no wrangler.json; run pnpm cloudflare:build" >&2; exit 1; }
  name="$(basename "$(dirname "$output")")"
  owner_names+=("$name")
  owner_ports+=("$port")
  node --input-type=module --eval '
    import { readFileSync, writeFileSync } from "node:fs";
    const [file, appId, outputDirectory, port] = process.argv.slice(1);
    const owners = JSON.parse(readFileSync(file, "utf8"));
    owners.push({ appId, baseUrl: "https://localhost:" + port + "/", outputDirectory });
    writeFileSync(file, JSON.stringify(owners));
  ' "$work/owners.json" "$name" "$output" "$port"
  port=$((port + 1))
done
shell_output="$artifact_root/apps/shell-super-app/.output"
node scripts/cloudflare-local-topology-fixture.mts prepare \
  --intent-file topology/application-release-intent.json --owners-file "$work/owners.json" \
  --shell-output "$shell_output" --shell-origin "$shell_origin" \
  --snapshot-file "$work/active.json" --paths-file "$work/paths.json"
revision="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).revision)' "$work/paths.json")"
node scripts/cloudflare-local-topology-fixture.mts seed --snapshot-file "$work/active.json"
authority_fixture_started=true

for output in "$artifact_root"/verticals/*/.output "$shell_output"; do
  write_dev_vars "$output"
  config="$output/wrangler.local-topology.$(basename "$work").json"
  local_configs+=("$config")
  node --input-type=module --eval '
    import { readFileSync, writeFileSync } from "node:fs";
    const [output, localConfig] = process.argv.slice(1);
    const config = JSON.parse(readFileSync(output + "/wrangler.json", "utf8"));
    const vpcServices = config.vpc_services ?? [];
    delete config.vpc_services;
    config.services = [
      ...(config.services ?? []),
      ...vpcServices.map(({ binding }) => ({ binding, service: "ontos-local-spicedb-gateway" })),
    ];
    const composition = config.kv_namespaces?.find(({ binding }) => binding === "ONTOS_ACTIVE_APPLICATION_COMPOSITION");
    if (composition === undefined) throw new Error("The native Worker must bind the active composition KV");
    composition.id = "0000000000000000000000000000cf0001";
    delete composition.preview_id;
    writeFileSync(localConfig, JSON.stringify(config, null, 2));
  ' "$output" "$config"
  if [ "$output" = "$shell_output" ]; then
    shell_config="$config"
  fi
done
# Every actual Worker reads the same explicit local KV namespace and exact encoded snapshot.
"$wrangler" kv key put active --binding ONTOS_ACTIVE_APPLICATION_COMPOSITION --path "$work/active.json" \
  --local --persist-to "$work/state" --config "$shell_config" >"$work/logs/kv-seed.log" 2>&1
start_worker spicedb-gateway "$work/spicedb-gateway/wrangler.json" "$((first_vertical_port - 1))"
for index in "${!dev_vars_outputs[@]}"; do
  output="${dev_vars_outputs[$index]}"
  config="${local_configs[$index]}"
  if [ "$output" = "$shell_output" ]; then
    start_worker shell-super-app "$config" "$shell_port"
  else
    name="$(basename "$(dirname "$output")")"
    start_worker "$name" "$config" "$(owner_port "$name")" https
  fi
done

deadline=$((SECONDS + 180))
for log in ${ready_logs[@]+"${ready_logs[@]}"}; do
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
  curl --silent --show-error --compressed --max-time 30 --cacert "$owner_certificate" --output "$output" --write-out '%{http_code}' \
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
  "$(request "$work/composition-denied.json" "$shell_origin/shell-super-app-api/shell/composition?compositionRevision=$revision")"
node -e '
  const problem = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (problem._tag !== "ShellTargetForbiddenProblem" || problem.status !== 403) {
    throw new Error("The missing SpiceDB grant must produce the native Shell forbidden problem");
  }' "$work/composition-denied.json"
shell_grant OPERATION_TOUCH
shell_grant_withdrawn=false

# 3. The Shell projects the complete approved inventory under the exact native authority revision.
check "Shell composition is allowed by SpiceDB over HTTP" 200 \
  "$(request "$work/composition.json" "$shell_origin/shell-super-app-api/shell/composition?compositionRevision=$revision")"
node -e '
  const fs = require("fs");
  const composition = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const paths = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (composition.state !== "available" || composition.compositionRevision !== paths.revision || composition.unavailableDeployments.length !== 0) {
    console.error("FAIL: the approved composition is unavailable or has a different revision", JSON.stringify(composition));
    process.exit(1);
  }
  if (!composition.navigation.some(({ appId }) => appId === "party-registry")) {
    console.error("FAIL: Party Registry is missing from the Shell navigation", JSON.stringify(composition));
    process.exit(1);
  }
  console.log("ok: the Shell admitted the complete pinned composition");' "$work/composition.json" "$work/paths.json"

# Resolve the canonical Party page declared by the actual approved contract.
node -e '
  const fs = require("fs");
  const paths = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.writeFileSync(process.argv[2], JSON.stringify({ canonicalPath: paths.party.routePath, compositionRevision: paths.revision }));
  console.log(paths.party.shellPagePath);' "$work/paths.json" "$work/page-selector.json" > "$work/party-page-path"
check "Shell admits the contract-declared Party page" 200 \
  "$(request "$work/page-target.json" -H 'content-type: application/json' --data-binary "@$work/page-selector.json" \
    "$shell_origin/shell-super-app-api/shell/module-target")"
node -e '
  const fs = require("fs");
  const target = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const paths = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const party = paths.party;
  if (target.compositionRevision !== paths.revision || target.appId !== party.appId || target.moduleId !== party.moduleId ||
      target.entrypointKey !== party.entrypointKey || target.componentKey !== party.componentKey ||
      target.federation.expose !== party.expose || target.federation.remoteName !== party.remoteName ||
      Object.keys(target.routeParameters).length !== 0 || target.federation.manifest.sha256 !== party.federationManifest.sha256 ||
      target.federation.manifest.url !== party.federationManifest.url) {
    throw new Error("The resolved Party page must match the admitted contract and artifact pins");
  }' "$work/page-target.json" "$work/paths.json"

# 4. The independently executing Party owner behind the full release gateway refuses a governed read
#    without an assertion and answers it with the one the Shell issued (assertions are single-use).
#    The answer needs the vertical's own registration of the staff namespace the assertion names.
gateway_status="$(request "$work/gateway.json" -H 'content-type: application/json' \
  --data "{\"audience\":\"party-registry\",\"compositionRevision\":\"$revision\"}" \
  "$shell_origin/shell-super-app-api/auth/gateway-context")"
if [ "$gateway_status" != 200 ]; then
  node -e '
    const body = require("fs").readFileSync(process.argv[1], "utf8");
    if (body.trim().length === 0) {
      console.error("Gateway issuance failed: empty HTTP error response");
      process.exit(0);
    }
    let problem;
    try { problem = JSON.parse(body); } catch {
      console.error("Gateway issuance failed: non-JSON HTTP error response");
      process.exit(0);
    }
    if (problem === null || typeof problem !== "object") {
      console.error("Gateway issuance failed: non-object JSON error response");
      process.exit(0);
    }
    console.error("Gateway issuance failed:", JSON.stringify({
      tag: problem._tag, status: problem.status, title: problem.title, detail: problem.detail,
      reason: problem.reason, message: problem.message,
    }));' "$work/gateway.json"
fi
check "Shell issues a Party Registry gateway assertion" 200 "$gateway_status"
assertion="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).token)' "$work/gateway.json")"
party_api_base="$(node -e '
  const fs = require("fs");
  const gateway = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const paths = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (gateway.compositionRevision !== paths.revision || gateway.apiBaseUrl !== paths.party.apiBaseUrl) {
    throw new Error("The gateway assertion must bind the exact admitted release and composition");
  }
  console.log(gateway.apiBaseUrl);' "$work/gateway.json" "$work/paths.json")"
party_search() { # <output file> [curl args...]
  local output="$1"
  shift
  request "$output" -H 'content-type: application/json' -H "x-correlation-id: $(node -e 'console.log(crypto.randomUUID())')" \
    -H "x-ontos-composition-revision: $revision" "$@" --data '{"query":"acme"}' \
    "$shell_origin$party_api_base/party.registry/search/parties"
}
anonymous_status="$(party_search "$work/party-anonymous.json" --dump-header "$work/party-anonymous.headers")"
if [ "$anonymous_status" != 401 ]; then
  # Diagnose only: this direct owner request never replaces the required Shell gateway result.
  direct_status="$(curl --silent --show-error --compressed --max-time 30 --cacert "$owner_certificate" \
    --output "$work/party-direct-anonymous.json" --write-out '%{http_code}' \
    -H 'content-type: application/json' -H "origin: $shell_origin" \
    -H "x-correlation-id: $(node -e 'console.log(crypto.randomUUID())')" \
    -H "x-ontos-composition-revision: $revision" --data '{"query":"acme"}' \
    "https://localhost:$(owner_port party-registry)/party-registry-api/party.registry/search/parties")" || direct_status=000
  echo "diagnostic: direct anonymous Party HTTPS owner answered HTTP $direct_status" >&2
  node -e '
    const fs = require("fs");
    const body = fs.existsSync(process.argv[1]) ? fs.readFileSync(process.argv[1], "utf8") : "";
    let problem;
    try { problem = JSON.parse(body); } catch {
      console.error("Direct owner error body is empty or non-JSON; byte length:", Buffer.byteLength(body));
      process.exit(0);
    }
    console.error("Direct owner safe problem:", JSON.stringify({
      tag: problem?._tag, status: problem?.status, title: problem?.title, detail: problem?.detail,
      reason: problem?.reason, message: problem?.message,
    }));' "$work/party-direct-anonymous.json"
  node -e '
    const fs = require("fs");
    const path = require("path");
    for (const name of ["shell-super-app", "party-registry"]) {
      const file = path.join(process.argv[1], name + ".log");
      const lines = fs.readFileSync(file, "utf8").split("\n")
        .map(line => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""))
        .filter(line => /Uncaught (Error|TypeError)|internal error; reference =|^\s+at |^\s*(cause|stack|code)\s*:/i.test(line))
        .slice(-30)
        .map(line => line.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
          .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted token]"));
      console.error("Native Worker safe stack/cause lines for " + name + ":", JSON.stringify(lines));
    }' "$work/logs"
fi
check "Party Registry refuses a governed read without an assertion" 401 "$anonymous_status"
node -e '
  const fs = require("fs");
  const problem = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const headers = fs.readFileSync(process.argv[2], "utf8");
  if (problem._tag !== "PartiesProviderAuthenticationProblem" || problem.status !== 401 || !/^www-authenticate: Bearer\s*$/im.test(headers)) {
    throw new Error("The actual Party owner must refuse anonymous governed reads with its native authentication problem");
  }' "$work/party-anonymous.json" "$work/party-anonymous.headers"
check "Shell rejects a stale composition before redeeming the owner assertion" 409 \
  "$(request "$work/party-stale.json" -H 'content-type: application/json' -H "authorization: Bearer $assertion" \
    -H "x-ontos-composition-revision: ${revision:0:63}$([ "${revision:63:1}" = 0 ] && echo 1 || echo 0)" \
    --data '{"query":"acme"}' "$shell_origin$party_api_base/party.registry/search/parties")"
asserted_status="$(party_search "$work/party-asserted.json" --dump-header "$work/party-asserted.headers" -H "authorization: Bearer $assertion")"
[ "$asserted_status" = 200 ] || echo "Party Registry answered: $(cat "$work/party-asserted.json")" >&2
check "Party Registry answers a governed read through the admitted native HTTPS release gateway" 200 \
  "$asserted_status"
node -e '
  const fs = require("fs");
  const decoded = fs.readFileSync(process.argv[1]);
  let results;
  try { results = JSON.parse(decoded.toString("utf8")); } catch {
    const headers = fs.readFileSync(process.argv[2], "utf8");
    const header = name => headers.split(/\r?\n/)
      .filter(line => line.toLowerCase().startsWith(name + ":"))
      .map(line => line.slice(line.indexOf(":") + 1).trim()).at(-1);
    const diagnostic = {
      status: headers.match(/^HTTP\/\S+\s+\d{3}[^\r\n]*/gm)?.at(-1)?.split(/\s+/)[1],
      contentEncoding: header("content-encoding") ?? "identity",
      contentType: header("content-type"),
      declaredLength: header("content-length"),
      decodedByteLength: decoded.length,
      decodedSha256: require("crypto").createHash("sha256").update(decoded).digest("hex"),
    };
    console.error("Party Registry safe decoded-response diagnostic:", JSON.stringify(diagnostic));
    throw new Error("The native Party Registry decoded response did not parse as JSON");
  }
  if (!Array.isArray(results)) {
    console.error("FAIL: the Party Registry read did not answer its result list", JSON.stringify(results));
    process.exit(1);
  }
  console.log("ok: the Party Registry read answered " + results.length + " result(s)");' "$work/party-asserted.json" "$work/party-asserted.headers"
# 5. SSR: the Shell renders the authenticated Party Registry page frame; each UI vertical Worker
#    renders its own route.
party_page_path="$(cat "$work/party-page-path")"
check "Shell SSR of the admitted Party page" 200 "$(request "$work/shell-party.html" "$shell_origin$party_page_path")"
grep -q 'Local User\|aria-label="Dashboard header"' "$work/shell-party.html" ||
  { echo "FAIL: Shell SSR did not render the authenticated frame" >&2; exit 1; }
node -e '
  const html = require("fs").readFileSync(process.argv[1], "utf8");
  const meta = html.match(/<meta\b[^>]*>/g) ?? [];
  if (!meta.some(tag => tag.includes("name=\"ontos-composition-revision\"") && tag.includes("content=\"" + process.argv[2] + "\""))) {
    throw new Error("Shell SSR must pin the admitted composition revision");
  }
  const renderedText = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<[^>]*>/g, " ");
  if (!renderedText.includes("Loading module")) {
    throw new Error("Shell SSR must render the resolved admitted target loading state");
  }' "$work/shell-party.html" "$revision"
for page in "party-registry:$party_page_path:Party Registry" "catalog:/en:Catalog" "commerce-market-catalog:/en:Commerce Market Catalog"; do
  IFS=: read -r name route marker <<<"$page"
  check "$name Worker SSR of $route" 200 "$(request "$work/$name.html" "https://localhost:$(owner_port "$name")$route")"
  grep -q "$marker" "$work/$name.html" || { echo "FAIL: $name SSR did not render $marker" >&2; exit 1; }
done

echo "Cloudflare local topology proof passed"
