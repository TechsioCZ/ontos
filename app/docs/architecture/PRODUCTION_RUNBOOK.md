# Stand up production in under an hour

Production doesn't exist yet. This page gets it from nothing to a dispatched first deploy. The
details behind each step are in [Create production](DEPLOYMENT.md#create-production).

**What you get.** A separate Serious-core Zerops project `ontos-production` that runs the same
topology as stage, in high availability: `db18` becomes `postgresql:ha@18`, and every runtime
except the migrator runs at least 2 containers. Each owner gets its own outbox worker
(`OUTBOX_WORKER_MODE=dedicated`). Production deploys only to Zerops. Only stage can use the
Cloudflare target.

**Stage stays cheap.** Stage keeps its single-container Zerops services, the Cloudflare Workers
target and the shared outbox worker host. Nothing below touches stage or `stage-edge`.

**Cost.** Running this creates paid resources: a Serious-core project, an HA database and about 2×
the runtime containers stage had. Check Zerops pricing for 18 services before step 3.

## What you need (10 min)

| Item                                | Where it comes from                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `zcli` logged in                    | an account allowed to create projects in the stage project's organization (BDA Platform)                       |
| Production Zerops token             | Zerops → Settings → Access tokens. Keep it separate from stage's token                                         |
| Production Shell origin             | a domain for the Shell, e.g. `https://ontos.<domain>`, or the Zerops subdomain you get after step 3            |
| Cloudflare token + account ID       | only for the SpiceDB gateway certificate: "SSL and Certificates: Edit" on a zone you own (e.g. `bleeding.dev`) |
| Production gateway signing key pair | generated below. Never reuse stage's                                                                           |

Generate the gateway key pair and the secrets file. Keep the file in the vault, not in the repo:

```sh
cd app
SHELL_ORIGIN=https://ontos.example.com node --input-type=module -e '
import { generateKeyPairSync, randomUUID } from "node:crypto";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const kid = randomUUID().replaceAll("-", "");
const meta = { kid, alg: "EdDSA", use: "sig" };
const priv = JSON.stringify({ ...privateKey.export({ format: "jwk" }), ...meta });
const jwks = JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), ...meta }] });
const origin = process.env.SHELL_ORIGIN;
const verticals = ["partyregistry","commercecustomercontext","paymenttermcatalog","commercemarketcatalog","catalog","assortment","pricing","storefrontregistry","pricegroupcatalog","inventory"];
console.log([
  `shellsuperapp_BETTER_AUTH_URL=${origin}`,
  `shellsuperapp_BETTER_AUTH_TRUSTED_ORIGINS=${origin}`,
  `shellsuperapp_ONTOS_GATEWAY_PRIVATE_JWK=\x27${priv}\x27`,
  ...verticals.map((v) => `${v}_ONTOS_GATEWAY_PUBLIC_JWKS=\x27${jwks}\x27`),
].join("\n"));
' > ~/ontos-production-secrets.env
```

`provision --dry-run` prints the exact list of secret names it needs, so check it against the file.

## Steps

1. **Review the plan (5 min).** It runs every read and changes nothing. It works without the token
   or the secrets file and tells you what the real run still needs.

   ```sh
   cd app && git switch --detach origin/main
   node scripts/ops/production-environment.mts render-import
   node scripts/ops/production-environment.mts provision --dry-run --spicedb-endpoint spicedb:50051
   ```

2. **Pick the SpiceDB endpoint.** Use `spicedb:50051`, the in-project SpiceDB. Its gRPC certificate
   (step 4) covers `spicedb`, and runtimes pin it.

3. **Provision (15–20 min, mostly Zerops importing).** Creates the project, imports the 18 services
   with their secrets, then sets the `production` GitHub variables and the `ZEROPS_TOKEN` secret.

   ```sh
   printf %s "$PRODUCTION_ZEROPS_TOKEN" | node scripts/ops/production-environment.mts provision \
     --spicedb-endpoint spicedb:50051 --secrets-file ~/ontos-production-secrets.env --zerops-token-stdin
   ```

   If it stops halfway, run the same command again. It reads first and finishes what's missing.

4. **SpiceDB TLS (2 min).** SpiceDB won't start without its gRPC and HTTP gateway certificates.
   The gateway name only has to be inside a zone of the Cloudflare account. It needs no DNS record.

   ```sh
   export ZEROPS_TOKEN="$PRODUCTION_ZEROPS_TOKEN"
   node scripts/ops/production-environment.mts spicedb-tls \
     --gateway-hostname ontos-production-spicedb.bleeding.dev --env-file ~/.cloudflare-ontos-stage-token --dry-run
   # then the same command without --dry-run
   ```

5. **Project variables (5 min).** In the Zerops UI, open `ontos-production` → Environment
   variables and set the 3 project variables stage holds, each to production's Shell origin:
   `MODERN_PUBLIC_SITE_URL`, `ONTOS_GATEWAY_ISSUER` and `ULTRAMODERN_MF_DEV_ORIGIN`.

6. **Domain (5 min).** Add the custom domain to the `shellsuperapp` service in Zerops and point
   DNS at it. Or keep the `*.zerops.app` subdomain and make sure it matches the origin you used in
   the secrets file and step 5.

7. **Pass the authorization gate (blocks step 8).** The deploy plan refuses production until
   production has exact-build enforced authorization evidence and an approved production context
   in `topology/authorization-contexts/`. Neither exists yet: issue #173 (implementation) and
   issue #369 (approval). Until both are done, step 8 fails. See
   [Fail-closed authorization promotion](DEPLOYMENT.md#fail-closed-authorization-promotion).

8. **Dispatch the first deploy (1 min).** The first deploy has no base, so it must be `full=true`:

   ```sh
   gh workflow run ultramodern-workspace-gates.yml --ref main -f environment=production -f full=true
   ```

Steps 1–6 and 8 take about 45–60 minutes; step 7 is a separate governance task. The first full deploy then runs on its own: each Zerops unit
builds remotely and units deploy one by one, so expect it to take a few hours on the current
pipeline. Later deploys only push what changed.

## Before it can serve real users

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
