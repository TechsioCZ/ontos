# Multi-select property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-multi-select-property.md`
- Technical handoff: `../../sources/handoffs/ontos-multi-select-ticketing-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Multi-select is a user-editable property whose per-Task value is a set of zero, one, or more option identities from a definition-owned shared catalog. The same option may appear at most once in one Task value.

## Options and values

- A definition owns stable option identities with trimmed name, normalized name, one color, shared catalog order, version, and timestamps.
- Names are required, case-insensitively unique per definition, and may not contain a comma.
- Adding another option preserves existing selections; removing one preserves the others; removing the final selection produces Empty.
- Renaming, recoloring, or reordering an option affects its shared presentation without changing assignments.
- Selected values display in shared catalog order under [DEC-084](../decisions.md#dec-084--multi-select-values-display-in-catalog-order), not selection-time order.
- Inline creation automatically assigns one supported color, then atomically creates a shared option and selects it only for the current Task. Authorized schema editors may later change the color through `ColorSelect` under [DEC-085](../decisions.md#dec-085--multi-select-color-selection-uses-colorselect), [DEC-098](../decisions.md#dec-098--option-color-editing-uses-colorselect), and the [ColorSelect integration contract](../../contracts/option-color.md). Palette and automatic-selection algorithm remain outside business scope.

## Option deletion

- Deletion always previews the number of distinct Tasks currently selecting the option, including zero.
- Confirmed deletion removes the option and all its selection rows atomically, preserving other selected options.
- A Task becomes Empty only when no selections remain; no replacement is required.
- Cancellation makes no change.

## Schema operations and duplication

- Whole-property deletion always previews the distinct count of Tasks with at least one selected option and removes definition, catalog, values, and selections atomically after confirmation.
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); enabling it does not backfill existing zero-selection values.
- Duplication creates new property and option identities plus an old-to-new mapping.
- Copying values remaps every Task's selection set; declining creates Empty values for all existing Tasks.
- The duplicate is independent, receives the next available shared `Copy` name under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared), and copies each option's current color to its new option identity.

## Query capabilities

- `Contains <option>` matches Tasks selecting that option; Empty does not match.
- `Does not contain <option>` matches Tasks without that option, including Empty.
- `Is empty` means zero selections; `Is not empty` means one or more selections.
- Option-specific filters accept exactly one option from the filtered definition's catalog and cannot be applied without it.
- General AND/OR filter composition is outside this datatype specification.
- Task sorting and grouping remain explicitly out of scope. Standalone search matches a case-insensitive, diacritic-sensitive substring of any currently selected option name; Empty has no searchable text under [DEC-104](../decisions.md#dec-104--default-enabled-query-operations-use-datatype-aware-semantics).

## Permissions

- The baseline role matrix governs despite the product document's single generic actor.
- Full access and Editor may mutate catalog/configuration, duplicate/delete the definition, and create options inline.
- User may select/clear existing options only.
- Viewer is read-only and may use governed read/filter operations.

## Confirmed implementation contract

- Ticketing owns a deep module and relational tables; transports stay thin.
- A Task/property value uses a versioned envelope with zero or more selection rows; zero rows is Empty and retains revision/timestamp state.
- Database constraints enforce option ownership, schema agreement, normalized name uniqueness, and no duplicate Task/option selection.
- Optimistic versions protect stale value/configuration edits. A stale Multi-select value write follows [DEC-100](../decisions.md#dec-100--stale-task-property-value-writes-are-rejected-with-the-draft-preserved): reject it, preserve the committed set, show a Toast, and retain the unsaved draft set without merging.
- Create-option-and-select, deletion, and duplication are atomic and enter through governed CoreSDK action/data-access seams.
- Mutable configuration/value records have monotonic version and `updated_at`; every accepted change is recorded in both the audit log and domain log under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record). No separate product-facing history is included.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property and Multi-select Option deletion counts and effects include every retained Task, including archived and soft-deleted Tasks, without lifecycle, visibility, or current-view filtering. Option deletion removes that membership from every affected retained value under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

General filter composition, Task sorting/grouping, bulk value edits, automation, import/export, public API design, product-facing history, restore, and technical performance guarantees.

## Unresolved business behavior
