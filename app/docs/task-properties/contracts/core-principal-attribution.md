# Core Principal, Person Directory, and operation-attribution contract

## Purpose

This contract supplies the shared Core identity behavior required by Person, Created by, and Last edited by. It consolidates already-authoritative Task Property decisions; it does not add a new role, assignment target, attribution rule, or product capability.

## Principal identity and lifecycle

- A Principal is a stable tenant-scoped identity for a human or named system actor. Authentication bindings and sessions are replaceable access infrastructure, not Task Property identity.
- Principal identity, not display name, is stored in Person values and Task provenance/last-edit facts. Presentation resolves the current display name.
- Principal state distinguishes at least active, disabled, and archived. Disabled, archived, or departed human Principals may no longer receive new Person assignments but remain resolvable for historical values and attribution.
- Physical Principal deletion must not break a retained Person reference, Created by fact, Last edited by fact, audit record, or domain record. Core retains or otherwise durably resolves the stable Principal identity while any such reference exists.
- A Principal belongs to one tenant. Submitting a Principal identity from another tenant to a Person value is rejected.

## Person Directory

- Core owns Person Directory search and stored-reference resolution as separate operations.
- Eligible search returns active human members and guests of the current tenant only. Groups, non-human Principals, account-less external contacts, cross-tenant identities, disabled/archived Principals, and people who no longer belong to the tenant are ineligible for new assignment.
- Search matches only visible display-name, email, and login fields and enforces the acting user's field visibility.
- Stored-reference resolution accepts a stable Principal identity already retained by a Person value and resolves current display/inactive state even when that Principal is no longer eligible for new assignment.
- Search eligibility never deletes or rewrites an existing Person value. A later eligibility loss changes presentation/selection eligibility only.

## Actor and trusted operation context

- Actor is the human or named system Principal actually responsible for an operation.
- Core derives Actor from trusted operation context. Public Task or Task Property payloads cannot choose or override Actor, Originating Principal, or System Principal identity.
- Manual Task creation uses the authenticated human Principal as Actor.
- Import, automation, duplication, template, and other creation paths use the Principal actually responsible for creating the new Task. A human is used only when the operation is genuinely executed in that human's name.
- If a creation path cannot establish a valid Actor, Task creation fails. An administrator, arbitrary user, anonymous identity, or generic System Principal is not substituted merely to avoid failure.

## Originating Principal and Effective Editor

- Originating Principal is the human Principal whose action initiated a user-driven automation chain. Core propagates it across every known downstream hop without accepting a caller-supplied override.
- Effective Editor is the Originating Principal for a user-initiated automatic Task mutation; otherwise it is the Actor that directly performs the successful mutation.
- Created by always records the actual creating Actor. It never substitutes Originating Principal and never copies the source Task's creator during Task duplication.
- Last edited by records the Effective Editor for the latest successful relevant Task mutation. A scheduled or independent automatic mutation with no human origin uses its actual stable tenant-scoped System Principal.
- A no-op, rejected, failed, cancelled, or rolled-back mutation changes neither attribution fact.

## System Principal

- Each governed independent automation identity is a stable named system Principal in the tenant where it operates.
- A System Principal is used only when it is the actual Actor for the independent operation. It is not a fallback for a missing authenticated human Actor.
- System attribution remains resolvable by stable identity and current display name under the same retention guarantees as human attribution.

## Mutation and evidence guarantees

- Task creation commits the Task, Created by Actor, initial Last edited by attribution, Task revision, and required audit/domain evidence atomically.
- A relevant successful Task mutation commits its value/state change, Last edited time, Last edited by Effective Editor, Task revision, and required evidence atomically.
- Archive and restore use the same Effective Editor for Last edited by and the same committed instant for Last edited time.
- Schema-only operations do not update Task-level Last edited by.

## Acceptance guarantees

- A disabled former assignee remains displayable but cannot be newly assigned.
- A Task created by automation records that automation's named system Principal unless the automation genuinely acts in a human's name.
- Task duplication records the duplicating Actor, not the source Task's creator.
- A user-triggered multi-hop automation attributes its Task mutation to the initiating human Originating Principal.
- A scheduled mutation without human origin attributes to the named System Principal that performed it.
- A forged public `actorId`, `originatingPrincipalId`, or equivalent field cannot alter attribution.
- Failure to establish an Actor prevents creation rather than producing unknown or fabricated provenance.

## Sources and architecture evidence

- [DEC-035 through DEC-038](../analysis/decisions.md#dec-035--person-eligibility-is-tenant-scoped-human-membership).
- [DEC-062 through DEC-064](../analysis/decisions.md#dec-062--created-by-is-intrinsic-immutable-task-provenance).
- [DEC-070 through DEC-072](../analysis/decisions.md#dec-070--last-edited-by-tracks-successful-titlepropertycanvas-saves).
- [DEC-088](../analysis/decisions.md#dec-088--archive-and-restore-update-both-last-edit-facts).
- `../sources/product-owner/ontos-person-property.md` and `../sources/handoffs/ontos-task-ticketing-person-handoff.md`.
- `../sources/product-owner/ontos-created-by-property.md` and `../sources/handoffs/ontos-created-by-property-handoff.md`.
- `../sources/product-owner/ontos-last-edited-by-property.md` and `../sources/handoffs/ontos-task-ticketing-last-edited-by-handoff.md`.
- Existing Core identity and retention shape: `packages/core-runtime/src/db/schema.ts` (`principals`, restricted Principal references), `packages/core-runtime/src/operation-context.ts`, `packages/core-runtime/src/operation-context-from-session.ts`, and `packages/core-runtime/src/outbox-worker.ts` (`originalPrincipalId`).
