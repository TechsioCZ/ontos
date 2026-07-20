# Handoff: task ticketing — `Last edited by`

## Purpose

Return the completed `Last edited by` datatype analysis to the main task-ticketing thread. The business behavior is settled and can later be synthesized with the other datatype documents using `to-spec`, followed by `to-tickets`. Do not implement from this handoff alone unless the user explicitly requests implementation.

## Source artifacts

- General task-property baseline and repository constraints: `/tmp/ontos-task-ticketing-handoff.md`
- Final `Last edited by` business specification (GOLD readiness): `/Users/jiprochazka/.codex/attachments/ca36b9b7-dc63-4043-82b1-9137a4e3e3f9/pasted-text.txt`

The source artifacts remain the authority for wording and full Gherkin. The coverage below is a self-contained synthesis of every business requirement, exclusion, acceptance outcome, and scenario supplied for this datatype, plus the inherited baseline rules.

## Inherited task-property baseline

- A new task initially exposes only `Title`.
- A task schema may contain multiple distinct property definitions of the same datatype.
- Property definitions belong to a shared task schema. Adding a definition makes it available to all tasks using that schema; existing tasks receive the value state `Empty`.
- Removing a definition from one task removes it from the shared schema and therefore from every task using it.
- Every removal requires confirmation showing the number of values matching `Is not empty`.
- General duplication creates an independent property definition with copied configuration and asks whether to copy existing values to the duplicate. Accepting copies values for all existing tasks; declining leaves all duplicate values empty. Later configuration/value changes do not couple the two definitions.
- Every change is versioned with a timestamp.
- Access levels are: Full access (edit, suggest, comment, share); Editor (edit, suggest, comment); User (edit task property values, suggest, comment, but no property-definition add/remove/duplicate/format/configuration changes); Viewer (read-only).
- Schema-level operations and task-level value edits remain distinct, especially for authorization and edit attribution.
- The confirmed datatype-specific exceptions to general duplication/value-materialization behavior appear in the next section.

## Complete product-owner business coverage

### Readiness, purpose, and actors

- Product-owner readiness is GOLD: triggering edits, human/automatic attribution, system ownership, scope, exceptions, and acceptance behavior are defined and testable.
- The property answers who performed the latest relevant successfully saved change without opening change history. It shows only the current latest editor; it is not an audit history.
- `User` is a person who creates, edits, or views a task.
- `Automation Initiator` is the user whose action caused an automatic task mutation.
- `System` is the fallback actor for automatic mutations without an identifiable user initiator.

### Scope

- The `Last edited by` datatype and its automatic task-level value.
- Attribution on successful changes to `Title`, any task property value, and canvas content.
- Human edits, automation with or without a known initiator, automation chains, task creation, and concurrent saves.
- Existing-task display, property removal/re-addition, and preservation of deactivated/removed users' identities.
- Renaming the property without altering its type, task values, or behavior.

### Out of scope

- Complete editor history, last-edited date/time, version comparison, and audit-log functionality.
- Comment authorship and notifications to editors.
- The technical identity-storage mechanism.
- Permissions governing whether the underlying task may be edited.
- Filtering, sorting, or grouping by this property.
- Detailed UI presentation of the property.

### Business rules BR-01 through BR-13

1. **System-managed value:** users cannot manually enter, replace, clear, or otherwise change the value.
2. **Exactly one actor:** each task has one current last editor; each later relevant save replaces the prior actor.
3. **Creation:** after successful creation, the task creator is the last editor.
4. **Relevant edit:** a successful persisted change to `Title`, any task property value, or canvas content updates the value.
5. **Non-triggering activity:** opening, viewing, leaving without saving, cancelling a draft, failed persistence, adding/editing/deleting comments, and personal-view changes that do not mutate the task leave the value unchanged.
6. **Decision point:** attribution changes only after successful persistence, never when editing begins.
7. **Multiple actors:** ordering follows successful-save order, not edit-start order; the last successful saver wins.
8. **Automation with initiator:** an automatic task mutation is attributed to the identifiable user who initiated it.
9. **Automation without initiator:** an automatic task mutation with no identifiable initiator is attributed to `System`.
10. **Metadata always exists:** last-editor data is retained as task system metadata whether or not a `Last edited by` property definition is currently exposed.
11. **Removal is non-destructive:** removing the property definition does not delete task metadata; re-adding it exposes the current retained actor.
12. **Historical identity:** deactivation, workspace removal, or loss of task access does not erase the retained identity of the last editor.
13. **Rename is schema-only:** the display name may change, but datatype, task value, and task last-editor attribution do not.

### Required edge-case behavior

- Concurrent editing resolves to the actor whose relevant mutation is successfully saved last.
- A failed save makes no attribution change.
- Saving a change and later successfully saving a reversal to the earlier business value still produces a new edit attributed to the later saver.
- One save containing several relevant field/content changes produces one last-editor update for that save.
- A user-initiated chain of automations remains attributed to the original initiating user while that origin is known.
- A later independent automation without an identifiable initiator replaces the earlier user attribution with `System`.

### Acceptance criteria

1. A created task reports its creator.
2. A successful `Title` edit reports its saver.
3. A successful edit to another property value reports its saver.
4. A successful canvas edit reports its saver.
5. Viewing alone changes nothing.
6. Comment activity changes nothing.
7. Unsaved, cancelled, or failed edits change nothing.
8. Manual overwrite or clearing is impossible.
9. Sequential/concurrent saves report the actor of the last successful save.
10. User-initiated automation reports the initiating user.
11. Automation without a known initiator reports `System`.
12. Adding the property to an existing task exposes the already-recorded editor.
13. Removing and re-adding the property preserves and re-exposes the value.
14. Deactivating/removing the user does not erase the retained identity.
15. Renaming the property preserves its datatype and all task values and does not count as a task edit.

### Supplied BDD scenario inventory

The product-owner document supplies executable-style Given/When/Then coverage for all of the following. Preserve these outcomes when `to-spec` selects testing seams and when `to-tickets` writes acceptance criteria:

- creator becomes the initial last editor;
- the value cannot be manually changed or cleared;
- successful `Title`, other-property-value, and canvas saves each update attribution;
- cancelled edit, failed save, and view-only access leave attribution unchanged;
- comment creation, edit, and deletion each leave attribution unchanged;
- sequential edits by different users report the later saver;
- concurrent edits saved in reverse start order report the actor of the final successful save;
- a multi-change single save updates attribution once;
- a user-triggered automation and a multi-step user-triggered automation chain report the initiating user;
- scheduled/independent automation without a known initiator reports `System`, including when replacing an earlier human editor;
- adding the property to an existing task exposes retained metadata;
- removing and re-adding it retains the value;
- deactivating the last editor preserves identity;
- renaming the property preserves type/value and does not update any task editor.

### Explicitly closed product hypotheses

- Comment changes do not update `Last edited by`.
- Automations use the original user initiator when known and `System` otherwise.
- Last-editor metadata exists independently of visible property definitions.
- Deactivation/removal does not erase historical identity.
- “Last edit” is defined by the relevant mutation categories and successful-persistence ordering above; there are no remaining open business hypotheses in the product-owner document.

## Confirmed cross-spec decisions

The user explicitly confirmed both decisions below:

1. Multiple or duplicated `Last edited by` property definitions all expose the same task-level system value. Their display/configuration can be independent, but their value is not. Duplicating this datatype does not show the general “copy values” prompt; the duplicate immediately displays the existing last editor.
2. Property-schema operations never update the affected tasks’ `Last edited by`. This includes adding, renaming, removing, and duplicating property definitions, even when the operation copies or deletes task property values. Only explicit task-content edits count.

These are datatype/cross-spec exceptions to the general duplication and value-materialization behavior in the baseline. They are no longer open questions.

## Domain and implementation conclusions

- `Last edited by` is task-level system metadata exposed through a schema property definition, not an ordinary independently stored task-property value.
- Persist a stable principal reference on the task and update it atomically with every successful relevant task mutation: Title, an explicitly edited property value, or canvas content.
- Pair it with the task revision/version and last-edited timestamp in the same transaction. A multi-field save updates the editor once.
- Task creation initializes the value from the effective creator. Adding/removing the visible property never creates or deletes the underlying metadata.
- Comments, personal-view changes, and all property-schema/configuration commands bypass the task-edit invariant.
- Model automation context with both the executing actor and originating principal. Attribute to the originating user when known; otherwise use a stable tenant-scoped `System` principal.
- Preserve principal identity after deactivation/removal. Resolve display information through the retained principal identity rather than storing the editor as mutable free text.
- Serialize concurrent relevant saves through the same task row/revision so the committed mutation ordered last becomes the visible editor.

The following are non-blocking implementation interpretations derived during review, not verbatim product-owner requirements: an identical-value/no-op save does not update attribution; automation-created tasks apply the same effective-actor rule; and display information is resolved from the retained principal identity rather than snapshotted as free text. The explicitly specified “change then later restore” case remains a new edit regardless.

## Current repository findings

- Work only under `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/app`; `mvp/` and `mvp2/` are read-only.
- The ticketing vertical is still a generated scaffold. Its current Create Ticket action accepts a placeholder request and does not persist the task/property domain model.
- Core principals already support `human`, `service`, `integration`, `agent`, and `system` kinds. Principal foreign keys use restrictive deletion, which supports retained historical identity.
- CoreSDK write actions already execute the handler, domain event, outbox messages, invocation completion, and audit evidence transactionally.
- Outbox worker context already reconstructs `originalPrincipalId` and the originating action identifiers, providing the basis for user-attributed automation.
- An implementation gap remains for scheduled/system and multi-hop automation: the main CoreSDK action entry currently assumes session authentication, while worker handlers mutate inside worker transactions. The design needs a governed system/worker command entry path that can preserve the originating principal, use `System` when none exists, and emit further domain events/outbox messages.
- No domain glossary or task-ticketing `CONTEXT.md` currently exists. Create/update one only when consolidating stable domain vocabulary, not as an implementation spec.
- Issue-tracker setup and triage vocabulary were not inspected in this datatype task. Before publishing, `to-spec` should use the configured tracker or invoke `setup-matt-pocock-skills` if configuration is absent, exactly as required by that skill.
- No workspace files were changed during this analysis. The worktree already contained unrelated user changes; preserve them.

## Proposed testing seam for `to-spec`

Prefer one high public seam: execute ticketing write actions through CoreSDK and read the task through the ticketing query/API contract. This can verify persistence, permissions, transaction rollback, actor attribution, automation propagation, and the projected `Last edited by` value without testing internal helpers directly.

Additional focused seams are justified only for:

- outbox-worker automation chains where the public write action cannot directly drive scheduled/system execution;
- concurrency tests that require independently controlled transactions;
- schema-operation assertions proving that bulk value materialization/deletion does not alter task edit metadata.

The `to-spec` flow should present these seams to the user for confirmation before publishing the spec, as required by that skill.

## Readiness for later skills

When the main thread has accumulated the intended datatype documents:

1. Invoke `to-spec` to synthesize the baseline, all datatype business specifications, and confirmed cross-spec decisions into one tracker specification. Do not re-interview about the two decisions above.
2. After the specification exists, invoke `to-tickets` against that spec. Draft tracer-bullet vertical slices, quiz the user on granularity and blocking edges, and publish only after approval.
3. Keep system-metadata datatypes distinct from ordinary stored property values when shaping both the spec and tickets.

## Suggested skills

- `to-spec` — later, from the main thread, to publish the consolidated business and implementation specification. Do not invoke merely for this datatype handoff unless the user says the collection is ready.
- `to-tickets` — after an approved/published spec, to produce dependency-aware tracer-bullet tickets. Do not invoke before the user reviews the proposed breakdown.
- `domain-modeling` — while consolidating stable terminology such as Task, Task Schema, Property Definition, Property Value, System Metadata, Principal, Originating Principal, and Effective Editor.
- `implement` — only after the specification/tickets exist and the user explicitly requests implementation.

## Open questions

None for the `Last edited by` business behavior or its interaction with property duplication/schema operations.
