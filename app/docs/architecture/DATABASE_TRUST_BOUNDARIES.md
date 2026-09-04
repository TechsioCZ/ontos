# Database Trust-Boundary Audit

This is the reproducible current-state evidence for
[TechsioCZ/ontos#370](https://github.com/TechsioCZ/ontos/issues/370). It informs the human decision
in [TechsioCZ/ontos#174](https://github.com/TechsioCZ/ontos/issues/174); it does not change grants,
credentials, or application behavior.

## Run it

After migrations and runtime-role bootstrap:

```sh
mise exec -- pnpm database-trust:audit
```

The command uses distinct admin and runtime connections to the same PostgreSQL database and writes
`.codex/reports/database/database-trust-boundary.json`. The ignored report contains identities,
effective authority, RLS state, trusted-context probes, and finding codes. It never contains URLs,
passwords, secrets, tenant IDs, or legal-entity IDs.

Evidence in this document is:

- **VERIFIED** when established by repository code, the audit, or a named test;
- **INFERRED** when it follows from current composition but was not observed in deployment;
- **UNKNOWN** when it is controlled outside this repository.

The audit covers current and reachable-role authority over databases, schemas, relations,
sequences, routines, types, extensions, foreign data, publications, subscriptions, parameters,
grant options, defaults, RLS, owner-context views, and direct or indirect `SECURITY DEFINER`
execution. The executable report is the detailed capability inventory; this document records only
the architectural conclusions.

## Reproduced local baseline

**VERIFIED** against a freshly migrated local database:

| Surface                            | `ontos_runtime` authority                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Cluster and roles                  | Login only; no superuser, `BYPASSRLS`, database/role creation, replication, inheritance, memberships, or parameter grants |
| Database and schemas               | `CONNECT` and temporary objects; `USAGE` on application schemas; no database or schema `CREATE`                           |
| Relations                          | DML across 27 owner tables; no migration-journal access or relation-control privileges                                    |
| Sequences                          | `USAGE` and `SELECT` on one application sequence; no `UPDATE`                                                             |
| Ownership and privileged execution | No application-object ownership and no executable `SECURITY DEFINER` path                                                 |
| RLS                                | Two tables have enabled and forced RLS                                                                                    |
| Trusted settings                   | Can set both `ontos.tenant_id` and `ontos.legal_entity_id`; local values disappear after rollback                         |

Exact counts describe this local database, not production. Re-run the audit against each target
environment.

The baseline has exactly two high-severity findings:

1. `runtime_role_has_cross_schema_dml`: one credential spans Core, Auth, and Contacts.
2. `runtime_role_can_forge_trusted_context`: that credential can choose both custom GUC values used
   by RLS.

The first is a blast-radius problem. The second is a trust-root problem; splitting role names alone
does not solve it.

## Process-to-identity map

| Boundary            | Current evidence                                                                         | Status                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Migration/bootstrap | Drizzle and role bootstrap use `DATABASE_ADMIN_URL`.                                     | Repository wiring **VERIFIED**; deployed secret and rotation **UNKNOWN**.       |
| Shell requests      | Auth and Core persistence use the shared `DATABASE_URL`.                                 | Code **VERIFIED**; deployed login **UNKNOWN**.                                  |
| Contacts requests   | Contacts persistence and assertion redemption use the shared `DATABASE_URL`.             | Code **VERIFIED**; deployed login **UNKNOWN**.                                  |
| Core                | Package/schema boundary composed into its caller; no independent process or credential.  | **VERIFIED**.                                                                   |
| Workers             | Generated workers compose the shared database layers; no production worker is installed. | Current code **VERIFIED**; future identity **INFERRED**.                        |
| SpiceDB             | Separate datastore login; applications use gRPC plus a pre-shared key.                   | Bootstrap **VERIFIED**; deployed distribution **UNKNOWN**.                      |
| Browser/remotes     | Boundary checks reject database imports outside server owners.                           | Static boundary **VERIFIED**; not protection from a compromised server process. |

External service configuration may supply production credentials, so their absence from
`zerops.yaml` proves nothing about deployed identity distribution.

## Tenant-context trust path

```text
validated request context
  -> scoped transaction
  -> set_config(..., true)
  -> verify current_setting(...)
  -> owner repositories
  -> forced RLS reads the settings
  -> commit or rollback clears them
```

**VERIFIED:** transaction scoping prevents missing context from matching rows and prevents values
leaking to a later transaction on the same pooled connection.

**VERIFIED:** the ordinary runtime role can also call `set_config` directly. Arbitrary SQL inside a
compromised runtime can therefore choose another valid scope. Forced RLS still runs, but evaluates
attacker-selected context. Typed services and import rules prevent accidents; they do not make a
shared credential an unforgeable security boundary.

## Negative evidence and remaining gaps

| Threat                  | Current evidence                                                                                                 | Gap                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Cross-tenant SQL        | RLS integration tests prove filtering for selected context.                                                      | They do not prove the context is authentic.                                           |
| Raw database access     | Static boundaries reject imports from non-owner surfaces.                                                        | Arbitrary code inside an allowed server process retains the credential.               |
| DDL and role escalation | The audit checks effective privileges, ownership, grant authority, and reachable roles; local baseline has none. | Production needs its own audit and pilot denial probes.                               |
| Privileged execution    | The audit follows direct and indirect privileged routine/view paths; local baseline has none.                    | Every future privileged path needs a narrow contract and review.                      |
| Unrelated-schema DML    | The audit enumerates effective relation and sequence access.                                                     | Denial is impossible today because the shared role intentionally spans three schemas. |

## Pilot options

### A. Process-scoped roles

Give Shell, Contacts, and workers distinct logins. Each vertical gets its owner schema plus an
explicit minimal Core grant set; migrations remain administrative.

- Benefit: measurable blast-radius reduction.
- Cost: per-process provisioning/rotation and a maintained Core grant manifest.
- Limit: ordinary roles can still forge trusted GUCs, so this cannot solve scope authenticity alone.

### B. Admin-owned trusted-scope entry point

Validate an unforgeable scope assertion in a narrow admin-owned entry point and store scope where
the ordinary role cannot write it. RLS reads that trusted state and direct table access is revoked
for the pilot.

- Benefit: enforceable scope authenticity inside PostgreSQL.
- Cost: privileged-function hardening, pool lifecycle, replay/audience/expiry validation,
  observability, and rollback design.
- Constraint: a `SECURITY DEFINER` function accepting caller-chosen IDs remains forgeable.

### C. Trusted broker or pooler

A trusted component validates scope, selects the allowed database identity, and establishes
authoritative context before forwarding work. Applications cannot connect around it.

- Benefit: centralized identity, rotation, and audit across independent or multi-cloud deployments.
- Cost: an availability-sensitive hop, network/provider integration, pooling semantics, local
  parity, and a strict no-bypass credential path.
- Constraint: generic SQL filtering is insufficient; the broker must establish state the ordinary
  role cannot overwrite.

Per-tenant PostgreSQL logins or databases are outside this pilot because of credential and
connection cardinality.

## Proposed Contacts pilot

1. Create separate `shell_runtime` and `contacts_runtime` roles; keep `ontos_admin` for migrations.
2. Deny each runtime access to the other vertical and grant only an explicit Core subset.
3. Apply option B or C to one Contacts RLS path.
4. Prove denial of unrelated DML/DDL, `SET ROLE`, `BYPASSRLS`, trusted-state writes, forged scope,
   cross-tenant access, and retained context.
5. Define provisioning, rotation, observability, rollback, and local bootstrap before expanding.

Before implementation, Petr and Jiří must decide:

1. Is the trust root an admin-owned database entry point (B) or a trusted broker/pooler (C)?
2. Is a per-process Core grant manifest acceptable, or should Core access first move behind callable
   APIs?
3. Is rollback in place sufficient, or must one release support a dual path using the shared role?
