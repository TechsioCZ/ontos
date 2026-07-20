# Checkbox property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-checkbox-property.md`
- Technical handoff: `../../sources/handoffs/ontos-checkbox-property-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Checkbox is a general user-editable binary property with exactly one value, `true` or `false`, for every Task where the definition exists. It has no Empty/null/third state and no automatic relationship to Task completion, Status, Title, or another property.

## Value and default

- Creating a Checkbox definition makes every existing Task resolve to `false` immediately; new Tasks also resolve to `false`.
- Users may toggle repeatedly and independently per Task/property.
- Checkbox has no option list, custom labels/colors, or multi-value configuration.
- At an API boundary the value is boolean; `null` is invalid and an omitted partial-update field means unchanged.
- Persistence may materialize rows or use an implicit schema default, but no observable transient Empty state is permitted.

## Query capabilities

- Exhaustive filters: `is checked` (`true`) and `is unchecked` (`false`). Defaulted false values must be included.
- Sorting and grouping are explicitly out of scope. Standalone search is not defined.

## Schema operations and duplication

- Generic lifecycle rules from the baseline apply even though the Checkbox product document treats them as outside its datatype scope.
- Duplication always asks whether to copy values.
- The duplicate receives the next available shared `Copy` name under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared).
- With copying, each Task's current boolean is copied; without copying, every Task resolves to `false` rather than Empty.
- Whole-property deletion always confirms. Because both booleans are non-empty, `Is not empty` equals the total Task count in the schema/collection, including Tasks with `false`.
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); both `true` and `false` satisfy it, so no Checkbox value is backfilled or blocked.

## Permissions

- Full access and Editor manage schema and values.
- User may toggle values only.
- Viewer is read-only.

## Versioning

Every accepted Checkbox definition/value change is versioned by both the audit log and domain log under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record). Checkbox has no separate historical-value store. A stale Checkbox value write follows [DEC-100](../decisions.md#dec-100--stale-task-property-value-writes-are-rejected-with-the-draft-preserved): reject it, keep the committed boolean, show a Toast, and preserve the unsaved draft toggle.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property deletion counts and affects every retained Task, including archived and soft-deleted Tasks, because both boolean values are non-empty. No lifecycle, visibility, or current-view filter applies under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Automatic completion/Status behavior, automation, bulk edits, sorting/grouping, formulas/derived values, datatype-specific permissions, public API/integrations, control visuals, and standalone search.

## Unresolved business behavior

- No Checkbox-specific product question remains.
