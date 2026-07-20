# Text property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-text-property.md`
- Technical handoff: `../../sources/handoffs/ontos-text-property-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Text is a user-editable property whose definition belongs to one Task Collection schema and whose value is independent per Task. A value is either Empty or one multiline inline-rich-text document. It is not a second block canvas.

The inline document supports bold, italic, underline, strikethrough, inline code, foreground and background colors, hyperlinks, inline equations, Core Mentions, and Core Relations. Different spans may use different supported formatting. Paste keeps readable text and supported inline semantics while flattening unsupported block structure.

## Value and emptiness

- Cardinality: zero or one inline-rich-text document per Task.
- Initial value: Empty for existing and future Tasks when the definition is created.
- Whitespace and blank lines alone are Empty.
- A Mention, Relation, or inline equation alone is non-empty, per the technical handoff's recorded implementation default.
- If a Mention or Relation target is deleted or cannot be resolved, retain its stable identity and last label but render the label as plain non-clickable text under [DEC-092](../decisions.md#dec-092--unresolved-core-references-degrade-to-searchable-plain-text). Mere permission denial leaves a resolvable target clickable and is handled before open under DEC-099.
- Editing or clearing one Task's value does not affect another Task or remove the definition.
- No Text-specific business length limit is defined.

## Configuration and schema operations

- The definition name is trimmed, non-empty, and case-insensitively unique within the schema under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared); rename does not change values, formatting, or Core references.
- Type conversion is outside the product scope.
- Multiple independent Text definitions may coexist in one Task Collection.
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); enabling it does not backfill existing Empty values.
- Duplication asks for confirmation, then creates an independent Text definition with the next available shared `Copy` name and the same Mandatory setting. It presents no copy-values choice and copies no per-Task values; every existing Task is Empty for the duplicate under [DEC-083](../decisions.md#dec-083--text-duplication-copies-definition-configuration-only).
- Removal deletes the definition and all its values from the collection schema after the cross-cutting confirmation flow.

## Query capabilities

- Search operates on readable text independently of visual formatting.
- Filters: contains, does not contain, equals, does not equal, starts with, ends with, is empty, is not empty.
- Text comparison is case-insensitive, diacritic-sensitive, and uses the Task Collection locale under [DEC-082](../decisions.md#dec-082--text-like-queries-share-comparison-and-empty-rules). Empty matches negative filters.
- Resolved Mention and Relation labels and their plain-text fallbacks contribute to search/filter as ordinary readable text.
- Sort: ascending and descending using the same Task Collection locale collation; formatting does not affect order; Empty is last in both directions.
- Group by readable value using the same case-insensitive, diacritic-sensitive Task Collection locale equality; formatting does not affect membership and Empty is separate under [DEC-104](../decisions.md#dec-104--default-enabled-query-operations-use-datatype-aware-semantics).

## Permissions

- Full access and Editor may mutate the Text definition and its schema presence.
- Full access, Editor, and User may edit a Task's Text value.
- Viewer is read-only.
- Full access alone includes sharing.

## Core dependencies

- Any Business Entity exposed by any registered microvertical in any tenant is eligible for a Mention or Relation under [DEC-099](../decisions.md#dec-099--core-references-span-microverticals-and-authorize-when-opened) and the durable [Core Reference contract](../../contracts/core-reference.md).
- Picker discovery is federated but controlled by each owning microvertical. Known opaque Core references/deep links may be pasted even when not discoverable; raw guessed IDs are insufficient.
- Active references remain clickable regardless of permission. The owning microvertical authorizes immediately before opening; deleted/unresolvable fallback rendering and search follow DEC-092.

## Versioning and consistency requirements

- Every accepted schema and value mutation records the change in both the audit log and the domain log under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record). Internal revisions may additionally protect concurrency.
- A stale Text value write is rejected under [DEC-100](../decisions.md#dec-100--stale-task-property-value-writes-are-rejected-with-the-draft-preserved): the committed value remains, a Toast is shown, and the unsaved draft is preserved without automatic merge.
- Duplication and confirmed deletion are atomic across the schema and affected Task values.
- A deletion preview is tied to the current schema revision; stale confirmation is rejected or refreshed.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property deletion counts and affects every retained Task whose value is non-empty, including archived and soft-deleted Tasks. No lifecycle, visibility, permission-derived list, or current-view filter applies under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Block elements, attachments and embeds inside Text, custom Mention/Relation behavior, the Task canvas, type conversion, inline comments, user-facing history/restore/rollback, AI generation, automations/formulas, a specific editor library, and a storage encoding.

## Unresolved business behavior

- No Text-specific Core Reference dependency remains unresolved.
