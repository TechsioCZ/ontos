# Date property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-date-property.md`
- Technical handoff: `../../sources/handoffs/ontos-task-ticketing-text-handoff.md` (combined Date/Text review)
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Date is a user-editable property containing Empty or exactly one valid calendar date. It never contains a time, timezone, end date, recurrence, reminder, or special due-date behavior.

## Value and interaction

- Existing and new Tasks start Empty when the schema contains a Date definition.
- Past, current, and future valid calendar dates are accepted.
- Picker: editable input, month/year label, Today action, previous/next navigation, weekday labels, calendar grid, and selected-date indication.
- Empty opens the current month without saving Today; a value opens its month; navigation alone never mutates.
- Selecting a visible adjacent-month day stores that actual date.
- Manual entry accepts only an existing calendar date. Invalid input retains the previous value.
- Clearing one Task value makes it Empty without confirmation and does not affect the schema or other Tasks.

## Locale and storage

- Parsing/display follow explicit product-locale mappings; the confirmed current mappings are `cs-CZ` and `en-GB`.
- Canonical API representation is ISO `YYYY-MM-DD`.
- Canonical database representation is PostgreSQL `DATE`, never a timestamp/instant or serialized JavaScript `Date`.
- `Today` means the current client-local calendar date; Date itself has no timezone component.
- Client and server validate calendar existence; permissive `Date.parse` is not accepted for localized input.

## Schema operations

- Duplication assigns the next available shared `Copy` name under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared) and asks whether to deep-copy every Task's current date. Empty remains Empty; declining produces Empty for all existing Tasks; definitions/values are independent.
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); enabling it does not backfill existing Empty values.
- Whole-property removal always confirms, shows the exact `Is not empty` Task count including zero, and deletes the definition and values atomically after confirmation.
- Optimistic concurrency prevents silent last-write-wins. A stale Date value write follows [DEC-100](../decisions.md#dec-100--stale-task-property-value-writes-are-rejected-with-the-draft-preserved): reject it, retain the committed date, show a Toast, and preserve the unsaved draft.

## Query capabilities

Filtering, sorting, calendar/timeline views, and standalone search are not part of the Date scope. Grouping uses the exact stored calendar date, with Empty separate, under [DEC-104](../decisions.md#dec-104--default-enabled-query-operations-use-datatype-aware-semantics).

## Permissions

- Full access and Editor may mutate the definition and values.
- User may set/change/clear values only.
- Viewer is read-only.

## Confirmed implementation contract

- Schema availability is derived without materializing Empty rows for every Task.
- Mutations, duplication, removal, and their audit-log/domain-log records are atomic and idempotent.
- The installed UI kit has no Calendar/DatePicker; later implementation must use a future kit component or a ticketing-owned accessible composite routed through the required UI-kit workflow.
- Every accepted persisted mutation is recorded through both the audit log and domain log under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record); Date does not add a separate reconstructable value-history store.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property deletion counts and affects every retained Task whose value is non-empty, including archived and soft-deleted Tasks. No lifecycle, visibility, permission-derived list, or current-view filter applies under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Date Range, time/timezones in the stored value, reminders, notifications, recurrence, automatic dates, due-date semantics, overdue styling, filters, sorting, calendar/timeline views, public API design, and presentation-only picker closing behavior.

## Unresolved business behavior

- No Date-specific business question remains.
