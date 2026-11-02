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

### Fail-closed Action authorization checkpoint

Sandbox preparation creates the fixed development context and Tenant membership, but does not provision Action executor relationships. Check the current owner descriptor before choosing a sample: `tenant_membership_default` and `explicit` have different provisioning requirements. Neither classification grants execution by itself.

**A. Default membership Action.** In a fresh, unchanged isolated sandbox, use the Party Registry person-engagement flow (`party.registry.attach-person-engagement`, declared `tenant_membership_default`) as `demo@test.com`, with the fixed local Tenant and Legal Entity and valid owner input:

1. Submit the engagement mutation and confirm the localized denial Toast and `403`, one rejected invocation/audit record, and no business write or handler effect. This tests missing executor denial; unavailable configuration or an indeterminate permission check is a different result.
2. Keep the missing-rule case as the negative control. A positive retry requires a successfully verified, authorized provisioning input for that environment and catalog; it must also satisfy the Action's owner/resource and lifecycle rules. Tenant membership alone is insufficient.
3. When that prerequisite is available, verify the fixed member's permission separately, retry the valid mutation with a fresh request identity after the terminal rejection, confirm success without a denial Toast, and verify a Principal outside the fixed development Tenant remains denied. Verify idempotent provisioning by repeating the same **valid authorized input**, not by repeating a refused call.

**B. Explicit Actions and the current CLI refusal.** Inspect the current Core catalog and owner descriptors; for example, `core.identity.reserve-principal-binding` is `explicit`. Every explicit Action needs its recorded allowed and denied verification assertions; any direct executor grants must name approved fixed Principals that those assertions allow. Do not substitute a default Tenant-membership grant.

The parameterless operator command discovers the **complete** current Action catalog, including explicit Actions:

```sh
mise exec -- pnpm authorization:provision-current-actions
```

Development supplies no explicit policy input. With the current explicit-containing catalog and otherwise valid local configuration/discovery, this command deliberately returns `action_authorization_input_invalid` **before schema or grant writes**. It does not partially provision the default Actions. Existing stored grants do not supply the missing input assertions, and running it twice does not establish provisioning idempotence or make the subsequent mutation succeed. There is currently no development CLI flag/file input that supplies this missing policy; do not filter the catalog, relabel Actions, add manual blanket grants or borrow stage data to complete the tutorial.

Stage uses its separately approved operator accounts file to derive fixed explicit grants and assertions; follow [Stage accounts bootstrap and provisioning](docs/architecture/DEPLOYMENT.md#stage-accounts-bootstrap). That authority does not extend to development or production. The command accepts no arbitrary Tenant, Principal or Action arguments, selects only the fixed development or stage target, and rejects production. Run it only as an authorized operator action, never during startup, migration, sandbox preparation or automatic deployment. See [Action authorization](docs/architecture/ACTIONS.md) and the [SpiceDB provisioning sequence](docs/architecture/DEPLOYMENT.md#spicedb) for the distinct provisioning, permission-verification and business-execution boundaries.

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
