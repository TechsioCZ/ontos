# Created time property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-created-time-property.md`
- Technical handoff: `../../sources/handoffs/ontos-created-time-property-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Created time is a read-only projection of the Task's intrinsic immutable creation instant. The Task and instant come into existence when the server durably creates and opens the blank Task canvas, before Title or content is entered.

## Value source and lifecycle

- Every created Task has exactly one non-empty creation instant independent of whether any Created time definition is exposed.
- Adding/re-adding a definition reveals the original fact for existing Tasks without backfill; removing a definition never deletes the fact.
- No user or forged generic command may enter, overwrite, paste, clear, or otherwise mutate it.
- Any Task edit/move/status change/property rename/hide/show leaves it unchanged.
- Server/database assigns Task ID and instant idempotently; retries return the same Task and instant.

## Display and query behavior

- Transport an absolute instant with millisecond precision.
- Display uses the current user's persisted IANA time zone and locale, honoring DST. Standard view shows minutes; detail exposes seconds.
- Sort by actual instant ascending/descending, with deterministic secondary key for equal instants; display precision and time zone do not alter order.
- Temporal filters: exact, before, after, on/before, on/after, exact local day, and custom local date range.
- An exact second covers that whole half-open second so hidden milliseconds match.
- Local day/range is converted from the user's IANA zone to a half-open absolute range; changing zone can change calendar-filter results but not exact-instant results.
- Search parses viewer-locale date/time input in that configured zone. Date-only input matches the whole local day; date-time input matches the supplied precision.
- Grouping uses the viewer's local calendar day, so changing the configured zone may change group membership, under [DEC-104](../decisions.md#dec-104--default-enabled-query-operations-use-datatype-aware-semantics).

## Schema operations and duplication

- Rename changes only the definition label.
- Created time is an explicit value-copy exception: no copy-values prompt. A duplicate receives the next available shared `Copy` name under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared), projects the same intrinsic fact, and is independently renameable/removable.
- Removal always confirms; every Task is non-empty, so impact equals the Task count. Re-adding projects original values.
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); its intrinsic non-empty fact always satisfies the setting.

## Permissions and versioning

- Full access/Editor manage the definition; all roles may view/query where Task access permits; no role can edit the value.
- Task creation and definition changes are versioned in both the audit log and domain log under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record). There are no independently mutable Created time values or separate value-history records.

## Confirmed implementation contract

- Store the instant on the Task, not as materialized Task Property Value rows.
- Query compilation targets the Task creation column directly.
- Resolve the tenant-scoped Core Principal's persisted IANA zone through [DEC-095](../decisions.md#dec-095--core-principal-preferences-owns-the-configured-iana-time-zone) and the [Core Principal time-zone preference contract](../../contracts/core-principal-time-zone-preference.md). Browser detection is initialization/fallback only; the final fallback is `UTC`.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property deletion counts every retained Task, including archived and soft-deleted Tasks, because Created time is intrinsically non-empty. No lifecycle, visibility, or current-view filter applies under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Other derived datatypes, individual edit history, manual correction/import/migration of creation time, abandoned-blank-Task cleanup, generic schema permissions, and audit infrastructure design.

## Unresolved business behavior

- No Created time-specific question remains.
- No Created time-specific or shared time-zone preference question remains unresolved.
