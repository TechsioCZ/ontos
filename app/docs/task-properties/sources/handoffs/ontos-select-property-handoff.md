# Handoff: Task ticketing — Select property

## Purpose of the next session

Return this work to the main task so it can first be synthesized and published with `to-spec`, then—after the specification is accepted—broken into tracer-bullet implementation tickets with `to-tickets`.

Do not implement the feature from this handoff directly, and do not call either publishing skill until the user requests it in the main task.

## Authoritative source documents

Do not reproduce or reinterpret the full business behavior; read these documents in full:

1. General task-property baseline: `/tmp/ontos-task-ticketing-handoff.md`
2. Select property business description and BDD scenarios: `/Users/jiprochazka/.codex/attachments/b679753b-72bc-4940-a3b5-9e4943910f6e/pasted-text.txt`

The Select document is GOLD/readiness-complete for business behavior. Preserve the baseline semantics alongside it. If a future datatype document materially conflicts with the baseline, surface the conflict rather than resolving it silently.

## Repository constraints and current state

- Repository: `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos`
- Work only under `app/`; `mvp/` and `mvp2/` are read-only.
- The ticketing vertical is still a generated scaffold, not an existing task-property implementation.
- `app/verticals/ticketing/api/index.ts` serves an in-memory demo item list.
- `app/verticals/ticketing/shared/api.ts` exposes placeholder title-only ticketing contracts.
- `app/verticals/ticketing/src/actions/create-ticket.ts` is a synthetic CoreSDK action, not real task creation.
- No Task Schema, Task Property Definition, Select Option, Task Property Value, or ticketing-owned persistence currently exists.
- Existing working-tree changes belong to the user. In particular, do not restore the staged deletion of `app/docs/ticketing/task-properties.md` or overwrite changes to `app/AGENTS.md` and generated diagnostics.
- This discussion made no workspace changes.

## Domain vocabulary to use

- **Task Schema**: the shared property schema used by a set of Tasks.
- **Task**: an individual work item using exactly one Task Schema.
- **Task Property Definition**: schema-owned configuration shared by every Task using the schema.
- **Select Option**: an independently identified option owned by one Select Task Property Definition.
- **Task Property Value**: task-owned selection for one Task Property Definition.
- **Empty**: no Task Property Value exists for the Task/property pair; it is not a Select Option.

Keep schema-level configuration mutations distinct from task-level value mutations, particularly for permissions and versioning.

## Conclusions from the implementation review

No blocking product questions remain. Use the following as implementation decisions/defaults when drafting the specification unless the user explicitly overrides them:

1. The ticketing vertical owns its domain tables, Postgres schema, migrations, and domain implementation. Core supplies shared database/action-runtime capabilities; ticketing state must not be added to the Core domain schema.
2. Build a deep ticketing task-property module rather than placing domain rules in HTTP handlers or React callers. Transport and persistence remain adapters around the module.
3. Give Task Property Definitions and Select Options stable IDs. Task Property Values reference option IDs, never option names.
4. Represent `Empty` sparsely: absence of a value row means Empty. Creating a property therefore adds its definition to the shared schema but does not backfill one empty row per existing Task. Reads combine schema definitions with sparse values.
5. A new Select property defaults to `Manual` sorting with no options.
6. Trim option names, normalize Unicode consistently, and enforce case-insensitive but accent-sensitive uniqueness per property in both the domain implementation and a database uniqueness constraint. The exact normalization implementation must be deterministic across runtime and database checks.
7. Keep manual position persisted for every option. Alphabetical and reverse-alphabetical display order is derived deterministically by normalized name with a stable tie-breaker. Switching from an automatic mode to Manual snapshots the currently displayed order as manual positions.
8. Use the Task Schema/tenant locale—not each viewer's current UI locale—for shared alphabetical ordering. This prevents users from seeing different shared order and makes the automatic-to-manual snapshot deterministic.
9. Define option colors as semantic design-token identifiers rather than arbitrary CSS values. Inline-created options receive the next deterministic color from the supported palette; users may later recolor them.
10. Inline option creation is a shared-configuration mutation. Full access and Editor may perform it; User may select or clear existing options but may not create one; Viewer remains read-only. This resolves the generic actor wording in the Select document against the baseline access rules.
11. `is not <option>` includes Empty because Empty does not equal that option. `is not empty` remains the condition for any selected option.
12. Interpret “every change is versioned with a timestamp” as an optimistic version plus server-generated UTC timestamps on mutable domain records, together with the existing CoreSDK audit/domain-event path. Restorable historical snapshots and recovery remain out of scope.
13. Every mutation is idempotent where the CoreSDK action interface requires it and is atomic at the database transaction level. In particular: create-option-and-select, option deletion, property duplication, and property deletion cannot leave partial state.
14. Property duplication creates a new property and new option IDs, records an old-option-to-new-option mapping inside the transaction, and optionally copies all existing values through that mapping. Empty stays Empty. The duplicate is placed immediately after its source and receives a deterministic unique copy name such as `Priority copy`, then `Priority copy 2`.
15. Option-deletion preview returns the current affected-Task count and a revision/confirmation token. Confirmation recounts within the transaction; if relevant state changed, it returns a conflict and requires the user to reconfirm the new impact rather than deleting against a stale count.
16. Whole-property deletion follows the same preview/confirm discipline and must display the baseline count of Tasks matching `Is not empty`, even though the Select-specific F8 wording only explicitly requires a general all-Tasks warning.
17. Database constraints are the final defense for one Select value per Task/property, option ownership, uniqueness, and referential integrity; domain validation provides user-facing failures before constraint errors where possible.
18. The current Select scope includes the four specified filters. Option ordering is fully specified. Task-row sorting and grouping are mentioned as a business goal but are not defined by the current acceptance criteria; do not silently add them to the initial implementation specification.

## Proposed module and testing seams for `to-spec`

The preferred external seam is the ticketing Effect BFF contract backed by real ticketing actions/queries. It should exercise the same domain module used by production callers. The domain module should expose behavior-oriented commands and reads while hiding transactions, normalization, impact counting, ID remapping, and sparse-value persistence.

Use the highest practical seam for acceptance tests:

- End-to-end contract tests through the ticketing Effect BFF for user-visible create/select/clear/manage/duplicate/delete/filter behavior and authorization failures.
- Domain-module integration tests against a real or locally substitutable Postgres adapter for transactional behavior, uniqueness, stale-confirmation conflicts, concurrent mutations, and database constraints.
- UI interaction tests only for behavior that cannot be proven through the contract seam, especially confirmation dialogs, affected counts, disabled capabilities by role, and cancellation without mutation.

Tests should assert observable results through these interfaces and survive internal refactors. Avoid unit tests of normalization helpers, remapping helpers, or individual SQL repositories once the same behavior is covered through the module interface.

When `to-spec` is invoked, its required seam check with the user should present this proposal compactly rather than reopening the settled business behavior.

## Guidance for the future specification

- Use the `to-spec` template exactly and publish one parent specification with the configured issue tracker and `ready-for-agent` label.
- The user stories should cover every rule and BDD scenario from the Select document plus applicable shared-schema, duplication, deletion, permission, and versioning behavior from the baseline.
- Record the implementation defaults above under Implementation Decisions.
- Treat cancellation, concurrency, atomicity, authorization, stale impact counts, and independent duplicate IDs as first-class acceptance behavior.
- Keep the Select document's explicit out-of-scope list. Also exclude task-row sorting/grouping until its behavior is separately specified.
- Do not include volatile file paths or code snippets in the published specification.
- If no issue tracker/triage vocabulary is configured when publishing, follow `to-spec` and run `setup-matt-pocock-skills` first.

## Guidance for future tickets

Invoke `to-tickets` only after the parent specification is published and accepted. Draft narrow, demonstrable vertical slices rather than layer-by-layer schema/API/UI tickets. A likely capability progression is:

1. Establish a real Task Schema/Task/Title path and create/read an Empty Select property end to end.
2. Select and clear an existing option, including filtering.
3. Create an option inline and select it atomically with role enforcement.
4. Rename, recolor, reorder, and change sorting mode.
5. Preview and confirm deletion of an option, including affected counts and stale confirmation.
6. Duplicate a property with independent option IDs, with and without copied values.
7. Preview and confirm deletion of the whole property across the schema.

This is only context for `to-tickets`; that skill must still draft dependency edges, quiz the user on granularity and blockers, and publish only after approval.

## Suggested skills

1. `to-spec` — next, when the user asks to synthesize and publish the parent specification. Do not interview about business behavior; only perform its required test-seam check.
2. `to-tickets` — after the specification is accepted, to create approved tracer-bullet tickets with blocking edges.
3. `domain-modeling` — if the main task needs to formalize Task Schema, Task Property Definition, Select Option, Task Property Value, Empty, and permission terminology before publishing.
4. `codebase-design` — retain the deep-module vocabulary and keep domain complexity behind one small interface.
5. `techsio-ui-kit-ai:ui-kit-workflow-orchestrator` and routed component-usage skills — only when ticket implementation reaches UI work.
6. `implement` — one approved ticket at a time after tickets exist.
