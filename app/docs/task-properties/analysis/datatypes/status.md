# Status property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-status-property.md`
- Technical handoff: `../../sources/handoffs/ontos-status-property-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Status is a distinct user-editable datatype displayed like a Select. Each Task has Empty or one Status Option. Every Status definition has exactly three fixed groups and exactly one Default option.

## Fixed groups and initial configuration

- Fixed stable groups: `To-do`, `In progress`, and `Complete`; labels are localized at display time.
- Groups cannot be added, renamed, or removed. Ordering is local to each group, and a group may be empty.
- The definition must contain at least one option overall because exactly one Default is mandatory.
- New definition options: `Not started` in To-do, `In progress` in In progress, and `Done` in Complete; `Not started` is Default. Each Option has a color.

## Options, Default, and values

- Options have stable identity, trimmed Unicode-normalized case-insensitively unique name, one color, group, and group-local order.
- Authorized schema editors choose or change Option colors through `ColorSelect` under [DEC-098](../decisions.md#dec-098--option-color-editing-uses-colorselect) and the [ColorSelect integration contract](../../contracts/option-color.md). No palette or automatic-assignment rule is added to Status business behavior. Options may also be renamed, reordered within a group, moved between groups, removed, or made Default.
- Existing Tasks receive Empty when the Status definition is added.
- A newly created Task receives the then-current Default of each Status definition in its schema.
- Changing Default never rewrites existing selected or Empty values.
- Users may clear a value to Empty; Empty does not spontaneously become Default.

## Option deletion

- A used option requires a confirmation showing the exact affected-Task count.
- Confirmed deletion replaces every affected selection with the current Default; other selections and Empty values remain unchanged.
- The current Default cannot be removed until another existing option becomes Default.
- Preview/confirmation is protected by an impact revision/token and the replacement is atomic.

## Schema operations and duplication

- Duplication creates a new definition and fresh option identities with copied groups, colors, configuration, Default mapping, and Select-like presentation.
- The duplicate receives the next available shared `Copy` name under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared).
- The user always chooses whether to remap all existing values; Empty remains Empty and declining leaves every existing Task Empty in the duplicate.
- Each duplicate is independent; new Tasks receive each Status definition's own Default.
- Whole-property deletion uses the baseline's unconditional, count-bearing confirmation and removes the definition across the schema.
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); existing Empty values remain until the affected Task form is next submitted.

## Query capabilities

Filtering, Task sorting, aggregation, boards, and external integrations are explicitly out of scope. Standalone search matches a case-insensitive, diacritic-sensitive substring of the current selected option name; Empty has no searchable text. Grouping uses stable Status Option identity, with Empty separate, under [DEC-104](../decisions.md#dec-104--default-enabled-query-operations-use-datatype-aware-semantics).

## Permissions

- Full access and Editor may manage the definition/options and edit values.
- User may set, replace, or clear a Task value but not change configuration.
- Viewer is read-only.

## Confirmed implementation contract

- Values reference stable option IDs; fixed groups use stable internal keys.
- Empty may be represented by absence of a value row.
- Relational constraints enforce one value per Task/definition, same-schema membership, option ownership, and a valid mandatory Default reference.
- Creation, Task default assignment, option/default changes, option deletion/replacement, duplication, and deletion are transactional domain commands.
- A stale Status value write is rejected under [DEC-100](../decisions.md#dec-100--stale-task-property-value-writes-are-rejected-with-the-draft-preserved): the committed status remains, a Toast is shown, and the unsaved draft is preserved without automatic merge.
- Every accepted Status change, including bulk value replacement, is recorded through both the audit log and domain log under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record). Status does not add a separate historical-value store.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property and Status Option deletion counts and effects include every retained Task, including archived and soft-deleted Tasks, without lifecycle, visibility, or current-view filtering. Option deletion replaces every affected retained selection with the current Default under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Transition restrictions, automatic transitions, notifications, datatype-specific role definitions, filters, sorting, aggregation, boards, external integrations, event sourcing, rollback, and snapshots.

## Unresolved business behavior

- No Status-specific questions remain.
