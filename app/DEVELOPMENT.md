# Development

## Development branch

`main` is the canonical development branch and the default pull-request base. Do not start new work
from `develop`; it exists only for the one-time transition back to `main`.

Promote releases from `main` to the protected `stage` branch. Feature work starts from the current
committed `main`.

## Locki

[Locki](https://github.com/JanPokorny/locki) creates isolated worktree-and-container sandboxes.
Each feature receives its own branch, dependencies, services, database, and AI session without
changing the primary checkout.

The repository command below validates Locki availability and minimum version, committed workflow
inputs, and recovery. When it reports a missing or old installation, follow its exact versioned
install command, then run `locki setup` once.

Do not copy the complete `~/.codex` directory during setup; it may contain large worktrees.
Authenticate the selected AI harness inside Locki when needed. Treat the repository script as the
executable source instead of duplicating its checks here.

## Feature sandbox workflow

From the primary `app/` directory:

```sh
mise exec -- pnpm sandbox:new -- customer-search
```

Replace `customer-search` with a lower-kebab feature slug. The command creates the branch and
sandbox, copies the local environment file without requiring agents to inspect it, installs
dependencies, starts services, runs migrations, initializes the configured local context and
MicroVerticals, verifies the database, and opens the configured AI harness. Record the sandbox ID.

Forward application ports from macOS:

```sh
locki pf --match 1aixi9oo 3020 4101
```

Replace `1aixi9oo` with the sandbox ID. The command returns immediately.

Enter the sandbox and start OntOS:

```sh
locki x --match 1aixi9oo
cd app
mise exec -- pnpm dev
```

For non-interactive host control:

```sh
locki exec --match 1aixi9oo -- sh -lc 'cd app && mise exec -- pnpm <script>'
```

Release and authorization rollout work follows
[Module Entrypoints](docs/architecture/MODULE_ENTRYPOINTS.md) and the
[Deployment Playbook](docs/architecture/DEPLOYMENT.md); do not copy feature-specific rollout
sequences into this onboarding guide.

## Cleanup

Stop running processes, then remove the sandbox:

```sh
locki rm --match 1aixi9oo --branches
```

Locki refuses removal while uncommitted changes exist. Review or preserve them first.

Delete the shared Locki VM only when no sandbox needs it:

```sh
locki vm delete
```

This deletes VM containers, images, volumes, and caches. Host-side worktrees and the shared sandbox
home remain.

## Prepared local environment

[`scripts/initialize-local-development.mts`](scripts/initialize-local-development.mts) owns the
local login and seeded Tenant, Legal Entity, Principal, and module state. Read that executable
source only when the task needs the exact local values; do not duplicate them in guidance.
