# Development

## Branches

`main` is the canonical development branch and the default base and pull-request target. Do not start new work from `develop`; it exists only for the one-time transition back to `main` and may be removed after that transition.

Promote releases from `main` to the protected `stage` branch. Feature sandboxes start from the current committed `main` workflow below.

## Repository-managed tooling

- `.mise.toml` and `package.json#packageManager` own the local Node and pnpm toolchain.
- `package.json#scripts` owns command names and composition.
- `.agents/skills-lock.json` owns tracked skill sources; `.codex/skills/` is generated local output.
- Read-only reference repositories are opt-in through `mise exec -- pnpm agents:refs:install`.

Do not copy versions, current package inventory, or generated skill state into prose.

## Locki

[Locki](https://github.com/JanPokorny/locki) creates isolated development sandboxes backed by Git worktrees and containers. Each feature gets its own branch, dependencies, services, database, and AI session without changing the primary checkout.

Install Locki globally; the current directory does not matter:

```sh
uv tool install locki
```

Run the one-time setup to select the AI harness and editor:

```sh
locki setup
```

Do not copy the entire `~/.codex` directory when prompted; it can contain large Codex worktrees. Authenticate the selected harness inside Locki when required.

## Feature sandbox workflow

Create and prepare a sandbox from `main` while in the primary `app/` directory:

```sh
mise exec -- pnpm sandbox:new -- customer-search
```

Replace `customer-search` with the feature slug. The command creates the branch and worktree, copies `app/.env`, installs dependencies, starts containers, runs Drizzle migrations, initializes the local tenant, legal entity, user, and Party Registry MicroVertical, verifies the database, and opens the configured AI harness. Record the printed sandbox ID.

Forward application ports from macOS to the sandbox:

```sh
locki pf --match 1aixi9oo 3020 4102
```

Replace `1aixi9oo` with the sandbox ID. The command returns immediately.

Enter the sandbox and run OntOS in another terminal:

```sh
locki x --match 1aixi9oo
cd app
mise exec -- pnpm dev
```

`pnpm dev` occupies that terminal until stopped.

Party Registry owns Contacts, counterparties, and engagement profiles in one MicroVertical. Start the Shell and Party Registry processes before exercising engagement-profile writes; there is no separate Contacts deployment or cross-MicroVertical validation call. `mise exec -- pnpm env:local:ensure` materializes the shared local infrastructure values while preserving explicit values and printing no secrets.

### Action authorization checkpoint

There is no Action-provisioning command. `authorization:provision-current-actions` was removed with granular authorization (Authorization v2, #1343) and is not declared in `package.json#scripts`; running it fails with pnpm's `Command "authorization:provision-current-actions" not found`. That error is an absent entrypoint, **not** an authorization refusal, and says nothing about permissions or policy. Do not recreate the command, write SpiceDB relationships by hand or add blanket grants to make a flow pass: only Core's single compiler writes the SpiceDB projection from PostgreSQL access intent. Older specifications under `specs/` that still name the command are historical records, not current guidance.

Sandbox preparation (`pnpm local:initialize`, run by `sandbox:new`) bootstraps the fixed development Tenant's access in one step through `bootstrapTenantAccess`: its scopes, the owner membership, the "Plný přístup" Role compiled from the pinned access catalog artifact (every capability of that catalog with every mode it declares), the owner's Assignment in every scope, and one Core compiler reconcile. It also registers the local Storefront workload binding. A capability that is not in that catalog is not covered; see [Granular Authorization](docs/architecture/AUTHORIZATION.md) for the gate, its outcomes and the Bootstrap and Novinky rules, and [Action Execution](docs/architecture/ACTIONS.md) for the Action carrier.

Keep these results separate when checking a flow:

1. **Preparation.** `pnpm local:initialize` succeeds; the bootstrap is idempotent, so rerunning it is a safe retry. Preparation success is not a permission check.
2. **Permission decision.** The access gate answers `ALLOWED`, `NEEDS_APPROVAL`, `DENIED` or `UNAVAILABLE`; unavailable configuration or an unprovable engine is not a denial.
3. **Business operation.** The Action's own owner, resource, payload and lifecycle rules still apply after an allowed decision.

Checkpoint, in a fresh and unchanged isolated sandbox, with the Party Registry process running:

1. As `demo@test.com` (the fixed local owner) submit a valid person-engagement mutation (`party.registry.attach-person-engagement`) for the fixed local Tenant and Legal Entity, then confirm it succeeds without a denial Toast. If it is denied or unavailable, treat that as a failed or incomplete sandbox preparation and rerun `pnpm local:initialize`; do not add grants by hand.
2. As the negative control, confirm a Principal that is not a member of the fixed development Tenant, or a capability that Role does not name, remains denied for the same mutation. A denial for a capability added after the Role was compiled is expected until it is adopted through Access administration (Novinky), not a provisioning failure.
3. List the current catalog with `mise exec -- pnpm authorization:catalog:report`, and confirm the inventory is complete with `mise exec -- pnpm authorization:inventory:check`. These read declarations; they never grant anything.

This guide does not claim the checkpoint was run end to end in a sandbox; it names only commands and entrypoints present in this repository.

Stage uses its separately approved operator accounts file, not repository data: follow [Stage accounts bootstrap and provisioning](docs/architecture/DEPLOYMENT.md#stage-accounts-bootstrap) (`stage:bootstrap-accounts`). That authority does not extend to development or production. Run it only as an authorized operator action, never during startup, migration, sandbox preparation or automatic deployment. The [SpiceDB provisioning sequence](docs/architecture/DEPLOYMENT.md#spicedb) describes the schema and intent boundaries.

When the feature sandbox is no longer needed, stop its running processes and remove it:

```sh
locki rm --match 1aixi9oo --branches
```

Locki refuses removal when uncommitted changes exist. This removes the container, worktree, port forwards, and sandbox branches.

Delete the shared Locki VM only when its containers, images, volumes, and caches are no longer needed:

```sh
locki vm delete
```

Host-side worktrees and the shared sandbox home remain.

## Prepared environment

- Login: `demo@test.com`
- Password: `password1234`
- Tenant: `Local Tenant`
- Legal entity: `Local Legal Entity`
