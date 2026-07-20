# Handoff: task-ticketing Date and Text property review

## Purpose

Return the datatype review from this task to the main task-ticketing thread. The main thread can later consolidate the material with `to-spec`, then derive tracer-bullet work with `to-tickets`. Neither skill has been invoked here.

## Authoritative source artifacts

Read these artifacts in full rather than relying on this compact handoff:

1. Shared task-ticketing baseline: `/tmp/ontos-task-ticketing-handoff.md`
2. Text property GOLD business description: `/Users/jiprochazka/.codex/attachments/8ea93e34-9e45-4bb3-981b-da48071ad5a3/pasted-text.txt`
   - The identical duplicate at `/Users/jiprochazka/.codex/attachments/eb04503c-ea49-468e-a516-2f8c5d9a6897/pasted-text.txt` adds no information.
3. Date property GOLD business description reviewed earlier in this task: `/Users/jiprochazka/.codex/attachments/125c7dde-380b-4c86-bb5c-646b77a0a2ac/pasted-text.txt`

Precedence: the shared baseline applies to every datatype. The explicit decisions below override contradictory wording in a datatype description. Otherwise preserve each datatype description as written.

## Confirmed decisions

### Cross-cutting versioning

- The user chose immutable history, not timestamp-only audit metadata.
- Every accepted persisted mutation must append an immutable revision with its timestamp. An audit event may accompany it but is not a substitute for the revision history.
- A user-facing history browser or restore workflow remains outside the datatype scope unless separately specified.

### Property removal

- Property removal always opens a confirmation dialog, including when no task has a non-empty value.
- The dialog always displays the number of task values matching `Is not empty`, including `0`.
- Confirmation removes the property definition from the shared schema and all of its values; cancellation changes nothing.
- This explicitly overrides Text sections F9, G, H, and the deletion Gherkin scenarios wherever they condition confirmation on at least one non-empty value.

### Date localization

- The earlier locale recommendation was accepted: use explicit product locale mapping rather than ambiguous language-only parsing. Record the current mapping as `cs-CZ` and `en-GB` unless the main thread establishes a different shared locale policy.
- Persist Date as a date-only value; locale affects parsing and display, not storage.

## Implementation decisions ready to carry into a spec

These are technical conclusions from repository inspection and do not change the business behavior.

### Shared schema/value model

- Model task schema, task, property definition, and per-task property value as distinct identities. Multiple properties of one datatype are distinguished by property-definition identity.
- Derive property availability from the shared schema. Do not materialize an empty value row for every task merely because a property exists.
- Treat `Empty` as the absence of meaningful value content. Use an explicit content predicate where a structured value can contain meaningful non-text nodes.
- Make schema mutation, value mutation, duplication, removal, and their immutable revisions atomic and idempotent. Use optimistic concurrency rather than silent last-write-wins.
- Duplication with values must deep-copy each task's current value into a new independent property; duplication without values creates no meaningful value rows.

### Date

- Canonical API representation: ISO `YYYY-MM-DD`.
- Canonical database representation: PostgreSQL `DATE`, never a timestamp and never a serialized JavaScript `Date` instant.
- Validate calendar existence on both client and server. Do not use permissive `Date.parse` for localized manual input.
- `Today` is the current client-local calendar date and opening or navigating the picker never persists a value.
- The installed `@techsio/ui-kit` 0.23.0 has Popover, Input, Button, and Dialog but no Calendar/DatePicker. The implementation must either consume a future UI-kit DatePicker or build a ticketing-owned accessible composite using UI-kit controls plus an appropriate headless calendar engine.

### Text

- Store canonical rich text as a schema-versioned structured document, preferably JSON/JSONB, not HTML as the source of truth.
- Maintain a derived readable-text projection for search, text filtering, and sorting. Visual formatting must not affect comparisons.
- Store Core Mention and Relation nodes with stable target identity and type, not only their rendered labels. Maintain any reference edges needed by Core lifecycle and authorization behavior.
- Whitespace-only documents are `Empty`; meaningful structured inline nodes such as Mention, Relation, or equation make a value non-empty even when ordinary text is absent.
- Sanitize pasted content and hyperlinks. Flatten unsupported block structure into readable inline content while preserving supported inline marks.
- Apply a Core/platform payload-safety limit even though Text has no datatype-specific business length limit.
- A practical revision boundary is each accepted debounced save, with a flush on blur/navigation, rather than every keystroke. Each accepted save appends one immutable revision. This is an implementation recommendation, not separately confirmed business behavior.
- The installed UI kit has no rich-text editor, and the workspace has no editor engine. The rich-text editor should be ticketing-owned because it integrates domain references, while using UI-kit controls for toolbar actions, menus, popovers, dialogs, and feedback.

### Authorization

- Keep task-value permissions separate from shared-schema permissions. At minimum the implementation needs resource-level capabilities equivalent to `read`, `edit_task_value`, `manage_schema`, and `share_schema`.
- Full access and Editor can manage property definitions; User can edit values but cannot mutate schema/configuration; Viewer is read-only. Full access alone has sharing capability.
- CoreSDK currently describes SpiceDB authorization against a fixed resource object ID. Real task/schema actions need dynamic resource targeting derived from the validated request.

## Current repository state

- Work only under `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/app`; `mvp/` and `mvp2/` are read-only.
- No implementation was performed in this task and no workspace files were changed.
- The ticketing vertical is still a generated scaffold:
  - `app/verticals/ticketing/api/index.ts` serves in-memory sample items.
  - `app/verticals/ticketing/src/pages/ticketing-experience.tsx` exposes a demo Create Ticket action.
  - `app/verticals/ticketing/src/policies/index.ts` is empty.
  - `app/scripts/spicedb/schema.zed` contains only generic resource permissions.
  - There is no ticketing-owned task/property persistence model yet.
- Core runtime already provides transactional actions, domain/audit events, outbox support, and a generic search-index table, but not the ticketing domain behavior or shared text-normalization/Mention/Relation services required by the Text description.
- The worktree contained pre-existing unrelated changes during inspection. Preserve them and inspect status before any later edits.

## Core dependencies delegated by the Text description

The Text business description intentionally delegates these behaviors to Core, but they are not implemented or fully specified in the current `@app` scaffold:

- property-name validation;
- case, diacritic, Unicode normalization, and collation rules for comparison;
- Core Mention and Relation selection, authorization, rendering, and deleted/unavailable-target lifecycle;
- how Mention/Relation readable labels participate in search and sorting.

The main spec should define these as shared Core contracts or explicit dependencies, not silently invent Text-only rules.

## Testing seam proposal for `to-spec`

Before publishing a spec, present this seam proposal to the user as required by `to-spec`:

1. Use the public ticketing BFF/API contract as the main high-level seam for schema/value mutations, immutable revision creation, duplication, removal counts, and search/filter/sort results.
2. Add focused interaction/accessibility tests only for behaviors that cannot be proven through the API seam: localized Date input/calendar navigation and the structured Text editor/paste/reference interactions.
3. Prefer externally observable assertions and the supplied Gherkin outcomes; avoid testing storage layout or editor-library internals.

## Guidance for later `to-spec`

- Synthesize the baseline plus both datatype artifacts; do not re-interview the user about decisions recorded above.
- Use the task-schema/property-definition/property-value vocabulary consistently.
- Include the repository gaps, immutable-history requirement, dynamic authorization target, storage contracts, Core dependencies, and testing seams under implementation/testing decisions.
- Preserve datatype out-of-scope lists, with one clarification: Text's exclusion of “version history” excludes a datatype-specific history UI, not the required immutable persistence history.
- Check whether the issue tracker and `ready-for-agent` label vocabulary are configured. If not, invoke `setup-matt-pocock-skills` before publishing as directed by `to-spec`.

## Guidance for later `to-tickets`

- Invoke only after a consolidated spec exists and its proposed testing seams have been confirmed.
- Build tracer-bullet vertical slices that each cross persistence, action/API contract, authorization, UI, immutable revision, and externally observable tests.
- Account for shared foundation work before datatype slices: dynamic resource authorization, task/schema/property identity, immutable revision journal, and Core reference/normalization contracts.
- Keep Date and Text behavior in independently demoable slices once the shared foundation permits it.
- Declare genuine blocking edges and quiz the user on granularity/edges before publishing, as required by `to-tickets`.
- Check tracker configuration before publication; do not modify or close a parent issue.

## Open questions

There are no remaining datatype business questions from this task. Editor-engine selection, DatePicker composition, persistence layout details, autosave timing, and indexing strategy are implementation choices to settle in the consolidated spec or tickets without changing the recorded behavior.

## Suggested skills

- `to-spec`: next, in the main thread, to synthesize the baseline and datatype artifacts into the tracker after confirming the proposed test seams.
- `to-tickets`: after the consolidated spec is accepted, to create user-reviewed tracer-bullet tickets with explicit blocking edges.
- `domain-modeling`: if the main thread needs to formalize the shared vocabulary and Core boundaries before the spec.
- `techsio-ui-kit-ai:ui-kit-workflow-orchestrator`: when implementation begins to route Date picker and rich-text UI work correctly.
- `implement`: only after the spec/tickets exist and the user explicitly requests implementation.
