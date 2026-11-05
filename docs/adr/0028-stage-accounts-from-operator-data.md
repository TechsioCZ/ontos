---
status: accepted
---

# Stage accounts and their rights come from operator data

Source control holds no stage Tenant, account, or right. It holds only the shape of an operator file outside the repository, named by `ONTOS_STAGE_ACCOUNTS_FILE`. Its schema is in `app/docs/architecture/DEPLOYMENT.md` (Stage accounts bootstrap).

The file lists every stage Tenant, its legal entity and module state, and its accounts. Each account carries its fixed identifiers, its email, its password, and its grants:

- `owner` is true for the one account that owns the Tenant. `bootstrapTenantAccess` creates that Tenant's scopes, memberships, the "Plný přístup" (Full access) Role compiled from the current catalog, and the owner's Assignment in every scope.
- `roles` lists the further roles the account holds beside its membership. Today the only value is `full_access`; role templates arrive with the Role editor.

Code has no account kinds and assigns no rights by kind. The bootstrap validates the data and writes Core intent; the Core compiler is the only writer of the SpiceDB projection. Nothing writes a SpiceDB relationship directly and nothing reads the earlier `member`, `module_access` or `party_identity_*` grants, which no longer exist.

- `stage:bootstrap-accounts` creates or confirms the Better Auth users, Tenants, legal entities, module states, Principals, and bindings, then calls `bootstrapTenantAccess` and assigns the listed roles, then runs one reconcile.

Tenant isolation comes from the v2 scopes: a grant belongs to one scope, and the compiler projects only that scope's intent. The bootstrap refuses a file that does not name exactly one owner per Tenant.

The file also lists retired Tenants and retired account emails. For each retired Tenant the bootstrap ends the intent that carried its authority and reconciles:

- it revokes the Tenant's memberships and assignments in PostgreSQL;
- it archives the Principals, module state, legal entity and Tenant;
- it bans each Better Auth user listed in `retiredAccountEmails`, ends its sessions and removes its password credential.

The reconcile after the revocation removes the projected tuples, so a retired Tenant's graph stops answering. Adding or changing grants is not revocation: only removing or changing the account's data does that, and the operator must re-run the bootstrap and reconcile to make it take effect.

Production stays strict. It has no fixed accounts.
