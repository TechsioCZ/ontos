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
3. `pnpm db:migrate`, `pnpm local:initialize`, `pnpm demo:reset`, `pnpm db:verify`, and
   `node scripts/demo/provision-actions.mts` (development replacement for
   `pnpm authorization:provision-current-actions`, see Known issues).
4. Native builds of the shell and each selected vertical, run only when an app has no build or its
   sources (or `packages/`, or the lockfile) changed since its last build.
5. Starts `modern serve` for the shell and each vertical. Then it starts the composition publisher
   (`scripts/siampark/development-composition.mts`) and the outbox worker host
   (`scripts/outbox-worker-host.generated.mts`).
6. `node scripts/demo/reset-permissions.mts`: sales-demo accounts, role grants and the agent-bot API key
   (see Sales demo permissions).

Every step and server writes a log to `app/.scratch/demo-logs/<name>.log` (gitignored). PIDs go in
`.scratch/demo-pids/` and build stamps in `.scratch/demo-build/`.

### Options

| Variable                | Default                                                                           | Effect                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEMO_VERTICALS`        | `party-registry siampark-work siampark-billing-finance commerce-customer-context` | Verticals to build, serve and compose. Takes vertical IDs from `topology/reference-topology.json`, separated by spaces or commas.              |
| `DEMO_REBUILD=1`        | off                                                                               | Rebuilds every selected app.                                                                                                                   |
| `DEMO_RESET=0`          | on                                                                                | Skips `pnpm demo:reset` and keeps the database data. Use it only when SpiceDB was not restarted: the reset is what writes the Siampark grants. |
| `DEMO_COMPOSITION_PORT` | `3041`                                                                            | Composition publisher port.                                                                                                                    |

Example: `DEMO_VERTICALS="party-registry siampark-work siampark-billing-finance commerce-customer-context workforce tagging" ./scripts/demo/up.sh`.
The composition publisher reads the same list through `ONTOS_DEMO_VERTICALS`.

## Ports

| Port            | Service                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| 3020            | Shell: http://localhost:3020/cs                                                                        |
| 3041            | Development composition (`/active`). Siampark used 3031, but launchd still holds 3031 on this machine. |
| 4101            | commerce-customer-context (API only)                                                                   |
| 4102            | party-registry                                                                                         |
| 4117            | siampark-work                                                                                          |
| 4118            | siampark-billing-finance                                                                               |
| 4114–4116, 4119 | siampark property / occupancy / agreements / relationships (not started by default)                    |
| 5433            | Postgres (`siampark_demo` database, admin `ontos_admin`)                                               |
| 50051 / 8443    | SpiceDB gRPC / HTTP (TLS)                                                                              |

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

| Login / principal      | Role            | Write                                                 | Read only                                 |
| ---------------------- | --------------- | ----------------------------------------------------- | ----------------------------------------- |
| `obchod@demo.ontos`    | Vedoucí obchodu | everything, plus identity admin (creates the bot key) |                                           |
| `obchodnik@demo.ontos` | Obchodník       | customers, tagging, opportunities, tasks              | employees, products, statistics, invoices |
| `ucetni@demo.ontos`    | Účetní          | invoices                                              | customers, statistics                     |
| `sklad@demo.ontos`     | Skladník        | products, tasks                                       |                                           |
| `agent-bot` (API key)  | service         | opportunities, tasks, tagging (no tag update/delete)  | all other demo modules                    |

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

## Build identity

Each native build marker includes the clean Git HEAD. A commit made while the stack runs would
therefore make the composition publisher reject the running builds. To prevent that, builds and the
publisher run with a failing `git` stub (`.scratch/demo-bin/git`), which pins every demo build to the
unpromotable `workspace` identity. The demo build also skips the `modern deploy` step: that step
emits a promotable release envelope, and `modern serve` only needs `dist/`.

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
