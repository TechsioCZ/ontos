# Date Range property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-date-rande-property.md` (source filename contains `rande`)
- Technical handoff: `../../sources/handoffs/ontos-date-range-property-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Date Range is a user-editable property containing Empty or one complete interval. A complete interval always has two different calendar dates with Start strictly before End, plus either no times or a complete pair of timezone-free wall-clock times when that definition enables time support.

## Value invariants and validation

- Persisted states are structurally limited to Empty, complete dates without times, or complete dates with both times.
- Same-day ranges are invalid even when Start/End times differ.
- Partial dates or a single time exist only in an editor draft and cannot be persisted.
- Invalid save keeps the draft for correction, preserves the prior persisted value, does not auto-swap/shift endpoints, and returns a stable localizable error code.
- Error cases: missing Start, missing End, equal dates, Start after End, incomplete time pair, and times supplied while disabled.
- Clearing removes the complete range and produces Empty.

## Time-support configuration

- Time support belongs to one Date Range Property Definition and is shared by all Tasks using that definition; it is not a global switch for all Date Range definitions.
- Enabling time preserves existing dates and leaves both times Empty.
- Disabling time always previews the number of values containing a complete time pair. Confirmation atomically removes both times while preserving dates; cancellation changes nothing.
- Dates and times are timezone-free. No conversion to UTC instants occurs without a future timezone business rule.

## Schema operations and duplication

- Date Range is a confirmed exception to the general duplication baseline: duplication always copies complete configuration and all current Task values; the user is not asked whether to copy values.
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); enabling it does not backfill existing Empty ranges.
- Empty stays Empty, values are snapshot copies, and the new definition is independent.
- Duplicate naming follows the shared `Name Copy`, `Name Copy 2`, and increasing-number sequence under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared); identity remains an immutable ID.
- Whole-property deletion always confirms, shows the exact non-empty Task count including zero, and deletes definition/values atomically.

## Query capabilities

Filtering, sorting, calendar/timeline views, duration calculation, and standalone search are outside the Date Range scope. Grouping uses the complete exact stored range, including configured start/end times, with Empty separate, under [DEC-104](../decisions.md#dec-104--default-enabled-query-operations-use-datatype-aware-semantics).

## Permissions

- Full access and Editor manage definition/configuration and values.
- User edits/clears values only.
- Viewer is read-only.

## Confirmed implementation contract

- Use a Date Range value constructor/module that prevents invalid persisted shapes.
- An absent value row may represent Empty.
- Add, set, clear, enable/disable time, duplicate, and delete are explicit, idempotent transactional commands with optimistic concurrency; every accepted change is recorded by both the audit log and domain log under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record).
- A stale Date Range value write is rejected under [DEC-100](../decisions.md#dec-100--stale-task-property-value-writes-are-rejected-with-the-draft-preserved): the committed range remains, a Toast is shown, and the complete unsaved draft is preserved without automatic merge.
- Deletion counts non-empty values; disable-time counts only values containing times.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property deletion counts and affects every retained Task whose value is non-empty, including archived and soft-deleted Tasks. No lifecycle, visibility, permission-derived list, or current-view filter applies under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Simple Date, same-day ranges, filters, sorting, calendar/timeline views, duration calculation, reminders/notifications, recurrence, permissions specific to this datatype, public API design, and timezone semantics.

## Unresolved business behavior

- No Date Range-specific product question remains.
