# Handoff: Task ticketing — ID property ready for specification and tickets

## Purpose of the next main-thread session

Consolidate the task-ticketing baseline and the finalized `ID` property behavior into a tracker specification with `to-spec`, then—after the specification is accepted—derive tracer-bullet implementation tickets with `to-tickets`. Do not re-interview the user about decisions already recorded below.

## Authoritative source artifacts

Read these in full rather than relying on duplicated requirements in this handoff:

- General task-property baseline: `/tmp/ontos-task-ticketing-handoff.md`
- Final business specification for Property `ID`, including business rules, acceptance criteria, Gherkin scenarios, hypotheses, and out-of-scope behavior: `/Users/jiprochazka/.codex/attachments/21335367-d043-4192-a318-bf4db71bebfc/pasted-text.txt`
- Writable implementation workspace: `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/app`
- Workspace instructions: `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/AGENTS.md` and `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/app/AGENTS.md`

Repository constraint: work only in `app/`; `mvp/` and `mvp2/` are read-only.

## Product decisions resolved in this conversation

These decisions supplement and resolve cross-spec ambiguities in the source artifacts:

1. An `ID` property cannot be duplicated. Reject the duplication before presenting the generic “copy values?” choice.
2. Removing an `ID` property only hides it. Preserve its definition/configuration, prefix, task assignments, and collection sequence counter. Revealing/re-adding it restores the same IDs and continues the existing sequence; no number is released or reassigned.
3. One task collection owns exactly one task schema. Schemas are not shared across collections.

No further product question was identified for the `ID` behavior.

## Current implementation state

The ticketing vertical is still scaffold/PoC code, not a task domain implementation:

- `verticals/ticketing/api/index.ts` serves an in-memory placeholder list and synthesizes a slug-like identifier; it has no task persistence.
- `verticals/ticketing/src/actions/create-ticket.ts` validates a placeholder target, logs, and queues an outbox message, but inserts no task.
- `verticals/ticketing/shared/actions/create-ticket.ts` does not carry a collection ID or return a persisted task/ID.
- `packages/core-runtime/src/core-sdk.ts` already provides the useful high seam: an action handler, its domain event, outbox messages, invocation status, and success audit record execute in one database transaction.
- CoreSDK authorization currently accepts only a static resource object ID. Collection-scoped actions require the authorization resource to be derived from action input.
- The current Drizzle configuration and client register only core/auth persistence. Ticketing domain schema and migration ownership do not yet exist.
- The SpiceDB schema is a generic PoC (`resource_type` with read/create); it does not model task collections or the baseline access levels.

No workspace source file was changed during this review. The worktree was already dirty; preserve unrelated user changes, including the existing deletion of `app/docs/ticketing/task-properties.md` and generated diagnostics changes.

## Implementation decisions ready to carry into `to-spec`

- Make the task action/module interface the primary test and caller seam. ID allocation must be internal to task creation; do not expose a caller-facing `allocateId` operation.
- Keep ticketing domain persistence owned by the ticketing vertical rather than adding domain tables to the core infrastructure schema.
- Model at least collection/schema ownership, tasks, property definitions/configuration, an immutable ID-assignment ledger, and a collection-scoped sequence counter.
- Back ID invariants with database constraints: one visible/active ID property per collection, one ID assignment per task, and unique numeric assignment per collection.
- Store the numeric part as PostgreSQL `bigint`; serialize it as a decimal string at transport interfaces to avoid JavaScript precision loss.
- Persist a durable task creation ordinal. Initial backfill ordering is `(created_at, creation_ordinal)` so equal timestamps follow system-recorded order.
- Include retained soft-deleted tasks in initial backfill. Keep task rows and their ID assignments across deletion so restoration performs no allocation.
- Serialize property activation/backfill and task creation at the collection scope. Backfill, assignment, counter update, task mutation, version/history record, domain event, and outbox records must commit atomically.
- Prefer a transactional counter row (`increment ... returning`) over a PostgreSQL sequence so a rolled-back task creation does not consume a business ID.
- Render the displayed value from the stored prefix plus immutable number. Prefix changes version only the property configuration; they do not rewrite every assignment.
- Use database `timestamptz`/transaction time for the baseline timestamped version history. Each immutable ID assignment has its assignment/version timestamp; property configuration changes increment their own history/version.
- Extend the CoreSDK authorization interface so collection-scoped resource IDs can be derived from validated action input. Do not bypass the CoreSDK seam with direct SpiceDB calls in ticketing handlers.
- Treat hiding/revealing the ID property as state transitions on the preserved definition, not destructive delete/recreate operations.

## Testing seam and behaviors

For `to-spec`, propose the highest existing seam: invoke ticketing actions through CoreSDK against PostgreSQL, then assert returned/read task behavior and durable state. Confirm this seam with the user as required by `to-spec` before publishing.

Important behavioral coverage:

- deterministic initial backfill, including equal `Created time` values;
- first assignment and continuation after backfill;
- concurrent task creation without duplicate or missing IDs;
- rollback and idempotent retry behavior;
- read-only numeric values and task-copy behavior allocating a fresh ID;
- delete/restore retaining the original number;
- hide/reveal retaining definition, prefix, assignments, and counter;
- prefix normalization and computed display;
- prevention of second-ID creation and ID duplication;
- independent numbering in different collections;
- version timestamps and atomicity of domain state, event, outbox, and audit records;
- collection-scoped authorization for schema changes versus value/task operations.

The detailed expected values and Gherkin scenarios remain authoritative in the Property `ID` source artifact; do not restate all of them in this handoff.

## Downstream workflow notes

- The issue tracker and `ready-for-agent` triage vocabulary were not established in this conversation. When invoking `to-spec` or `to-tickets`, use the project’s configured tracker; if none is configured, follow those skills’ instruction to run `setup-matt-pocock-skills` first.
- `to-spec` should synthesize without reopening settled business questions, but it must still show the proposed test seam to the user before publication as required by that skill.
- Invoke `to-tickets` only after the specification exists and the user approves the ticket breakdown. Tickets should be narrow, demoable vertical slices with explicit blocking edges—not separate schema/API/UI horizontal tickets.
- Do not implement from this handoff alone. Implementation starts only after an actionable specification/ticket is selected and the user requests it.

## Suggested skills

1. `domain-modeling` — normalize the collection, schema, property definition, property configuration, property assignment/value, sequence, task, deletion, restoration, permission, and version vocabulary before publishing.
2. `codebase-design` — keep task creation/ID allocation behind one deep module interface and place collection-scoped authorization at the CoreSDK seam.
3. `to-spec` — synthesize the baseline, Property `ID` artifact, resolved decisions, implementation decisions, and testing seam into the tracker specification. Do not interview again about settled behavior.
4. `to-tickets` — after the spec is published and accepted, propose and obtain approval for tracer-bullet slices, then publish them with blocking edges.
5. `rstest-best-practices` — use when designing or implementing the integration/concurrency tests in this generated workspace.
6. `implement` — use only when the user selects an approved ticket for implementation.
