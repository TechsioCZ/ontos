# Plan Markdown Format

## Expected Frontmatter

The local plan corpus for this skill follows this pattern:

```yaml
---
name: Example Plan
overview: One-paragraph summary
todos:
  - id: step-one
    content: Do the first thing
    status: completed
  - id: step-two
    content: Do the second thing
    status: pending
isProject: false
---
```

Supported top-level fields in the parser:

- `name`
- `overview`
- `todos`
- `isProject`

Supported todo fields in the parser:

- `id`
- `content`
- `status`

Observed todo statuses in the local corpus:

- `pending`
- `in_progress`
- `completed`

The parser also tolerates:

- `todos: []`
- empty quoted strings such as `name: ""`
- unknown statuses, which are carried through as warnings instead of hard failures

## Recommended Markdown Body

The graph parser only needs the frontmatter, but the plan files may also include a markdown body after the closing `---` for operator guidance.

Recommended order:

1. `# <Plan Name>`
2. one or more guidance sections such as `## Execution Notes`, `## Constraints`, `## References`, or `## Operator Guidance`

Do not mirror the overview or todo list by default. Keep todo ids, statuses, and overview authoritative in frontmatter, and use the body only for execution notes, scope, or references that are awkward to encode as metadata.

The body should still be detailed enough for a subagent or later operator to read the plan file directly and understand:

- the intent of the plan
- key boundaries or constraints
- how to approach the implementation
- what a good outcome looks like

Use [`plan-template.plan.md`](plan-template.plan.md) as the canonical starting point when authoring new plans for this skill.

The bundled CLI can also scaffold plans from that template:

```bash
python scripts/plan_graph.py generate --title-prefix "Example Plan" --slug-prefix example-plan --breadth 2 --depth 2 --todo-count 3
```

That command creates layered `.plan.md` files, writes a saved graph snapshot, and fills the markdown body with detailed operator guidance sections under the frontmatter.

## Graph Semantics

- Todo order inside a plan is sequential and defines the default intra-plan DAG.
- Explicit inter-plan edges are optional and are supplied through `--depends source:target`.
- Without explicit inter-plan edges, plans are treated as independent roots.

Saved-slot identity is based on the full plan selection:

- the resolved absolute `selected_plan_paths`
- the normalized explicit dependency edges from `--depends`

## Frontier Semantics

- If a plan has one or more `in_progress` todos, those become the active frontier items for that plan.
- Otherwise the first non-completed todo becomes the plan's current frontier item.
- `--max-depth` controls how many pending todos after the active item are shown as upcoming work.
- `--lanes` caps how many current frontier items are returned overall.

## Validation Coverage

`validate` checks both parsing and graph integrity. The current checks include:

- empty or malformed frontmatter fields already tracked by per-plan warnings
- duplicate plan slugs
- duplicate plan names
- duplicate non-empty todo ids inside a plan
- empty todo content
- non-boolean `isProject`
- self-dependencies
- dependency cycles created by explicit `--depends` edges

## Durable State

By default, snapshots are written under:

- `./.codex/plan-graphs/<GRAPH_ID>/snapshot.json`
- Override with `--state-dir`, `CODEX_PLAN_GRAPHS_ROOT`, or `CODEX_HOME`

If `GRAPH_ID` is omitted, the script reuses the latest managed slot for the same resolved plan selection and refreshes `snapshot.json` from the current plan files.
If no prior match exists, it creates a managed graph id automatically and writes a new snapshot.

The saved `selected_plan_paths` field stores the resolved absolute plan paths, and the saved `edges` field stores the explicit dependency overlay, so auto-managed reuse works only when both the plan files and the explicit `--depends` edges match.

The JSON handoff bundle may include:

- `graph_id`
- `selection_hash`
- `state_dir`
- `snapshot_path`
- `plan_count`
- `edge_count`
- `selected_plan_paths`

Persisted state is intentionally file-backed. The local skill tooling does not currently prove built-in interpolation for thread IDs or agent IDs into skill prompts, so cross-agent persistence should come from saved snapshots, not hidden prompt state.

## Plan Deletion

- `delete-plan` matches plan files through the same `--plan`, `--plans-root`, and `--glob` selection rules as the read modes.
- Explicit `--plan` inputs must still point to files ending in `.plan.md`.
- The command is preview-only unless `--yes` is passed.
- Plan deletion removes only the matched `.plan.md` files.
- Saved graph snapshots are intentionally left untouched.
