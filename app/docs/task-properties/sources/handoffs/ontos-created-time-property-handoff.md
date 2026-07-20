# Handoff: Created time property for task ticketing

## Purpose

Return the completed `Created time` datatype discussion to the main task-ticketing thread. The main thread should consolidate this handoff with the remaining datatype documents and may later invoke `to-spec` and `to-tickets`. Do not implement from this handoff unless the user explicitly requests implementation.

## Source artifacts

This handoff is self-contained for later synthesis. The source artifacts remain linked for exact original wording and verification:

- General task-ticketing baseline: `/tmp/ontos-task-ticketing-handoff.md`
- GOLD business specification for `Created time`: `/Users/jiprochazka/.codex/attachments/7f4fb6af-69fd-4cd8-b809-fcbf67400b24/pasted-text.txt`
- Repository: `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/app`
- Repository instructions: `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/AGENTS.md` and `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/app/AGENTS.md`

The GOLD document is the authoritative source for user-visible behavior, acceptance criteria, edge cases, Gherkin scenarios, and out-of-scope items. Its H1-H4 hypotheses are accepted as business behavior for this datatype.

## Complete product-owner business contract

### Executive summary and business goal

`Created time` automatically records the instant a Task comes into existence. The value is created when the system creates the new Task record and opens its blank canvas, even if `Title` and content remain empty. It is read-only and immutable for the Task's lifetime. Every user sees a local representation of the same instant in their own time zone.

The business goal is to provide a trustworthy, immutable creation fact so users can distinguish newer from older Tasks, sort and filter by creation date or time, and use the fact in overviews and working views. The behavior follows the Notion principle of an automatically produced, non-editable item-creation timestamp. The product-owner document rates the definition GOLD because creation timing, editability, immutability, time-zone display, precision, existing-Task behavior, edge cases, and testability are defined.

### Actors

- **Task-system user:** creates and edits Tasks, views `Created time`, sorts and filters Tasks, and may have a personal time zone.
- **Schema administrator:** may add the property to the shared Task schema, rename it, duplicate it, and remove it, subject to the general schema-management authorization model.

### In scope

1. Creating a Task Property of type `Created time`.
2. Automatically determining the value when the Task comes into existence.
3. Creation behavior for a blank Task canvas without `Title` or content.
4. Display in the current user's time zone, including daylight-saving rules.
5. Standard and detailed display precision and locale-aware formatting.
6. Value immutability and complete non-editability.
7. Exposure of original creation instants for existing Tasks.
8. Ascending and descending chronological sorting.
9. Instant-based and local-calendar-based filtering.
10. Renaming, duplicating, and removing the Task Property definition.

### Out of scope

- `Created by`, `Last edited time`, and `Last edited by`.
- History of individual Task edits.
- Correcting, overriding, or manually setting a creation instant.
- Importing or migrating creation times from external systems.
- Automatic deletion rules for abandoned blank Tasks.
- The business specification of the technical storage mechanism. This discussion nevertheless records an implementation decision below so later engineering work is deterministic.
- General schema-management permission design beyond the baseline access model.
- System logging and audit infrastructure.

### F1 — Property type and definition

- The Task Property type is `Created time` and its default name is `Created time`.
- A schema administrator can rename the definition. Renaming changes neither its type, value source, nor behavior.
- The definition belongs to the shared Task schema and becomes available on every Task using that schema.
- Multiple independently named definitions of this datatype may exist in the same schema through duplication.

### F2 — Exact moment a Task is created

- A Task comes into existence when the system creates its durable record and opens the blank Task canvas.
- `Title`, canvas content, and values for other Task Properties are not prerequisites for creation.
- `Created time` is that creation instant. Entering the first content later, even hours later, never moves it.

### F3 — Automatic and non-empty value

- The system assigns the value automatically and never prompts the user to enter it.
- Every existing Task has exactly one system creation instant, whether or not its schema currently exposes a `Created time` definition.
- For a created Task, projected `Created time` is never `Empty`.
- The value represents both date and time, not only a calendar date.

### F4 — Immutability

The creation instant does not change when any of the following occurs:

- `Title` is first entered, renamed, or otherwise changed;
- canvas content changes;
- another Task Property value changes;
- the Task moves;
- Task status changes;
- the Task is reopened;
- the `Created time` definition is renamed;
- the property is hidden and shown again.

### F5 — Non-editability

- No user, including one with schema-management access, can manually enter, overwrite, clear, paste over, change only the date, change only the time, or set the value to `Empty`.
- The property offers no value-editing control.
- Server behavior must preserve this rule even when a caller bypasses the UI.

### F6 — Existing Tasks

When a schema administrator adds `Created time` to a schema already used by Tasks:

- the property appears for every Task using that schema;
- every Task shows its original historical creation instant;
- no value is the property-addition time;
- no existing Task has an `Empty` value;
- no value backfill or copied snapshot is conceptually created because the underlying fact already exists.

### F7 — Time zone

- The system maintains one shared absolute creation instant per Task.
- Each current user sees it in that user's time zone. Different users may therefore see different local times or even different calendar dates while viewing the same instant.
- Changing the user's time zone changes display only, never the stored instant.
- Display observes the daylight-saving and standard-time rules applicable to the chosen time zone at the creation instant.

### F8 — Precision and formatting

- Standard display shows precision to minutes.
- A detailed value view exposes precision to seconds.
- Date and time are formatted for the user's locale/environment.
- Hiding seconds in standard display never reduces the precision used by sorting or filtering.
- The confirmed engineering precision is milliseconds in persistence and transport; this may distinguish Tasks whose standard or detailed text looks equal.

### F9 — Sorting

- Users can sort ascending and descending by `Created time`.
- Ascending places older Tasks before newer Tasks; descending places newer Tasks before older Tasks.
- Sorting uses the absolute creation instant, not formatted text.
- A user's time zone cannot change chronological order.
- Tasks displayed in the same minute must still sort by their more precise instants. Equal stored instants may use a deterministic secondary key.

### F10 — Filtering

Supported temporal conditions are:

- exactly;
- before;
- after;
- on or before;
- on or after;
- within a specific local calendar day or calendar period.

Evaluation rules:

- All comparisons operate on the real creation instant.
- A condition containing a time uses the available value precision.
- The confirmed exact-filter UI semantics are second-granular: an exact second denotes the half-open interval covering that whole second, so invisible milliseconds remain matchable.
- A date-only condition uses the start and end boundaries of that local day in the current user's IANA time zone.
- Initial calendar-period scope is an exact day and a custom date range. Local ranges are converted into half-open absolute-instant ranges.
- Changing time zone can change a date-only or local-range result because local day boundaries move.
- Changing time zone cannot change a result based on an exact absolute instant.

### F11 — Duplication

- Duplicating the definition creates a new, independent Task Property definition of type `Created time`.
- The duplicate inherits the source definition's display configuration and receives its own name.
- The system does not ask whether to copy values. This datatype-specific rule overrides the baseline rule that normally asks on every duplication.
- Both definitions expose the same Task creation instant for a given Task.
- Later renaming or removing either definition does not affect the other.

### F12 — Removal

- Removal deletes the definition from the shared schema and makes it disappear from every Task using that schema.
- Every removal begins with a confirmation dialog; the definition remains until the administrator confirms.
- The dialog shows the number of Tasks for which the property `Is not empty`. Because every existing Task has a creation instant, this equals the number of existing Tasks using the schema.
- Removing the definition never changes or deletes any Task's historical creation instant.
- Adding a new `Created time` definition later exposes the original instants again rather than generating new values.

### Edge cases G1–G8

1. **Abandoned blank Task:** opening the canvas has already created the Task and a valid instant even if `Title` and content remain empty. Automatic cleanup is out of scope.
2. **Delayed first edit:** content entered hours after opening does not move the original instant.
3. **Task predating the property:** adding the definition reveals the historical instant rather than property-addition time.
4. **Creation near midnight:** users in different zones may see different dates for the same absolute instant.
5. **User changes time zone:** displayed date/time and date-only filter results may change; the absolute instant, chronological order, and exact-instant filter results do not.
6. **Two Tasks displayed in the same minute:** more precise system instants determine their order even when standard text is identical.
7. **Daylight-saving transition:** local display uses the zone rules valid at the creation instant.
8. **Remove and re-add:** the re-added definition reveals each original instant and does not create a new one.

### Acceptance criteria

1. Opening a new blank Task canvas creates a Task and its creation instant.
2. The instant is created without a `Title`.
3. The system supplies the value automatically.
4. A created Task never projects `Created time = Empty`.
5. A user cannot change or remove the value.
6. Editing or otherwise changing the Task does not change the value.
7. Adding the definition for existing Tasks exposes their original instants.
8. Standard display uses minute precision.
9. Detailed display exposes second precision.
10. Display uses the current user's time zone.
11. Changing time zone does not change the actual instant.
12. Sorting is chronological by the actual instant.
13. Date filtering respects the current user's time zone.
14. Renaming the definition changes neither values nor behavior.
15. Duplicated definitions expose the same instant for each Task.
16. Removing the definition requires confirmation and reports the affected Task count.
17. Re-adding the datatype exposes the original instants.

### BDD scenario inventory

The later specification and tickets must preserve coverage for all scenarios in the product-owner Gherkin:

1. Create the instant when opening a blank canvas at a known second.
2. Keep the instant when `Title` remains empty.
3. Keep the instant after a delayed first edit.
4. Reject an attempted value change.
5. Reject an attempted value clear.
6. Preserve the instant across first `Title`, renamed `Title`, canvas edit, another property edit, Task move, and status change.
7. Add the definition to Tasks created on different historical dates without using definition-addition time or `Empty`.
8. Show two local representations of the same instant to users in different zones.
9. Change only presentation after the current user changes zone.
10. Show minutes in standard display and seconds in detailed display.
11. Sort newest-first, oldest-first, and distinguish different seconds within one displayed minute.
12. Filter on-or-after a concrete instant and filter by a local calendar date near midnight.
13. Rename the definition without changing type, source, or values.
14. Duplicate without a copy-values prompt and show the same instant through both definitions.
15. Show the non-empty Task count before removal and do not remove before confirmation.
16. After confirmed removal, remove the definition everywhere while preserving historical instants.
17. Re-add the datatype and expose the original instant rather than a new one.

### Accepted H1–H4 hypotheses

- **H1 — Shared schema:** the definition is a normal part of the shared Task schema, so adding or removing it affects every Task using that schema.
- **H2 — Independent historical fact:** a Task has its creation instant even when the schema does not expose it.
- **H3 — Duplication does not copy values:** duplicates project the same system fact, so no copy-values prompt is shown.
- **H4 — Removal preserves history:** removing the definition does not delete the Task's creation fact.

## Confirmed decisions from this discussion

- `Created time` is an intrinsic, immutable fact of a Task, not an independently stored Task Property Value.
- The Task creation instant is assigned when the durable empty Task record is created for the newly opened blank canvas. `Title` and content are not prerequisites.
- Creation must be an idempotent server operation. The server/database assigns the Task ID and creation instant; retries must return the same Task and instant.
- A `Created time` Task Property definition exposes the Task's intrinsic creation instant. Adding it requires no value backfill; removing it does not delete that instant; duplicating it creates another independent definition that exposes the same instant.
- The datatype-specific duplication rule overrides the baseline general rule: do not ask whether values should be copied for `Created time`.
- No value-editing interface is exposed for `Created time`, and generic value mutation must reject forged attempts server-side regardless of access level.
- Sorting and filtering operate on the real instant rather than formatted text. A deterministic secondary key may resolve equal instants without changing chronological semantics.
- Standard display shows minute precision; detail display shows seconds. Display formatting is separate from storage and query evaluation.
- Persist and transport the instant with millisecond precision.
- An exact filter entered to second precision covers that entire second, avoiding equality against invisible milliseconds.
- Initial calendar filter scope is exact local day plus custom local date range.
- Persist a per-user IANA time-zone identifier such as `Europe/Prague`. Browser detection supplies only the initial default.
- The API should transport an absolute instant. Presentation uses the current user's locale and persisted IANA zone.
- Date-only and date-range filters are interpreted as local calendar ranges in the current user's IANA zone and converted to half-open instant ranges. Exact-instant filters remain zone-independent.
- Task creation and Task Property definition changes participate in the baseline timestamped versioning model. There are no mutable `Created time` value versions to copy or edit.

## Codebase findings

The ticketing vertical is currently a scaffold rather than a persisted Task model:

- `verticals/ticketing/shared/api.ts` models a starter `TicketingItem`, requires `title` for its create payload, and supports only `limit` on list queries.
- `verticals/ticketing/api/index.ts` serves an in-memory starter item and does not persist Tasks.
- `verticals/ticketing/src/actions/create-ticket.ts` validates a client-supplied target resource ID and emits action/outbox data but does not insert a Task.
- `verticals/ticketing/src/pages/ticketing-experience.tsx` currently exposes only a scaffold create-action button rather than an empty Task canvas flow.
- `packages/core-runtime/src/db/schema.ts` establishes the existing PostgreSQL/Drizzle convention of non-null timezone-aware timestamps, but there is no ticketing-owned Task, Task Collection, Task Property definition, or Task Property value schema yet.
- `packages/core-runtime/src/db/auth-schema.ts` has no persisted user time-zone preference.

Consequently, `Created time` is not an isolated field change. The foundational Task lifecycle, Task Collection schema, persistence adapter, property-definition model, query semantics, and user preference source must exist in an implementation slice.

## Recommended module shape

Use a deep Task ticketing module with a small external interface covering user-observable operations:

- create and open an empty Task in a Task Collection;
- manage Task Property definitions at the shared-schema seam;
- read projected Task Property values;
- list Tasks with typed sorting and filtering.

Keep these details inside its implementation:

- database timestamp assignment and idempotent creation;
- projection of every `Created time` definition onto the same Task creation instant;
- direct query compilation to the Task creation column;
- conversion of local calendar filters through an IANA time zone;
- standard/detail locale-aware formatting;
- server-side denial of derived-value mutations.

Avoid a materialized Task Property Value row for `Created time`; it would introduce backfill, synchronization, duplication, deletion, and emptiness states prohibited by the business specification.

## Proposed testing seam for a later `to-spec` run

Before publishing the spec, propose this seam to the user as required by `to-spec`:

- Primary/highest seam: the public ticketing command/query interface with a real persistence adapter, exercising empty Task creation, schema operations, derived value projection, sorting, filtering, permissions, and idempotency as external behavior.
- Presentation seam only where necessary: formatter behavior for locale, IANA zone, DST, minute display, and second detail. Do not test framework internals or duplicate domain assertions in UI implementation tests.
- UI acceptance coverage should verify that opening a blank canvas creates the Task and that no value editor is offered, while detailed edge cases remain behind the primary interface.

The user has confirmed all outstanding product choices from this discussion. There are no remaining `Created time` business blockers.

## Repository safety

- Work solely in `app/`; `mvp/` and `mvp2/` are read-only.
- The worktree already contained unrelated/staged changes when inspected. Preserve them and review current `git status` before any future edits.
- This discussion made no workspace changes. Only this temporary handoff was created.

## Suggested skills

1. `domain-modeling` in the main thread when consolidating Task, Task Collection, Task Property definition, derived Task Property value, user preference, permission, and version terminology across datatype handoffs.
2. `to-spec` only after the main thread decides the relevant datatype documents are consolidated. Use this self-contained handoff as the synthesis input, consult the linked sources only for verification, inspect current repository/ADR state, propose the testing seam to the user, then synthesize and publish the specification. Do not re-interview the user about the confirmed decisions in this handoff.
3. `to-tickets` only after the specification is published and the user asks for ticketing. Pass the published spec reference, draft narrow end-to-end tracer bullets with genuine blocking edges, and complete the skill's user review before publishing tickets.
4. `implement` only after approved tickets/specification exist and the user explicitly asks to implement a frontier ticket.

If the issue tracker and `ready-for-agent` triage vocabulary are not configured when `to-spec` or `to-tickets` is invoked, run `setup-matt-pocock-skills` first as those skills require.
