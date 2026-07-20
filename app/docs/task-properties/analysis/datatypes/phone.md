# Phone property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-phone-property.md`
- Technical handoff: `../../sources/handoffs/ontos-phone-property-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Phone is a user-editable property containing Empty or one arbitrary textual phone-related value. It deliberately performs no phone-format, existence, reachability, country-code, or normalization validation.

## Value and emptiness

- Type/paste accept arbitrary non-empty text, including numbers, formatting, extensions, and words.
- Unicode-whitespace-only input becomes Empty. If any non-whitespace character exists, preserve the entire original string exactly, including leading/trailing whitespace.
- A non-empty value is limited to 256 Unicode code points and must be single-line. Reject carriage returns, line feeds, Unicode line/paragraph separators, tabs, NUL, and other control characters under [DEC-090](../decisions.md#dec-090--phone-is-bounded-single-line-exact-text).
- Reject an over-limit or prohibited-character input/paste as a whole without truncation or character stripping; retain the previous persisted value while the invalid draft is corrected.
- Editing fully replaces the current value; clearing returns to Empty.
- Stored/displayed/copied text is not normalized, reformatted, corrected, or decomposed.

## Copy and call activation

- Any reader, including Viewer, may copy the exact stored/displayed value.
- Activation makes a safe standards-compliant encoded `tel:` handoff to the device/environment; transport encoding may differ solely for URI safety while stored/displayed/copied content remains exact.
- Ticketing does not place or record a call. Unsupported/failed call capability causes no Task/save error or mutation and leaves copy available.
- Empty offers neither copy nor call.

## Query capabilities

Filtering, sorting, grouping, and standalone Task search are explicitly outside Phone scope.

## Schema operations

- Rename preserves values and datatype.
- Duplication assigns the next available shared `Copy` name under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared) and asks whether to copy all Task values; Empty mapping and independence follow the baseline.
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); enabling it does not backfill existing Empty values.
- Whole-property deletion always confirms with the non-empty count across every retained Task, including archived and soft-deleted Tasks, even when that count is zero; confirmation recounts and requires renewed confirmation when the count changes.

## Permissions and sensitive logging

- Full access/Editor manage schema and values; User edits values; Viewer may read/copy/activate only.
- Every accepted Phone change is versioned by both the audit log and domain log under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record), without retaining historical Phone values in a separate store. Record privacy-safe actor, identifiers, operation, timestamp, and outcome data, but never raw Phone content in general logs, traces, analytics, outbox messages, or generic audit evidence.

## Confirmed implementation contract

- Sparse persistence: no row represents Empty; do not store an empty string.
- Duplicate/remove are atomic; change-log timestamps are server-generated UTC.
- Phone specialization stays thin behind generic property lifecycle and authorization seams.
- A stale Phone value write is rejected under [DEC-100](../decisions.md#dec-100--stale-task-property-value-writes-are-rejected-with-the-draft-preserved): the committed value remains, a Toast is shown, and the exact unsaved draft is preserved without automatic merge.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property deletion counts and affects every retained Task whose value is non-empty, including archived and soft-deleted Tasks. No lifecycle, visibility, permission-derived list, or current-view filter applies under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Phone validity/reachability, formatting/normalization, country codes, structured number parts, multiple numbers, SMS/messages, call history, contacts, automatic calling, query behavior, OS-specific call behavior, and datatype-specific permissions.

## Unresolved business behavior

- Migration layout remains an implementation concern. Log retention/access follows the shared audit-log and domain-log policies.
