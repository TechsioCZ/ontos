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
