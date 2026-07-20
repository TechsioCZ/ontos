# ID property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-id-property.md`
- Technical handoff: `../../sources/handoffs/ontos-id-property-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

ID exposes one immutable automatically allocated numeric assignment per Task within its Task Collection, optionally rendered with a shared prefix as `PREFIX-123`. Each Task Collection owns exactly one non-reusable sequence and exactly one ID property definition.

## Collection/schema scope

- One Task Collection owns exactly one Task Property schema; schemas are not shared across collections.
- Numeric uniqueness is per collection. Different collections may both contain number `1`.
- The first assigned number is `1`; later assignment is one greater than the highest ever assigned.

## Initial activation/backfill

- Activating ID in an existing collection assigns every retained Task a number ordered by `(Created time, durable creation ordinal)` ascending.
- Stable creation ordinal breaks equal timestamps deterministically.
- Retained soft-deleted Tasks participate so restoration never requires/reorders allocation.
- Empty collection assigns nothing; its first later Task gets `1`.

## New, deleted, restored, and duplicated Tasks

- Every new Task receives exactly one next number atomically with creation; no user can supply/change/clear it.
- Concurrent creation produces unique consecutive assignments.
- Deleting a Task never releases its number; restoration retains it and does not alter the counter.
- Duplicating a Task creates a new Task and allocates a fresh ID; it never copies the source assignment.

## Prefix

- Prefix is optional shared property configuration, trimmed at both ends and case-preserved.
- Empty-after-trim renders only the decimal number with no hyphen.
- Prefix changes recompute presentation only; they do not rewrite assignments or advance sequence.

## Property lifecycle exceptions

- A collection may not create a second ID definition.
- ID property definitions cannot be duplicated; reject before showing a copy-values choice.
- The ID definition name follows the shared trim, non-empty, and case-insensitive uniqueness rule in [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared), but its duplicate-name sequence is never invoked.
- Confirmed removal permanently deletes the ID definition, prefix, every assignment, and sequence counter under [DEC-087](../decisions.md#dec-087--id-property-deletion-permanently-removes-its-state). It is not a hide or soft deletion.
- A later ID addition creates a new definition and sequence, then freshly backfills retained Tasks from `1` using the deterministic activation order.
- The removal action requires the baseline confirmation UX; its non-empty count includes all retained Tasks with assignments, including soft-deleted Tasks, under [DEC-086](../decisions.md#dec-086--id-deletion-impact-includes-soft-deleted-tasks).
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); every active ID assignment is intrinsically non-empty and satisfies the setting.

## Query capabilities

Search, filtering, sorting, special ID URLs, and external integrations are explicitly out of scope. Grouping uses the exact immutable ID Assignment; because assignments are unique, each active assignment normally forms its own group under [DEC-104](../decisions.md#dec-104--default-enabled-query-operations-use-datatype-aware-semantics).

## Permissions and versioning

- Full access/Editor manage the ID definition/prefix; all readers view; no role edits assignments.
- Assignment has an immutable timestamp; prefix/visibility changes version configuration. Every accepted change is versioned by both the audit log and domain log under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record), with no separate ID history store.

## Confirmed implementation contract

- Use PostgreSQL `bigint` and transport decimal strings.
- Maintain assignments, collection counter, stable creation ordinal, and database constraints for one definition, one assignment per Task, and unique number per active ID namespace. Assignment state is immutable while that definition exists and is removed only by whole-property deletion.
- Serialize activation/backfill and Task creation at collection scope; commit assignment/counter/mutation/version/event/outbox atomically.
- Prefer a transactional counter row so rollback does not consume a business ID.
- ID allocation is internal to Task creation, not a public caller operation.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- ID deletion continues to count every retained assignment, including archived and soft-deleted Tasks, under DEC-086 and the aligned shared population rule in [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

ID-based URLs, query behavior, external integrations, import/export, Task moves between collections, collection merge/split, generic schema permissions, and a caller-supplied allocation endpoint.

## Unresolved business behavior
