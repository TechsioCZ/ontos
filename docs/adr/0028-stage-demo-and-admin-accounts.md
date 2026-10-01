---
status: accepted
---

# Stage has one demo and one admin account per Tenant

Stage holds two Tenants: Techsio and Akros. Akros runs an e-shop back office today and a full ERP later. Siam Park left stage when its contract ended. Each stage Tenant has exactly two fixed accounts, defined in `STAGE_CONTEXTS`:

| Account | Role |
| --- | --- |
| Techsio demo | `demo` |
| Techsio admin | `admin` |
| Akros demo | `demo` |
| Akros admin | `admin` |

Source control holds only these slots. Each account's email and password, and the emails of retired accounts, come from an operator file outside the repository, named by `ONTOS_STAGE_ACCOUNTS_FILE`. Its schema is in `app/docs/architecture/DEPLOYMENT.md` (Stage/demo bootstrap). A slot keeps its Principal as long as its email maps to the same Better Auth user.

- **demo** may run every `tenant_membership_default` Action and read Party Registry (`party_identity_reader`). It holds no `explicit` Action.
- **admin** may run every Action, including every `explicit` one, and holds `identity_admin` plus every Party Registry role in its own Tenant.
- Neither role gets `support` (impersonation).

`topology/authorization-contexts/stage.json` records the rule as `explicitActionPolicy.allowedRoles: ["admin"]` with its fixed Tenant slugs. `authorization:provision-current-actions` expands that rule per Action:

- it writes a direct `action#executor@principal` grant for each admin;
- it records an allowed assertion for each admin;
- it records a denied assertion for each demo and the synthetic non-member.

`action#executor` is global per Action, so the Akros admin can run an explicit Action at the Action level. Tenant isolation comes from the Tenant check: the runtime binds each Principal to its own Tenant, and provisioning fails unless every fixed Principal is denied `tenant#access` on the other fixed Tenant.

The stage bootstrap retires Siam Park through typed writes:

- it revokes the Principal binding;
- it archives the Principal, module state, legal entity and Tenant;
- it deletes the Siam Park SpiceDB relationships it once wrote;
- it bans each Better Auth user listed in the accounts file's `retiredAccountEmails`, ends its sessions and removes its password credential.

Production stays strict. It has no fixed accounts and no explicit Action policy (#369).
