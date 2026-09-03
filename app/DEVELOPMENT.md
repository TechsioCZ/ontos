# Development

## Branches

`main` is the canonical development branch and the default base and pull-request target. Do not
start new work from `develop`; it exists only for the one-time transition back to `main` and may be
removed after that transition.

Promote releases from `main` to the protected `stage` branch. Feature sandboxes start from the
current committed `main` workflow below.

## Repository-managed tooling

- `.mise.toml` and `package.json#packageManager` own the local Node and pnpm toolchain.
- `package.json#scripts` owns command names and composition.
- `.agents/skills-lock.json` owns tracked skill sources; `.codex/skills/` is generated local output.
- Read-only reference repositories are opt-in through
  `mise exec -- pnpm agents:refs:install`.

Do not copy versions, current package inventory, or generated skill state into prose.

## Locki

[Locki](https://github.com/JanPokorny/locki) creates isolated development sandboxes backed by Git
worktrees and containers. Each feature gets its own branch, dependencies, services, database, and
AI session without changing the primary checkout.

Install Locki globally; the current directory does not matter:

```sh
uv tool install locki
```

Run the one-time setup to select the AI harness and editor:

```sh
locki setup
```

Do not copy the entire `~/.codex` directory when prompted; it can contain large Codex worktrees.
Authenticate the selected harness inside Locki when required.

## Feature sandbox workflow

Create and prepare a sandbox from `main` while in the primary `app/` directory:

```sh
mise exec -- pnpm sandbox:new -- customer-search
```

Replace `customer-search` with the feature slug. The command creates the branch and worktree,
copies `app/.env`, installs dependencies, starts containers, runs Drizzle migrations, initializes
the local tenant, legal entity, user, and Contacts MicroVertical, verifies the database, and opens
the configured AI harness. Record the printed sandbox ID.

Forward application ports from macOS to the sandbox:

```sh
locki pf --match 1aixi9oo 3020 4101
```

Replace `1aixi9oo` with the sandbox ID. The command returns immediately.

Enter the sandbox and run OntOS in another terminal:

```sh
locki x --match 1aixi9oo
cd app
mise exec -- pnpm dev
```

`pnpm dev` occupies that terminal until stopped.

### Fail-closed Action authorization checkpoint

Sandbox preparation creates the fixed development context and Tenant membership but does not
provision Action executor relationships. For authorization changes, keep one sandbox unchanged
and verify this order:

1. invoke a representative Contacts mutation as `demo@test.com`;
2. confirm a localized error Toast and `403`, one rejected invocation/audit record, and no
   business write or handler effect;
3. run `mise exec -- pnpm authorization:provision-current-actions` twice to prove idempotence;
4. retry the mutation and confirm normal success without a denial Toast;
5. confirm a Principal outside the fixed development Tenant remains denied.

The provisioning command discovers current Actions and grants executor relations only to the
fixed development Tenant membership set. It accepts no caller-supplied scope and never writes
stage from a development sandbox.

Remove an unused sandbox after preserving any work:

```sh
locki rm --match 1aixi9oo --branches
```

Locki refuses removal when uncommitted changes exist. This removes the container, worktree, port
forwards, and sandbox branches.

Delete the shared Locki VM only when its containers, images, volumes, and caches are no longer
needed:

```sh
locki vm delete
```

Host-side worktrees and the shared sandbox home remain.

## Prepared environment

- Login: `demo@test.com`
- Password: `password1234`
- Tenant: `Techsio`
- Legal entity: `TechsioCZ`
