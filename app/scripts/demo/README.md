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
   (including the CRM and Nájempark operations owner seeds), `pnpm demo:seed:eshop`, and `pnpm db:verify`.
   Early fixtures create identities and data, not Action execution grants.
4. Native builds of the shell and each selected vertical, run only when an app has no build or its
   sources (or `packages/`, or the lockfile) changed since its last build. At most two native builds run
   concurrently (`DEMO_BUILD_JOBS`); the standalone storefront is built separately.
5. Starts `modern serve` for the shell and each vertical. Then it starts the composition publisher
   (`scripts/siampark/development-composition.mts`) and the outbox worker host
   (`scripts/outbox-worker-host.generated.mts`).
6. `node scripts/demo/reset-permissions.mts`: all four companies, 14 staff personas, role grants and the
   agent/storefront API keys. The shared tenant is labelled **OntOS DEMO**; each company retains its own name.
7. `pnpm demo:ai-profiles` records the AI A/B/C identities and display profiles through native Actions;
   `setup-agent-operators.mts` records human oversight. Neither command grants agent access or creates consent.
   A one-off repair of the reviewed human access is `node scripts/demo/local-repair.mts`.
8. Unless `DEMO_RESET=0`, `pnpm demo:seed:rental --apply` against the running local shell, authenticated as
   `management@najempark.demo`, fixed Nájempark company `…0021`. This uses public reads/Actions, not private DB writes.
9. Restarts the ŠroubShop storefront on **http://localhost:3070** (`akros-storefront/scripts/demo-restart.sh`). Its
   managed key is read server-side; Kavárna Doma has no customer storefront.

The CRM and operations seeds are already wired through `scripts/demo/reset-demo.mts`; their standalone entrypoints
are `pnpm demo:seed:crm` and `pnpm demo:seed:facility-operations`. Do not run full resets while other lanes are testing.
On the shared sales-demo machine, only the orchestrator runs `up.sh`/`down.sh`; contributors commit first and use
`rebuild-one.sh <app>` instead. Cold startup has been source-verified, not run against the live shared demo.

Every step and server writes a log to `app/.scratch/demo-logs/<name>.log` (gitignored). PIDs go in
`.scratch/demo-pids/` and build stamps in `.scratch/demo-build/`.

### Options

| Variable                | Default                                                                                                                                                                                                        | Effect                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEMO_VERTICALS`        | `party-registry property-portfolio property-leasing legal-agreements work-tasks finance-billing commerce-customer-context workforce tagging sales-pipeline merchandise sales-insights crm facility-operations` | Verticals to build, serve and compose. Takes vertical IDs from `topology/reference-topology.json`, separated by spaces or commas.                                                                                |
| `DEMO_REBUILD=1`        | off                                                                                                                                                                                                            | Rebuilds every selected app.                                                                                                                                                                                     |
| `DEMO_RESET=0`          | on                                                                                                                                                                                                             | Skips all data resets and rental/CRM/operations/e-shop seeds; re-applies demo account grants and AI profiles. Use the default reset after a fresh in-memory SpiceDB restart to restore baseline resource grants. |
| `DEMO_COMPOSITION_PORT` | `3041`                                                                                                                                                                                                         | Composition publisher port.                                                                                                                                                                                      |

Example: `DEMO_VERTICALS="party-registry work-tasks finance-billing commerce-customer-context workforce tagging" ./scripts/demo/up.sh`.
The composition publisher reads the same list through `ONTOS_DEMO_VERTICALS`.

## Ports

| Port            | Service                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| 3020            | Shell: http://localhost:3020/cs                                                                             |
| 3041            | Development composition (`/active`). Nájempark used 3031, but launchd still holds 3031 on this machine.     |
| 4125 / 4126     | CRM / facility operations                                                                                   |
| 4101            | commerce-customer-context (API only)                                                                        |
| 4102            | party-registry                                                                                              |
| 4117            | work-tasks                                                                                                  |
| 4118            | finance-billing                                                                                             |
| 4114–4116, 4119 | property-portfolio / property-leasing / legal-agreements (started by default), crm-activities (not started) |
| 1025 / 8025     | Mailpit: SMTP (127.0.0.1 only) / web UI + API http://localhost:8025                                         |
| 1026 / 8026     | Test Mailpit (test/QA recipients only): SMTP / web UI + API http://localhost:8026                           |
| 3096            | E-mail dispatcher: read-only delivery receipts (127.0.0.1)                                                  |
| 5433            | Postgres (`siampark_demo` database, admin `ontos_admin`)                                                    |
| 50051 / 8443    | SpiceDB gRPC / HTTP (TLS)                                                                                   |

## Real e-mail (SMTP, Mailpit)

Nothing is simulated: e-mails really go over SMTP. In the demo the SMTP server is Mailpit (container
`ontos-demo-mailpit`), which captures every message instead of delivering it; open http://localhost:8025.

What is sent, exactly once per event (after the database commit, by `scripts/demo/email-dispatcher/main.mts`):

- ŠroubShop e-shop orders (channel STOREFRONT): order received, then the status changes Zpracovává se
  (same label as staff app and storefront), Předáno dopravci (for Osobní odběr: „připravena k vyzvednutí“), Dokončená and Stornovaná.
  Only orders created after the dispatcher's first start (`demo_email.settings.enabled_since`) get e-mails, so
  old fixtures are never mailed. Customer e-mails carry no „(simulace)“ markers; their DEMO footer says that no
  goods are shipped.
- Payment reminders („Připravit upomínku“ → „Odeslat e-mailem“ in Faktury a finance) of every company that
  uses the finance module. Each reminder goes out in the name of the company that issued the invoice (header,
  subject, footer and sender: Nájempark → Nájempark, Obchodní firma → Obchodní firma).
- Nájempark agenda notifications (Provoz → Agenda) for people who switched on „Posílat upozornění i e-mailem“ in
  Nastavení upozornění: Přiřazeno vám and Po termínu always, Blíží se termín and Změna only when chosen. Only
  notifications created after e-mail was switched on, one e-mail per delivery batch, to the person's sign-in
  address; the notification centre shows „odesláno e-mailem“ per notification (receipts only for one's own).

No provider configured (`EMAIL_PROVIDER=none`): the dispatcher sends nothing and `GET /v1/provider` returns
`{"configured":false}`. The reminder dialog then says „Odeslání e-mailem není dostupné“, disables „Odeslat
e-mailem“ and offers only „Kopírovat text“ / „Stáhnout návrh“ (nothing is recorded); the agenda settings say
„E-mail není nastaven“. To show it: `EMAIL_PROVIDER=none scripts/demo/email-dispatcher/restart.sh`, then
`scripts/demo/email-dispatcher/restart.sh` again to switch e-mail back on.

Presentable demo inbox: e-mails to test/QA addresses (`*.invalid`, `*.test`, `*audit*`, `*critic*`, `*fixer*`,
`*test*@…`, see `recipients.ts`) are still really sent over SMTP, but to the separate test Mailpit
(container `ontos-demo-mailpit-test`, SMTP 127.0.0.1:1026, http://localhost:8026), never to the demo inbox on :8025.
Test and proof scripts must use such an address and check delivery on `http://localhost:8026/api/v1/messages`;
the ledger and the receipts („Odesláno e-mailem“) are the same as for real recipients. Demo-story orders use a
presentable fictitious address (guide: `pavel.dvorak@dvorak-stavby.demo`). `EMAIL_TEST_SMTP_HOST=none` turns the
separation off. To clear leftovers from older runs: `node --env-file=.env scripts/demo/email-dispatcher/tidy-inbox.mts`
(dry run) and `… --apply` deletes from the demo inbox only messages about removed (soft-deleted) ŠroubShop orders and
messages to test/audit addresses; the ledger and the domain data stay untouched.

The dispatcher claims each e-mail in its own ledger `demo_email.deliveries` (primary key = dedupe key) before
sending. SMTP unreachable before any data was sent → `RETRY` with backoff (10 s, 20 s, 40 s, then every 60 s,
so it heals by itself when the server is back); still undelivered after 24 h → `FAILED` („Odeslání selhalo“).
A broken connection after the data → `UNKNOWN` and never resent. Staff UI and the ŠroubShop confirmation page show
„Odesláno e-mailem“ with the time the SMTP server accepted the message.

Who may read receipts (`GET /v1/deliveries`, never addresses or bodies):

- staff app (browser, `credentials: 'include'`): the dispatcher checks the OntOS session cookie with the shell
  (`EMAIL_DISPATCHER_SESSION_URL`) and returns only rows of the session's tenant and selected company; no
  session → 401;
- ŠroubShop storefront (server-side BFF `/api/ontos/order-emails`): the order number AND the e-mail the order was
  placed with (`recipient`) must both match, so other customers' orders cannot be enumerated.

| Variable                                        | Default                                                  | Meaning                                                                                                                                                                                                |
| ----------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SMTP_HOST`                                     | `127.0.0.1`                                              | SMTP server                                                                                                                                                                                            |
| `SMTP_PORT`                                     | `1025`                                                   | SMTP port (Mailpit)                                                                                                                                                                                    |
| `SMTP_SECURE`                                   | `false`                                                  | `true` = implicit TLS (normally port 465). STARTTLS (587) is not supported.                                                                                                                            |
| `SMTP_USER` / `SMTP_PASSWORD`                   | –                                                        | AUTH PLAIN; only accepted together with `SMTP_SECURE=true`                                                                                                                                             |
| `SMTP_TIMEOUT_MS`                               | `10000`                                                  | Socket timeout per attempt                                                                                                                                                                             |
| `SMTP_FROM`                                     | –                                                        | Sender address for every company without its own variable below (the display name stays the company's, e.g. `Obchodní firma – účtárna <noreply@vase-domena.cz>`). Unset → the built-in demo addresses. |
| `AKROS_EMAIL_FROM`                              | `ŠroubShop e-shop <eshop@sroubarna.demo>`                | Sender of ŠroubShop order e-mails                                                                                                                                                                      |
| `SIAMPARK_EMAIL_FROM`                           | `Nájempark – finanční oddělení <finance@najempark.demo>` | Sender of Nájempark payment reminders                                                                                                                                                                  |
| `OBCHODNI_FIRMA_EMAIL_FROM`                     | `Obchodní firma – účtárna <ucetni@demo.ontos>`           | Sender of Obchodní firma payment reminders                                                                                                                                                             |
| `EMAIL_TEST_SMTP_HOST` / `EMAIL_TEST_SMTP_PORT` | `127.0.0.1` / `1026`                                     | Test capture for test/QA recipients (second Mailpit); `none` = send them to `SMTP_HOST` too                                                                                                            |
| `EMAIL_PROVIDER`                                | `smtp`                                                   | `none` = no e-mail provider configured: nothing is sent, the UI offers only copy/download                                                                                                              |
| `SIAMPARK_AGENDA_EMAIL_FROM`                    | `Nájempark – upozornění <provoz@najempark.demo>`         | Sender of Nájempark agenda notifications                                                                                                                                                               |
| `ONTOS_PUBLIC_URL`                              | `http://localhost:3020`                                  | Links to the staff app in agenda e-mails                                                                                                                                                               |
| `EMAIL_DISPATCHER_SESSION_URL`                  | `http://127.0.0.1:3020/shell-super-app-api/auth/session` | Shell session check for staff receipt reads                                                                                                                                                            |
| `AKROS_STOREFRONT_PUBLIC_URL`                   | `http://localhost:3070`                                  | Link in ŠroubShop e-mails                                                                                                                                                                              |
| `EMAIL_DISPATCHER_PORT`                         | `3096`                                                   | Receipts API (127.0.0.1 only)                                                                                                                                                                          |
| `EMAIL_DISPATCHER_INTERVAL_MS`                  | `2000`                                                   | Poll interval                                                                                                                                                                                          |
| `EMAIL_DISPATCHER_ALLOWED_ORIGINS`              | `http://localhost:3020,http://127.0.0.1:3020`            | CORS origins of the staff app                                                                                                                                                                          |
| `EMAIL_DISPATCHER_URL`                          | `http://127.0.0.1:3096`                                  | Used server-side by the ŠroubShop storefront                                                                                                                                                           |

A real SMTP server is configuration only: put e.g. `SMTP_HOST=smtp.vase-domena.cz`, `SMTP_PORT=465`,
`SMTP_SECURE=true`, `SMTP_USER=…`, `SMTP_PASSWORD=…`, `SMTP_FROM=noreply@vase-domena.cz` (one verified sender
address for all companies) or the per-company `*_EMAIL_FROM` variables into `app/.env` and run
`scripts/demo/email-dispatcher/restart.sh`. Recipients then receive real e-mail.

Checks:

    curl -s http://127.0.0.1:3096/healthz
    curl -s 'http://127.0.0.1:3096/v1/deliveries?source=akros-order&subjectNumber=OBJ-2026-0026&recipient=zakaznik@example.cz'
    curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3096/v1/deliveries?source=akros-order&subjectNumber=OBJ-2026-0026'  # 401
    curl -s 'http://localhost:8025/api/v1/messages?limit=10'
    curl -s 'http://localhost:8025/api/v1/search?query=subject:%22OBJ-2026-0026%22'

Ledger: `select dedupe_key, status, sent_at from demo_email.deliveries order by created_at desc limit 20;`
Restart only e-mail: `scripts/demo/email-dispatcher/restart.sh` (log `.scratch/demo-logs/email-dispatcher.log`).

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
The development companies are `Obchodní firma` and `Nájempark`; server IDs may differ.

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
`Ukázkový nájemce Nájempark` customer, a rent opportunity, a confirmed long-term lease for
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

For administration across all five companies in **OntOS DEMO**, use `obchod@demo.ontos`.
It holds the explicit tenant superadministrator role and can switch between Obchodní firma,
Nájempark, Velkoobchod Hanák, Kavárna Doma and Šroubárna Vysočina s.r.o. (brand ŠroubShop). This does not grant access to other tenants.
The company-specific personas below keep their restricted roles.

| Login                       | Role                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `management@najempark.demo` | Management: reads all Nájempark modules                                                                       |
| `operations@najempark.demo` | Operations: can write in the Nájempark modules                                                                |
| `provoz@najempark.demo`     | Operations (second login): same rights as `operations@`                                                       |
| `finance@najempark.demo`    | Finance: can write in billing/finance                                                                         |
| `external@najempark.demo`   | External: ENTRUSTED CRM and pipeline records; operational facility reads and own personal-agenda updates only |
| `demo@test.com`             | Local Tenant from `local:initialize`. Holds every Action in its own Tenant only.                              |
| `admin@n1.ontos.demo`       | N1 demo (own tenant, `n1-demo-20261103`): company administrator of N1, signs in to the N1 e-shop admin.       |
| `catalog@n1.ontos.demo`     | N1 demo (own tenant): catalogue manager of N1.                                                                |

### Sales demo permissions

`scripts/demo/permissions.mts` holds the reviewed role matrix as canonical Authorization v2 source
(ADR-0030): who takes part in which company, and which declared capability each Role grants. It writes no
SpiceDB relationship; `scripts/demo/reset-permissions.mts` hands the reviewed Roles, Assignments, memberships
and workloads to `packages/core-runtime/scripts/bootstrap-development-context.mts`, which seeds them through
the canonical Core path and lets the one Core writer project them. It runs at the end of `up.sh` and inside
`pnpm demo:reset:sales` (after `workforce`). Re-run it alone at any time with
`node --env-file=.env scripts/demo/reset-permissions.mts` (`--skip-bot` skips the API key). SpiceDB is
in-memory, so re-run it after a container restart. A Role that names a capability the pinned release does not
declare fails the seed with the exact key instead of silently granting less.

Once the Shell is running, the same operator command calls the restricted
`core.identity.configure-demo-companies` Action. It renames the fixed commercial demo company to
Obchodní firma and ensures the separate Nájempark company and rental module states exist. This runs
at the end of the local launcher after grants have been installed; when the Shell is offline it is
deferred. Conflicting company identity or an Action denial fails setup. Existing business rows are
retained. Rental example data is added separately with `demo:seed:rental --apply`.

| Login / principal      | Role            | Write                                                 | Read only                                 |
| ---------------------- | --------------- | ----------------------------------------------------- | ----------------------------------------- |
| `obchod@demo.ontos`    | Vedoucí obchodu | everything, plus identity admin (creates the bot key) |                                           |
| `obchodnik@demo.ontos` | Obchodník       | customers, tagging, opportunities, tasks              | employees, products, statistics, invoices |
| `ucetni@demo.ontos`    | Účetní          | invoices, tasks                                       | customers, statistics                     |
| `sklad@demo.ontos`     | Skladník        | products, tasks                                       |                                           |
| `agent-bot` (API key)  | service         | none; no reviewed workload binding                    | none on human declaration carriers        |

Customer writers (`obchod`, `obchodnik`) receive the reviewed Party capability cells, including
`party.registry.duplicate-candidate.resolve-create`. These do not include the dedicated
`party.registry.crm-client-party.create` permission. The customer form still follows the owner's
duplicate-review lifecycle when creation is ambiguous.

Owner command guards and field groups can narrow an admitted Action further. An API key is not a
human Role: a service principal cannot enter a declaration-only Action, even if it has profile metadata.

The bot's managed API key is issued through `/auth/identity/api-keys/managed` as `obchod@demo.ontos`. It is
written with `ONTOS_SHELL_URL`, `ONTOS_COMPOSITION_REVISION` and `ONTOS_LEGAL_ENTITY_ID` to the gitignored
`app/.env.demo.local` for the demo bot scripts. A re-run keeps a key that still works.

The Better Auth apiKey plugin stores a limit of 10 verifications per 24 h on every key it creates. Every agent call
redeems the key for a new single-use gateway assertion, so `reset-permissions.mts` turns that limit off for the
`agent-bot` keys (`auth.apikey.rate_limit_enabled = false`). Without it the agent gets `429
GatewayRateLimitedProblem` after ten calls.

### CRM and e-shop companies (demo v2)

The same step creates **Velkoobchod Hanák s.r.o.** (`…0022`, CRM) and **Kavárna Doma s.r.o.** (`…0023`,
e-shop) and their personas. Each persona is a member of its own company only, so the company switcher shows
exactly one company and a switch to any other company answers 403.

| Login                    | Name            | Company | Role            | Access                                                                                                    |
| ------------------------ | --------------- | ------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| `spravce@hanak.demo`     | Karel Hanák     | Hanák   | Správce         | CRM ALL records, command writes and owner assignment; customers, tasks, employees, company identity admin |
| `vedouci@hanak.demo`     | Lucie Dvořáková | Hanák   | Vedoucí obchodu | CRM ALL records, command writes and owner assignment; tasks, employees; customers read                    |
| `obchodnik.a@hanak.demo` | Jan Novák       | Hanák   | Obchodník A     | CRM ASSIGNED records and command writes, no owner assignment; tasks; employees read                       |
| `obchodnik.b@hanak.demo` | Petra Svobodová | Hanák   | Obchodník B     | same as A                                                                                                 |
| `eshop@kavarna.demo`     | Tereza Malá     | Kavárna | Správce e-shopu | products, orders, customers, tasks, employees                                                             |
| `expedice@kavarna.demo`  | Ondřej Kříž     | Kavárna | Expedice        | merchandise only (orders, products)                                                                       |
| `kavarna-storefront`     | service         | Kavárna | Storefront BFF  | merchandise read + `demo.merchandise.apply-command` (managed API key)                                     |

The storefront key lands in `app/.env.demo.local` as `ONTOS_STOREFRONT_API_KEY` (with
`ONTOS_STOREFRONT_PRINCIPAL_ID` and `ONTOS_STOREFRONT_LEGAL_ENTITY_ID`); it is verified against a
`merchandise` gateway assertion in company 0023 and runs without the Better Auth rate limit. The Nájempark
accounts (`management@najempark.demo`, `operations@najempark.demo`, `finance@najempark.demo`,
`external@najempark.demo`, `provoz@najempark.demo`) also get their roles in the
Nájempark company 0021 (`siamparkRentalPersonas`).

### Nájempark CRM: entrusted contacts (S00)

`node --env-file=.env scripts/demo/seed-siampark-crm.mts` writes the Nájempark (0021) CRM state once (`--reset`
replaces it): six prospective tenants, three entrusted by Vedení to `external@najempark.demo` (Martin Krejčí), with
contacts, calls/meetings and planned contacts. Management has `demo.crm.api-records.read` with selector `all`,
`demo.crm.apply-command.write` and the `demo.crm.client-owner.assign` field-write group. The external
persona has `demo.crm.api-records.read` with selector `entrusted`, no CRM writes or owner assignment.
Pipeline reads use the same ENTRUSTED restriction through `demo.sales-pipeline.api-records.read`, with no
pipeline search or writes. Finance, agreements and occupancy stay closed. The reviewed narrowing is source
intent, not proof of a deployed owner transport. To reconcile an approved local fixture, re-run
`node scripts/demo/local-repair.mts` after a change. In Nájempark the sidebar shows only Klienti, K oslovení and
Návštěvy of CRM.

CRM Party intake is a separate service bound only to `demo.crm.party-intake`. Its CRM carriers are the
slim `demo.crm.api.pending-client-intake` Read and `demo.crm.intake-client-party` Action. Party accepts
delegation only from the composed `crm` caller with that bound workload; the generic Party Create caller
is unchanged. The dedicated `party.registry.api.crm-client-intake-review` Read returns only an outcome
and revision. Generic duplicate-detail and its identity-review fields have no new workload delegation;
missing evidence fails closed. Both Party purpose carriers declare `accessActor.subject: 'workload'`,
caller `crm` and `subjectWorkloads: ['demo.crm.party-intake']`, with no human declaration, workload
marker or field groups. They contribute no human catalog entries or full-owner cells. The workload key
belongs to producer module `demo.crm`; topology app ID `crm` is the caller, not a renamed workload
namespace. No human Role or broad CRM/Party data grant belongs to this service. The bootstrap owner's
full-access compiler remains unchanged. Owner native negative proofs and final catalog publication
are still required before claiming activation.

### Proofs

`node scripts/demo/prove-sales-demo.mts` checks requirements 5, 7d and 10 over HTTP against the running stack:
sign-in as the demo users, the bot through its API key, PASS/FAIL per check, exit code 1 on any failure. It writes
demo data on every run: one open opportunity goes to WON (and gets a draft invoice), its product gets a +10 % price,
and the bot creates one task. Agents use the Shell MCP endpoint `http://localhost:3020/mcp` (OAuth); its end-to-end proof is `node scripts/demo/prove-mcp-oauth.mts`.

Pages: `/cs/ukoly` (Úkoly) and `/cs/finance` (Faktury a finance). The business
date is 2026-10-05.

### Agent setup boundary

`ai-profiles.mts`, `replay-agent-profiles.mts` and `setup-agent-operators.mts` authenticate a real operator,
select each company through that session and preflight the native Action through the canonical gate.
Profile modules, write policies and operator labels are audited metadata, not authorization. Their results
explicitly report `authority: not-provisioned`; profile or oversight verification does not prove MCP readiness.
The profile replay preserves persisted display names, rejects conflicting administrator evidence and uses
deterministic native idempotency keys. Managed credentials stay in the native `IdentityLifecycle`;
`agent-api-keys.mts issue` displays a one-time secret only in an interactive terminal.

Full agent setup still needs Core-owned commands for agent role assignments and current connection consent.
The current People command planners reject Agent holders, and the canonical connection/consent tables have
no production writer. Do not fill this gap with profile flags, a human role for an agent, direct SQL or
SpiceDB operator edges. MCP authority must remain bounded by actual roles, current consent and owner limits.

### Operator acceptance tests

`pnpm test:operator` runs the rstest `operator` project. The workspace gates never run it, because each
test needs an environment CI does not provision; prepare that environment first:

- `scripts/integration/siampark-demo-http.test.mts` drives the running stack over HTTP at
  `http://localhost:3020`. Start the stack with `./scripts/demo/up.sh` (or run `pnpm demo:reset` on a running
  stack) immediately before it: the test commits Nájempark changes and expects the reset golden fixture.
  Run it with `pnpm test:operator scripts/integration/siampark-demo-http.test.mts`.
  The old `agent-profile-replay.test.mts` is no longer shipped. The focused source tests are
  `scripts/tests/demo-agent-setup.test.mts`; they do not connect to a live database or authorization engine.

The people-model scratch proofs need the same scratch database and local SpiceDB, and also rewrite its schema:
`pnpm --filter @app/core-runtime test:operator` runs the company membership and agent profile, operator and status
lifecycles, and `pnpm --filter @app/shell-super-app test:operator` runs the person invitation lifecycle.

## Pseudonymous demo catalog (lane P/b)

The fixed demo company keeps its product/variant identities, prices, stock, category tree/order and offers; only
display text and photos change. Demo seeds use the neutral copy: `merchandise/scripts/seed-akros.mts` selects
`buildSroubshopEncoded()`, and the in-app „Obnovit demo data“ baseline (`generate-akros-baseline.mts`) is built from
it. Real-AKROS imports must use `buildAkrosEncodedFrom(source, demoId)` / `buildAkrosEncoded()`, which stay unchanged;
the generated source JSON is never edited. The neutral copy contains no source image URLs, so photos come from the
operator below as Core Media uploads, never hot links.

`scripts/demo/pseudonymize-akros-catalog.mts` uses only governed merchandise records/media reads and audited
`ChangeProductImages`, `UpdateProduct`, `UpdateCategory` Actions. It reads live (also staff-edited) descriptions,
parameters, variant labels and alt texts, not just seed copy. Audit history is retained, not rewritten. Czech
phrases are rewritten before declined brand names (rewriting is idempotent, so a resumed run matches its snapshot).

- **Plan** freezes per-record snapshots and the exact photo bytes/SHA-256 (only full renditions are uploaded) and
  writes `summary.json` with the approval fingerprint that apply/verify require. A source photo that no longer
  answers with an accepted image (≤ 5 MB JPEG/PNG/WebP) is listed as unavailable and dropped. The placeholder
  `/akros/products/image-unavailable.svg` is removed, never uploaded.
- **Photos**: at most 20 per product: main first, then distinct gallery/variant photos in order. Variants beyond the
  cap use the same product's main photo; the plan lists these groups (`overflowGroups`, in the source
  `product-35568` and `product-37766`). Marketing artwork (file name contains `banner`/`sekce`, e.g. the FVE banners)
  is never uploaded: it is replaced by the first photo of its category's representative product, or dropped
  (`brandedGraphics`).
- **Categories** (after all products): the first active, published product with a photo of the category itself
  (catalog order), otherwise the first one in its descendants ordered by category position. `imageSrc` becomes that
  product's `/obrazky/<product>/<asset>` only after an anonymous image response from the storefront, otherwise it
  is cleared. No category media links or static image hosting.
- **Apply** is resumable and never uploads a photo twice: already uploaded photos are recognized from the live
  gallery's governed media SHA-256, even when the local journal was lost. Prices, variant stock, SKU, quantity tiers
  and the category tree are rechecked; staff edits since the plan stop the run (re-plan with a new checkpoint).
- **Verify** re-reads every record: no brand text or source URL, consistent galleries (main = first photo, variant
  photos in the gallery), unchanged protected fields, category images anonymously deliverable.

„Obnovit demo data“ keeps the photos already uploaded to Core Media (gallery, variant and category photos of the
baseline products) and resets everything else to the neutral baseline. Should photos still be missing afterwards
(e.g. the reset ran before the first apply), run a fresh plan → apply → verify with a new checkpoint; it re-uses the
uploaded media and changes nothing else.

Local demo: `ONTOS_DEMO_SEED_URL=http://localhost:3020 ONTOS_AGENT_SETUP_EMAIL=obchod@demo.ontos
ONTOS_AGENT_SETUP_PASSWORD=… node scripts/demo/pseudonymize-akros-catalog.mts --mode plan --seed-images
--checkpoint .scratch/pseudonym-catalog`, repeat until the summary prints, then `--mode apply` and `--mode verify`
with `--approved <fingerprint>` (storefront on http://localhost:3070). Only the stage and local demo are accepted.

**Operator rights.** Catalog edits require the company's reviewed merchandise cells in the canonical
Role. The retired catalog-grant tuple helper has been removed. Use the reviewed seed and Access
administration, not direct engine writes or `read_all`/`write_all` aliases. Source changes do not
provision an operator or authorize an apply.

### Stage runbook — plan first; apply only after lane T cutover and parent approval

Operator-local inputs (set them in your shell; nothing here depends on a particular checkout):

| Variable                       | Meaning                                                                                                                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ONTOS_STAGE_REMOTE_RUNNER`    | Remote runner: pipes a committed `scripts/demo/*.mts` script into the stage app container over the Zerops VPN SSH host `app` (pinned known_hosts, `StrictHostKeyChecking=yes`), with the operator credentials on stdin, never argv/env. Each call is limited to 300 s. |
| `ONTOS_STAGE_KNOWN_HOSTS`      | Pinned known_hosts file for `app`. Every deploy replaces the container and its host key: re-pin it after each deploy (from the key the authenticated Zerops control plane reports), never with trust-on-first-use.                                                     |
| `ONTOS_CATALOG_CHECKPOINT_DIR` | Owner-only local copy of the operator checkpoint (mode 700).                                                                                                                                                                                                           |

Every run stops starting new records after 200 s, so one remote call never times out; repeat a mode until it prints
`complete=true`. Never run two batches at once. The checkpoint lives in the app container
(`/var/www/ontos-pseudonym-catalog-v2`), which **every deploy replaces**: back it up after each batch and restore it
before a batch when the container is new. A deploy during a batch kills it without output; re-pin, restore and
rerun, the operator resumes from the last backup. macOS tar must not add AppleDouble (`._*`) files to the archive
(flags below).

```sh
REMOTE=$ONTOS_STAGE_REMOTE_RUNNER
LOCAL=$ONTOS_CATALOG_CHECKPOINT_DIR
SSH="ssh -o UserKnownHostsFile=$ONTOS_STAGE_KNOWN_HOSTS -o StrictHostKeyChecking=yes -o BatchMode=yes app"
restore() { [ ! -d "$LOCAL" ] || $SSH test -d /var/www/ontos-pseudonym-catalog-v2 || COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C "$LOCAL" -cf - . | $SSH 'mkdir -m 700 -p /var/www/ontos-pseudonym-catalog-v2 && tar -C /var/www/ontos-pseudonym-catalog-v2 -xf -'; }
backup() { mkdir -m 700 -p "$LOCAL" && $SSH tar -C /var/www/ontos-pseudonym-catalog-v2 -cf - . | tar --no-xattrs -C "$LOCAL" -xf -; }
# 0. Operator rights (once): plan, review, apply the printed fingerprint (the plan file lives in the container).
# 1. Plan (read-only), repeat until complete=true and the summary JSON is printed:
restore; "$REMOTE" scripts/demo/pseudonymize-akros-catalog.mts --mode plan; backup
# Review "$LOCAL/summary.json"; only the lane P parent authorizes apply.
APPROVED=$(sed -n 's/.*"fingerprint":"\([0-9a-f]*\)".*/\1/p' "$LOCAL/summary.json")
# 2. Apply (after lane T snapshot + real-host cutover and parent approval), repeat until complete=true:
restore; "$REMOTE" scripts/demo/pseudonymize-akros-catalog.mts --mode apply --approved "$APPROVED"; backup
# 3. Verify (read-only), repeat until complete=true:
restore; "$REMOTE" scripts/demo/pseudonymize-akros-catalog.mts --mode verify --approved "$APPROVED"; backup
```

`summary.json` states the expected apply effort (`estimatedApplyBatches`, `estimatedApplyMinutes`); stop on any
error instead of retrying concurrently, and do not delete the checkpoint after a partial apply. Do not run other
catalog/market migrations meanwhile. Keep the local copy until verification is signed off, then delete exactly that
directory. Deploying this code authorizes no apply.

## Known issues

- Operational warmup uses existing reviewed demo people. It creates no synthetic warmup accounts or
  reader Roles. Its browser request guard still blocks business writes. Previously created live
  warmup people need a separate authorized retirement; this source cutover does not delete them.
- The canonical stage accounts file requires `tenants[].moduleKey`. The module must be declared by
  the supplied composition. Core no longer chooses a business module when the field is absent.

- Authorization v2 retired the `provision-current-actions` command and the legacy scoped-role policy
  (ADR-0030). The local `up.sh` seeds the reviewed demo policy through `reset-permissions.mts`; no blanket
  `demo@test.com` Action grants are created.
- The shell signs sessions into `__Secure-better-auth.session_token`, but the API-key Better Auth instance
  reads `better-auth.session_token` over plain http. Issuing an API key from a browser session on
  `http://localhost` therefore returns 401. `reset-permissions.mts` sends the session under both names.
- On the work and finance pages, the lists stay empty until you click **Načíst úkoly** or
  **Obnovit**. Data appears after that click.
- The outbox worker host logs `OutboxWorkerDescriptorError` about every second for the inventory,
  price-group-catalog and privacy workers, because those owners are not in the composition. During
  the first seconds, before the composition is published, the shell also logs
  `InstalledModuleCatalogUnavailableError`. Both are harmless for the demo.
- A disabled account's open session is sent to sign-in with „Účet nemá přístup“; a session the Shell no longer
  accepts is sent there with „Přihlášení vypršelo“. If a browser holds a session from another OntOS instance on
  `localhost:3020` and still sees "Přihlášené prostředí je dočasně nedostupné", sign out
  (`POST /shell-super-app-api/auth/sign-out`) and sign in again.
