---
status: accepted
---

# Stage accounts and their rights come from operator data

Source control holds no stage Tenant, account, or right. It holds only the shape of an operator file outside the repository, named by `ONTOS_STAGE_ACCOUNTS_FILE`. Its schema is in `app/docs/architecture/DEPLOYMENT.md` (Stage accounts bootstrap).

The file lists every stage Tenant, its legal entity and module state, and its accounts. Each account carries its fixed identifiers, its email, its password, and its grants:

- `tenantRelations` names the Principal relations it holds on its own Tenant. Each must be a `tenant` relation from the SpiceDB schema, other than `member`, which every account gets.
- `explicitActions` lists the `explicit` Action keys it may run, or `"all"`.

Code has no account kinds and assigns no rights by kind. SpiceDB decides every right. The tools only validate the data and write it:

- `stage:bootstrap-accounts` creates or confirms the Better Auth users, Tenants, legal entities, module states, Principals, and bindings. It writes `member` plus the listed Tenant relations.
- `authorization:provision-current-actions` writes a direct `action#executor@principal` grant for each listed explicit Action. From the same file it records an allowed assertion for each grantee and a denied assertion for every other account and the synthetic non-member.

`action#executor` is global per Action, so a grantee can run an explicit Action at the Action level. Tenant isolation comes from the Tenant check: the runtime binds each Principal to its own Tenant, and provisioning fails unless every fixed Principal is denied `tenant#access` on every other fixed Tenant.

The file also lists retired Tenants and retired account emails. For each retired Tenant the bootstrap uses typed writes:

- it revokes the Principal bindings;
- it archives the Principals, module state, legal entity and Tenant;
- it deletes every SpiceDB relationship a bootstrap can have written for them;
- it bans each Better Auth user listed in `retiredAccountEmails`, ends its sessions and removes its password credential.

Both tools only add (`TOUCH`). Removing a grant from the file does not revoke it; revocation needs a reviewed removal.

Production stays strict. It has no fixed accounts and no explicit Action grants (#369).
