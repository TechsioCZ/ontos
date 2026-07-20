# Handoff: finalized Date Range task property

## Purpose of the next session

Return this datatype result to the main task-ticketing conversation. Consolidate it with the general property baseline and the other datatype documents. Later, the main thread may invoke `to-spec`, followed by `to-tickets`; neither skill was invoked in this task.

## Authoritative source artifacts

- General task-property baseline: `/tmp/ontos-task-ticketing-handoff.md`
- Full final Date Range business specification, including acceptance criteria and Gherkin scenarios: `/Users/jiprochazka/.codex/attachments/a3add880-c6b9-456b-bd66-0647566a22ba/pasted-text.txt`

Read both artifacts in full. This handoff records only the discussion outcomes and implementation-facing context that are not already captured there.

## Final product decisions from this conversation

There are no remaining product questions for Date Range.

1. **Duplication is a confirmed Date Range exception to the general baseline.** Duplicating a Date Range property always copies its complete configuration and every existing task value. The user is not offered a copy-values choice. Empty source values remain Empty. Original and duplicate become independent immediately after the operation.
2. **Disabling time support uses the H1 behavior from the Date Range document.** Before disabling, show confirmation with the number of affected tasks (tasks whose Date Range contains the complete time pair). On confirmation, remove both Start time and End time from those values while preserving Start date and End date. Cancellation changes nothing. The confirmed change must be atomic.
3. **Versioning is inherited from the generic property system.** Date Range definition/configuration changes, value changes, duplication, deletion, and the destructive removal of times use the same version and timestamp mechanism as other property types. “Schema versioning” being outside the datatype document does not cancel the baseline rule.
4. **Duplicate naming uses the generic unique-name convention.** Generate names from the source label as `Name copy`, `Name copy 2`, `Name copy 3`, and so on within the schema. Identity must use an immutable property ID rather than the display label.

## Implementation-facing interpretation

- Time support is configuration of an individual Date Range `PropertyDefinition`, shared by all tasks using that definition. It is not one global switch for every Date Range property in a `TaskSchema`. Distinct or duplicated Date Range definitions remain independently configurable.
- Persisted Date Range state should be structurally limited to `Empty` or one complete value. A complete value has both dates and either no times or a complete Start/End time pair. Do not model persisted values as four independently optional fields.
- Partial fields belong only to an editor draft. A failed save preserves that draft for correction but leaves the persisted value unchanged.
- Dates should be represented as timezone-free calendar dates and optional times as timezone-free wall-clock times. The business rule compares dates: equal Start/End dates are invalid even when times differ. Do not convert these values into UTC instants unless a future business specification introduces timezones.
- A single Date Range domain module should own construction and validation. Return stable, localizable error codes for missing Start, missing End, equal dates, Start after End, incomplete time pair, and times supplied while time support is disabled. The UI maps these codes to notifications and preserves the draft.
- An absent value record may represent `Empty`; creating a property need not insert an empty row for every task. The observable behavior must still make the property immediately available on all existing and new tasks.
- Add, duplicate, delete, clear, enable time, and disable time should be explicit application commands. Schema-wide duplicate/delete/configuration mutations and their counts/copies should run transactionally.
- The deletion confirmation count is the number of non-empty values. The disable-time confirmation count is narrower: the number of values containing times.
- Baseline access rules still apply even though permissions are outside this datatype document: schema editors manage definitions/configuration/duplication/deletion; task editors set and clear values.

## Repository context

- Repository: `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos`
- Work only under `app/`. Treat `mvp/` and `mvp2/` as read-only.
- The `app/verticals/ticketing` vertical is currently a scaffold, not an implemented ticketing domain. Its shared `TicketingItem` contains only an ID, build marker, and title; the backend returns an in-memory starter item and synthesizes created items without persistence.
- No `TaskSchema`, `PropertyDefinition`, `PropertyValue`, Date Range persistence, or property lifecycle module currently exists. Implementing properties therefore requires a generic task-property foundation rather than a Date Range-only patch.
- The existing CoreSDK action pattern provides relevant prior art for transport schemas, action registration, authorization, audit metadata, domain events, idempotency, and outbox messages.
- The repository already had unrelated/staged changes during this review, including a deleted `app/docs/ticketing/task-properties.md` and generated diagnostics changes. Preserve them and do not infer that they belong to this datatype work.
- No workspace files were changed in this task.

## Candidate module and test seams for `to-spec`

The preferred external seam is the ticketing property-command interface: callers request create/configure/set/clear/duplicate/delete operations and receive either the committed result or a structured domain rejection. Persistence, counting, atomic copying/deletion, audit/version emission, and datatype validation stay behind this interface.

Use the Date Range value module as an internal seam for exhaustive rule tests, but prefer end-to-end behavior tests through the property-command interface for the feature specification. The full Gherkin source already enumerates the expected externally observable cases; reference it rather than restating it. Before publishing a spec, `to-spec` must still show the proposed seams to the user as required by that skill.

Useful test coverage beyond the existing Gherkin cases:

- reject transport attempts to provide times when time support is disabled;
- prove failed validation does not overwrite the previous persisted value;
- prove duplication is a snapshot and later mutations are independent;
- prove schema-wide counts and mutations are transactional under concurrent value changes;
- prove disabling time removes only time pairs and preserves dates, versions, and unaffected values;
- prove Empty can be represented without materialized rows while remaining observable on every task;
- prove baseline permissions distinguish schema operations from task-value operations.

## Scope guidance for later specification and tickets

- The Date Range document is authoritative for Date Range business behavior.
- The general baseline remains authoritative for shared schema behavior, permissions, and generic timestamp/version semantics, except for the explicitly confirmed Date Range duplication override above.
- Keep generic property-foundation decisions separate from Date Range-specific rules in the eventual spec so subsequent datatype documents can reuse the foundation.
- When ticketing later begins, use tracer-bullet vertical slices that are independently demoable across persistence, property commands/transport, UI, authorization/versioning, and behavior tests. Do not create horizontal “database only” or “UI only” tickets.
- Do not start implementation from this handoff alone. Publish/approve the consolidated spec and ticket breakdown first in the main thread.

## Suggested skills

1. **`domain-modeling`** — consolidate the shared vocabulary (`Task`, `TaskSchema`, `PropertyDefinition`, `PropertyValue`, `Empty`, schema operation, task-value operation, version) across all datatype handoffs before final specification work.
2. **`to-spec`** — in the main thread, synthesize the baseline, this handoff, the full Date Range document, other completed datatype documents, and the agreed test seam into the project tracker specification. Do not interview again about the four decisions above.
3. **`to-tickets`** — only after the consolidated specification exists; create user-approved tracer-bullet tickets with explicit blocking edges and publish them to the configured tracker.
4. **`techsio-ui-kit-ai:ui-kit-workflow-orchestrator`** — later, when implementation reaches the Date Range editor, confirmation dialogs, notifications, and other app UI under `app/`.
5. **`implement`** — only after the specification and tickets have been approved, working one frontier ticket at a time.

If the issue tracker and triage vocabulary are not configured when `to-spec` or `to-tickets` runs, invoke `setup-matt-pocock-skills` first as those skills require.
