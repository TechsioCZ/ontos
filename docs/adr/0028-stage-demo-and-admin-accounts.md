---
status: accepted
---

# Stage has one demo and one admin account per Tenant

Stage holds two Tenants: Techsio and Akros. Akros runs an e-shop back office today and a full ERP later. Siam Park left stage when its contract ended. Each stage Tenant has exactly two fixed accounts, defined in `STAGE_CONTEXTS`:

| Account | Email | Role |
| --- | --- | --- |
| Techsio demo | `demo@test.com` | `demo` |
| Techsio admin | `admin@techsio.test` | `admin` |
| Akros demo | `demo@akros.test` | `demo` |
| Akros admin | `admin@akros.test` | `admin` |

The Techsio demo keeps `demo@test.com` because its existing Principal binding is pinned to that Better Auth user.

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
- it bans the Better Auth user, ends its sessions and removes its password credential.

Production stays strict. It has no fixed accounts and no explicit Action policy (#369).
