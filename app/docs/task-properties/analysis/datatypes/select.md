# Select property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-select-property.md`
- Technical handoff: `../../sources/handoffs/ontos-select-property-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Select is a user-editable property with either Empty or exactly one selected option per Task. The definition owns a shared, ordered set of independently identified Select Options; each Task value references an option identity, never its name.

## Options and values

- New Select definitions start Empty for every Task, with no options and `Manual` option ordering.
- An option has stable identity, trimmed non-empty name, one color, and persisted manual position.
- Option names are unique per definition after deterministic Unicode normalization, case-insensitively but accent-sensitively.
- Renaming or recoloring updates every Task that references the option without changing its selection.
- Selecting another option replaces the current value; clearing returns the Task value to Empty.
- Inline creation adds the option to shared configuration and selects it for the current Task atomically. Authorized schema editors choose or change its color through `ColorSelect` under [DEC-098](../decisions.md#dec-098--option-color-editing-uses-colorselect) and the [ColorSelect integration contract](../../contracts/option-color.md); palette and color initialization are not additional Task Property business rules.

## Option ordering

- Modes: `Manual`, `Alphabetical`, and `Reverse alphabetical`.
- Manual mode persists positions; new options append.
- Automatic modes derive deterministic order from normalized names using each viewer's configured user locale, with stable option identity as the tie-breaker, under [DEC-096](../decisions.md#dec-096--select-automatic-option-ordering-uses-the-viewers-user-locale). Different viewers may see different automatic orders.
- Reverse alphabetical reverses the viewer-locale-derived alphabetical order.
- Switching from an automatic mode to Manual snapshots the order currently displayed to the acting user and persists it as the shared manual order.

## Option deletion

- Deletion always shows the current number of Tasks selecting the option, including zero.
- Confirmation uses a revision/token and recounts in the transaction; changed impact requires reconfirmation.
- Confirmed deletion removes the option and makes affected Task values Empty; no replacement is required.
- Cancellation changes nothing.

## Schema operations and duplication

- Duplication creates a new definition with new option IDs, copied names/colors/manual positions/ordering mode, and a transactional old-to-new option mapping.
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); enabling it does not backfill existing Empty values.
- The user must choose whether values are copied; copied values reference mapped duplicate options, while Empty stays Empty.
- The duplicate is independent, placed immediately after the source, and receives the next available shared name (`Name Copy`, `Name Copy 2`, and so on) under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared).
- Whole-property deletion uses the cross-cutting count-bearing, version-protected confirmation and removes the definition, its options, and all values atomically.

## Query capabilities

- Filters: `is <option>`, `is not <option>`, `is empty`, `is not empty`.
- `is not <option>` includes Empty because Empty is not the named option under [DEC-097](../decisions.md#dec-097--empty-select-values-match-is-not-option). `is not empty` still includes only Tasks with a selected option.
- The product goal mentions Task filtering, ordering, and grouping, but acceptance behavior defines only filters and option-list ordering.
- Task-row sorting, grouping, and search remain explicitly excluded from the accepted initial scope; this is a datatype exception to [DEC-080](../decisions.md#dec-080--query-and-grouping-capabilities-are-available-by-default).

## Permissions

- Full access and Editor may create/manage options and mutate the property definition, including inline option creation.
- User may select or clear existing options but may not create or configure options.
- Viewer is read-only but may use read operations such as filtering.

## Confirmed implementation contract

- Ticketing owns the tables/migrations and exposes a deep domain module; Core supplies shared runtime capabilities.
- Empty may be represented by absence of a value row.
- Database constraints enforce one value per Task/definition, option ownership, normalized uniqueness, and referential integrity.
- Create-option-and-select, option deletion, property duplication, and property deletion are idempotent where required and transactionally atomic.
- Mutable records carry optimistic versions and server UTC timestamps; every accepted change is recorded in both the audit log and domain log under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record).
- A stale Select value write is rejected under [DEC-100](../decisions.md#dec-100--stale-task-property-value-writes-are-rejected-with-the-draft-preserved): the committed option remains, a Toast is shown, and the unsaved draft selection is preserved without automatic merge.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property and Select Option deletion counts and effects include every retained Task, including archived and soft-deleted Tasks, without lifecycle, visibility, or current-view filtering. Option deletion clears every affected retained value under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Multi-select, Status, type conversion, default selected value, automation, restorable history, recovery, Task-row sorting, Task grouping, search, and technical performance promises.

## Unresolved business behavior

- No Select-specific palette question remains; the shared `ColorSelect` component decision is authoritative.
