# Created by property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-created-by-property.md`
- Technical handoff: `../../sources/handoffs/ontos-created-by-property-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Created by is a read-only projection of the single stable Principal identity in intrinsic Task provenance. It identifies the actual Actor that created the Task, not the owner, assignee, last editor, administrator, template author, or source record author.

## Attribution rules

- Every valid Task is created with exactly one Actor derived only from trusted operation context; public payloads cannot override it.
- Human creation uses the authenticated Principal. Automation/import uses the actual named system Principal, or a human only when operating in that human's name.
- If no valid Actor can be established, creation fails; there is no unknown/admin/random fallback.
- Task duplication creates a new Task attributed to the duplicating Actor; it never copies the source Task's provenance.
- Copied content/templates do not transfer creator identity. Editing an existing Task never changes Created by.

## Identity lifecycle and presentation

- Stable Principal identity is the reference/filter key; presentation uses the Principal's current display name, not a creation-time name snapshot.
- Disabled/archived Principals remain referenced and may be marked inactive; physical identity deletion must not break provenance.
- Adding/re-adding/hiding/removing the property definition changes only projection availability, never provenance.

## Query capabilities

- Filter by exact human or system Principal identity.
- Standalone Task search matches a case-insensitive, diacritic-sensitive substring of the current Principal display name.
- Sort by current Principal display name using Task Collection locale collation, with stable Principal and Task identity tie-breakers.
- Group by stable Principal identity and show its current display name under [DEC-104](../decisions.md#dec-104--default-enabled-query-operations-use-datatype-aware-semantics).

## Schema operations and duplication

- Multiple independently configured Created by definitions may project the same provenance.
- Property-definition duplication assigns the next available shared `Copy` name under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared) and copies configuration without a copy-values prompt; every definition immediately projects the same Actor.
- Removal always confirms; every valid Task is non-empty, so impact equals affected Task count. Re-addition reveals original Actors.
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); its intrinsic non-empty provenance always satisfies the setting.

## Permissions and versioning

- Full access/Editor manage definition availability/name; every role with Task read access may view/filter; no role can edit/clear value.
- Task creation and definition changes are versioned in both the audit log and domain log under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record); there are no independent mutable creator-value versions.

## Confirmed implementation contract

- Persist non-null immutable `created_by_principal_id` with Task provenance and restrict Principal deletion.
- Converge manual, duplicate, import, automation, and future creation paths behind one idempotent Task-creation module that persists Task, provenance, initial version, and evidence transactionally.
- Core operation attribution follows the durable [Core Principal, Person Directory, and operation-attribution contract](../../contracts/core-principal-attribution.md): trusted context supplies the actual Actor, system paths use a named tenant-scoped System Principal only when it is the actual Actor, and creation fails without a valid Actor.
- Project/filter through provenance, not generic property-value rows.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property deletion counts every retained Task, including archived and soft-deleted Tasks, because Created by is intrinsically non-empty. No lifecycle, visibility, or current-view filter applies under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Owner, assignee, last editor, complete audit history, notifications, Task permissions, performance reporting, multiple authors, manual correction/override, and migration of historical Tasks lacking creator provenance.

## Unresolved business behavior

- No Created by-specific product question remains.
- No Core Principal or automated-attribution dependency remains unresolved.
