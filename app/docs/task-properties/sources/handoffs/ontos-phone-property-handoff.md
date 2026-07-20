# Self-contained handoff: task-ticketing baseline and Phone property

## Status and intended next use

This handoff is content-complete for the general task-ticketing baseline, the final Phone-property business document, and the implementation clarifications agreed in the follow-up discussion. A fresh main-thread agent can use this document as the input to `to-spec`, then use the resulting approved specification as the input to `to-tickets`. Neither workflow has been invoked yet.

Do not implement from this handoff unless the user explicitly requests implementation. The expected sequence is:

1. Consolidate this handoff with the other datatype handoffs.
2. Invoke `to-spec`, agree the test seams, and publish the consolidated specification.
3. Invoke `to-tickets`, quiz the user on tracer-bullet granularity and blocking edges, and publish the approved tickets.
4. Hand individual ready tickets to coding agents through `implement`.

## Source provenance

The normalized content below includes all business information from:

- General baseline handoff: `/tmp/ontos-task-ticketing-handoff.md`
- Final Phone business specification: `$HOME/.codex/attachments/429e282d-40ea-4b8a-99fe-25dd2f758dd7/pasted-text.txt`

The original documents remain the provenance references. No API keys, credentials, or personal data are included here.

## General task-ticketing baseline

### Current product state

- The product owner supplied requirements for a Notion-inspired task-ticketing model.
- No implementation, repository specification, issue, ADR, or design decision was created as part of the original baseline discussion.
- A separate detailed document is expected for every property datatype. Each datatype handoff adds to, rather than replaces, this baseline.

### Shared task and property behavior

1. A newly created task initially contains only the `Title` property.
2. A task can contain additional properties.
3. Multiple distinct properties of the same datatype can coexist. They remain independent property definitions.
4. Properties belong to a shared task schema.
5. Creating a property adds it to every task using that schema. Existing tasks receive the property in state `Empty`.
6. Removing a property through any task removes the property definition from the shared schema and therefore from every task using that schema.
7. Every property removal requires a confirmation dialog, including when no values exist.
8. The removal dialog displays the number of task values matching `Is not empty`.
9. Confirming removal deletes the property definition and all its values across the shared schema; cancelling changes nothing.
10. Duplicating a property creates a new, independent property definition with the original property's configuration.
11. Every duplication asks whether existing values should also be copied.
12. When value copying is accepted, every existing task receives the corresponding copied value; source `Empty` states remain `Empty`.
13. When value copying is declined, the duplicate is `Empty` for every existing task.
14. Later changes to the source or duplicate property definition, configuration, name, or values do not affect the other.
15. Every change is logged with a timestamp. The later Phone discussion clarified that this means change logging, not retention of historical Phone values.

### Access levels

1. **Full access:** may edit, suggest, comment, and share.
2. **Editor:** may edit, suggest, and comment.
3. **User:** may edit property values and may suggest or comment, but may not add, remove, duplicate, or change the format/configuration of property definitions.
4. **Viewer:** read-only with respect to task and schema data.

Schema-level operations and task-level value edits must remain distinct authorization capabilities. For Phone, non-mutating copy and call activation were later confirmed as available to Viewers as well as higher roles.

### Property datatype documents expected

- Text
- Number
- Select
- Multi-select
- Status
- Date
- Date range
- Person
- Files & Media
- Checkbox
- URL
- Email
- Phone
- Created time
- Created by
- Last edited time
- Last edited by
- ID

### Baseline integration guidance

- Preserve these shared semantics when incorporating each datatype document.
- Do not silently resolve a material conflict between a datatype document and the baseline; obtain a product decision.
- Keep shared property lifecycle behavior generic rather than implementing it independently for every datatype.
- Do not begin implementation unless explicitly requested.

## Phone property: executive behavior and business objective

`Phone` records one optional phone-related value per task and property definition. The value is textual, not numeric. The application does not validate phone-number correctness or enforce a national/international format.

The user can type, paste, edit, clear, and copy the value. Activating a populated value asks the user's device or environment to initiate a telephone call. The application does not itself place the call. When calling is unsupported, the task and value remain unchanged, the application does not show a task/save error, and the value remains copyable.

The business objective is to let users store and quickly use phone contacts without restricting country formats, internal extensions, or user formatting. This follows the basic Notion model: Phone behaves like a textual property for entry and paste and does not enforce a phone-number format.

## Phone actors and permissions

### Actor who can edit task property values

May:

- type, paste, edit, and clear the Phone value;
- copy a populated Phone value;
- activate a populated Phone value to request a call.

Under the shared roles, User, Editor, and Full access may edit or clear values.

### Actor who can manage the shared task schema

May:

- create a Phone property definition;
- rename it;
- duplicate it;
- remove it from the shared schema.

Under the shared roles, Editor and Full access may manage the schema.

### Confirmed non-mutating Viewer behavior

- Viewer may copy and activate/call a populated Phone value because those actions do not mutate task data.
- Viewer may not edit or clear the value and may not manage property definitions.

## Phone in scope

- Creating a property of datatype `Phone`.
- Showing it on every task using the shared schema.
- At most one optional value for each task and Phone property definition.
- Manual entry.
- Clipboard paste.
- Editing and full replacement.
- Clearing back to `Empty`.
- Clipboard copying.
- Activating the value to request that the device initiate a call.
- Behavior when the device/environment cannot initiate a call.
- Renaming the property.
- Duplicating the property with the choice to copy or omit values.
- Removing the property from the shared schema.

## Phone explicitly out of scope

- Verifying that a phone number exists, is reachable, or belongs to anyone.
- National or international format validation.
- Automatic country-code insertion.
- Automatic reformatting, normalization, or correction.
- Splitting the value into prefix, main number, and extension.
- Storing multiple numbers inside one Phone property value.
- Sending SMS or other messages.
- Call history.
- Contact management.
- Automatically placing a call without the device's system action.
- Filtering, sorting, or grouping by Phone.
- Defining the technical behavior of individual operating systems.
- Defining roles or permissions beyond the shared task/schema access model.

## Complete Phone business rules

### BR-01 — Shared schema

Phone is a property definition in a shared task schema. Creation makes it available on every task using that schema. Existing tasks receive `Empty`.

### BR-02 — One value

A task has at most one value for a particular Phone property definition. Multiple phone contacts require multiple independent Phone property definitions.

### BR-03 — Optional value

`Empty` is valid. An empty Phone value never blocks creation, editing, saving, or other processing of the task.

### BR-04 — Textual representation

The value is stored as a text string rather than a number. It can contain digits, `+`, spaces, hyphens, parentheses, slashes, extension text, and other user-entered characters.

### BR-05 — No blocking phone validation

The system does not determine whether the value is a valid or existing telephone number. Any non-empty textual value is accepted without a blocking error, invalid-format warning, or automatic correction. Valid examples include `+420 777 123 456`, `777-123-456`, `ústředna 123, linka 42`, and `555 / 123`.

### BR-06 — Preserve user notation

Preserve the entered content and formatting. Do not add/remove a country code, rearrange digits, remove spaces/parentheses/hyphens, or convert to a canonical phone format.

### BR-07 — Type and paste equivalently

The user can type or paste the value. Both methods produce the same business behavior and preservation guarantees.

### BR-08 — Replace on edit; no value history

Editing replaces the previous current value completely. Phone does not maintain a history of prior values. A separate change log records that an operation occurred and when, without making prior Phone values part of the property.

### BR-09 — Clear value, retain definition

Clearing the entire value returns that task/property pair to `Empty`. Clearing a task value does not remove the property definition from the shared schema.

### BR-10 — Copy exactly

A populated value can be copied as displayed and stored. Copying does not mutate the value, initiate a call, validate it, or normalize it.

### BR-11 — Activate to request a call

Activating a populated value asks the device/environment to initiate a call using that value. The application does not automatically place the call, confirm that a call occurred, or write a call result into the task.

### BR-12 — Unsupported calling environment

If the device/environment cannot initiate calls, neither task nor value changes. The application does not show a task/save error, and the value remains copyable. Lack of call support does not make the stored Phone value invalid.

### BR-13 — Empty has no value actions

`Empty` exposes neither call activation nor copying of an existing value.

### BR-14 — Rename safely

Renaming a Phone property changes only its name. Its datatype, existing task values, and behavior remain unchanged.

### BR-15 — Duplicate independently

Duplication creates a new independent Phone property definition with copied configuration and always asks whether to copy values:

- If accepted, populated values are copied to the corresponding existing tasks and source `Empty` states remain `Empty`.
- If declined, every existing task is `Empty` for the duplicate.
- Later changes to either definition, name, configuration, or any task value never affect the other property.

The duplicate's generated name follows common property-duplication behavior and is not Phone-specific.

### BR-16 — Remove from the shared schema

Removing Phone removes it from the shared schema and therefore from every task using that schema. A confirmation dialog is always required and displays the number of tasks whose value is `Is not empty`, including a count of zero. Before confirmation the property remains intact. Cancelling changes nothing. Confirming removes the definition and all its values across affected tasks.

## Phone edge cases and exceptions

1. `Empty` is valid and has no copy/call action.
2. A nonstandard value is stored unchanged and does not produce a validation error.
3. Textual content such as `ústředna +420 123 456 789, linka 42` is allowed; the device is not guaranteed to interpret it successfully.
4. Failed or unsupported call handoff must not alter the task or cause a task-save error.
5. Entering a new value replaces the current value; it never creates a list of numbers.
6. Duplication with partially populated tasks preserves task mapping: populated values copy to the same tasks and `Empty` remains `Empty`.
7. Removal confirmation is shown even when the non-empty count is zero.

## Phone acceptance criteria

1. A permitted schema manager can create a Phone property.
2. The new property appears on every task using the shared schema.
3. Existing tasks receive it as `Empty`.
4. A task can hold only one value for a particular Phone property.
5. Phone may remain `Empty`.
6. A permitted value editor can type or paste a value.
7. The system accepts the value without phone-format validation.
8. Entered content and formatting are preserved.
9. A permitted editor can replace an existing value.
10. A permitted editor can clear it back to `Empty`.
11. Any permitted viewer can copy a populated value exactly.
12. Activating a populated value requests device call initiation.
13. An unsupported calling environment causes no task/value mutation and no application task/save error.
14. `Empty` offers no call activation or existing-value copy action.
15. Renaming leaves datatype and values unchanged.
16. Duplication offers copy-values and no-copy alternatives.
17. The duplicate is independent of the source.
18. Removal always requires confirmation.
19. Confirmation displays the `Is not empty` task count.
20. Cancelling removal preserves definition and values.
21. Confirming removal deletes the definition and all values across the shared schema.

## Complete BDD scenario inventory

The source document provides 22 Gherkin scenarios. Preserve all of these behaviors in the eventual specification and test plan:

1. **Create Phone:** adding `Telefon` to a schema used by existing tasks exposes it on all those tasks as `Empty`.
2. **Rename Phone:** renaming `Telefon` to `Kontaktní telefon` preserves datatype and all values.
3. **Save an empty task:** saving a task with Phone `Empty` succeeds and remains `Empty`.
4. **Set an empty Phone:** entering `+420 777 123 456` stores exactly that value.
5. **Replace a Phone:** entering `+420 777 654 321` leaves only the new current value.
6. **Paste a Phone:** pasting `(+420) 777-123-456` stores exactly that content.
7. **Store nonstandard text:** `ústředna +420 123 456 789, linka 42` is unchanged, produces no validation error, and does not block saving.
8. **Store without international prefix:** `777 123 456` remains unchanged; no prefix is added.
9. **Preserve formatting:** `+420 (777) 123-456` retains spaces, parentheses, and hyphen.
10. **Edit Phone:** changing a populated value produces exactly the replacement.
11. **Clear Phone:** clearing returns the task value to `Empty` while retaining the schema definition.
12. **Copy Phone:** copying `+420 (777) 123-456` produces exactly that clipboard content, changes nothing, and initiates no call.
13. **Activate on supported device:** activation requests a call using the stored value and changes no task data.
14. **Activate on unsupported device:** task/value remain unchanged, copy remains available, and no task/save error is shown.
15. **Display Empty Phone:** no call or existing-value copy action is offered.
16. **Duplicate with values:** a new definition is created; populated task values copy to corresponding tasks and empty ones remain `Empty`.
17. **Duplicate without values:** the new definition is `Empty` on every existing task.
18. **Edit source after duplication:** changing a source value does not change the duplicate.
19. **Open removal confirmation:** with 12 non-empty tasks, the dialog says 12 and the property is not yet removed.
20. **Cancel removal:** definition and all values remain unchanged.
21. **Confirm removal:** definition disappears from the schema and all using tasks, and all its values are deleted.
22. **Remove with no populated values:** confirmation still appears and displays zero.

## Explicit Phone hypotheses, now adopted

### H-01 — Whitespace-only means Empty

An input containing only spaces or other whitespace is `Empty`. The user confirmed the implementation interpretation: use Unicode whitespace only to test emptiness; when any non-whitespace character exists, preserve the entire original value, including leading and trailing whitespace.

### H-02 — Device handoff for nonstandard content

Activation attempts to hand off the stored value, but successful interpretation of text, extensions, or multiple-number-like content is not guaranteed. The user confirmed that exact preservation applies to storage/display/copy, while safe standards-compliant URI encoding is allowed at the `tel:` transport boundary.

### H-03 — Duplicate naming

The duplicate's precise generated name follows shared property-duplication rules and is not part of Phone behavior.

## Product clarification record

1. **Change versioning resolved:** "versioned" means logging that a change occurred with a timestamp. Do not retain historical Phone values as property history.
2. **Sensitive-value logging:** log actor, task/property identifiers, operation, timestamp, and outcome; do not put raw Phone values in general logs, traces, analytics, outbox messages, or generic audit evidence.
3. **Safe call URI resolved:** transport encoding may differ from the stored bytes solely to create a safe `tel:` handoff; stored, displayed, edited, and copied content remains exact.
4. **Viewer capabilities resolved:** Viewers may copy and activate populated values; those operations are non-mutating.
5. **Whitespace resolved:** Unicode-whitespace-only becomes `Empty`; otherwise retain the original string exactly.
6. **Deletion race resolved as implementation behavior:** duplicate/remove operations are atomic. At removal confirmation, recompute `Is not empty`; if the count differs from what the user saw, display the new count and require confirmation again.
7. There are no remaining Phone-specific business questions.

## Coaching context from the product document

The initial brief supplied only the property name and Notion inspiration; it did not decide validation, value cardinality, or activation behavior. The final document deliberately makes Phone an optional, single-valued textual property with predictable behavior on both supported and unsupported calling environments.

## Implementation shape discussed

- Implement shared lifecycle behavior once in the ticketing domain: property creation, rename, duplication, removal preview/confirmation, authorization, and change logging.
- Give every property definition a stable identifier independent of datatype so several Phone properties can coexist.
- Prefer sparse value persistence: no value record represents `Empty`; do not persist `""` as a Phone value.
- Keep Phone specialization thin: scalar text, the agreed emptiness predicate, exact presentation/copy, and call activation.
- Duplicate definitions and the optional mapped value snapshot in one transaction.
- Use server-generated UTC timestamps for change-log entries.
- Keep task/property domain persistence owned by the `ticketing` vertical. Use `core-runtime` as infrastructure for transactions, authorization, idempotency, audit, and events.

## Current repository state relevant to later work

Repository constraint: work only in `app/`; `mvp/` and `mvp2/` are read-only.

The `ticketing` vertical is currently a scaffold:

- `app/verticals/ticketing/api/index.ts` serves in-memory/generated ticket data.
- `app/verticals/ticketing/src/actions/create-ticket.ts` exercises CoreSDK but does not persist a task.
- `app/verticals/ticketing/shared/api.ts` contains starter ticket and create-action contracts only.
- `app/packages/core-runtime/src/core-sdk.ts` already wraps action execution, event/outbox persistence, completion, and audit success in a database transaction.
- `app/packages/core-runtime/drizzle.config.ts` includes core/auth schemas only; no ticketing-domain tables or vertical-owned migration arrangement exists yet.

Exploration was read-only. No workspace source files were changed in the Phone discussion. A pre-existing dirty worktree was observed, including agent-instruction edits, a staged deletion under `app/docs/ticketing/`, and generated diagnostics changes. Preserve user-owned changes and inspect status before editing.

## Test seams for the later `to-spec` workflow

The `to-spec` skill must present proposed seams to the user and obtain confirmation before publishing. Recommended seams:

1. **Primary seam:** public Ticketing BFF/action contract through CoreSDK and real persistence. Assert externally observable schema/value behavior, authorization, transactions, counts, and change logging.
2. **Focused browser seam:** rendered Phone control. Assert exact clipboard content, empty-state affordances, role capabilities, and safe `tel:` activation. Do not assert that the external device actually places a call.

Test shared schema/rename/duplicate/removal behavior primarily as generic property-platform behavior. Keep Phone-focused tests for textual preservation, whitespace emptiness, copy, and call activation.

## Deferred shared platform decisions

These are deliberately not Phone-specific questions and should be resolved during consolidated property-platform specification:

- maximum scalar-text value length;
- handling of pasted line breaks and control characters;
- optimistic concurrency and stale-write UX;
- common duplicate-property naming;
- audit-log retention duration and access policy;
- vertical-owned database migration layout.

## Readiness for `to-spec`

- This handoff now contains the complete baseline and Phone business payload plus all settled clarifications.
- Consolidate it with other datatype handoffs before defining the shared property architecture.
- Use project glossary vocabulary and applicable ADRs from the allowed `app/` scope.
- The published spec should use the required Problem Statement, Solution, extensive User Stories, Implementation Decisions, Testing Decisions, Out of Scope, and Further Notes sections.
- Verify issue-tracker and `ready-for-agent` label configuration before publishing. Tracker setup was not established in this task.
- Do not put repository file paths into the published specification.

## Readiness for `to-tickets`

- Prefer the published consolidated specification as the source.
- Draft narrow, demoable tracer bullets crossing persistence, action/API contract, authorization, UI, and tests.
- Separate necessary shared property prefactoring from Phone specialization without creating a horizontal "build all infrastructure" ticket.
- Declare real blocking edges and work the dependency frontier.
- Present ticket granularity and edges to the user for approval before publishing.
- Verify tracker configuration, publish in dependency order, apply `ready-for-agent`, and do not close or modify a parent issue.
- Do not put stale repository paths or implementation snippets into tickets.

## Suggested skills

- `domain-modeling`: consolidate Task, Task Schema, Property Definition, Property Value, Empty, permissions, and change-log terminology across datatype handoffs.
- `to-spec`: invoke after consolidating the baseline and datatype handoffs; confirm test seams and publish the agreed specification.
- `to-tickets`: invoke after an approved specification exists; draft, quiz, and publish tracer-bullet tickets with blocking edges.
- `grilling`: only if the user later asks to stress-test deferred cross-datatype behavior.
- `implement`: only for an approved, agent-ready ticket and only when the user requests coding.
