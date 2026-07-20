# Handoff: Task Ticketing — Person property to spec and tickets

## Next-session objective

Continue this work in the main Task Ticketing thread. Consolidate the existing Task Ticketing baseline and the completed Person-property description into a published specification, then—only after the specification flow is complete—turn it into approved tracer-bullet tickets.

Do not implement the feature during those synthesis steps.

## Authoritative source artifacts

Read both artifacts in full rather than relying on summaries here:

- General Task Ticketing baseline: `/tmp/ontos-task-ticketing-handoff.md`
- Person-property business description and Gherkin scenarios: `/Users/jiprochazka/.codex/attachments/19aa37f3-42d7-4351-80d7-e02920f5fb5f/pasted-text.txt`

Treat these two artifacts and the confirmed decisions below as authoritative. No specification, tickets, ADR, issue, or implementation was created in this session.

## Confirmed decisions from this session

- The Person-property document does not conflict with the general baseline and is considered business-ready.
- `Workspace` is the product term for the existing Core tenant; do not introduce a separate Workspace entity.
- Only active human members and guests of the current tenant are eligible for new assignment.
- If an assigned person later loses tenant membership, preserve the historical assignment and mark/resolve it as inactive or otherwise ineligible; do not allow that person to be newly assigned.
- The same preservation rule applies to disabled or archived Principals.
- Person lookup searches both visible display names and visible email/login identifiers. Core must enforce visibility.
- “Every change is versioned with a timestamp” means immutable audit/history only. User-facing undo, restore, and time travel are not required.
- A Person value change must not itself create a notification. Audit/domain events are still expected.
- There are no remaining product questions for the Person behavior.

## Current codebase reality

- Work only under `app/`; `mvp/` and `mvp2/` are read-only.
- The Ticketing vertical is currently a scaffold. Its public contract only models simple Ticketing items (`id`, `title`, build marker), and its example Create Ticket action does not persist a Task domain model.
- Ticketing currently has no Task Collection, shared Task Property schema, Task Property Value persistence, Ticketing-owned migrations, or completed authorization relationship model.
- Core Principals already have tenant ownership, human/non-human kind, display name, and active/disabled/archived status.
- Core does not currently represent the member-versus-guest classification needed by Person eligibility.
- CoreSDK already supplies action invocations, authorization checks, audit records, domain events, timestamps, tenant sequence numbers, and outbox support. Reuse these mechanisms rather than building a parallel cross-cutting runtime.
- The worktree was already dirty before this session. Inspect `git status` and preserve all existing user changes. In particular, do not revive or treat the staged-deleted older Task Properties note as authoritative.

## Recommended implementation shape to capture in the spec

### Module seams

- A generic Task Property module owns shared-schema behavior: create, rename, configuration changes, duplicate, deletion impact/confirmation, permissions, and timestamped versions.
- A Person-property adapter owns only Person-specific behavior: eligible identity validation, `1 Person` versus `No limit`, replacement, deduplication, Person filters, and inactive-reference presentation.
- A Core-owned Person Directory interface supplies tenant-scoped identity behavior. Ticketing must not query Better Auth tables directly.
- Keep the directory interface capable of at least two distinct operations:
  - Search eligible people: active human members and guests only, matching visible display name and visible email/login.
  - Resolve stored references: includes people who are now disabled, archived, or no longer tenant members.

### Persistence and invariants

- Store Principal references, not copied names or free text.
- Prefer normalized Person assignment records keyed by Task, Task Property, and Principal.
- Absence of assignments represents `Empty`; creating a property does not require materializing empty rows for every Task.
- Enforce uniqueness of `(task, property, principal)` and store no ordering because order has no business meaning.
- Cross-tenant Principal IDs must always be rejected, even if supplied directly rather than through the picker.
- A `1 Person` replacement is one atomic mutation and one audit/history version.
- Lock the property definition while mutating its values or cardinality so concurrent writes cannot violate the configured limit.
- The `No limit` to `1 Person` conflict count and configuration update must occur in one transaction; never delete or select people automatically.
- Duplicate-with-values should use a set-based copy and must preserve inactive historical Principal references.
- Use current-state version/updated-at metadata plus immutable Core domain/audit history. No restore interface is needed.
- Do not attach a notification outbox message to ordinary Person value mutations.

### Authorization

- Preserve the baseline distinction between shared-schema management and Task Property Value editing.
- Model separate permissions such as managing the Task schema versus editing Task values. Full access and Editor can manage schema; User can edit values only; Viewer is read-only. Sharing remains Full-access-only.
- Apply authorization at the Task Collection/shared-schema seam rather than separately duplicating checks for every Person operation.

### Bulk-operation default

- Use synchronous, atomic, set-based database operations initially for duplication, delete-impact counts, deletion, and limit validation.
- If a later non-functional requirement establishes very large Task Collections, revisit these operations as background jobs. No such scale requirement was supplied here.

## Suggested test seams

- Prefer the highest Ticketing action/HTTP interface as the primary acceptance-test seam for property creation, value editing, cardinality changes, filters, duplication, and deletion.
- Contract-test the Core Person Directory interface independently with active member, active guest, disabled/archived person, membership loss, cross-tenant identity, and visibility cases.
- Add persistence integration tests for uniqueness and concurrency-sensitive cardinality invariants.
- Express the supplied Gherkin behavior through externally observable tests; do not test internal table layout or helper functions directly.
- Verify that no-op attempts, such as adding the same person twice, do not create duplicate assignments. Unless the spec decides otherwise, no actual state change should mean no new state version.

## Suggested skills

1. `to-spec` — invoke first in the main thread. Synthesize the two authoritative artifacts and the confirmed decisions above; do not interview again about settled Person behavior. Use the highest Ticketing action/HTTP seam as the proposed primary test seam and perform the skill’s required seam check before publishing.
2. `to-tickets` — invoke only after the specification is published/approved. Produce small, demoable tracer-bullet vertical slices with explicit blocking edges; do not create horizontal database-only or UI-only tickets.
3. `setup-matt-pocock-skills` — invoke before `to-spec` only if the main thread still lacks a configured issue tracker and triage vocabulary.
4. `codebase-design` — use while shaping the Task Property, Person adapter, and Core Person Directory interfaces so their complexity stays behind small seams.

## Expected main-thread sequence

1. Read the two authoritative artifacts and this handoff.
2. Inspect current tracker configuration and run `setup-matt-pocock-skills` only if required.
3. Invoke `to-spec`; propose/check the highest test seam and publish the resulting specification with the required triage state.
4. After the specification is accepted, invoke `to-tickets` using that specification as the source and complete its user review before publishing tickets.
5. Do not begin implementation until the user separately requests it.
