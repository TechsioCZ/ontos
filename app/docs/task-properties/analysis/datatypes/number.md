# Number property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-number-property.md`
- Technical handoff: `../../sources/handoffs/ontos-number-property-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Number is a user-editable property with one locale-independent numeric value per Task. Empty and numeric zero are distinct states. It accepts positive, negative, zero, integer, and decimal values and has three display-only formats: `Number`, `Number with separators`, and `Percent`.

## Value and validation

- Cardinality: zero or one number per Task.
- Initial value: Empty; `0` is non-empty.
- Supported persisted values: signed finite integers and decimals within the confirmed implementation bound.
- A minus sign may occur once before the numeric part; at most one decimal separator is accepted.
- Incomplete or invalid editor input is not persisted.
- Scientific notation, `NaN`, infinity, and a leading plus sign are rejected by the confirmed technical contract.
- Invalid paste is rejected as a whole and retains the previous valid editor value.
- The product edge-case statement “`5` is less than `0`” is a confirmed typo; the rule is `5 > 0`.

## Formats and locale

- New definitions default to `Number`.
- Formats are `Number`, `Number with separators`, and `Percent`.
- Format changes affect presentation for every Task but never rewrite stored values.
- Percent uses direct percentage semantics: stored/input `25` displays as `25 %`, not `2500 %` and not `0.25`.
- Decimal and grouping separators follow the active user locale; storage is locale-independent.

## Schema operations

- Schema managers may create, rename, reformat, duplicate, and remove the definition according to access rights.
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); enabling it does not backfill existing Empty values.
- Duplication always requires the copy-values choice, copies configuration, and either snapshots all existing values or leaves the duplicate Empty for all Tasks.
- The duplicate is independent and receives the next available shared `Copy` name under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared).
- Creation, duplication/value snapshot, schema ordering, revision, and audit emission are one transaction.
- Removal uses the cross-cutting count-bearing, version-protected confirmation flow.

## Query capabilities

- Filters: `=`, `≠`, `>`, `<`, `≥`, `≤`, `Is empty`, `Is not empty`.
- Numeric comparisons use the stored value, independent of display format.
- Empty values are excluded from all numeric comparisons, including `≠`; `Is empty` handles Empty explicitly.
- `Is not empty` includes `0`.
- Sort: true numeric ascending/descending; Empty last in both directions; deterministic Task tie-breaker.
- Search performs substring matching on canonical decimal text, independent of separators or Percent display; `1250` matches `25`.
- Group by numeric equality, so `1` and `1.0` share a group; Empty is separate under [DEC-104](../decisions.md#dec-104--default-enabled-query-operations-use-datatype-aware-semantics).
- Filter and sort are read operations available to any actor who can view the collection.

## Permissions

- Full access and Editor may mutate the definition and values.
- User may mutate values but not definition/configuration.
- Viewer may read, filter, and sort but not mutate.
- Full access alone includes sharing.

## Confirmed implementation contract

- Separate a shared `NumberPropertyDefinition` from per-Task `TaskNumberValue`.
- Empty may be represented by absence of a value row; `0` must be materialized as a real value.
- Store values as PostgreSQL `numeric(38,18)`, not floating point, and transport canonical decimal strings across API boundaries.
- The editor may hold transient incomplete states, but the server is authoritative for persistence validation.
- Execute comparisons against stored numeric values and use database ordering equivalent to `NULLS LAST`.
- A stale Number value write is rejected under [DEC-100](../decisions.md#dec-100--stale-task-property-value-writes-are-rejected-with-the-draft-preserved): the committed value remains, a Toast is shown, and the unsaved draft is preserved without automatic merge.
- Every accepted change is recorded by both the audit log and domain log under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record). Audit timestamps are server-generated UTC and identify actor/action; no separate reconstructable Number history is maintained.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property deletion counts and affects every retained Task whose value is non-empty, including archived and soft-deleted Tasks. No lifecycle, visibility, permission-derived list, or current-view filter applies under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Currency, custom units, formulas, automatic calculations, cross-Task aggregation, progress visualization, configurable min/max, format-driven value conversion, multiple values per Task, and undo/restore.

## Unresolved business behavior
