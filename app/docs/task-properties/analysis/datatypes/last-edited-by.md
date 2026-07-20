# Last edited by property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-last-edited-by-property.md`
- Technical handoff: `../../sources/handoffs/ontos-task-ticketing-last-edited-by-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Last edited by is a read-only projection of the single Task-level Principal identity attributed to the latest successfully persisted relevant Task edit. It is current metadata, not editor history or an audit log.

## Triggering edits

- Task creation initializes the value to the effective creator.
- Successful actual changes to Title, an editable Task property value, canvas content, archive, or restore update it once per committed save. Archive/restore uses the Effective Editor under [DEC-088](../decisions.md#dec-088--archive-and-restore-update-both-last-edit-facts).
- Successful-save order, not edit-start time, determines the winner under concurrency.
- A later successful reversal to an earlier business value is still a new edit and updates attribution.
- No-op identical-value saves are a confirmed implementation interpretation that do not update attribution.

## Non-triggering operations

- Open/view/leave without saved change; cancelled/failed edits.
- Comment create/edit/delete and personal view changes.
- Shared schema operations: add/rename/configure/duplicate/remove definitions, including operations that copy/delete values.

## Automation attribution

- A user-initiated automation and known multi-hop chain attributes mutations to the Originating Principal.
- A scheduled/independent automation without identifiable origin attributes to a stable tenant-scoped `System` Principal.
- A later independent System mutation can replace earlier human attribution.

## Identity lifecycle

- Retain stable Principal identity after disable, tenant removal, or access loss.
- Resolve display from the retained Principal rather than mutable free text as an implementation interpretation.
- Metadata exists independent of property definitions; remove/re-add preserves current value.

## Schema operations and duplication

- Multiple/duplicated definitions project the same live Task metadata and have independent display/configuration; a duplicate receives the next available shared `Copy` name under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared).
- Duplication has no copy-values prompt; removal always confirms. Every valid Task has a value, so impact equals affected Task count.
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); its intrinsic non-empty fact always satisfies the setting.

## Query capabilities

Filtering, sorting, grouping, and standalone search are explicitly out of scope.

## Permissions and versioning

- Full access/Editor manage definitions; Task readers view; no role edits/clears the value.
- Update the editor reference, Task revision, last-edited timestamp, audit log, and domain log in one transaction for relevant mutations under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record).

## Confirmed implementation contract

- Persist stable editor Principal on Task and serialize concurrent saves through the Task revision/row.
- Operation attribution follows the durable [Core Principal, Person Directory, and operation-attribution contract](../../contracts/core-principal-attribution.md): trusted context carries the Actor and any Originating Principal, propagates human origin across known automation hops, and uses the actual named System Principal for independent scheduled/system operations.
- Comments/views/schema operations bypass the Task-edit invariant.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property deletion counts every retained Task, including archived and soft-deleted Tasks, because Last edited by is intrinsically non-empty. No lifecycle, visibility, or current-view filter applies under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Complete editor history, last-edited date/time behavior, version comparison, audit UI, comment authorship, notifications, query operations, detailed UI, and generic Task edit permissions.

## Unresolved business behavior

No Last edited by-specific business behavior remains unresolved.
