# Runbook: stand up production in under an hour

Production doesn't exist yet. This page gets it from nothing to a dispatched first deploy. The
details behind each step are in [Create production](../../app/docs/architecture/DEPLOYMENT.md#create-production).

**What you get.** A separate Serious-core Zerops project `ontos-production` that runs the same
topology as stage, in high availability: `db18` becomes `postgresql:ha@18`, and every runtime
except the migrator runs at least 2 containers. Each owner gets its own outbox worker
(`OUTBOX_WORKER_MODE=dedicated`). Production deploys only to Zerops. Only stage can use the
Cloudflare target.

**Stage stays cheap.** Stage keeps its single-container Zerops services, the Cloudflare Workers
target and the shared outbox worker host. Nothing below touches stage or `stage-edge`.

**Cost.** Running this creates paid resources: a Serious-core project, an HA database and about 2×
the runtime containers stage had. Check Zerops pricing for 18 services before step 2.

## What you need (10 min)

| Item                                | Where it comes from                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `zcli` logged in                    | an account allowed to create projects in the stage project's organization (BDA Platform)                       |
| Production Zerops token             | Zerops → Settings → Access tokens. Keep it separate from stage's token                                         |
| Production Shell origin             | a custom domain you control, e.g. `https://ontos.<domain>`. Decide it now: step 2 imports it as a secret       |
| Cloudflare token + account ID       | only for the SpiceDB gateway certificate: "SSL and Certificates: Edit" on a zone you own (e.g. `bleeding.dev`) |
| Production gateway signing key pair | generated below. Never reuse stage's                                                                           |

Generate the gateway key pair and the secrets file. The secret names come from
`provision --dry-run`, so the list always matches the services in the repo. The file holds the
gateway private key: it is created owner-only (`umask 077`). Keep it in the vault, not in the repo:

```sh
cd app
NAMES=$(node scripts/ops/production-environment.mts provision --dry-run | sed -n 's/.*needs --secrets-file with //p')
(umask 077; NAMES="$NAMES" SHELL_ORIGIN=https://ontos.example.com node --input-type=module -e '
import { generateKeyPairSync, randomUUID } from "node:crypto";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const meta = { kid: randomUUID().replaceAll("-", ""), alg: "EdDSA", use: "sig" };
const priv = JSON.stringify({ ...privateKey.export({ format: "jwk" }), ...meta });
const jwks = JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), ...meta }] });
const value = (name) => {
  if (name.endsWith("_ONTOS_GATEWAY_PRIVATE_JWK")) return `\x27${priv}\x27`;
  if (name.endsWith("_ONTOS_GATEWAY_PUBLIC_JWKS")) return `\x27${jwks}\x27`;
  if (name.endsWith("_BETTER_AUTH_URL") || name.endsWith("_BETTER_AUTH_TRUSTED_ORIGINS")) return process.env.SHELL_ORIGIN;
  throw new Error(`no generator for ${name}; add its value by hand`);
};
const names = process.env.NAMES.split(", ").filter(Boolean);
if (names.length === 0) throw new Error("provision --dry-run listed no secret names");
console.log(names.map((name) => `${name}=${value(name)}`).join("\n"));
' > ~/ontos-production-secrets.env)
```

If the script stops on a name it has no generator for, a new service needs a secret this page
doesn't know yet: add its value to the file by hand.

## Steps

1. **Review the plan (5 min).** It runs every read and changes nothing. It works without the token
   or the secrets file and tells you what the real run still needs.

   ```sh
   cd app && git switch --detach origin/main
   node scripts/ops/production-environment.mts render-import
   node scripts/ops/production-environment.mts provision --dry-run
   ```

2. **Provision (15–20 min, mostly Zerops importing).** Creates the project, imports the 18 services
   with their secrets, then sets the `production` GitHub variables and the `ZEROPS_TOKEN` secret.

   ```sh
   printf %s "$PRODUCTION_ZEROPS_TOKEN" | node scripts/ops/production-environment.mts provision \
     --secrets-file ~/ontos-production-secrets.env --zerops-token-stdin
   ```

   If it stops halfway, run the same command again. It reads first and finishes what's missing.

3. **SpiceDB TLS (2 min).** SpiceDB won't start without its gRPC and HTTP gateway certificates.
   The gateway name only has to be inside a zone of the Cloudflare account. It needs no DNS record.

   ```sh
   export ZEROPS_TOKEN="$PRODUCTION_ZEROPS_TOKEN"
   node scripts/ops/production-environment.mts spicedb-tls \
     --gateway-hostname ontos-production-spicedb.bleeding.dev --env-file ~/.cloudflare-ontos-stage-token --dry-run
   # then the same command without --dry-run
   ```

4. **Project variables (5 min).** In the Zerops UI, open `ontos-production` → Environment
   variables and set the 3 project variables stage holds, each to production's Shell origin:
   `MODERN_PUBLIC_SITE_URL`, `ONTOS_GATEWAY_ISSUER` and `ULTRAMODERN_MF_DEV_ORIGIN`.

5. **Domain (5 min).** Add the custom domain to the `shellsuperapp` service in Zerops and point
   DNS at it. It must be the origin you used in the secrets file and step 4.

6. **Pass the authorization gate (blocks step 7).** The deploy plan refuses production until
   production has exact-build enforced authorization evidence and an approved production context
   in `topology/authorization-contexts/`. Neither exists yet: issue #173 (implementation) and
   issue #369 (approval). Until both are done, step 7 fails. See
   [Fail-closed authorization promotion](../../app/docs/architecture/DEPLOYMENT.md#fail-closed-authorization-promotion).

7. **Dispatch the first deploy (1 min).** The first deploy has no base, so it must be `full=true`:

   ```sh
   gh workflow run ultramodern-workspace-gates.yml --ref main -f environment=production -f full=true
   ```

Steps 1–5 and 7 take about 45–60 minutes; step 6 is a separate governance task. The first full deploy then runs on its own: each Zerops unit
builds remotely and units deploy one by one, so expect it to take a few hours on the current
pipeline. Later deploys only push what changed.

## Before it can serve real users

- **Release gates.** The first deploy stops after publishing the composition; it doesn't run the
  authenticated smoke suite. Before sending real traffic, run the
  [required smoke suite](../../app/docs/architecture/DEPLOYMENT.md#required-smoke-suite), then canary, observe, expand and close as the
  [release sequence](../../app/docs/architecture/DEPLOYMENT.md#release-sequence) (steps 8–12) requires.
- **Composition refresh.** The scheduled `refresh-production` lane starts publishing once production
  has deployed.

## HA production vs low-cost stage

|                | Stage (today)                                   | Production                             |
| -------------- | ----------------------------------------------- | -------------------------------------- |
| Units          | Cloudflare Workers (`DEPLOY_TARGET=cloudflare`) | Zerops (`DEPLOY_TARGET=zerops`)        |
| Database       | `postgresql:single@18`                          | `postgresql:ha@18`                     |
| Runtimes       | 1 container                                     | at least 2 containers                  |
| Outbox workers | one shared host (`OUTBOX_WORKER_MODE=host`)     | one service per owner (`dedicated`)    |
| Created by     | `cloudflare-stage-cutover.mts provision`        | `production-environment.mts provision` |

`provision` always builds the HA profile. A low-cost production isn't scripted. To get one, you'd
switch production's `OUTBOX_WORKER_MODE` and container counts by hand.
