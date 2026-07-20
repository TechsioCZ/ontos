# Handoff: Number property back to the ticketing main task

## Purpose

Continue the Notion-inspired task-property work by incorporating the Number datatype into the ticketing baseline, then prepare it for `to-spec` and `to-tickets` in the main task. Do not implement yet unless the user explicitly requests implementation.

## Authoritative inputs

- General task-property baseline: `/tmp/ontos-task-ticketing-handoff.md`
- Number property business description and BDD scenarios: `/Users/jiprochazka/.codex/attachments/51b7e5c8-2729-4463-9666-f21b26b63d3c/pasted-text.txt`
- Repository instructions: `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/AGENTS.md` and `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/app/AGENTS.md`

Do not copy the full requirements from those artifacts into another document. Treat the baseline and Number description together as the product source.

## Outcome of this discussion

The Number description is ready to proceed to specification. Its core rules are compatible with the baseline: a shared property definition, one independent value per task, `Empty` distinct from `0`, display-only formats, numeric filtering and sorting, and transactional duplication with an explicit copy-values choice.

One textual error in the source document must be treated as a typo: the edge-case section says `5` is less than `0`; the confirmed correction is `5 > 0`.

The document's “Explicit hypotheses” are now confirmed as decisions:

1. Decimal input/display follows the active user locale.
2. Stored values are locale-independent.
3. Group separators follow the active user locale.
4. A duplicate receives an automatically distinguishable name.
5. Empty values are always sorted last in both ascending and descending order.
6. The `!=` / `<>` / `≠` operator does not include empty values; empty values are handled only by `Is empty`.

No workspace files were changed during this discussion.

## Confirmed implementation decisions

These are confirmed implementation decisions, not additional business scope.

- Use the canonical split `NumberPropertyDefinition` for shared schema configuration and `TaskNumberValue` for a task's value. Keep schema-level commands separate from value edits for authorization.
- Represent `Empty` as the absence of a value row; store `0` as a real value row. Creating a property therefore does not need to backfill every task.
- Keep the format on the property definition as a closed enum such as `number`, `number_with_separators`, and `percent`. A format change never rewrites values.
- Store decimal values in PostgreSQL `numeric`, not floating point. Carry them across API boundaries as canonical decimal strings so JavaScript does not lose precision.
- Use `numeric(38,18)` as the concrete numeric bound, validated before persistence. Reject scientific notation, `NaN`, infinity, and a leading plus sign.
- Let the editor hold incomplete transient states such as `-` or a trailing locale decimal separator, but never persist them. The server remains authoritative.
- Reject the whole invalid paste and retain the previous valid editor value, rather than silently converting `12a5` to `125`.
- Execute property creation/duplication, optional value snapshotting, schema ordering, and revision/event emission in one database transaction. The duplicate copies values from one consistent snapshot.
- Protect deletion confirmation from races by returning the property version with the `Is not empty` count and requiring that version on deletion. If it changed, refresh and reconfirm.
- Implement comparisons against the stored numeric value. For both directions use database ordering equivalent to `NULLS LAST`, with a deterministic secondary task ordering.
- Treat filter and sort as read operations available to every actor who can view the task collection/schema, including Viewer. Mutations follow the baseline capability split.
- Interpret “every change is versioned with a timestamp” as audit metadata only, not reconstructable append-only history. Record enough metadata for auditability, including server-generated UTC timestamp and actor/action identity. Undo/restore remains out of MVP.

## Current repository state and architectural seam

- Work only under `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/app`; `mvp/` and `mvp2/` are read-only.
- Ticketing is still a scaffold: `app/verticals/ticketing/shared/api.ts` models a simple item with title, and `app/verticals/ticketing/api/index.ts` serves an in-memory starter array. There is no task/property persistence model yet.
- `app/verticals/ticketing/src/actions/create-ticket.ts` demonstrates the existing Core SDK pattern for authorized, audited, idempotent mutations and domain events. Reuse that action seam for schema and value commands.
- The existing database client in `app/packages/core-runtime/src/db/client.ts` registers Core-owned schema only. Ticketing-owned persistence and its migration ownership need to be established without moving ticketing domain tables into Core merely for convenience.
- Design the generic property-definition identity and typed-value persistence before specializing Number. A Number-specific JSON blob would make later typed filtering, constraints, and indexing unnecessarily difficult.
- Preserve unrelated user work. At handoff time the worktree already contained changes to both `AGENTS.md` files, deletion of `app/docs/ticketing/task-properties.md`, and a modified generated Module Federation diagnostics file. Inspect `git status` before any write and do not restore or overwrite those changes.

## Suggested acceptance-test seam

Use one high public seam: the typed Ticketing Effect HTTP API backed by a real PostgreSQL test database. Exercise create/edit/clear, format change, filter, sort, duplicate with and without values, deletion impact count, permissions, concurrency/version conflicts, and audit timestamps through that seam.

Use focused UI/component tests only for behavior the API cannot prove: locale-aware input, transient invalid editing, display formatting, and mandatory confirmation interactions. Avoid tests that assert internal table layout or helper implementation.

The user confirmed this API-level acceptance-test seam.

## Preparation for later skills

### Before `to-spec`

All previously open product and implementation clarifications have been answered in this handoff. Verify that the issue tracker and `ready-for-agent` triage vocabulary are configured. If not, the main task should use `setup-matt-pocock-skills` before publishing.

Then invoke `to-spec` to synthesize the baseline plus Number description. It must reference the source artifacts, use the canonical schema-definition/value terminology, include the selected API acceptance-test seam, and avoid another broad product interview.

### Before `to-tickets`

Invoke `to-tickets` only after the user approves the published spec. Draft narrow, demonstrable vertical slices rather than database/API/UI horizontal layers. Likely slice boundaries are:

- a persisted Number property and task value through API and UI;
- locale-safe edit/clear/display behavior;
- numeric filters and stable null-last sorting;
- schema format changes;
- transactional duplication with and without values;
- deletion impact confirmation and concurrency protection;
- permissions plus audit timestamp evidence.

The ticket skill must quiz the user on granularity and blocking edges before publishing. Each published ticket should name its blockers and fit one fresh context window.

## Suggested skills

1. `domain-modeling` — resolve canonical terms and any ambiguity between the shared property definition, task value, schema owner, revision, and audit event. Only update a glossary when terms are actually agreed.
2. `to-spec` — publish the agreed Number-property specification with `ready-for-agent`.
3. `to-tickets` — after spec approval, publish tracer-bullet tickets with blocking edges.
4. `implement` — only when the user asks to execute an approved ticket/spec.
5. `techsio-ui-kit-ai:ui-kit-workflow-orchestrator` — first when implementation reaches ticketing UI work, as required by `app/AGENTS.md`; route to the relevant input, select/menu, dialog, table, and validation skills.
6. `rstest-best-practices` — when writing the agreed API and UI acceptance tests.
