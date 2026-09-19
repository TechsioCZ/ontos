# Runbook: Commerce portal-auth fresh deployment

Owner: `app/verticals/commerce-customer-context` (Commerce portal authentication realm).
Scope: standing up the `commerce_auth` realm on a deployment that has never had it before. Product
decision (2026-09-19): **no backfill** — this runbook only covers a clean opt-in, not migrating an
existing deployment's users into the realm.

## Required environment

All names are read in `app/verticals/commerce-customer-context/api/portal-auth/provider/config.ts`
and `app/verticals/commerce-customer-context/scripts/portal-auth-database-config.mts`.

| Variable | Required | Notes |
| --- | --- | --- |
| `COMMERCE_PORTAL_AUTH_URL` | yes | Realm base URL (`http`/`https`, no userinfo/query/hash). Also seeds the trusted-origin set. |
| `COMMERCE_PORTAL_AUTH_DATABASE_URL` | yes | Runtime PostgreSQL connection (least-privilege role). |
| `COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL` | yes | Administrative PostgreSQL connection used only by migration/bootstrap scripts. Must be a **distinct user** from the runtime URL, on the **same** host/port/database — the loader rejects a pair that shares a user or targets different databases. |
| `COMMERCE_PORTAL_AUTH_SECRET` | yes | ≥32 characters. See the key-rotation runbook once this is live. |
| `COMMERCE_PORTAL_AUTH_SECRETS` | no | Optional rotation array; leave unset for a fresh deploy. |
| `COMMERCE_PORTAL_AUTH_NODE_ENV` | no | Empty defaults to non-production; `secureCookies` is also forced on whenever the base URL is `https:`. |
| `COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS` | no | Comma-separated extra origins beyond the base URL. |
| `COMMERCE_PORTAL_AUTH_TRUSTED_PROXIES` | no | Exact reverse-proxy peer addresses; only these may supply a trusted forwarded-for hop. |

The three **admission keys** the composition root uses to decide whether the realm is installed at
all are `COMMERCE_PORTAL_AUTH_URL`, `COMMERCE_PORTAL_AUTH_DATABASE_URL` and
`COMMERCE_PORTAL_AUTH_SECRET` (`selectPortalAuthRuntimeLive` / `optionalCommercePortalAuthConfig` in
`api/index.ts` and `config.ts`). Naming **none** of them is a supported opt-out. Naming **some but
not all** is treated as a misconfiguration, not a partial opt-in, and fails config parsing.

## Core identity transport and the authentication namespace

Two further deployment inputs sit beside the realm. Neither is an admission key of the realm itself:
the realm can be live without them, and they are rotated independently.

| Variable | Required | Notes |
| --- | --- | --- |
| `COMMERCE_CORE_IDENTITY_BASE_URL` | no | `http`/`https` base URL of the Core identity API (no userinfo/query/hash). Read in `api/portal-auth/provider/core-identity-client-config.ts`. |
| `COMMERCE_CORE_IDENTITY_API_KEY` | no | Server-owned service credential, ≥16 characters, `Redacted` from the moment it is read. |

Naming neither is a supported opt-out: enrollment commit convergence stays the fail-closed
`commerceEnrollmentCommitResolutionUnavailableLive` and refuses retryably instead of reporting an
uncertain enrollment write as settled. Naming only one is a misconfiguration; it is logged and the
same fail-closed capability is installed, so the Action runtime every governed business route is
served from is never taken down by it. The deployment owns the endpoint and the credential: the
installed transport replaces both on every call, so no caller can point the client at another host.

The vertical also registers its own authentication namespace,
`ontos.commerce.portal.better-auth.v1`, through `CommercePortalAuthenticationNamespaceRegistryLive`
(`api/portal-auth/authentication-namespace-registry.ts`). This needs no environment variable, but it
is load-bearing: Core revalidates the namespace a presented session binding names before any
authorization runs, and with no registry reachable every namespace-carrying (version 2) gateway
assertion is answered `503 operation_context_unavailable`. The only registered audience is this
vertical's own action-boundary audience, `commerce-customer-context`, so an assertion minted for
another receiver is refused rather than accepted because the namespace matched. Admission-time
re-verification remains Shell's; this runtime installs no external operation authentication port.

## Migration order

Authoritative source: `app/scripts/run-zerops-migrator.mjs` (`main`), the script the real
deployment migrator runs end to end:

1. `scripts/postgres/bootstrap-spicedb-database.mts`
2. `scripts/postgres/bootstrap-runtime-role.mts` (generic runtime role, first pass)
3. Core (`packages/core-runtime`, `drizzle.config.ts`)
4. Shell (`apps/shell-super-app`, `drizzle.auth.config.ts`)
5. Party Registry (`verticals/party-registry`: `prepare-contacts-migration.mts`, then
   `drizzle.contacts.config.ts`, then `drizzle.config.ts`)
6. Payment Term Catalog (`verticals/payment-term-catalog`, `drizzle.config.ts`)
7. Commerce (`verticals/commerce-customer-context`, `drizzle.config.ts` — the vertical's own
   business schema, not the portal-auth one)
8. `scripts/postgres/bootstrap-runtime-role.mts` (generic runtime role, second pass)
9. **Only if `COMMERCE_PORTAL_AUTH_DATABASE_URL` + `_ADMIN_URL` are both configured**
   (`loadOptionalCommercePortalAuthDatabaseConfig`):
   1. Commerce portal-auth migration (`verticals/commerce-customer-context`,
      `drizzle.portal-auth.config.ts` → the `commerce_auth` schema)
   2. `verticals/commerce-customer-context/scripts/bootstrap-portal-auth-runtime-role.mts` —
      grants the runtime role exactly the privileges it needs on the `commerce_auth` tables, using
      the admin connection
   3. `verticals/commerce-customer-context/scripts/verify-portal-auth-db-schema.mts` — table
      catalog + runtime-role privilege proof
10. `scripts/verify-application-db-schema.mts` — whole-deployment schema verification
11. Serve the migrator's own `/ready` endpoint

Locally, the same ordering (minus the standalone readiness server) is available as the composite
root scripts:

```sh
pnpm db:bootstrap-spicedb
pnpm db:bootstrap-runtime-role
pnpm --filter @app/core-runtime db:migrate
pnpm --filter @app/shell-super-app db:migrate
pnpm --filter @app/party-registry db:migrate
pnpm --filter @app/payment-term-catalog db:migrate
pnpm --filter @app/commerce-customer-context db:migrate
pnpm db:bootstrap-runtime-role
pnpm db:portal-auth:migrate        # no-ops if the portal-auth database env is not configured
```

`pnpm db:migrate` from `app/` runs the same chain *except* the leading `db:bootstrap-spicedb` step —
run that once, first, on a fresh database before `db:migrate` (or use the explicit sequence above).

## Readiness and the 503 fail-closed behaviour

The vertical's `readiness` route (`GET` handled in `api/index.ts`) is **unconditional** — it does
not depend on the portal-auth realm and reports ready regardless. What depends on the realm is the
four portal-auth route groups (session, MFA, recovery, step-up).

- If the three admission keys are **all absent**, `selectPortalAuthRuntimeLive` installs
  `commercePortalAuthRealmUnavailableLive` (`api/portal-auth/realm-unavailable.ts`): every route in
  the four portal-auth groups answers a retryable `503` naming
  `"The Commerce portal authentication realm is not installed in this deployment"`, while readiness
  and every business (non-portal-auth) route keep serving normally. This is the intended state for
  a deployment that has not opted in yet — not an error condition.
- If **any** admission key is present, the deployment is committed to a fully valid configuration:
  a config parse error at that point does **not** fall back to the `503` realm — see the key-rotation
  runbook's "If the rotation was bad" section for what happens instead (a boot-time defect that
  takes down the whole vertical, not a graceful `503`).

## Readiness check

```sh
curl -sf https://<deployment-host>/commerce-customer-context-api/readiness
```

expect `"status":"ready"`. Then confirm the portal-auth realm itself came up (not just the vertical)
by exercising one of its routes — a `503` here after you configured all three admission keys means
something in that configuration did not parse; a `503` before configuring them is expected.

## Enrollment journeys after start

`POST /api/portal-auth/enrollment/start` commits the Enrollment Attempt and the one provider account
its claim authorizes, then hands the rest of the journey to the server-side enrollment continuation
as a detached fork. The continuation is installed only when a deployment named **both** the portal
realm and the Core identity transport — the same pair the owner preparation authority needs. With
either half missing, start still serves and the Attempt simply stops where it is: the fail-closed
continuation refuses to advance rather than dispatching an owner effect the deployment cannot place.

Operationally that means an Attempt that never reaches `COMPLETE` is a normal, resumable state, not
a lost one. The continuation is safe to re-run: every owner invocation identity it claims under is
derived from the Attempt, so a repeat run replays the durable owner operation instead of creating a
second Party, profile or binding, and an owner whose answer was lost is settled by one authoritative
read. A halt is logged at `info` with the Attempt id and a halt reason (`NO_OWNER_EFFECT`,
`RECONCILIATION_REQUIRED`, `OWNER_REJECTED`, `IN_FLIGHT`); a failure to advance is logged at `warn`
with the same Attempt id. Attempts left in `RECONCILIATION_REQUIRED` are the ones that need a human
decision — an ambiguous Party candidate, or a Retail Portal binding that committed without its
complete reviewed Permission baseline.

## Verification commands

Run from `app/verticals/commerce-customer-context` (or `pnpm --filter @app/commerce-customer-context <script>` from `app/`):

```sh
pnpm db:portal-auth:check                        # drizzle-kit check --config drizzle.portal-auth.config.ts
pnpm db:portal-auth:generate                      # drizzle-kit generate --config drizzle.portal-auth.config.ts
pnpm db:portal-auth:migrate                       # drizzle-kit migrate --config drizzle.portal-auth.config.ts
pnpm db:portal-auth:bootstrap-runtime-role        # node scripts/bootstrap-portal-auth-runtime-role.mts
pnpm db:portal-auth:verify                        # node scripts/verify-portal-auth-db-schema.mts
```

and, from `app/`, the whole-deployment check:

```sh
pnpm db:verify                                    # node scripts/verify-application-db-schema.mts
```
