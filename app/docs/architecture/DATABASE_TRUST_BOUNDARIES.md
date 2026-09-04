# Database Trust-Boundary Audit

This document is the reproducible current-state audit for
[TechsioCZ/ontos#370](https://github.com/TechsioCZ/ontos/issues/370). It informs, but does not make,
the human pilot decision in [TechsioCZ/ontos#174](https://github.com/TechsioCZ/ontos/issues/174).
It changes no database grant or credential.

## Evidence contract

Evidence is classified as follows:

- **VERIFIED** — established by checked-in code, an executable catalog query, or a named test.
- **INFERRED** — a likely consequence of current composition, but not a directly observed deployed
  fact.
- **UNKNOWN** — controlled outside this repository or absent from the current implementation.

Run the audit after migrations and runtime-role bootstrap:

```sh
mise exec -- pnpm database-trust:audit
```

It writes `.codex/reports/database/database-trust-boundary.json`. The report is intentionally
ignored because it describes the database being inspected. It includes role names, effective
privileges, direct/`PUBLIC`/inherited/assumable default ACL sources, ownership, RLS flags, and
finding codes, but no URL, password, secret, tenant ID, or legal-entity ID. The command rejects an
admin/runtime pair that resolves to a different observed server endpoint or database. When both
connections use Unix sockets and the observed network address and port are null, it compares the
effective node-postgres socket host and port instead, including connection-string query
overrides. It derives both audited identities from live
`session_user`/`current_user` evidence, rejects a startup role switch, and rejects an
admin/runtime identity collapse even if URL query parameters override the authority user. These
checks require no monitoring-role privilege. Its pure report uses `null` schema for a global
default ACL. It evaluates PostgreSQL's built-in global defaults even when `pg_default_acl` has no
stored row, including the distinct catalog and `acldefault` sequence type codes and defaults for
future schemas. Report ordering uses locale-independent code-unit comparison. It includes
column-level DML, `REFERENCES`, and
PostgreSQL 17 `MAINTAIN`; classifies tables, partitioned tables, views, materialized views, foreign
tables, and sequences; inventories executable `SECURITY DEFINER` routines and user-defined base,
standalone composite, domain, enum, range, and multirange type
ownership; and distinguishes `SET OPTION` from direct `ADMIN OPTION` escalation paths. Its pure
membership analysis also follows `ADMIN OPTION` edges reachable after `SET ROLE` and records
ownership authority inherited without `SET ROLE`; cluster attributes are not treated as inherited.
Its pure report builder and target/session validators are covered by
`scripts/tests/audit-database-trust-boundaries.test.mts`.

## Reproduced local baseline

**VERIFIED:** Against a freshly migrated local database from the issue branch's `origin/main`
baseline, the audit reported:

| Surface           | Effective `ontos_runtime` authority                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cluster role      | Login; no superuser, `BYPASSRLS`, database creation, role creation, replication, inheritance, or role memberships                                                                      |
| Database          | `CONNECT` and temporary objects; no database `CREATE`                                                                                                                                  |
| Schemas           | `USAGE` on `core`, `auth`, `contacts`, and `public`; neither `USAGE` nor `CREATE` on `drizzle`; no `CREATE` on any non-system schema                                                   |
| Tables            | `SELECT`, `INSERT`, `UPDATE`, and `DELETE` across 27 owner tables; no privilege on the three `drizzle` journals and no `MAINTAIN`, `TRUNCATE`, `REFERENCES`, or `TRIGGER` authority    |
| Sequences         | `USAGE` and `SELECT` on the one application sequence; no privilege on the three `drizzle` sequences and no `UPDATE` anywhere                                                           |
| Routines          | No routines exist in the audited non-system schemas; therefore no executable `SECURITY DEFINER` routine                                                                                |
| Application types | No user-defined base, standalone composite, domain, enum, range, or multirange type exists in the audited non-system schemas                                                           |
| Future objects    | 22 effective default privileges: owner-local table DML and sequence `USAGE`/`SELECT`, plus global `PUBLIC EXECUTE` on functions and `PUBLIC USAGE` on types for relevant creator roles |
| Ownership         | All three logical owner schemas and their relations are physically owned by `ontos_admin`                                                                                              |
| RLS               | Two of 27 current tables have enabled and forced RLS                                                                                                                                   |
| Trusted settings  | The runtime role can set and read both `ontos.tenant_id` and `ontos.legal_entity_id`; transaction-local values disappear after rollback                                                |

The exact counts are local-baseline evidence, not a claim about production. Re-run the command
against any target environment before relying on them.

Two high-severity findings are therefore present:

1. `runtime_role_has_cross_schema_dml` — one credential spans the `core`, `auth`, and `contacts`
   application schemas and therefore their logical ownership boundaries.
2. `runtime_role_can_forge_trusted_context` — code holding that credential can choose either custom
   GUC value used by RLS.

The first finding is a blast-radius problem. The second is a trust-root problem. Merely renaming or
splitting roles can reduce the first; it does not, by itself, solve the second.

## Process-to-identity map

| Process or boundary              | Current identity evidence                                                                                                                                                                                                       | Status                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Migration/bootstrap service      | `zerops.yaml` supplies `DATABASE_ADMIN_URL`; Drizzle migration configs and role bootstrap use the administrative URL.                                                                                                           | **VERIFIED** for repository wiring; deployed secret value and rotation are **UNKNOWN**.                    |
| Shell request process            | Auth persistence reads `DATABASE_URL`; Core persistence composes the same Core `DatabaseConfigLive`.                                                                                                                            | **VERIFIED** in code; the deployed PostgreSQL login injected into Shell is **UNKNOWN**.                    |
| Contacts request process         | Contacts persistence and gateway-assertion redemption load the shared `DATABASE_URL`; Core runtime is a library composed into the process rather than a separate network service.                                               | **VERIFIED** in code; the deployed PostgreSQL login injected into Contacts is **UNKNOWN**.                 |
| Core                             | Core has a package and schema boundary, not an independent process or credential boundary. It executes under its caller's pool.                                                                                                 | **VERIFIED**.                                                                                              |
| Outbox Worker                    | Generated owner-local workers compose `DatabaseConfigLive` and `CoreDatabaseLive`. No production worker implementation is currently installed. A future worker would use `DATABASE_URL` unless its deployment contract changes. | First two statements **VERIFIED**; future credential choice **INFERRED**.                                  |
| SpiceDB server                   | Bootstrap requires a distinct `spicedb` login and database; application processes reach SpiceDB through its gRPC endpoint and pre-shared key.                                                                                   | **VERIFIED** in bootstrap/config code; deployed datastore connection and key distribution are **UNKNOWN**. |
| Browser/Module Federation remote | Database clients are server-only and the boundary checker rejects database imports from Actions, reads, transports, and other non-owner surfaces.                                                                               | **VERIFIED** statically; this is not evidence about a compromised server process.                          |

`zerops.yaml` deliberately does not prove which `DATABASE_URL` reaches each long-running runtime.
That may be supplied by external service configuration. No production identity or secret
distribution is inferred from its absence in the repository.

## Tenant-context trust path

The intended request path is:

```text
validated request context
  -> Core scoped transaction
  -> set_config('ontos.tenant_id' / 'ontos.legal_entity_id', value, true)
  -> verify current_setting(...)
  -> construct owner repositories
  -> forced RLS policies read those settings
  -> commit or rollback clears transaction-local settings
```

**VERIFIED:** This prevents missing scope from matching RLS rows, constrains repositories to a
transaction, and prevents context from leaking to a later transaction on the same pooled
connection.

**VERIFIED:** PostgreSQL permits the ordinary runtime role to call `set_config` for these custom
settings. Tests also use the runtime connection to set them directly. Therefore code that can send
arbitrary SQL through a compromised request process can select another syntactically valid scope.
Forced RLS still runs, but it evaluates attacker-selected context. Static import and typed-service
boundaries reduce accidental bypasses; they do not turn a shared database credential into an
unforgeable trust boundary.

## Existing negative evidence and gaps

| Threat                                          | Existing evidence                                                                                                                                                                                                          | Remaining gap                                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Superuser or `BYPASSRLS` runtime                | Bootstrap verifies both are false; the audit reads effective role attributes.                                                                                                                                              | Production must be audited rather than inferred from bootstrap source.                                                                                            |
| Admin/runtime identity collapse                 | Config tests reject identical URLs/users and a `postgres` runtime login; the audit validates distinct live session identities and rejects startup role switching.                                                          | Production must be audited rather than inferred from configuration text.                                                                                          |
| Missing, malformed, or leaked transaction scope | Core tenant-isolation integration tests verify no match and no scope leakage; the audit treats any non-empty custom setting after rollback—including a pre-existing session value—as retained context.                     | The runtime role can deliberately install a different valid value.                                                                                                |
| Cross-tenant rows and references                | Core tenant-isolation and Contacts database-boundary integration tests exercise RLS and same-tenant constraints.                                                                                                           | These tests demonstrate policy behavior under selected settings, not authenticity of the settings.                                                                |
| Raw database access from business boundaries    | `database-access:check` rejects database imports from handlers, Actions, reads, BFFs, and hidden Core bypasses.                                                                                                            | A dependency exploit or arbitrary-code execution inside a permitted server process remains inside the credential boundary.                                        |
| Privileged routines                             | Audit inventories routines in every non-system schema and flags `SECURITY DEFINER` routines that the runtime or an assumable role can both resolve through schema `USAGE` and execute; the baseline has none.              | Every future privileged routine needs a narrow contract and hardening review; production must be audited rather than inferred.                                    |
| DDL and role escalation                         | Audit checks database-level `CREATE`, every non-system schema, audited relation/routine ownership, and cluster/database/schema/object authority for every assumable role; the baseline has no DDL authority or membership. | There is no deployed-environment evidence until the audit is run there; executable denial probes for `SET ROLE` and representative DDL could be added to a pilot. |
| Unrelated schema DML                            | Audit enumerates every effective application table and sequence privilege.                                                                                                                                                 | Today denial cannot be proven: the shared role intentionally has DML in all three schemas.                                                                        |

## Bounded pilot options

### A. Process-scoped roles only

Give Shell, Contacts request handling, and installed workers distinct logins. Grant each vertical
its owner schema plus an explicit minimum Core relation/function set; deny unrelated vertical and
Auth schemas. Keep migration authority separate.

- Benefit: immediate, measurable blast-radius reduction; straightforward catalog assertions.
- Cost: credential provisioning/rotation per deployed process, a maintained Core grant manifest,
  and local-development bootstrap changes.
- Limit: every ordinary role can still forge the custom GUCs it is allowed to use. This option does
  not satisfy the trusted-context acceptance criterion alone.

### B. Admin-owned trusted-scope entry point

Stop treating custom GUCs chosen by the runtime role as authoritative. A narrowly privileged,
admin-owned entry point validates an unforgeable scope assertion and records transaction/backend
scope in state the ordinary role cannot write; RLS reads that trusted state. Direct table access is
revoked where the pilot applies.

- Benefit: can make scope authenticity enforceable inside PostgreSQL while preserving a
  transaction-scoped repository model.
- Cost: careful connection-pool lifecycle, replay/audience/expiry validation, privileged-function
  hardening, observability, and migration/rollback design.
- Critical constraint: a `SECURITY DEFINER` function that merely accepts caller-provided tenant and
  legal-entity IDs is still forgeable and is not an acceptable pilot.

### C. Trusted connection broker or pooler

A separate trusted component validates the scope assertion, selects the permitted database
identity, and establishes authoritative context before forwarding database work. Application
processes cannot mint broader context or connect around the broker.

- Benefit: centralizes identity, policy, rotation, and audit across separately deployed or
  multi-cloud MicroVerticals.
- Cost: a new availability-sensitive hop, provider/network integration, pooling semantics, local
  parity, and a strict no-bypass credential path.
- Open proof: generic SQL filtering is not sufficient. The broker must establish a database fact
  the ordinary role cannot overwrite.

Splitting every tenant into a PostgreSQL login or database is not proposed for this pilot. It would
create credential and connection cardinality before the simpler process boundary is measured.

## Proposed pilot decision packet

The smallest pilot that measures both problems is Contacts-only:

1. introduce distinct `shell_runtime` and `contacts_runtime` roles while retaining
   `ontos_admin` for migrations;
2. deny `contacts_runtime` access to `auth`, deny `shell_runtime` access to `contacts`, and grant
   only an enumerated Core subset required by each process;
3. apply either option B or C to one Contacts RLS path so the ordinary role cannot choose its
   authoritative tenant/legal-entity scope;
4. prove denial of unrelated schema DML/DDL, `SET ROLE`, `BYPASSRLS`, direct trusted-state writes,
   forged scope, cross-tenant access, and scope retention;
5. document credential creation, rotation, emergency rollback, metrics, and local bootstrap before
   considering another MicroVertical or a worker role.

Before implementation, Petr and Jiří need to decide only:

1. Is the pilot's trust root an admin-owned database entry point (B) or a separately operated
   broker/pooler (C)?
2. Is maintaining an explicit per-process Core grant manifest acceptable, or should Core database
   access first be narrowed behind callable APIs?
3. What rollback bound is required: role/grant rollback in place, or dual-path deployment with the
   old shared role available for one release?

No production grant, credential, or rollout should change until those choices are recorded in
issue #174.
