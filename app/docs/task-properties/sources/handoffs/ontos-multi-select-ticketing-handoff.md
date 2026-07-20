# Handoff: Multi-select task property

## Purpose of the next main task

Consolidate the general task-ticketing baseline and the final Multi-select business specification, then invoke `to-spec` and, after the specification is published, `to-tickets`. Do not re-interview the user about business behavior already defined or the two decisions confirmed below. Do not implement until the user later requests implementation of approved tickets.

## Authoritative artifacts

- General task-ticketing baseline and access model: `/tmp/ontos-task-ticketing-handoff.md`
- Final GOLD Multi-select business specification, including acceptance criteria, Gherkin scenarios, hypotheses, and out-of-scope behavior: `~/.codex/attachments/068ebb57-7c7c-42b1-acc2-1bb4a06971f3/pasted-text.txt`

Read both in full. This handoff deliberately does not duplicate their contents.

## Decisions confirmed in this conversation

1. Interpret “every change is versioned with a timestamp” as:
   - a monotonic version and `updated_at` for every mutable property configuration and task-property value;
   - the existing platform audit/domain-event record retains its `occurred_at` timestamp;
   - no user-facing revision history, restoration, or historical snapshots are required.
2. The whole-property deletion confirmation must show the number of distinct tasks for which that property matches `Is not empty`. For Multi-select, this is the number of tasks with at least one selected option.
3. GOLD’s statement that history/audit log is out of scope means no product-facing history feature. It does not disable the platform’s mandatory CoreSDK audit/domain-event evidence.
4. The baseline role matrix remains authoritative. GOLD’s single “task editor” actor is a capability description, not an override of Full access / Editor / User / Viewer permissions.

There are no remaining business blockers for Multi-select.

## Implementation direction already established

Treat this as one deep, ticketing-owned module. Keep transport adapters thin and concentrate validation, catalog invariants, value semantics, duplication, deletion, and filter behavior behind the module’s interface.

Recommended relational model:

- shared task schemas;
- tasks belonging to a schema;
- property definitions with stable property identity and datatype;
- task-property value envelopes carrying version and timestamps, including when the value is empty;
- Multi-select options with stable option identity, property identity, display name, normalized name, color, catalog order, version, and timestamps;
- Multi-select selection rows connecting a task-property value to option identities, with database uniqueness preventing duplicate selection.

Important invariants and mechanics:

- Store and filter by property/option identity, never option name. Renaming and recoloring therefore preserve every assignment.
- Enforce that selected options belong to the selected property and that task/property schema identities agree.
- Enforce case-insensitive option-name uniqueness per property using a normalized key at both module and database levels; trim names and reject blank names and commas.
- Represent empty as a value envelope with zero selection rows so an empty value still has version/timestamp state.
- “Create option while editing a task” must add the shared option and select it only for the current task in one transaction.
- Option deletion preview counts distinct tasks using the option. Confirmation removes the option and all of its selections atomically while preserving other selections.
- Property deletion preview counts distinct non-empty task values. Confirmation removes definition, catalog, value envelopes, and selections atomically.
- Duplication creates fresh property and option identities and uses an old-option-to-new-option mapping. Copying values remaps every task selection; declining value copying creates empty value envelopes.
- `Contains` is an existence query for the chosen option identity. `Does not contain` is the corresponding non-existence query and includes empty values. Empty/non-empty filters test whether selection rows exist.
- Use optimistic concurrency on versions for stale configuration/value edits.
- Default implementation may perform duplication synchronously in one transaction. Revisit as an asynchronous job only if a later non-functional requirement establishes task counts too large for this approach.
- Duplicate property naming and automatic color selection remain GOLD hypotheses/defaults, not blockers: use a unique derived name such as `Labels copy`, `Labels copy 2`, and a deterministic supported UI palette unless a general property/UI specification supersedes them.

## Repository findings

- Work only in `<workspace>/app`; `mvp/` and `mvp2/` are read-only.
- The ticketing vertical is still scaffold-level. Its list/read handlers use a static in-memory item, and its current create-ticket action validates and emits evidence but does not persist a task.
- The platform convention requires public writes to enter through CoreSDK Actions and governed reads/filters through CoreSDK data-access registrations.
- Action handlers already receive the CoreSDK transaction, so multi-table delete and duplicate operations can be atomic without a new public persistence seam.
- Ticketing should own its domain tables and migrations; do not put task-property semantics into Core Runtime.
- No implementation or workspace artifact was created in this conversation.
- The worktree already contained unrelated/user-owned changes before this discussion, including changes to `AGENTS.md`, deletion of `docs/ticketing/task-properties.md`, and generated ticketing diagnostics. Preserve them and do not restore or overwrite them.
- No issue-tracker or `ready-for-agent` triage configuration was found under `app/.agents` or `app/.codex`. Before publishing with `to-spec`, verify whether the main task configured it elsewhere; if not, invoke `setup-matt-pocock-skills` first.

## Testing seam for `to-spec`

The proposed highest backend behavior seam is the existing CoreSDK registration interface:

- commands through `runAction`;
- deletion previews and task filtering through `runDataAccess`;
- a small number of API-adapter tests for transport schema/status mapping;
- UI acceptance tests only for user-observable dialogs, selection behavior, and filters.

Exercise the GOLD Gherkin behavior through these public seams and observable persisted/query outcomes. Avoid tests against internal helper functions or repository implementation details. The `to-spec` skill requires checking this seam with the user before publishing; that seam check is the only expected confirmation, not a reopening of business requirements.

## Dependency facts for later ticket slicing

- The shared task/schema/property foundation gates every datatype-specific slice.
- Property creation and empty value representation gate option/value behavior.
- The option catalog gates selection, configuration, option deletion, duplication, and option-based filters.
- Governed task reads gate all filter slices and both deletion-preview counts.
- Value copying in duplication depends on stable option identity and working task selections.
- Each ticket produced by `to-tickets` should remain a tracer bullet spanning persistence, Action/data-access contract, UI behavior, and tests; avoid layer-only tickets unless an unavoidable platform prefactor is discovered.

## Suggested skills

1. `setup-matt-pocock-skills` — only if the main task still has no configured issue tracker and triage vocabulary.
2. `to-spec` — synthesize the referenced artifacts and confirmed implementation decisions; do not interview again beyond its required testing-seam check.
3. `to-tickets` — after the published spec exists, draft tracer-bullet tickets, quiz the user on granularity and blocking edges, then publish only after approval.
4. `implement` — later, one approved frontier ticket at a time, only when the user explicitly requests implementation.
5. During later UI implementation, begin with the repository-required `techsio-ui-kit-ai:ui-kit-workflow-orchestrator`; during test implementation use the repo-owned `rstest-best-practices` instructions.
