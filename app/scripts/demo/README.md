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
are `pnpm demo:seed:crm` and `pnpm demo:seed:facility-operations`. Do not run full resets while other lanes are testing.
On the shared sales-demo machine, only the orchestrator runs `up.sh`/`down.sh`; contributors commit first and use
`rebuild-one.sh <app>` instead. Cold startup has been source-verified, not run against the live shared demo.

Every step and server writes a log to `app/.scratch/demo-logs/<name>.log` (gitignored). PIDs go in
`.scratch/demo-pids/` and build stamps in `.scratch/demo-build/`.

### Options

| Variable                | Default                                                                           | Effect                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEMO_VERTICALS`        | `party-registry property-portfolio property-leasing legal-agreements work-tasks finance-billing commerce-customer-context workforce tagging sales-pipeline merchandise sales-insights crm facility-operations` | Verticals to build, serve and compose. Takes vertical IDs from `topology/reference-topology.json`, separated by spaces or commas.              |
| `DEMO_REBUILD=1`        | off                                                                               | Rebuilds every selected app.                                                                                                                   |
| `DEMO_RESET=0`          | on                                                                                | Skips all data resets and rental/CRM/operations/e-shop seeds; re-applies demo account grants and AI profiles. Use the default reset after a fresh in-memory SpiceDB restart to restore baseline resource grants. |
| `DEMO_COMPOSITION_PORT` | `3041`                                                                            | Composition publisher port.                                                                                                                    |

Example: `DEMO_VERTICALS="party-registry work-tasks finance-billing commerce-customer-context workforce tagging" ./scripts/demo/up.sh`.
The composition publisher reads the same list through `ONTOS_DEMO_VERTICALS`.

## Ports

| Port            | Service                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| 3020            | Shell: http://localhost:3020/cs                                                                        |
| 3041            | Development composition (`/active`). Siampark used 3031, but launchd still holds 3031 on this machine. |
| 3060            | Kavárna Doma customer storefront + server-only BFF |
| 4125 / 4126     | CRM / facility operations |
| 4101            | commerce-customer-context (API only)                                                                   |
| 4102            | party-registry                                                                                         |
| 4117            | work-tasks                                                                                          |
| 4118            | finance-billing                                                                               |
| 4114–4116, 4119 | property-portfolio / property-leasing / legal-agreements (started by default), crm-activities (not started)                    |
| 1025 / 8025     | Mailpit: SMTP (127.0.0.1 only) / web UI + API http://localhost:8025 |
| 1026 / 8026     | Test Mailpit (test/QA recipients only): SMTP / web UI + API http://localhost:8026 |
| 3096            | E-mail dispatcher: read-only delivery receipts (127.0.0.1) |
| 5433            | Postgres (`siampark_demo` database, admin `ontos_admin`)                                               |
| 50051 / 8443    | SpiceDB gRPC / HTTP (TLS)                                                                              |

## Real e-mail (SMTP, Mailpit)

Nothing is simulated: e-mails really go over SMTP. In the demo the SMTP server is Mailpit (container
`ontos-demo-mailpit`), which captures every message instead of delivering it; open http://localhost:8025.

What is sent, exactly once per event (after the database commit, by `scripts/demo/email-dispatcher/main.mts`):

- AKROS e-shop orders (channel STOREFRONT): order received, then the status changes Zpracovává se
  (same label as staff app and storefront), Předáno dopravci (for Osobní odběr: „připravena k vyzvednutí“), Dokončená and Stornovaná.
  Only orders created after the dispatcher's first start (`demo_email.settings.enabled_since`) get e-mails, so
  old fixtures are never mailed. Customer e-mails carry no „(simulace)“ markers; their DEMO footer says that no
  goods are shipped.
- Payment reminders („Připravit upomínku“ → „Odeslat e-mailem“ in Faktury a finance) of every company that
  uses the finance module. Each reminder goes out in the name of the company that issued the invoice (header,
  subject, footer and sender: Siampark → Siampark, Obchodní firma → Obchodní firma).
- Siampark agenda notifications (Provoz → Agenda) for people who switched on „Posílat upozornění i e-mailem“ in
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
(dry run) and `… --apply` deletes from the demo inbox only messages about removed (soft-deleted) AKROS orders and
messages to test/audit addresses; the ledger and the domain data stay untouched.

The dispatcher claims each e-mail in its own ledger `demo_email.deliveries` (primary key = dedupe key) before
sending. SMTP unreachable before any data was sent → `RETRY` with backoff (10 s, 20 s, 40 s, then every 60 s,
so it heals by itself when the server is back); still undelivered after 24 h → `FAILED` („Odeslání selhalo“).
A broken connection after the data → `UNKNOWN` and never resent. Staff UI and the AKROS confirmation page show
„Odesláno e-mailem“ with the time the SMTP server accepted the message.

Who may read receipts (`GET /v1/deliveries`, never addresses or bodies):

- staff app (browser, `credentials: 'include'`): the dispatcher checks the OntOS session cookie with the shell
  (`EMAIL_DISPATCHER_SESSION_URL`) and returns only rows of the session's tenant and selected company; no
  session → 401;
- AKROS storefront (server-side BFF `/api/ontos/order-emails`): the order number AND the e-mail the order was
  placed with (`recipient`) must both match, so other customers' orders cannot be enumerated.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMTP_HOST` | `127.0.0.1` | SMTP server |
| `SMTP_PORT` | `1025` | SMTP port (Mailpit) |
| `SMTP_SECURE` | `false` | `true` = implicit TLS (normally port 465). STARTTLS (587) is not supported. |
| `SMTP_USER` / `SMTP_PASSWORD` | – | AUTH PLAIN; only accepted together with `SMTP_SECURE=true` |
| `SMTP_TIMEOUT_MS` | `10000` | Socket timeout per attempt |
| `SMTP_FROM` | – | Sender address for every company without its own variable below (the display name stays the company's, e.g. `Obchodní firma – účtárna <noreply@vase-domena.cz>`). Unset → the built-in demo addresses. |
| `AKROS_EMAIL_FROM` | `AKROS e-shop <eshop@akros.demo>` | Sender of AKROS order e-mails |
| `SIAMPARK_EMAIL_FROM` | `Siampark – finanční oddělení <finance@siampark.demo>` | Sender of Siampark payment reminders |
| `OBCHODNI_FIRMA_EMAIL_FROM` | `Obchodní firma – účtárna <ucetni@demo.ontos>` | Sender of Obchodní firma payment reminders |
| `EMAIL_TEST_SMTP_HOST` / `EMAIL_TEST_SMTP_PORT` | `127.0.0.1` / `1026` | Test capture for test/QA recipients (second Mailpit); `none` = send them to `SMTP_HOST` too |
| `EMAIL_PROVIDER` | `smtp` | `none` = no e-mail provider configured: nothing is sent, the UI offers only copy/download |
| `SIAMPARK_AGENDA_EMAIL_FROM` | `Siampark – upozornění <provoz@siampark.demo>` | Sender of Siampark agenda notifications |
| `ONTOS_PUBLIC_URL` | `http://localhost:3020` | Links to the staff app in agenda e-mails |
| `EMAIL_DISPATCHER_SESSION_URL` | `http://127.0.0.1:3020/shell-super-app-api/auth/session` | Shell session check for staff receipt reads |
| `AKROS_STOREFRONT_PUBLIC_URL` | `http://localhost:3070` | Link in AKROS e-mails |
| `EMAIL_DISPATCHER_PORT` | `3096` | Receipts API (127.0.0.1 only) |
| `EMAIL_DISPATCHER_INTERVAL_MS` | `2000` | Poll interval |
| `EMAIL_DISPATCHER_ALLOWED_ORIGINS` | `http://localhost:3020,http://127.0.0.1:3020` | CORS origins of the staff app |
| `EMAIL_DISPATCHER_URL` | `http://127.0.0.1:3096` | Used server-side by the AKROS storefront |

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
| `external@siampark.demo`   | External: reads only CRM contacts entrusted to him (`demo.crm.read_assigned`)    |
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

### Siampark CRM: entrusted contacts (S00)

`node --env-file=.env scripts/demo/seed-siampark-crm.mts` writes the Siampark (0021) CRM state once (`--reset`
replaces it): six prospective tenants, three entrusted by Vedení to `external@siampark.demo` (Martin Krejčí), with
contacts, calls/meetings and planned contacts. `management@` holds `demo.crm` read_all/write_all/assign and
`external@` only `demo.crm.read_assigned`, so the crm owner returns just the three entrusted clients to him; finance,
agreements and occupancy stay closed. On a running demo `node scripts/demo/siampark-crm-permissions.mts` adds the two
grants without a full permission reset. In Siampark the sidebar shows only Klienti, K oslovení and Návštěvy of CRM.

### Proofs

`node scripts/demo/prove-sales-demo.mts` checks requirements 5, 7d and 10 over HTTP against the running stack:
sign-in as the demo users, the bot through its API key, PASS/FAIL per check, exit code 1 on any failure. It writes
demo data on every run: one open opportunity goes to WON (and gets a draft invoice), its product gets a +10 % price,
and the bot creates one task. The MCP session `tools/ontos-agent-mcp/scripts/demo-session.mts` (requirements 8, 9, 11) writes its transcript to `docs/demo/agent-session.md`.

Pages: `/cs/ukoly` (Úkoly) and `/cs/finance` (Faktury a finance). The business
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
- A disabled account's open session is sent to sign-in with „Účet nemá přístup“; a session the Shell no longer
  accepts is sent there with „Přihlášení vypršelo“. If a browser holds a session from another OntOS instance on
  `localhost:3020` and still sees "Přihlášené prostředí je dočasně nedostupné", sign out
  (`POST /shell-super-app-api/auth/sign-out`) and sign in again.
