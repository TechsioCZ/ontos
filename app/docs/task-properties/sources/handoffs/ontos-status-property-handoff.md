# Handoff: Status property back to the main ticketing task

## Purpose

Carry the completed Status-property business discussion back into the main task-ticketing thread. The intended next workflow is to consolidate all datatype handoffs and later invoke `to-spec`, then invoke `to-tickets` against the resulting specification. Neither skill was invoked in this thread.

## Source artifacts

- General task-ticketing baseline: `/tmp/ontos-task-ticketing-handoff.md`
- Final Status-property business specification, including acceptance criteria and Gherkin scenarios: `/Users/jiprochazka/.codex/attachments/96bec413-1ace-4cd6-b8d5-b39cff4f90f6/pasted-text.txt`
- Workspace instructions: `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/AGENTS.md` and `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/app/AGENTS.md`

Do not reproduce the source documents when consolidating them; treat the Status document as the authoritative datatype-specific addition to the baseline and reference it while synthesizing the future specification.

## Resolved business decisions

There are no open Status-property business questions.

1. The baseline statement that a new Task initially contains only `Title` describes the initial Task Collection schema. Once that shared schema contains one or more Status properties, every newly created Task receives the current `Default` option of each Status property. Existing Tasks remain `Empty` when a Status property is added.
2. Status-option names are trimmed, Unicode-normalized, and compared case-insensitively for uniqueness within one Status property.
3. Status-option ordering is scoped within each fixed group. A fixed group may contain no options. The property must still have at least one option overall because it must always have exactly one `Default`.
4. “Versioned with a timestamp” means recording append-only change history, not event sourcing, rollback support, snapshots, or formal numbered versions. Record timestamp, actor, and before/after state for property-configuration and Task-value changes. Value changes caused by a bulk operation remain individually visible in Task history and attributable to the same operation.
5. All other behavior in the final Status document stands as written, including the fixed groups `To-do`, `In progress`, and `Complete`; independent property duplication; `Empty` semantics; option deletion and default replacement; exact impact counts; and Status being displayed like a Select while remaining a distinct property datatype.

## Repository state observed

- Work only under `app/`; never edit `mvp/` or `mvp2/`.
- This thread made no workspace changes.
- The `app` worktree was already dirty when inspected: `app/AGENTS.md` was modified, `app/docs/ticketing/task-properties.md` was staged as deleted, and `app/verticals/ticketing/.mf/diagnostics/latest.json` was modified. Treat these as user-owned changes and do not restore or overwrite them.
- Ticketing is currently a scaffold rather than an implemented domain. Its create-ticket action validates input and emits CoreSDK metadata but does not persist a Task. The BFF also serves generated/mock ticketing data. There are no Task, Task Collection/schema, property-definition, Status-option, property-value, or history tables.
- CoreSDK already runs action handlers, automatic domain events, outbox messages, completion state, and audit records in one database transaction. That transaction is the natural mutation seam.
- CoreSDK authorization currently describes a static resource object ID. Real Task/Task Collection-scoped access will probably require the authorization interface to resolve the target resource from action input.

## Implementation recommendations for the future specification

These are codebase-design conclusions from the discussion, not additional business requirements:

- Use stable identities for Status properties and options. Task values reference immutable option IDs, never display names, so rename/recolor/reorder/move operations preserve values.
- Represent fixed groups with stable internal keys and localize their fixed labels at display time.
- Prefer absence of a Task-property-value row as the persistence representation of `Empty`. This avoids backfilling every existing Task when a Status property is added.
- Enforce one value per `(Task, Status property)` and ensure through relational constraints that the selected option belongs to that exact property and that Task/property membership is in the same shared schema.
- Store a mandatory default-option reference on Status configuration and prevent its target from being removed. Creating or duplicating a Status property creates its options and default atomically.
- Duplication must create new property and option identities. When values are copied, map each source option ID to its corresponding duplicate option ID; preserve `Empty` as `Empty`.
- Treat property creation, Task creation with defaults, default changes, option deletion/value replacement, property deletion, duplication, history, and domain-event persistence as transactional commands behind one deep ticketing domain module.
- Protect impact confirmations against concurrency. A preview should return the exact affected count and an impact revision/token; confirmation should reject stale state and request a refreshed preview rather than acting on a misleading count.
- Keep schema-configuration commands distinct from Task-value commands so the baseline Full access/Editor/User/Viewer permissions can be enforced at the appropriate resource.

## Testing seam for `to-spec`

The recommended highest practical seam is the ticketing action/BFF interface executing through the real ticketing domain module and PostgreSQL transaction. Test observable responses, persisted state, history, domain events, permissions, and concurrency outcomes through that seam. Keep narrower pure-domain tests only for combinatorial invariants where they add leverage.

The future `to-spec` invocation requires the user to confirm its proposed testing seam before publication. This is the only procedural confirmation remaining; there are no unresolved business rules to interview about.

## Suggested skills

1. `domain-modeling` — use while consolidating Task, Task Collection/shared schema, Task Property Definition, Status Option, Task Property Value, `Empty`, `Default`, and change-history terminology. Preserve the established vocabulary and create/update a glossary only when authorized by the main task.
2. `to-spec` — after the datatype handoffs are ready to consolidate, synthesize the baseline, referenced Status specification, and resolved decisions above into the product specification. Do not re-interview the user about settled Status behavior. Follow the skill’s required testing-seam confirmation, then publish with `ready-for-agent`.
3. `to-tickets` — invoke only after the specification exists. Produce small tracer-bullet vertical slices with explicit blocking edges, present the proposed breakdown for user approval, then publish the approved tickets.
4. `setup-matt-pocock-skills` — invoke before `to-spec` only if the main thread still lacks a configured issue tracker and triage vocabulary.
