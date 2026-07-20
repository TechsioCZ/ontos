# Handoff: Ticketing Text property ready for specification

## Purpose of the next task

Consolidate the agreed task-ticketing baseline and the `Text` property business description into a publishable specification, then later break the approved specification into tracer-bullet tickets. Do not begin implementation unless the user explicitly requests it.

## Authoritative inputs

- General task-ticketing baseline: `/tmp/ontos-task-ticketing-handoff.md`
- Detailed `Text` property business description: `~/.codex/attachments/eb04503c-ea49-468e-a516-2f8c5d9a6897/pasted-text.txt`
- Repository scope: work only under `app/`; `mvp/` and `mvp2/` are read-only.
- Repository instructions: `app/AGENTS.md`

Do not duplicate the full contents of those inputs in another artifact; read and reference them.

## Explicit precedence and resolved decisions

The user confirmed the following implementation-relevant interpretations:

1. Every property deletion requires confirmation, even when the non-empty value count is zero. The dialog displays the count of values matching `Is not empty`.
2. “Every change is versioned with a timestamp” means an internal revision plus an audit record/timestamp. User-facing history, restore, and rollback remain out of scope.
3. Ignore `app/docs/ticketing/task-properties.md` entirely. It is staged for deletion and is not authoritative. Do not carry over its extra decisions about Title, mandatory properties, name uniqueness, ordering, or views unless separately defined by the two authoritative inputs or explicitly decided later.

Where the baseline and datatype document differ, the decisions above govern. Do not silently resolve any other material conflict.

## Agreed domain language

- `Task Collection`: owns one shared property schema and contains Tasks.
- `Task Property Definition`: a schema-level property shared by all Tasks in one Task Collection.
- `Task Property Value`: the independent value of one property for one Task.
- `Text Property Value`: empty or a single multi-line inline-rich-text value; it is not a second content canvas.
- `Core Reference`: a Core-provided Mention or Relation stored by stable identity rather than copied display text.

Keep schema mutations distinct from per-Task value edits and from view-only presentation concerns.

## Business behavior already settled

Treat the detailed Text document as authoritative for rich-text formats, paste flattening, search, filters, sorting, rename, duplication, deletion, Mentions, Relations, and its BDD scenarios. Important cross-cutting points are:

- Creating a property changes the collection schema and makes it available to every existing and future Task with an Empty value.
- Multiple independent properties of the same datatype are allowed.
- Text supports multiple lines and inline marks, hyperlinks, equations, Core Mentions, and Core Relations, but no independent block elements.
- Whitespace and empty lines alone are Empty.
- Search and comparison use readable text independent of visual formatting and inherit Core normalization rules.
- Empty values sort last in both ascending and descending order.
- Duplication always asks whether to copy current values; copied rich text and Core identities become independent values in the duplicate.
- Property removal deletes the definition and all its values after the always-required count-bearing confirmation.
- Full access and Editor may mutate the shared property schema; User may edit values only; Viewer is read-only. Full access also includes sharing.

Implementation defaults recorded during discussion, unless contradicted by a later product decision:

- A Mention, Relation, or inline equation alone is non-empty; whitespace and line breaks alone are empty.
- Copy and delete operations are atomic.
- A deletion preview should carry the current schema revision; reject or refresh stale confirmation rather than delete against a misleading count.
- Copying references preserves their target identities, not merely labels.

## Current repository state

Ticketing is a generated scaffold rather than an implemented task system:

- `app/verticals/ticketing/api/index.ts` lists a hard-coded item and returns a generated create response without persistence.
- `app/verticals/ticketing/shared/api.ts` exposes only a minimal item with `id` and `title` plus readiness/scaffold endpoints.
- `app/verticals/ticketing/src/actions/create-ticket.ts` validates a target ID and emits an outbox message but does not create a Task.
- `app/scripts/spicedb/schema.zed` only has generic `read`/`create` and module-state permissions; the four access levels are not modeled.
- `app/verticals/ticketing/package.json` has no rich-text editor dependency.
- No Core Mention/Relation contract or implementation was found.
- PostgreSQL/Drizzle infrastructure exists in `app/packages/core-runtime`, but no ticketing-owned persistence schema exists.

The worktree already contains user-owned staged/modified files. Preserve them and do not restore or reuse the deleted task-properties document.

## Proposed implementation shape for the future specification

Prefer one deep Ticketing domain module whose interface is used by transports and tests. Its implementation should own schema invariants, value normalization, atomic copy/delete behavior, revisions, and audit emission. Transport handlers should remain adapters rather than duplicating business rules.

Recommended persistence model:

- Task Collection with a schema revision.
- Task Property Definition with stable ID, collection ID, datatype, name/configuration, revision, and timestamps.
- Task with collection ID and revision/timestamps.
- Task Property Value keyed by Task ID plus Property Definition ID, with datatype payload, revision, and timestamps.
- Absence of a value row may represent Empty, avoiding fan-out inserts when a property is created.
- Text payload is a versioned structured inline document. Derive a canonical plain-text/search projection and canonical emptiness from it.
- Ticketing should own its domain tables; do not turn `core-runtime` into the ticketing domain model.

Core dependencies need explicit interfaces for property-name validation, text normalization/collation, Core Reference serialization and resolution, unavailable-target rendering, reference contribution to search text, and access-level authorization. The business document delegates these behaviors to Core, but the repository does not yet provide them.

## Proposed highest test seam

Use the Ticketing domain/command interface as the primary seam, with a smaller number of end-to-end contract tests through the Effect BFF transport. Test observable behavior rather than database layout or editor internals.

The specification should cover at least:

- schema propagation without requiring materialized empty rows;
- independent values for different Tasks and different property IDs;
- complete rich-text round trips and paste flattening;
- canonical Empty behavior for whitespace-only input;
- formatting-insensitive search and every defined filter;
- ascending and descending sorting with Empty last;
- permissions for schema mutations versus value edits;
- atomic duplication with and without values, preserving reference identities;
- count-bearing deletion confirmation, cancellation, stale-preview handling, and confirmed deletion;
- revision/timestamp and audit evidence for every mutation;
- concurrency around duplication, deletion preview/confirmation, and value edits.

## Out of scope

Retain the exclusions from the detailed Text document, including a second block canvas, attachments and embeds inside Text, custom Mention/Relation behavior, property type conversion, inline comments, user-facing version history, AI generation, automations/formulas, and choosing a technical editor/storage library as a business requirement.

Do not infer the discarded document's behavior for Title, mandatory fields, ordering, views, or property-name uniqueness. If those become necessary to specify the first executable slice, surface them as separate missing product behavior rather than importing the deleted decisions.

## Suggested skills

1. `to-spec`: invoke in the main task when the user wants the agreed requirements published. Use the authoritative inputs and decisions above; do not interview again about resolved items. Verify the issue tracker and `ready-for-agent` vocabulary are configured first.
2. `to-tickets`: invoke only after the specification exists and the user asks for tickets. Draft narrow, demoable vertical slices with explicit blocking edges, quiz the user on granularity/edges, then publish after approval.
3. `domain-modeling`: use if new terminology must be resolved; do not create a glossary entry from the discarded document.
4. `codebase-design`: use to keep the Ticketing domain module deep and the transport/persistence/Core integrations as adapters at clear seams.
5. `implement`: use only after an actionable specification or approved tickets exist and the user explicitly requests implementation.

Do not invoke `to-spec` or `to-tickets` merely by reading this handoff; wait for an explicit request in the main task.
