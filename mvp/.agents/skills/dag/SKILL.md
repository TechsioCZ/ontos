---
name: dag
description: Inspect plan todo progress and surface the next executable lanes from `.plan.md` files or a saved graph snapshot. Use when you need a quick frontier view, blocked-lane check, or resumable status read while orchestrating with `subagent-graph` or steering with `helm`.
---

# DAG

Use this skill when you need the next lanes, blocked work, or plan progress from selected plans or a saved graph snapshot. It is the fast frontier/status companion to `plan-graph`.

Despite the short name, treat this skill as the frontier lens, not the full DAG renderer. If you need the full per-plan todo chain, validation sweep, or Mermaid output, switch to `plan-graph`.

## Handoff Contract

For plan-backed orchestration, keep one canonical handoff bundle:

- the exact plan selection: explicit `--plan` paths, or `--plans-root` plus `--glob`
- any explicit `--depends source:target` edges
- the resolved `graph_id`
- `selection_hash`
- `snapshot_path` and `state_dir` when a snapshot exists

That bundle is what `subagent-graph` and `helm` should preserve when they need to stay attached to the same plan-backed state.

## Canonical Inputs

This skill reads the same plan format as `plan-graph`:

- `name`
- `overview`
- `todos`
- `isProject`

Select plans with explicit CLI inputs such as `--plan`, `--plans-root`, and `--glob`, or let the CLI use its env-backed defaults. Do not assume hidden prompt interpolation for paths or agent identity.

It can also read the persisted snapshot written by `dag` or `plan-graph` for the same resolved plan file set or an explicit graph id.

## Durable State

Use an explicit `GRAPH_ID` only when you need to pin `dag` to one exact saved graph snapshot.

- If you omit `GRAPH_ID`, rerun a selection that resolves to the same absolute plan files plus the same explicit `--depends` edges and `dag` can reuse the matched managed slot or create one automatically if none exists yet.
- Preserve the exact selection when you want that auto-managed slot again:
  the same `--plan` list, or any `--plans-root` plus `--glob` combination that resolves to the same plan files, plus the same `--depends` overlay.
- Pass `--graph-id <id>` or set `GRAPH_ID` when multiple agents or later resumptions must target one exact saved slot regardless of selection context.
- When you rerun `dag.py` with `--graph-id` plus a matching explicit plan selection, the wrapper now reuses the saved snapshot edges automatically if you omitted `--depends`.
- If the explicit selection does not match the saved snapshot for that `--graph-id`, `dag.py` warns and leaves the explicit selection untouched instead of silently applying stale edges.
- In the common `frontier` flow, state is auto-written for the resolved managed slot when `GRAPH_ID` is omitted.
- Use `--write-state` only when you want to force persistence for an explicit `--graph-id`.
- Keep shared snapshots under `<state-dir>/<resolved-graph-id>/snapshot.json`, where `state-dir` defaults to `./.codex/plan-graphs` and can be overridden by CLI or env.
- Do not assume thread or agent IDs will be interpolated into the prompt automatically.

## Workflow

1. Choose the targeting mode first.
   - For a fresh frontier directly from plans, run `scripts/dag.py` with `--plan` or `--plans-root` plus `--glob`.
   - For an exact saved slot, pass `--graph-id` or rerun a selection that resolves to the same plan files plus the same explicit `--depends` edges.
   - If you already have the correct `--graph-id` and matching selection, you can omit `--depends`; `dag.py` will recover them from the saved snapshot.
   - For multi-plan selections, validate the graph first with `plan-graph validate` so no selected plan is orphaned before you trust the frontier.
2. Run `scripts/dag.py` with no mode to get the current frontier.
3. Add `--lanes` and `--max-depth` to tighten the active and upcoming work list.
4. Prefer `--format json` when downstream tools or agents need the resolved `graph_id`, `selection_hash`, `snapshot_path`, or `state_dir`.
5. If the lane picture looks wrong or you need the full DAG, Mermaid representation, or integrity validation, switch to `plan-graph`.
   - Treat a documentation-only or wrapper plan showing up as a runnable lane as a likely orphan-linking problem unless it has explicit dependencies by design.
6. Hand the resulting frontier to `helm` or `subagent-graph` together with the exact plan selection, explicit `--depends` edges, or explicit `graph_id` when downstream work must stay on the same saved slot.

## Commands

```bash
python "<path-to-skill>/scripts/dag.py" --plans-root "$PLANS_ROOT" --glob '*subagent*.plan.md' --lanes 4 --max-depth 2
python "<path-to-skill>/scripts/dag.py" --plan "$PLAN_PATH" --format json
python "<path-to-skill>/scripts/dag.py" --graph-id subagents-v1 --format json
python "<path-to-skill>/scripts/dag.py" --plan "$PLAN_PATH" --graph-id subagents-v1 --write-state --format json
python "<path-to-skill>/scripts/dag.py" --plans-root "$PLANS_ROOT" --glob '*subagent*.plan.md' --graph-id subagents-v1 --lanes 2 --max-depth 3
```

## Boundaries

- Use `plan-graph` for the full DAG, explicit inter-plan edges, or Mermaid output.
- Use `subagent-graph` for launch design and ownership boundaries.
- Use `helm` for active steering once the lanes are live.

Read `references/lane-frontier.md` when you need the exact frontier rules or the wrapper behavior.
