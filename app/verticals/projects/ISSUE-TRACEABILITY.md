# Projects issue acceptance traceability

This note records the implemented surface for parent issue #146 and its linked issues #147–#158.
Parent #144 contains no additional acceptance criteria.

| Issue                  | Implemented evidence                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #146 Project entity    | `projects.projects` owns stable tenant-scoped identity, forced RLS, a linkable `projects.project` resource type, and governed create/read operations.                                                                 |
| #147 Create            | `create-project.action.ts`; strict payload, Owner eligibility, trusted creator/tenant/time, required idempotency, domain and Data Access evidence.                                                                    |
| #148 Read              | Generated Effect contract/client/server plus owner-local governed read; unknown, cross-tenant, and non-owner results are hidden consistently.                                                                         |
| #149 Created time      | PostgreSQL `defaultNow()` supplies immutable `created_at`; browser payload cannot provide it.                                                                                                                         |
| #150 Created by        | Action runtime principal supplies immutable `created_by_principal_id`; browser payload cannot provide it.                                                                                                             |
| #151 Owner             | Exactly one stable eligible Principal UUID is required on create and stored as `owner_principal_id`.                                                                                                                  |
| #152 Prefix            | 2–5 ASCII letters, normalized uppercase, tenant-unique under concurrent inserts, and immutable after create.                                                                                                          |
| #153 Short text        | Nullable `shortText`, limited to 255 Unicode code points.                                                                                                                                                             |
| #154 Name              | Required non-whitespace name.                                                                                                                                                                                         |
| #155 Update            | Generated Update Action changes only Name, `shortText`, or eligible Owner and preserves identity, Prefix, hierarchy, and creation metadata. The issue text's “Description” is implemented canonically as `shortText`. |
| #156 Archive/unarchive | Separate generated Actions, reversible lifecycle, typed repeated-transition rejection, durable events, and shared archived mutation guard while reads/references remain available.                                    |
| #157 Set Owner         | Initial Owner selection is part of Create; later Owner changes are part of Update. No redundant standalone Action was added.                                                                                          |
| #158 Move              | Generated Move Action changes only the direct parent/root position, locks the tenant hierarchy, preserves subtree identities, and rejects missing/cross-tenant targets and cycles.                                    |

Primary executable evidence lives in `tests/unit/*.test.ts` and
`tests/integration/projects-workflows.test.ts`. The database workflow covers tenant isolation,
case-normalized concurrent Prefix collision, stable descendants, lifecycle transitions, archived
move gating, and concurrent opposing moves without a committed cycle.

Out of scope and intentionally absent: UI pages, List/Search, deletion or Prefix reuse, arbitrary
sibling ordering, tasks, milestones, planning/workflows, team management, reporting, rich text,
outbox consumers, and authorization-model definitions.
