# Graph Templates

Use these patterns when the core skill is not enough by itself.

If the graph is already running and the next problem is steering active lanes rather than choosing the graph shape, switch to `helm`.

## Node Contract

Write subagent handoffs in this shape:

```text
Role:
Goal:
Dependencies:
Inputs and context:
Write scope:
Required output:
Verification:
Notes:
```

Keep each field short. Bound the node to a clear surface or outcome, but do not force micro-scoping when a slightly broader lane is the natural unit of work.

## Plan-Backed Handoff Bundle

When the graph is derived from `.plan.md` files, preserve this bundle in the orchestration note and in any helm handoff:

- exact plan selection (`--plan` paths, or `--plans-root` plus `--glob`)
- explicit `--depends` edges
- `graph_id`
- `selection_hash`
- `snapshot_path`
- `state_dir`

If the run will outlive one turn, keep a minimal operator ledger at `<state_dir>/operator-log.md` with:

- lane
- agent id
- owner
- status
- blocker
- next action

## First-Wave Target

First resolve limits with `python3 "<path-to-skill>/scripts/get_agent_limits.py"`. Then choose the smallest launch that keeps the critical path moving. The common starting shape is local ownership plus 0 to 2 sidecars.

Good reasons to stay below 3 or 4:

- the primary agent can own the main lane cleanly
- the graph has fewer than 3 crisp, non-overlapping sidecars
- unresolved dependencies would force some lanes to wait immediately
- the code ownership is still too coupled to split safely
- infrastructure instability makes extra lanes counterproductive
- the resolved `max_threads` budget is below the desired launch size

Do not invent filler work to hit a number. Fan out only when real independent lanes exist and the launch will save wall-clock time.

## Template 0: Local Owner Plus Sidecars

Use when one agent can cleanly own implementation while a small number of sidecars reduce uncertainty or add verification.

Graph:

- Local: own the main implementation, integration, and judgment-heavy decisions.
- Explorer or verifier A: answer one blocking question or run one validation lane.
- Explorer or verifier B: optional second sidecar for a second independent question or check.

This is the default GPT-5.4-era shape. Start here before considering larger fan-out.
If the uncertainty can be reduced with a quick local parallel read/search pass, do that before launching multiple explorers.

## Template 1: Sidecars Plus Local Critical Path

Use when two or more read-only questions can run in parallel while the primary agent keeps moving.

Prefer expanding this pattern to 4 sidecars when there are 4 distinct questions or surfaces to inspect and the resolved thread budget allows it.

Graph:

- Local: own the critical path and start the next blocking implementation or integration step.
- Explorer A: answer one repo or architecture question.
- Explorer B: inspect one adjacent surface such as tests, existing patterns, or API behavior.
- Explorer C: inspect a third source of truth such as docs, configs, or historical commits.
- Explorer D: inspect a fourth surface or run a narrow fact-check pass.
- Merge: compare the returned findings locally, resolve contradictions, and continue.

Use this template when the sidecars inform the work but are not themselves the main work.

## Template 2: Scout -> Implement -> Verify

Use when uncertainty is high and implementation should wait for one fact-finding pass.

Graph:

1. Scout node: gather the missing fact, pattern, or reproducer.
2. Local or worker implementation node: apply the minimal change once the ambiguity is resolved.
3. Verifier node: reproduce the bug, run the target test, or confirm before/after behavior.

Do not merge scout and verifier into the implementation node unless the task is trivial. Separate lanes reduce self-confirmation bias.

## Template 3: Disjoint Worker Split

Use when multiple write-capable tasks can proceed safely on different files or modules.

Use this pattern only when the write lanes are genuinely disjoint and the extra parallelism is worth the merge cost.

Graph:

- Worker A: own file set A.
- Worker B: own file set B.
- Worker C: own file set C.
- Verifier: run focused checks against the shared contract while the workers finish.
- Local: own shared interfaces, integration points, and final diff review.

If the work is uniform and fully disjoint, replace the verifier lane with Worker D and keep final verification local.

State ownership explicitly in the prompt:

- which files, module, or responsibility area each worker owns
- that the worker is not alone in the codebase
- that the worker must not revert edits made by others

If ownership cannot be made disjoint at the seam or responsibility level, do not fan out write-capable workers.

## Template 4: Checker Lane

Use when implementation is moving quickly and you need a live independent signal on correctness.

Graph:

- Local or worker implementation lane: apply the change.
- Checker lane: reproduce the issue, inspect output, or run a narrow verification command.

Use this for bug fixing, risky refactors, or UI work where independent evidence matters before signoff.

## Template 5: Map / Reduce

Use when many units have the same shape and the merge logic is straightforward.

Examples:

- one failing test case per node
- one file category per node
- one PR or issue per node
- one CSV row per node when `spawn_agents_on_csv` is justified

Keep reduce logic local. The primary agent should normalize results and decide which outputs are actionable.

## Replan Triggers

Redraw the graph when:

- two nodes return contradictory facts
- a node cannot produce the promised artifact
- write scopes start overlapping
- the critical path changes
- a supposedly independent lane turns out to depend on unresolved design work

When replanning, prefer deleting nodes over adding new speculative ones.

## Prompt Skeletons

Read-only explorer:

```text
Investigate one question or coherent surface: <question or surface>.
Stay read-only.
Return only the facts needed next, with file paths or commands as evidence.
Do not solve adjacent problems.
```

Write-capable worker:

```text
Own <files, module, or responsibility area>.
You are not alone in the codebase; do not revert edits made by others.
Implement only <bounded change or coherent lane>.
Return changed files, the exact verification you ran, and any residual risk.
```

Checker sidecar:

```text
Verify or challenge one implementation lane: <lane or claim>.
Stay independent from the implementation choices where possible.
Return concrete pass/fail evidence, contradictions, and any remaining uncertainty.
```

Verifier:

```text
Verify one claim: <claim>.
Prefer a reproducible command, fixture, or UI check.
Return pass/fail, concrete evidence, and any gap that remains.
```
