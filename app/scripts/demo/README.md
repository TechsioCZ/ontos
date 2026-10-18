# Sales demo: local stack and portable rental seed

The stack launchers run locally; the rental seeder can target an existing server. Nothing here deploys.
Run commands from `app/`. The macOS/Linux and native Windows
launchers use the same Effect/Node lifecycle in `scripts/demo/lifecycle.mts`; Windows does not require WSL.

## Prerequisites

Install Git, mise, the toolchain declared by `.mise.toml`, and Docker with its Compose plugin.
On Windows use Docker Desktop with Linux containers. From `app/`, run `mise install` and
`mise exec -- pnpm install` once. Start Docker before launching the demo. The launcher checks mise,
pnpm, the selected Docker daemon and Compose before preparing environment files or resetting data.

## Start / stop

macOS or Linux:

```sh
./scripts/demo/up.sh
./scripts/demo/down.sh
./scripts/demo/down.sh --containers
```

Windows PowerShell (the `.cmd` files also work in Command Prompt):

```powershell
.\scripts\demo\up.cmd
.\scripts\demo\down.cmd
.\scripts\demo\down.cmd --containers
```

The launchers resolve `app/` from their own path, including paths with spaces. Startup waits until
all selected servers and the composition publisher are ready, then returns. An authenticated
loopback supervisor owns their process trees. Repeated startup first stops that supervisor and its
children; stop waits for cleanup. Closing a launching terminal during preparation interrupts its
owned startup. Once startup succeeds, use the stop launcher to shut down the detached demo.

**The existing default `DEMO_RESET=1` reseeds demo data on each startup.** To preserve edits set
`DEMO_RESET=0` before starting. This skips both the Siampark and sales reset steps. SpiceDB is
in-memory; keeping database rows alone does not recover Siampark grants after its container was
restarted. The development Action provisioning and sales-account permission steps still run.

Stop preserves all database volumes. `--containers` additionally stops this demo's Compose
services. It never runs `docker compose down -v` and never changes the global Docker context.

## Lifecycle

The common lifecycle runs these steps in order and stops on failure:

1. Validate prerequisites, module IDs and application ports. A busy port is an error; no process
   found by port or a saved PID is killed.
2. Create `app/.env` from `.env.example` if absent, choosing `siampark_demo` and a random auth
   secret. Run `env:local:ensure` and `spicedb:tls:local`. Explicit inherited values take precedence
   when projecting configuration into child processes. Only local `siampark_demo` database URLs
   and the development environment are accepted before container startup or reset.
3. Start the selected Compose project, migrate, initialize the local context, optionally run
   `demo:reset` and `demo:reset:sales`, and run database verification and development provisioning.
4. Build the shell and selected verticals when their contract/stamp is missing, sources changed,
   or `DEMO_REBUILD=1`. Build stages use argument arrays without a platform shell; the deployment
   stage is removed explicitly. The supervisor pins development builds to the non-promotable
   `workspace` identity on both platforms.
5. Serve the shell and selected verticals, wait for their runtime contracts, start the development
   composition publisher and wait for `/active`, then start the outbox worker host and provision
   sales-demo accounts, role grants and the bot API key.

Startup has a 30-minute deadline; individual HTTP readiness checks have a 180-second deadline.
Any failed preparation or server exit releases the supervisor's scoped process trees, including
children on Windows through the Effect Node platform's tree termination. Containers remain
available for diagnosis and data is preserved. Stop does not rely on PID reuse-sensitive files.

Private state, build stamps and logs live under `app/.scratch/demo-<instance>/`. The directory is
created with owner-only POSIX permissions; on Windows keep the checkout in your private user
profile with normal private NTFS permissions. Logs may contain application configuration and
should not be shared unredacted. A stale `supervisor.json` never authorizes process termination:
if its listener cannot be authenticated, inspect the private logs and manually remove only the
stale descriptor after confirming that its supervisor is gone. Earlier Bash-launcher processes
must be stopped with that old launcher before upgrading; new code refuses to take over their ports.

## Options and isolation

| Variable                | Default                                                                                                                                       | Effect                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `DEMO_VERTICALS`        | `party-registry siampark-work siampark-billing-finance commerce-customer-context workforce tagging sales-pipeline merchandise sales-insights` | Space/comma-separated topology IDs to build, serve and compose.                                                                        |
| `DEMO_REBUILD=1`        | off                                                                                                                                           | Force all selected native builds.                                                                                                      |
| `DEMO_RESET=0`          | reset on                                                                                                                                      | Preserve database rows; see SpiceDB caveat above.                                                                                      |
| `DEMO_STRICT_VERIFY=1`  | off                                                                                                                                           | Make the existing database-verifier failure fatal. Otherwise its log remains available.                                                |
| `DEMO_COMPOSITION_PORT` | `3041`                                                                                                                                        | Loopback composition publisher port.                                                                                                   |
| `DEMO_DOCKER_CONTEXT`   | current active context                                                                                                                        | Select a Docker context per command without changing the global context. Use the same value for stop.                                  |
| `DEMO_INSTANCE`         | `default`                                                                                                                                     | Isolate supervisor state and Compose project, container and volume names. Lowercase letters, numbers and hyphens, up to 40 characters. |

Default infrastructure names remain `ontos-demo`, `ontos-demo-db`, `ontos-demo-spicedb` and
`ontos_demo_postgres_data`. With `DEMO_INSTANCE=proof-one` they become `ontos-demo-proof-one`,
`ontos-demo-proof-one-db`, `ontos-demo-proof-one-spicedb` and
`ontos_demo_proof_one_postgres_data`. Use a fresh instance in an isolated worktree for cold-start
proofs so resets cannot touch the standard demo volume. **An instance does not remap ports or
change an existing environment file.** Coordinate application ports and provide local database/
SpiceDB port overrides externally when another stack uses the defaults.

macOS/Linux example:

```sh
DEMO_INSTANCE=proof-one DEMO_DOCKER_CONTEXT=desktop-linux ./scripts/demo/up.sh
DEMO_INSTANCE=proof-one DEMO_DOCKER_CONTEXT=desktop-linux ./scripts/demo/down.sh --containers
```

Windows PowerShell example:

```powershell
$env:DEMO_INSTANCE = 'proof-one'
$env:DEMO_RESET = '0'
.\scripts\demo\up.cmd
.\scripts\demo\down.cmd --containers
```

## Ports

The shell listens on 3020 (`http://localhost:3020/cs`), the composition publisher defaults to
3041, and selected vertical ports come from `topology/reference-topology.json`. Database and
SpiceDB ports come from the configured local environment (normally 5433 and 50051/8443).

## Verification evidence

Focused lifecycle tests cover context selection, instance separation, argument-safe build stages,
configuration precedence, database safety, authenticated HTTP control and native scoped child-tree
cleanup. Run `mise exec -- pnpm test:scripts scripts/demo/tests/lifecycle.test.mts`.
Linux tests do not prove native Windows or macOS cold startup. Those full start, repeat-start,
stop and data-preservation smoke runs remain required on each target OS; do not infer them from
launcher syntax or Linux test success.

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
- Finance rows show the property as "Bez vazby" because `siampark-property` is not in the default set.
- The outbox worker host logs `OutboxWorkerDescriptorError` about every second for the inventory,
  price-group-catalog and privacy workers, because those owners are not in the composition. During
  the first seconds, before the composition is published, the shell also logs
  `InstalledModuleCatalogUnavailableError`. Both are harmless for the demo.
- If a browser already holds a session from another OntOS instance on `localhost:3020`, you see
  "Přihlášené prostředí je dočasně nedostupné". Sign out (`POST /shell-super-app-api/auth/sign-out`)
  and sign in again.
