# Sales demo: local stack

Local only. Nothing here deploys. Run everything from `app/`.

## Start / stop

```sh
./scripts/demo/up.sh                 # cold start or restart (idempotent)
./scripts/demo/down.sh               # stop the servers; containers keep running
./scripts/demo/down.sh --containers  # also stop the containers
```

`up.sh` runs these steps in order and stops at the first failure:

1. Creates `app/.env` from `.env.example` when it is missing. Both database URLs point at the
   isolated `siampark_demo` database, with a random auth secret and no Commerce portal realm.
   Then it runs `pnpm env:local:ensure` and `pnpm spicedb:tls:local`.
2. `docker --context orbstack compose -f docker-compose.yml -f scripts/demo/compose.demo.yml up -d --wait`.
   This starts `ontos-demo-db` (Postgres 18) and `ontos-demo-spicedb` (in-memory) in a separate
   project with its own `ontos_demo_postgres_data` volume.
3. `pnpm db:migrate`, `pnpm local:initialize`, `pnpm demo:reset`, `pnpm demo:reset:sales`
   (including the CRM and Siampark operations owner seeds), `pnpm demo:seed:eshop`, `pnpm db:verify`, and
   `node scripts/demo/provision-actions.mts` (development replacement for
   `pnpm authorization:provision-current-actions`, see Known issues).
4. Native builds of the shell and each selected vertical, run only when an app has no build or its
   sources (or `packages/`, or the lockfile) changed since its last build. At most two native builds run
   concurrently (`DEMO_BUILD_JOBS`); the standalone storefront is built separately.
5. Starts `modern serve` for the shell and each vertical. Then it starts the composition publisher
   (`scripts/siampark/development-composition.mts`) and the outbox worker host
   (`scripts/outbox-worker-host.generated.mts`).
6. `node scripts/demo/reset-permissions.mts`: all four companies, 14 staff personas, role grants and the
   agent/storefront API keys. The shared tenant is labelled **OntOS DEMO**; each company retains its own name.
7. `node scripts/demo/accounts-admin-grants.mts`, `node scripts/demo/company-membership-hygiene.mts`
   (removes only four stale commercial-company memberships of Siampark staff), and `pnpm demo:ai-profiles`
   (AI A/B/C principals and keys).
8. Unless `DEMO_RESET=0`, `pnpm demo:seed:rental --apply` against the running local shell, authenticated as
   `management@siampark.demo`, fixed Siampark company `…0021`. This uses public reads/Actions, not private DB writes.
9. Starts the customer storefront BFF on **http://localhost:3060**, registers its PID for `down.sh`, and waits for
   `/api/home` to return live backend data. Its managed key is read server-side from `app/.env.demo.local`.

The CRM and operations seeds are already wired through `scripts/demo/reset-demo.mts`; their standalone entrypoints
are `pnpm demo:seed:crm` and `pnpm demo:seed:siampark-ops`. Do not run full resets while other lanes are testing.
On the shared sales-demo machine, only the orchestrator runs `up.sh`/`down.sh`; contributors commit first and use
`rebuild-one.sh <app>` instead. Cold startup has been source-verified, not run against the live shared demo.

Every step and server writes a log to `app/.scratch/demo-logs/<name>.log` (gitignored). PIDs go in
`.scratch/demo-pids/` and build stamps in `.scratch/demo-build/`.

### Options

| Variable                | Default                                                                           | Effect                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEMO_VERTICALS`        | `party-registry siampark-property siampark-occupancy siampark-agreements siampark-work siampark-billing-finance commerce-customer-context workforce tagging sales-pipeline merchandise sales-insights crm siampark-ops` | Verticals to build, serve and compose. Takes vertical IDs from `topology/reference-topology.json`, separated by spaces or commas.              |
| `DEMO_REBUILD=1`        | off                                                                               | Rebuilds every selected app.                                                                                                                   |
| `DEMO_RESET=0`          | on                                                                                | Skips all data resets and rental/CRM/operations/e-shop seeds; re-applies demo account grants and AI profiles. Use the default reset after a fresh in-memory SpiceDB restart to restore baseline resource grants. |
| `DEMO_COMPOSITION_PORT` | `3041`                                                                            | Composition publisher port.                                                                                                                    |

Example: `DEMO_VERTICALS="party-registry siampark-work siampark-billing-finance commerce-customer-context workforce tagging" ./scripts/demo/up.sh`.
The composition publisher reads the same list through `ONTOS_DEMO_VERTICALS`.

## Ports

| Port            | Service                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| 3020            | Shell: http://localhost:3020/cs                                                                        |
| 3041            | Development composition (`/active`). Siampark used 3031, but launchd still holds 3031 on this machine. |
| 3060            | Kavárna Doma customer storefront + server-only BFF |
| 4125 / 4126     | CRM / Siampark operations |
| 4101            | commerce-customer-context (API only)                                                                   |
| 4102            | party-registry                                                                                         |
| 4117            | siampark-work                                                                                          |
| 4118            | siampark-billing-finance                                                                               |
| 4114–4116, 4119 | siampark property / occupancy / agreements (started by default), relationships (not started)                    |
| 5433            | Postgres (`siampark_demo` database, admin `ontos_admin`)                                               |
| 50051 / 8443    | SpiceDB gRPC / HTTP (TLS)                                                                              |

## Portable rental data seeder

Run `mise exec -- pnpm demo:seed:rental` from `app/` against a running local or server deployment.
It uses authenticated public APIs and audited Actions, with the same permissions and validation as
the UI. It needs no database administrator connection, localhost-only fixture port, or private
composition URL. Remote targets require HTTPS.

The target Tenant and Legal Entity must already exist, the rental modules must be active in the
composition, and the operator account must have read/write access to Party Registry, property,
occupancy, agreements, opportunities and finance, plus Party identity review for a new demo customer.
Provision server accounts through the normal environment-specific operator workflow first. This
command does not create accounts, grant permissions, rename companies or bootstrap a server.
The development companies are `Obchodní firma` and `Siampark`; server IDs may differ.

Example in Bash, using the IDs of the intended server company:

```bash
export ONTOS_DEMO_SEED_URL=https://demo.example.com
export ONTOS_DEMO_SEED_TENANT_ID='replace-with-tenant-uuid'
export ONTOS_DEMO_SEED_LEGAL_ENTITY_ID='replace-with-siampark-legal-entity-uuid'
export ONTOS_DEMO_SEED_EMAIL=operator@example.com
read -r -s -p 'Seeder password: ' ONTOS_DEMO_SEED_PASSWORD
export ONTOS_DEMO_SEED_PASSWORD

# Authentication, target selection and owner-read checks, no business writes:
mise exec -- pnpm demo:seed:rental

# Seed the selected company:
mise exec -- pnpm demo:seed:rental --apply

# Optionally add an explicitly labelled synthetic signature/document example:
mise exec -- pnpm demo:seed:rental --apply --demo-signature
unset ONTOS_DEMO_SEED_PASSWORD
```

Replace the UUID placeholders before running. Export the password through the server's secret
manager for unattended use. No configuration file or password is checked into source control.

The fixture contains Rezidence Parková at Parková 12 in Prague, active unit Byt A102, an active
`Ukázkový nájemce Siampark` customer, a rent opportunity, a confirmed long-term lease for
2026-11-01 through 2027-10-31, its draft contract, and a draft invoice for November rent of
12,500.25 CZK excluding 21% VAT. It does not confirm invoices or contact an accounting/signature
provider. `--demo-signature` records a `demo://` reference and a clearly labelled DEMO signer and
filename. No signed PDF exists or is uploaded by this command.

Repeated runs reuse matching records and preserve their IDs. Keys are property code, unit code
within the property, exact synthetic customer name, opportunity title, lease unit/period, contract
lease reference and invoice document number or matching rental line. Colliding identities, mismatching
rental amounts, references or incompatible lifecycle states stop the run instead of being overwritten.
Other existing metadata is retained. Each write uses the revision of the inspected snapshot;
conflicts and uncertain responses are not automatically retried. Earlier completed steps remain and
the command can be rerun after resolving the failure.

After creating a Party, its reference is stored with the exact server/Tenant/Legal Entity in
`.scratch/demo-seed/<target-hash>/customer.json`, with owner-only permissions. Keep that ignored
checkpoint when resuming an interrupted customer onboarding. If execution stops after Party
creation but before the checkpoint is durable, the next attempt may require identity review. It
refuses to create another Party when candidates exist. Do not copy a checkpoint to another target.

The earlier commercial dataset remains under `demo:reset:sales`, a destructive local-only reset.
Do not use that reset to populate a server. This portable command adds the rental sample without
resetting the commercial company or replacing existing company data.

## Accounts

Every account uses the password `password1234`. Sign in at http://localhost:3020/cs/login.

| Login                      | Role                                                                             |
| -------------------------- | -------------------------------------------------------------------------------- |
| `management@siampark.demo` | Management: reads all Siampark modules                                           |
| `operations@siampark.demo` | Operations: can write in the Siampark modules                                    |
| `finance@siampark.demo`    | Finance: can write in billing/finance                                            |
| `external@siampark.demo`   | External: sees only assigned records                                             |
| `demo@test.com`            | Local Tenant from `local:initialize`. Holds every Action in its own Tenant only. |

### Sales demo permissions

`scripts/demo/permissions.mts` holds the role matrix; `scripts/demo/reset-permissions.mts` writes it. It runs
at the end of `up.sh` and inside `pnpm demo:reset:sales` (after `workforce`). Re-run it alone at any
time with `node --env-file=.env scripts/demo/reset-permissions.mts` (`--skip-bot` skips the API key).
SpiceDB is in-memory, so re-run it after a container restart.

Once the Shell is running, the same operator command calls the restricted
`core.identity.configure-demo-companies` Action. It renames the fixed commercial demo company to
Obchodní firma and ensures the separate Siampark company and rental module states exist. This runs
at the end of the local launcher after grants have been installed; when the Shell is offline it is
deferred. Conflicting company identity or an Action denial fails setup. Existing business rows are
retained. Rental example data is added separately with `demo:seed:rental --apply`.

| Login / principal      | Role            | Write                                                 | Read only                                 |
| ---------------------- | --------------- | ----------------------------------------------------- | ----------------------------------------- |
| `obchod@demo.ontos`    | Vedoucí obchodu | everything, plus identity admin (creates the bot key) |                                           |
| `obchodnik@demo.ontos` | Obchodník       | customers, tagging, opportunities, tasks              | employees, products, statistics, invoices |
| `ucetni@demo.ontos`    | Účetní          | invoices                                              | customers, statistics                     |
| `sklad@demo.ontos`     | Skladník        | products, tasks                                       |                                           |
| `agent-bot` (API key)  | service         | opportunities, tasks, tagging (no tag update/delete)  | all other demo modules                    |

Customer writers (`obchod`, `obchodnik`) also hold `party_identity_reviewer`: `create-party` returns AMBIGUOUS for
every customer without a VERIFIED IČO, and the customer form resolves that case as CREATE_NEW when it lists no
candidate Party.

Each demo vertical also has `shared/actions/command-guard.ts`. One apply-command grant covers every
command, so the guard rejects human-only commands for API-key and system principals: tag update/delete,
price changes and bulk product edits, employee create/update/bulk edits, and every billing command.

The bot's managed API key is issued through `/auth/identity/api-keys/managed` as `obchod@demo.ontos`. It is
written with `ONTOS_SHELL_URL`, `ONTOS_COMPOSITION_REVISION` and `ONTOS_LEGAL_ENTITY_ID` to the gitignored
`app/.env.demo.local` for `tools/ontos-agent-mcp`. A re-run keeps a key that still works.

The Better Auth apiKey plugin stores a limit of 10 verifications per 24 h on every key it creates. Every agent call
redeems the key for a new single-use gateway assertion, so `reset-permissions.mts` turns that limit off for the
`agent-bot` keys (`auth.apikey.rate_limit_enabled = false`). Without it the agent gets `429
GatewayRateLimitedProblem` after ten calls.

### CRM and e-shop companies (demo v2)

The same step creates **Velkoobchod Hanák s.r.o.** (`…0022`, CRM) and **Kavárna Doma s.r.o.** (`…0023`,
e-shop) and their personas. Each persona is a member of its own company only, so the company switcher shows
exactly one company and a switch to any other company answers 403.

| Login                    | Name            | Company | Role            | Access                                                                               |
| ------------------------ | --------------- | ------- | --------------- | ------------------------------------------------------------------------------------ |
| `spravce@hanak.demo`     | Karel Hanák     | Hanák   | Správce         | CRM `read_all` + `write_all` + `assign`, customers, tasks, employees, identity admin |
| `vedouci@hanak.demo`     | Lucie Dvořáková | Hanák   | Vedoucí obchodu | CRM `read_all` + `write_all` + `assign`, tasks, employees; customers read            |
| `obchodnik.a@hanak.demo` | Jan Novák       | Hanák   | Obchodník A     | CRM `read_assigned` + `write_assigned` only, tasks; employees read                   |
| `obchodnik.b@hanak.demo` | Petra Svobodová | Hanák   | Obchodník B     | same as A                                                                            |
| `eshop@kavarna.demo`     | Tereza Malá     | Kavárna | Správce e-shopu | products, orders, customers, tasks, employees                                        |
| `expedice@kavarna.demo`  | Ondřej Kříž     | Kavárna | Expedice        | merchandise only (orders, products)                                                  |
| `kavarna-storefront`     | service         | Kavárna | Storefront BFF  | merchandise read + `demo.merchandise.apply-command` (managed API key)                |

The storefront key lands in `app/.env.demo.local` as `ONTOS_STOREFRONT_API_KEY` (with
`ONTOS_STOREFRONT_PRINCIPAL_ID` and `ONTOS_STOREFRONT_LEGAL_ENTITY_ID`); it is verified against a
`merchandise` gateway assertion in company 0023 and runs without the Better Auth rate limit. The Siampark
accounts (`management@`, `operations@`, `finance@`, `external@siampark.demo`) also get their roles in the
Siampark company 0021 (`siamparkRentalPersonas`).

### Proofs

`node scripts/demo/prove-sales-demo.mts` checks requirements 5, 7d and 10 over HTTP against the running stack:
sign-in as the demo users, the bot through its API key, PASS/FAIL per check, exit code 1 on any failure. It writes
demo data on every run: one open opportunity goes to WON (and gets a draft invoice), its product gets a +10 % price,
and the bot creates one task. The MCP session `tools/ontos-agent-mcp/scripts/demo-session.mts` (requirements 8, 9, 11) writes its transcript to `docs/demo/agent-session.md`.

Pages: `/cs/siampark/work` (Úkoly) and `/cs/siampark/finance` (Faktury a finance). The business
date is 2026-10-05.

## Known issues

- `pnpm authorization:provision-current-actions` always fails in development with
  `action_authorization_input_invalid: Each explicit Action requires unique recorded allowed and denied
verification assertions`. Its development target passes no explicit assertions, but every Action with
  `provisioning: 'explicit'` (all apply-commands, several core identity Actions) needs one. `up.sh` runs
  `scripts/demo/provision-actions.mts` instead, which derives them and grants every explicit Action to
  `demo@test.com`.
- The shell signs sessions into `__Secure-better-auth.session_token`, but the API-key Better Auth instance
  reads `better-auth.session_token` over plain http. Issuing an API key from a browser session on
  `http://localhost` therefore returns 401. `reset-permissions.mts` sends the session under both names.
- On the work and finance pages, the lists stay empty until you click **Načíst úkoly** or
  **Obnovit**. Data appears after that click.
- The outbox worker host logs `OutboxWorkerDescriptorError` about every second for the inventory,
  price-group-catalog and privacy workers, because those owners are not in the composition. During
  the first seconds, before the composition is published, the shell also logs
  `InstalledModuleCatalogUnavailableError`. Both are harmless for the demo.
- If a browser already holds a session from another OntOS instance on `localhost:3020`, you see
  "Přihlášené prostředí je dočasně nedostupné". Sign out (`POST /shell-super-app-api/auth/sign-out`)
  and sign in again.
