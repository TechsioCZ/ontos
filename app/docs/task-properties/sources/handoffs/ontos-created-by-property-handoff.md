# Handoff: ticketing `Created by` property

## Purpose

Return the completed `Created by` property discussion to the main task so it can later be synthesized with `to-spec` and broken into tracer-bullet work with `to-tickets`. Do not implement from this handoff alone unless the user explicitly asks.

## Original source artifacts

- Task-ticketing baseline: `/tmp/ontos-task-ticketing-handoff.md`
- Full final business description and BDD scenarios: `/Users/jiprochazka/.codex/attachments/a15d3954-dde6-4507-94d0-5ca8c2fa8d2e/pasted-text.txt`

Their complete relevant business content is consolidated below so the next agent can work from this handoff alone. The paths are retained for provenance and exact source wording.

## Status

- Business behavior is complete.
- The user confirmed all remaining decisions listed below.
- No implementation, specification, tickets, ADR, or workspace documentation was created.
- `to-spec` and `to-tickets` were explicitly not invoked.

## Canonical domain model

- **Actor**: the tenant-scoped OntOS Principal actually responsible for creating a task. It may represent a human, service, integration, agent, or system.
- **Task provenance**: intrinsic task metadata consisting of the original actor reference and creation timestamp.
- **`Created by` property**: an immutable, system-derived projection of task provenance. It is not an ordinary stored property value.
- **Property definition**: schema-level configuration that controls availability and presentation. Adding, hiding, removing, renaming, or duplicating this definition never mutates task provenance.

## Confirmed decisions

1. `Created by` is a system-derived property exception to the generic property rules:
   - It is never `Empty` for a valid task.
   - Adding it to a schema immediately projects the recorded actors for all existing tasks.
   - Multiple `Created by` definitions may exist and have independent configuration, but all project the same task provenance.
   - Duplicating its definition copies configuration only and does not ask whether values should be copied.
2. Task creation must fail in a controlled way when no valid actor can be established. There is no fallback or `Unknown System` identity.
3. `Created by` references a stable Principal identity but displays that Principal's current display name. Do not store or display a creation-time name snapshot. A disabled or archived Principal remains referenced and may be visually marked inactive.

These decisions resolve the baseline conflicts where newly added properties would otherwise be `Empty` and duplicated properties could otherwise decline value copying.

## Consolidated product-owner documentation

This section is a self-contained, lossless business consolidation of the task-ticketing baseline and the final `Created by` datatype document. The confirmed decisions above resolve the few alternatives that the source document left open.

### Shared task-property baseline

- A new task initially exposes only `Title`. Intrinsic system metadata such as provenance may still be recorded even when it is not a displayed property.
- Tasks use a shared task schema. Creating a property adds its definition to that schema and makes it available to every task using the schema.
- The generic rule is that existing tasks receive a newly created property in the `Empty` state. `Created by` is the confirmed system-derived exception: it immediately projects the actor already stored in task provenance.
- A schema may contain multiple distinct property definitions of the same datatype.
- Removing a property from one task removes its definition from the shared schema and therefore from all tasks using that schema.
- Every property removal requires confirmation showing how many values match `Is not empty`. For `Created by`, every valid task has a non-empty projected value, so this count is the number of affected tasks.
- Generic property duplication creates a new independent definition with the original configuration and asks whether to copy existing values. If accepted, values are copied for all existing tasks; if declined, the duplicate is empty for all tasks. `Created by` is the confirmed exception: duplication copies configuration only, asks no value-copy question, and every definition projects the same provenance.
- Later configuration changes to an original property and its duplicate do not affect each other.
- Every change is versioned with a timestamp.

Access levels remain:

1. **Full access**: edit, suggest, comment, and share.
2. **Editor**: edit, suggest, and comment.
3. **User**: edit ordinary property values, suggest, and comment, but cannot add, remove, duplicate, or reconfigure property definitions.
4. **Viewer**: read-only.

Datatype immutability overrides generic value-edit permission: no access level may manually edit or clear a task's `Created by` value. Schema-level availability and naming remain governed by the normal schema permissions.

The wider task-property model still expects separate detailed documents for Text, Number, Select, Multi-select, Status, Date, Date range, Person, Files & Media, Checkbox, URL, Email, Phone, Created time, Last edited time, Last edited by, and ID. Those datatypes are outside this handoff.

### Readiness and executive meaning

- Readiness is **GOLD**: meaning, creation timing, immutability, existing-task behavior, indirect creation paths, main rules, exceptions, scope, and testability are sufficiently defined for coding agents.
- `Created by` displays the identity of the Actor who created the specific task.
- It is an automatically managed, immutable system value. Users neither supply nor edit it and cannot remove it from one individual task.
- The system records the Actor when every task is created, whether or not a `Created by` definition is currently visible or present in the schema.
- Adding the definition later reveals the actual original Actors for existing tasks.
- The Actor may be a human Principal or a named system Principal such as an automation or import process.

### Business goal

Users must be able to determine reliably who or what created a task. This supports:

- provenance and traceability;
- distinguishing manual creation from automated creation;
- filtering tasks by original Actor.

`Created by` does not identify the current owner, assignee, or last editor.

### Actors

- **Human Actor**: an authenticated person who creates a task manually, through duplication, import acting in their name, or another user action.
- **System Actor**: a named non-human identity that creates a task without direct manual creation, including automation, import, and internal or external system operations.
- **Viewing user**: a user who views, searches, or filters tasks using `Created by`.

### Included scope

1. Automatically record the Actor for every task creation.
2. Display exactly one original Actor.
3. Support both human and system identities.
4. Keep the value immutable.
5. Reveal provenance for existing tasks when the property definition is added later.
6. Preserve provenance through later task edits.
7. Attribute duplicates to the Actor performing the duplication.
8. Attribute automated creation to the actual named system Actor.
9. Filter tasks by `Created by`.
10. Preserve provenance when the property definition is hidden, removed, or added again.

### Explicitly out of scope

- current task owner;
- assignee;
- last editor;
- complete change history;
- an audit log of every operation;
- author notifications;
- task read/edit permissions;
- user performance reporting;
- combining multiple authors;
- manual correction, replacement, or override of the Actor;
- prescribing the technical representation of identity in the business specification;
- migrating historical tasks for which an Actor was never recorded.

### Business rules

- **BR-01 — Automatic attribution:** Creating a task automatically records the creating Actor without user input.
- **BR-02 — Independent of property visibility:** Attribution occurs even if no `Created by` definition is currently present or visible.
- **BR-03 — Exactly one Actor:** Every valid task has exactly one original Actor; the datatype is single-valued.
- **BR-04 — Immutable value:** After creation, the value cannot be manually changed, cleared, or replaced.
- **BR-05 — Unaffected by task edits:** Changing title, content, owner, assignee, status, priority, due date, or any other business property does not change the original Actor.
- **BR-06 — Manual creation:** An authenticated user's new task is attributed to that user Principal.
- **BR-07 — Duplication:** A duplicate is a new independent task attributed to the Actor performing the duplication. The source task retains its original Actor, which is never copied to the new task.
- **BR-08 — Automated creation:** A task created by automation or another system process is attributed to that named system Principal. The workspace administrator and template author must not be substituted when they did not perform creation.
- **BR-09 — Import:** If import creates tasks in a user's name, that user is the Actor. If a standalone import process creates them, its named system Principal is the Actor. An external record's original author is not automatically imported into `Created by`.
- **BR-10 — Adding the definition later:** Adding `Created by` after tasks exist reveals each task's actual original Actor, never the user who added the property definition.
- **BR-11 — Hiding or removing the definition:** Hiding or removing the definition does not delete provenance. Adding or showing it again reveals the unchanged original value.
- **BR-12 — Filtering:** Filtering by a `Created by` identity returns only tasks created by that exact Principal, including named system Principals.
- **BR-13 — Renaming the property:** When general property renaming is allowed, the display name may change without changing the datatype, meaning, or projected values.

### Edge cases and exceptions

- **Disabled or removed access:** If the original human Actor later loses access or their Principal becomes disabled/archived, the task retains that identity. The UI may mark the identity inactive and displays the Principal's current display name. It must not substitute another user.
- **Deleted source task:** Deleting a source task does not affect existing duplicates; every duplicate retains the Actor who performed its own creation.
- **Automation editing only:** Automation that merely edits an existing task never becomes its creator. It is the Actor only when it creates a new task.
- **Actor cannot be established:** The confirmed behavior is controlled creation failure. The system must never guess, use a random user, use a workspace administrator, or use an unknown fallback identity.
- **Copied content or template:** Copying content, configuration, properties, or a template into a new task never transfers provenance. The Actor creating the new task is recorded.
- **Principal display-name changes:** The stable Principal identity remains the filter/reference key, while presentation uses its current display name rather than a creation-time snapshot.

### Acceptance criteria

1. Every newly created task has exactly one `Created by` value.
2. The value is created automatically with the task.
3. Manual creation uses the authenticated user's Principal.
4. Automated creation uses the automation's named Principal.
5. No user can manually change or clear the value.
6. Later task edits do not change it.
7. A duplicate uses the Principal performing duplication.
8. Duplication does not change the source task's Actor.
9. Adding the property definition later reveals the actual Actors of existing tasks.
10. Hiding or removing the definition does not lose provenance.
11. Showing or adding the definition again reveals the original values.
12. Filtering by Actor returns only tasks created by the selected Principal.
13. Disabling or archiving an Actor does not change historical task attribution.
14. Automation editing an existing task does not overwrite the original Actor.
15. Import and every other indirect creation path use the actual Actor responsible for creating the new task.
16. Creation fails in a controlled way when no valid Actor is available.
17. All presentations of an Actor use the stable identity's current display name, optionally marked inactive, with no creation-time name snapshot.
18. Duplicating a `Created by` property definition copies configuration without a value-copy prompt and immediately projects provenance for all tasks.

### Required BDD scenario coverage

The original Gherkin scenarios are incorporated as the following Given/When/Then expectations:

1. **Authenticated manual creation:** given an authenticated human Actor, when they create a task, then the task has exactly one automatically assigned `Created by` value equal to that Actor.
2. **Property absent during creation:** given a task created while the definition was not shown, when the definition is added later, then it shows the original Actor.
3. **Property edit UI:** given an attributed task, when a user edits task properties, then `Created by` cannot be changed.
4. **Attempted clearing:** given an attributed task, when a user attempts to clear the value, then the operation is unavailable or rejected and attribution remains unchanged.
5. **Edit by another user:** given a task created by one Actor, when another user changes title or content, then the original Actor remains.
6. **Assignee change:** given an attributed task, when its assignee changes, then its original Actor remains.
7. **Automation edits an existing task:** given a human-created task, when automation changes its status, then its original Actor remains.
8. **Duplicate another Actor's task:** given a source created by one Actor, when another Actor duplicates it, then the new task is attributed to the duplicating Actor and the source remains unchanged.
9. **Automation creates a task:** given a named automation Principal, when it creates a task, then that Principal is `Created by`.
10. **User-named import:** given an import acting in a human user's name, when it creates tasks, then that user Principal is `Created by`.
11. **Standalone import process:** given a named import-process Principal, when it creates tasks, then that system Principal is `Created by`.
12. **Hide and show:** given an attributed task and a hidden definition, when the definition is shown again, then the same Actor appears.
13. **Remove and add:** given an attributed task and a removed definition, when a `Created by` definition is added again, then the same Actor appears.
14. **Filter by human Actor:** given tasks from multiple human Actors, when filtering by one Principal, then only that Principal's tasks appear.
15. **Filter by system Actor:** given manual and automated tasks, when filtering by the named automation Principal, then only its tasks appear.
16. **Disabled Actor:** given an attributed task, when its human Actor is disabled/archived, then the task retains the same stable identity, shows its current display name, and does not substitute another user.
17. **Missing identity:** given that no valid creating Actor can be established, when task creation is attempted, then no task is created and no random user, administrator, or fallback identity is assigned.

### Source hypotheses and their final disposition

- **H1 — Disabled Actor presentation:** accepted with clarification: retain the stable identity, display its current name, and optionally mark it inactive.
- **H2 — Property renaming:** accepted: renaming follows general schema permission but cannot alter the system datatype or behavior.
- **H3 — Unknown system Actor:** resolved more strictly than the source alternative: do not create a fallback Principal; fail creation in a controlled way.
- **H4 — Schema removal:** accepted: removal affects availability/presentation only and never deletes provenance.

## Recommended implementation shape

- Persist a non-null, immutable `created_by_principal_id` as intrinsic data on every task, alongside the creation timestamp. Reference the tenant-scoped core Principal and prevent referenced identities from being physically deleted.
- Derive the actor exclusively from a trusted operation context. Never accept `createdBy` or an actor override in the public task-creation payload.
- Put all ways of creating a task behind one deep task-creation module/interface: manual creation, duplication, import, automation, template/content copying, and future indirect creation paths.
- In the same transaction, persist the task, provenance, initial version/timestamp, and domain/outbox evidence required for successful creation.
- Duplication copies eligible business content/configuration but calls the same creation module with the duplicating operation's actor. It must never copy the source task's provenance.
- Import and automation must execute under their actual named Principal. If they cannot establish one, creation fails.
- Resolve `Created by` reads and filters through a datatype adapter/projection onto task provenance rather than through generic property-value rows. Add a tenant-appropriate index for creator filtering.
- Removing or hiding the property definition only affects schema/presentation. Re-adding a definition projects the unchanged provenance.
- Property-value edit interfaces must not expose `Created by`; schema permission to add/remove/rename a definition is separate from value immutability.
- Treat creation as the initial task version. Later definition changes version the shared schema as appropriate but do not create fake creator-value mutations.

## Existing codebase findings

Work only in `app/`; `mvp/` and `mvp2/` remain read-only.

- Core already models tenant-scoped Principals with kinds `human`, `service`, `integration`, `agent`, and `system`, plus active/disabled/archived status. Its normal foreign-key convention uses restricted deletion.
- `OperationContext` already exposes `principalId`, `tenantId`, and `legalEntityId`, so the task-creation handler has a trusted actor reference available.
- The ticketing vertical is only a scaffold; no durable task/property model exists yet.
- There are currently two nominal creation routes:
  - a simple BFF `create` handler that manufactures an in-memory item and bypasses CoreSDK identity handling;
  - a CoreSDK `createTicketAction` that receives an operation context but currently validates/logs/emits an outbox message without persisting a task.
- These paths must converge on the single task-creation module so no creation route can omit provenance.
- Core Principals can represent automated actors, but CoreSDK action invocation and audit persistence currently hard-code `authMethod: 'session'`. Trusted operation identity/provenance must be enriched to represent API-key and system execution accurately before automation/import scenarios are considered complete.
- The vertical gateway token currently carries Principal, tenant, and legal-entity IDs but not authentication method/provenance.
- There is no persisted legacy task population in the current ticketing scaffold, so the explicitly out-of-scope migration of tasks whose creator was never recorded is not presently an implementation blocker.

## Preferred test seam

Use the highest practical seam: invoke the public task-creation action through CoreSDK with a trusted operation context, then read/filter through the public ticketing data-access interface. Tests should assert externally visible behavior and durable state, not internal helper calls.

Minimum scenario coverage should be taken from the source business document and include:

- human creation;
- system/automation creation;
- controlled rejection when identity is unavailable;
- duplicate attribution to the duplicating actor;
- later edits not changing provenance;
- adding, hiding, removing, and re-adding the property definition;
- filtering by both human and system Principals;
- disabled/archived actor retaining identity while showing the current display name/inactive state;
- attempts to set, edit, clear, or copy creator values being impossible through transport and domain interfaces;
- idempotent creation not creating a second task or changing its actor.

Before publishing a spec, `to-spec` requires confirming this proposed test seam with the user. This is a seam confirmation, not a reopening of business behavior.

## Guidance for `to-spec`

- Invoke `to-spec` from the main task using this handoff. The original source paths are optional provenance checks; the handoff is self-contained.
- Use the canonical terms above throughout.
- Preserve the complete business acceptance criteria and BDD behavior consolidated above.
- Record the single task-creation module/interface, intrinsic provenance storage, system-derived property projection, actor-only-from-context rule, and CoreSDK automated-actor gap as implementation decisions.
- Testing decisions should prefer one end-to-end creation/read seam and enumerate the business scenarios above.
- If the project issue tracker and `ready-for-agent` vocabulary have not already been configured in the main task, run `setup-matt-pocock-skills` before publishing. No tracker configuration was found inside `app/` during this task.

## Guidance for `to-tickets`

- Prefer invoking `to-tickets` after the `to-spec` issue exists, passing that issue as the source.
- Draft narrow, demoable vertical slices rather than schema/API/UI horizontal layers.
- Likely slicing themes are: trusted human creation with durable provenance; system-principal creation and failure behavior; schema projection plus filtering; duplication with fresh attribution; and lifecycle/presentation behavior for removed properties and inactive/renamed actors.
- Treat any CoreSDK operation-context expansion as prefactoring only if it cannot be delivered green as part of the first automated-actor tracer bullet.
- The skill must still present its proposed ticket breakdown and blocking edges for user approval before publishing.

## Scope reminders

- Do not conflate `Created by` with owner, assignee, last editor, permissions, or a complete audit log.
- Do not add manual correction/override behavior.
- Do not invent migration behavior for historical tasks whose actor was never recorded.
- Preserve the baseline's shared-schema permissions while allowing datatype-specific immutability to override generic value-edit permission.

## Workspace state

No workspace files were changed by this discussion; only this temporary handoff was created and updated. The worktree already contained unrelated changes when inspected; preserve them and do not assume ownership.

## Suggested skills

1. `to-spec` — synthesize the baseline, full datatype description, confirmed decisions, implementation seams, and test seam into the tracker specification. Do not interview for business behavior.
2. `to-tickets` — after the spec is published, propose and obtain approval for tracer-bullet tickets and their blocking edges, then publish them.
3. `domain-modeling` — maintain the Actor, Task provenance, Principal, property definition, and system-derived property vocabulary if a project glossary is introduced.
4. `codebase-design` — keep all creation paths behind one deep task-creation interface and avoid leaking property-source mechanics to callers.
5. `implement` — only after an approved spec/ticket exists and the user explicitly requests implementation.
