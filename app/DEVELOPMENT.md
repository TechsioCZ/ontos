# Development

## Development branch

`main` is the canonical development branch and the default base and pull-request target for new
work. Do not start new work from `develop`; that branch exists only for the one-time transition back
to `main` and may be removed after the transition is complete.

Promote releases from `main` to the protected `stage` branch. A feature sandbox always creates its
feature branch from the current committed `main` workflow described below.

## Locki

[Locki](https://github.com/JanPokorny/locki) creates isolated development sandboxes backed by Git worktrees and containers. OntOS uses it so each feature can have an independent branch, dependencies, services, database, and AI session without affecting another feature or the main checkout.

## Installation

Install Locki globally with `uv` (the current directory does not matter):

```sh
uv tool install locki
```

Run the one-time interactive setup to select the preferred AI harness and editor:

```sh
locki setup
```

Do not copy the entire `~/.codex` directory when prompted; it can contain large Codex worktrees. Authenticate the selected AI harness inside Locki separately if necessary.

## Feature sandbox workflow

Create and prepare a sandbox from the `main` branch:

```sh
mise exec -- pnpm sandbox:new -- customer-search
```

Replace `customer-search` with the feature slug. This command creates the branch and worktree, copies `app/.env`, installs dependencies, starts the containers, runs Drizzle migrations, initializes the local tenant, legal entity, user, and Contacts MicroVertical, verifies the database, and opens the configured AI harness. Note the sandbox ID printed by Locki.

Forward the application ports from macOS to the sandbox:

```sh
locki pf --match 1aixi9oo 3020 4101
```

Replace `1aixi9oo` with the sandbox ID. This maps macOS ports `3020` and `4101` to the same ports inside the sandbox. The command returns immediately and does not require a dedicated terminal.

Enter the sandbox and run OntOS in another terminal:

```sh
locki x --match 1aixi9oo
cd app
mise exec -- pnpm dev
```

`locki x` opens a shell in the selected sandbox. `pnpm dev` starts the OntOS development processes and occupies that terminal until stopped.

### Fail-closed Action authorization checkpoint

Sandbox preparation intentionally creates the fixed development context and Tenant membership but
does not provision Action executor relationships. For authorization changes, keep one sandbox
unchanged and verify the rollout in this order:

1. start the candidate application and invoke a representative Contacts mutation as `demo@test.com`;
2. confirm a localized error Toast and `403`, one rejected invocation/audit record, and no business
   write or handler effect;
3. run `mise exec -- pnpm authorization:provision-current-actions` and run it a second time to prove
   idempotence;
4. retry the same mutation and confirm normal success with no denial Toast;
5. confirm a Principal outside the fixed development Tenant remains denied.

The command discovers all current Actions and grants their executor relation to the fixed
development Tenant membership set. It accepts no caller-supplied scope and never writes stage from a
development sandbox.

When the feature sandbox is no longer needed, stop its running processes and remove it:

```sh
locki rm --match 1aixi9oo --branches
```

This removes the sandbox container, worktree, port forwards, and sandbox branches. Locki refuses when uncommitted changes are present; review or preserve them before removal.

Delete the complete shared Locki VM when it is no longer needed:

```sh
locki vm delete
```

This stops and deletes the VM, including its containers, images, volumes, and VM caches. Locki preserves host-side worktrees and its shared sandbox home.

## Prepared Environment:

Each new sandbox has login:
`demo@test.com`
`password1234`

There is a Tenant `Techsio` with a legal entity `TechsioCZ`
