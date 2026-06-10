# Lane Frontier

`dag` is a thin wrapper around `plan-graph/scripts/plan_graph.py`.

Default behavior:

- If no explicit mode is given, it runs `frontier`.
- It preserves the same arguments for `--plan`, `--plans-root`, `--glob`, `--lanes`, `--max-depth`, `--depends`, `--graph-id`, `--state-dir`, `--write-state`, and `--format`.
- With a plan selection and no explicit `--graph-id`, the underlying CLI reuses the managed slot for the same resolved selection when one exists, otherwise creates one, and writes state automatically in the common flow.
- A resolved selection means the resolved plan files plus the explicit `--depends` overlay.
- To hit that same auto-managed slot later, preserve the exact `--plan` list or use any `--plans-root` plus `--glob` combination that resolves to the same plan files, and preserve the same `--depends` edges.
- If downstream tools need one exact saved slot regardless of selection context, carry an explicit `--graph-id` instead of assuming hidden interpolation.
- Prefer `--format json` when handing off `graph_id`, `selection_hash`, `snapshot_path`, or `state_dir`.

Use this skill when you need:

- the next executable todo per selected plan
- blocked plans caused by unfinished explicit upstream dependencies
- a resumable lane view from the saved graph matched to the same resolved plan file set or an explicit graph id

Use `plan-graph` instead when you need:

- Mermaid graph output
- the full per-plan and cross-plan DAG
- a broader summary or integrity validation pass for every selected plan
