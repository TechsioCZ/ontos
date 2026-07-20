# Person property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-person-property.md`
- Technical handoff: `../../sources/handoffs/ontos-task-ticketing-person-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Person is a user-editable property whose value is an unordered set of Principal references. Per-definition cardinality is either `1 Person` or `No limit`; the default is `No limit`. The property name gives the business relationship (Assignee, Reviewer, and so on).

## Identity eligibility and lifecycle

- Eligible for new assignment: active human members and guests of the current Core tenant/workspace.
- Ineligible: groups, non-human Principals, external contacts without an account, cross-tenant identities, disabled/archived Principals, and people no longer belonging to the tenant.
- Stored references survive later disable/archive/membership loss and render as inactive/ineligible; they cannot be newly assigned.
- Core Person Directory search matches visible display names and visible email/login identifiers and enforces field visibility.
- Values store stable Principal references, never free text or copied display names.
- These shared identity, eligibility, and historical-resolution rules are concrete in the [Core Principal, Person Directory, and operation-attribution contract](../../contracts/core-principal-attribution.md).

## Cardinality and values

- Empty is zero assignments; ordering has no business meaning; duplicates are forbidden.
- `1 Person`: zero or one assignment; choosing another atomically replaces the old assignment.
- `No limit`: zero or more unique assignments; choosing another adds it.
- `1 Person` → `No limit` always succeeds without data change.
- `No limit` → `1 Person` succeeds only when no Task has multiple assignments. Otherwise it is rejected with the exact violating-Task count and no automatic data removal.

## Query capabilities

- Filters: `Contains <Person>`, `Does not contain <Person>`, `Is empty`, `Is not empty`.
- Negative membership includes any value that lacks the chosen Principal, including Empty.
- Person-directory lookup remains the picker capability. Task search matches a case-insensitive, diacritic-sensitive substring of any current Principal display name.
- Sort by the lexicographic sequence of current Principal display names after arranging the set in Task Collection locale order; Empty is last and stable Principal/Task identities break ties.
- Group by Principal membership: a Task appears in every assigned Principal group, while zero assignments appear in Empty, under [DEC-104](../decisions.md#dec-104--default-enabled-query-operations-use-datatype-aware-semantics).

## Schema operations

- Duplication assigns the next available shared `Copy` name under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared), copies cardinality configuration, and always asks whether to copy all Task assignment sets. Historical inactive references are preserved when copied.
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); enabling it does not backfill existing zero-assignment values.
- Without value copying, every existing Task is Empty; definitions/assignments become independent.
- Whole-property deletion always confirms and shows the exact non-empty Task count including zero.

## Permissions and side effects

- Full access and Editor manage schema and edit values.
- User edits values only; Viewer is read-only; Full access alone shares.
- A Person value change does not itself create a user notification. Audit/domain events still apply.

## Confirmed implementation contract

- Ticketing owns generic property behavior plus a Person-specific adapter; Core owns the Person Directory under the durable shared Principal contract.
- Use normalized assignment records unique by Task, property, and Principal; absence is Empty.
- Cross-tenant IDs are rejected even if directly submitted.
- Cardinality replacement/change, conflict counting, duplication, and deletion are synchronous atomic set-based operations with optimistic locking initially.
- A stale Person value write is rejected under [DEC-100](../decisions.md#dec-100--stale-task-property-value-writes-are-rejected-with-the-draft-preserved): the committed assignment set remains, a Toast is shown, and the unsaved draft set is preserved without automatic merge.
- No-op duplicate additions create neither duplicate rows nor accepted changes to version in the shared logs.
- Every accepted Person change is recorded through both the audit log and domain log under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record), without a separate Person history store or undo/restore/time travel.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property deletion counts and affects every retained Task whose value is non-empty, including archived and soft-deleted Tasks. No lifecycle, visibility, permission-derived list, or current-view filter applies under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Groups, account-less contacts, automatic assignment, value-change notifications, permission changes or automatic sharing caused by assignment, workload/capacity, user job roles, external directory integration, automation, and type conversion.

## Unresolved business behavior

- No Person-specific product question remains.
