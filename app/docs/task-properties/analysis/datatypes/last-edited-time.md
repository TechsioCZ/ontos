# Last edited time property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-last-edited-time-property.md`
- Technical handoff: `../../sources/handoffs/ontos-last-edited-time-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Last edited time is a read-only projection of Task-level `lastEditedAt`: the instant of the latest successfully persisted, actual mutation to that Task's own state. It is initialized to the creation instant and maintained whether or not a definition is exposed.

## What updates the fact

- Successful actual changes to Title, canvas, editable property values (including clear), archive/restore, and user/automation/system Task-state mutations.
- Archive/restore updates Last edited by to the same operation's Effective Editor in the same transaction under [DEC-088](../decisions.md#dec-088--archive-and-restore-update-both-last-edit-facts).
- Update occurs atomically only after persistence succeeds.
- Canonical no-op writes, failed/rolled-back edits, cancelled drafts, and idempotent replays do not update it.

## What does not update the fact

- Open/read/close without changes.
- Comments and reactions.
- List filters, sorting, grouping, views, or view configuration.
- Shared schema operations: add/remove/rename/configure/duplicate any property definition, including schema-wide copy/delete operations.
- Locale/time-zone changes and derived-property definition lifecycle.

## Value source, display, and query

- No user or access level can set/clear the value; forged writes are rejected server-side.
- Existing Tasks expose their historical fact; if never edited it equals Created time.
- Multiple definitions project the same instant.
- API carries an unformatted canonical instant with sufficient precision; presentation uses the viewer's configured IANA zone/locale and DST rules.
- Sort/filter use the canonical instant, never localized text. Filters are exact instant, before, after, on or before, on or after, exact local calendar day, and custom local date range under [DEC-089](../decisions.md#dec-089--system-time-properties-share-one-filter-contract). Exact seconds include hidden milliseconds; local day/range boundaries use the viewer's configured IANA time zone.
- Search parses viewer-locale date/time input in the configured zone. Date-only input matches the whole local day; date-time input matches the supplied precision.
- Grouping uses the viewer's local calendar day, so changing the configured zone may change group membership, under [DEC-104](../decisions.md#dec-104--default-enabled-query-operations-use-datatype-aware-semantics).

## Schema operations and duplication

- A duplicate receives the next available shared `Copy` name under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared), exposes the same live system fact without a copy-values choice or snapshot, and remains independently renameable/removable.
- Removing/re-adding does not reset the fact.
- Baseline deletion confirmation applies; because every Task has the fact, non-empty impact equals affected Task count.
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); its intrinsic non-empty fact always satisfies the setting.

## Permissions and versioning

- Full access/Editor manage definitions; all Task readers may view/query; no role edits value.
- Task revision sequencing remains separate from display precision. Every accepted relevant Task change and definition change is versioned by both the audit log and domain log under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record).

## Confirmed implementation contract

- Persist `lastEditedAt` on Task and update within the same transaction as actual state mutation.
- Keep comments/reactions/views/schema commands outside the Task-state mutation path.
- Use a controllable clock and deterministic sequencing for rapid/equal instants.
- Resolve the tenant-scoped Core Principal's persisted IANA zone through [DEC-095](../decisions.md#dec-095--core-principal-preferences-owns-the-configured-iana-time-zone) and the [Core Principal time-zone preference contract](../../contracts/core-principal-time-zone-preference.md). Browser detection is initialization/fallback only; the final fallback is `UTC`.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property deletion counts every retained Task, including archived and soft-deleted Tasks, because Last edited time is intrinsically non-empty. No lifecycle, visibility, or current-view filter applies under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Last edited by, edit history, audit-log UI, version compare/restore, comments/reactions as edits, notifications, custom per-property formats, and Created time behavior.

## Unresolved business behavior

- No datatype-specific blocker remains.
