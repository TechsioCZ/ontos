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

Workload registrations follow the same split. A storefront's or another external system's workload binding is operator data: the operator registers it per Tenant and company (`app/scripts/demo/register-stage-workloads.mts`), and it carries no key the platform issues. A module's own declared internal workload is not operator data. At every release the platform registers it in each Tenant where the module is installed, once per active company: one service principal, one workload binding, one company binding. The platform also issues, rotates and retires its key. When the module is uninstalled, the workload leaves the catalogue or a company ends, the platform retires that registration and its key, and deletes nothing. The step runs at each deploy (before the boot's key provisioning and again after publishing); a module installed in a tenant at runtime, or a company added at runtime, gets its registrations and key at the next deploy. Nobody registers or keys an internal workload by hand. The principal is named for a person, e.g. "CRM · zakládání klientů · Obchodní firma", and follows a renamed company. The platform recognises its own principals only by a marker that Core alone sets when it creates them (`platform_role = 'internal_workload'`; no Action or API carries it, and it can never change) together with their derived id, never by their name. A hand-made registration, even one created with the derived id, is left as it is and gets no key.

Production stays strict. It has no fixed accounts.
