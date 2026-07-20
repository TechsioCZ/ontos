# Email property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-email-property.md`
- Technical handoff: `../../sources/handoffs/ontos-email-property-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Email is a user-editable property containing Empty or one practical ASCII/punycode email address. It preserves the trimmed, case-entered form for display while using a lowercase invariant projection for search/filter/sort.

## Normative validation

- Trim outer whitespace; reject internal whitespace/control characters and multiple addresses.
- Maximum stored length: 254 ASCII characters.
- Local part: 1–64 ASCII dot-atom characters (`A-Z`, `a-z`, digits, supported specials, and non-leading/non-trailing/non-consecutive dots).
- Domain: 1–253 ASCII characters, at least two non-empty 1–63-character labels of letters/digits/interior hyphens; punycode labels are supported.
- Reject quoted local parts, comments, domain literals, raw non-ASCII local/domain content, leading/trailing hyphens, and advanced RFC variants outside the practical grammar.
- Backend parser is authoritative and shared with client behavior. Invalid draft stays visible with inline feedback while prior persisted value remains; cancel/reload restores persisted state.
- Syntax validation does not check mailbox existence or deliverability.

## Mandatory configuration

- Email is optional by default and may be marked Mandatory under the cross-datatype rule in [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory).
- Enabling Mandatory does not backfill values. The next submitted edit form for a Task with Empty Mandatory Email is blocked until populated; clearing it through that form is rejected.

## Activation

- A reader, including Viewer, may activate a populated address using a percent-encoded recipient-only `mailto:` request to the device/browser default client.
- Ticketing does not send mail; activation is non-mutating. Empty offers no action.

## Query capabilities

- Search whole or literal substring, case-insensitively.
- Filters: `Is`, `Is not`, `Contains`, `Does not contain`, `Is empty`, `Is not empty` using literal, case-insensitive comparison.
- Negative filters include Empty.
- Sort by normalized whole address using case-insensitive, diacritic-sensitive Task Collection locale collation, with Empty last in both directions and stable Task-ID tie-breaker under [DEC-082](../decisions.md#dec-082--text-like-queries-share-comparison-and-empty-rules).
- Group by normalized whole-address equality using the same collation, with Empty separate, under [DEC-104](../decisions.md#dec-104--default-enabled-query-operations-use-datatype-aware-semantics).

## Schema operations

- Duplication assigns the next available shared `Copy` name under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared), offers optional value copying, and produces independent values/configuration.
- Whole-property deletion always confirms against the non-empty count across every retained Task, including archived and soft-deleted Tasks; stale preview refreshes/reconfirms.
- Deletion removes live values while retaining the corresponding shared audit-log and domain-log records under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record).

## Permissions and versioning

- Baseline schema/value permission split applies; Email adds no role.
- Invalid edits do not create a change version. Successful live changes are recorded in both the audit log and domain log; the live projection remains current state, with no separate Email history store, event sourcing, or undo.
- A stale Email value write is rejected under [DEC-100](../decisions.md#dec-100--stale-task-property-value-writes-are-rejected-with-the-draft-preserved): the committed address remains, a Toast is shown, and the unsaved draft is preserved without automatic merge.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property deletion counts and affects every retained Task whose value is non-empty, including archived and soft-deleted Tasks. No lifecycle, visibility, permission-derived list, or current-view filter applies under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Direct sending, subject/body/templates, communication history/sync, mailbox existence/deliverability, multiple addresses, notifications/invitations, contact management, and exhaustive nonstandard RFC syntax.

## Unresolved business behavior
