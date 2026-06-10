---
name: subagent-graph
description: Orchestrate multiple subagents as a dependency-aware work graph so Codex can parallelize safely, keep the critical path moving, and integrate results without duplication or conflicting edits. Use when a task is large enough to split into bounded subtasks, when execution order or prerequisites matter, when several investigations or implementations can run in parallel, or when Codex needs help deciding whether to `spawn_agent`, `send_input`, `wait`, or keep work local. Prefer this skill for graph design, launch planning, ownership boundaries, and merge sequencing. Use `helm` instead when the graph is already live and Codex primarily needs to monitor agents, steer them, or re-shape active lanes in flight.
---

# Subagent Graph

Treat multi-agent work as a DAG of bounded nodes with explicit dependencies. Maximize useful parallelism without giving up ownership of the critical path, integration, or final verification.

Use subagents to buy wall-clock speed, independent evidence, or isolated ownership. Do not decompose work just because the task is large.

## Boundary With Helm

Use this skill to design and launch the graph:

- resolve limits
- choose graph shape
- define node ownership
- sequence waves
- identify merge points and conflict hotspots

If the orchestration source of truth is a set of `.plan.md` files, derive the launch graph from those plans with `dag` when you mainly need the current frontier, or with `plan-graph` when you need the full DAG or validation. Preserve downstream targeting by either rerunning a selection that resolves to the same plan files, or by carrying an explicit `GRAPH_ID` when another tool or agent must hit one exact saved slot.
Do not launch from a multi-plan selection until `plan-graph validate` passes without orphaned selected plans. If a wrapper or documentation plan is part of the selection, either link it explicitly or exclude it from the runnable graph.

If the graph is already active and the main problem is now steering it, switch to `helm`:

- monitor active agents and diffs
- push corrective `send_input` guidance
- interrupt drifting lanes
- reassign or relaunch stalled work
- keep the user informed while the graph is running

## Plan-Backed Contract

If the orchestration is backed by `.plan.md` files, do not paraphrase the plan and lose targeting details. Carry one canonical handoff bundle into the launch plan:

- the exact plan selection: explicit `--plan` paths, or `--plans-root` plus `--glob`
- any explicit `--depends source:target` edges
- the resolved `graph_id`
- `selection_hash`
- `snapshot_path` and `state_dir` when a snapshot exists

Get that bundle from `dag --format json` when you mainly need the frontier, or from `plan-graph summary --format json` / `plan-graph dag --format json` when you need broader structure.

If the rollout will span multiple turns or resumptions, keep a short operator ledger next to the snapshot at `<state_dir>/operator-log.md`. Record only the live control facts:

- lane name
- agent id
- owner / write scope
- dependency or blocker
- current status
- next action

## GPT-5.4 Posture

Assume the primary agent can carry broader context and longer task state than older orchestration patterns did. Design the graph accordingly:

- Keep more coherent work local by default. A single bug fix, feature slice, or refactor lane can often stay with the primary agent even when it spans several related files.
- Treat subagents as accelerators for independent lanes, not as a workaround for context limits.
- Prefer one strong owner for a coherent seam over several tiny workers that need constant reintegration.
- Prefer local parallel tool use for first-pass exploration before spawning explorer swarms. Read broadly yourself first, then delegate only the lanes that remain independent.
- Add explicit verification and persistence expectations for tool-heavy or research-heavy lanes. Stronger models are often more efficient by default, which can look like under-searching if the prompt does not ask for completeness.
- Use parallelism selectively. Independent evidence gathering and disjoint ownership usually benefit; dependent steps and speculative decomposition usually do not.

## Resolve Limits First

Before writing the orchestration plan, resolve the active agent limits:

- Run `python3 "<path-to-skill>/scripts/get_agent_limits.py"`, or pass an explicit config path.
- The helper parses Codex config with a real TOML parser and reads `[agents].max_threads` / `[agents].max_depth`, or the top-level `agent_max_threads` / `agent_max_depth` keys when that config shape is in use.
- If either setting is absent, use defaults of `max_threads=6` and `max_depth=1`.

Treat the result as a hard orchestration budget:

- Never plan more concurrently active agents than the resolved `max_threads` budget can support.
- Reserve headroom when the main agent still has meaningful local work; do not blindly consume the full thread budget.
- Treat `max_depth=1` as "only the primary/root agent may spawn subagents". Spawned subagents must not create their own subagents.
- If `max_depth` allows deeper nesting, use it only when the dependency graph truly benefits from it. Depth is not a goal by itself.

Record the resolved limits in the short orchestration plan whenever they materially affect graph shape or launch size.

## Orchestration First

Before spawning any agent, write a short orchestration plan for yourself.

If the task is already represented as one or more Cursor plan files, derive that orchestration plan from `dag` or `plan-graph` output instead of paraphrasing the plan from scratch.

If the work is plan-backed, write the handoff bundle into that orchestration plan before the node list. The next operator should be able to reattach to the same slot without rediscovering which plan selection or dependency overlay you used.
The launch graph should also name any intentionally non-runnable plans that were excluded from selection so later operators do not accidentally reintroduce them as orphaned nodes.

That plan should name:

- the user-visible goal
- the initial node set
- ownership for each node
- dependency edges
- the critical path
- the first wave to launch now
- the likely second wave if the first wave succeeds
- the merge points where results must be integrated or compared
- a conflict-risk map of files or directories likely to collide
- scope boundaries that explicitly say what each node must not touch

Do this even when the graph is small. The plan can be brief, but it should exist before the first spawn.

If the likely second wave is too fuzzy to describe, the first wave is probably still too broad.
If the best plan has no subagents yet, that is a valid outcome.

## Core Rules

- Keep the primary agent on the critical path. Do the next blocking local step yourself unless a subagent result is not needed immediately.
- Treat parallelism as a tool for latency reduction and risk isolation, not as the default answer to task complexity.
- Spawn subagents only for concrete tasks with a crisp output contract.
- Default to reviewable workloads per agent. Prefer the smallest natural lane that can finish independently and be reviewed quickly, but do not force microscopic shards when a slightly broader lane is cleaner.
- Split by question, workstream, or ownership boundary, not by vague "go explore" prompts.
- Keep write scopes disjoint. If two nodes need the same files, serialize them or make one read-only.
- Prefer stable seams. Split on module boundaries with low churn, not hot shared files.
- Keep one node to one job. Avoid mixing exploration, implementation, and review in the same subagent unless the work is tiny.
- Prefer a coherent owner over several shallow workers when the work shares too much context.
- Bias toward a strong first wave only when real independent lanes exist. Do not create filler nodes just to increase fan-out.
- Treat `wait` as a dependency edge, not a polling habit. Wait only when the next critical-path step truly depends on a result.
- Keep synthesis local. The primary agent owns dedupe, contradiction handling, tradeoffs, and the final response.
- Reuse or close agents deliberately. Do not keep idle agents alive without a reason.

## Scope Guardrails

Treat overscoped nodes as a primary source of merge conflicts and low-quality output.

- Every node must include both in-scope and out-of-scope statements.
- Require an explicit "stop condition" for each node: what counts as done, and what should be handed back instead of expanded.
- Prefer "finish one thin slice" over "partially touch many areas."
- If a node prompt needs more than one acceptance checklist, split it.
- If a node requires touching both shared interfaces and multiple downstream callers, keep interface ownership local and delegate only one side.
- If follow-up instructions are likely, pre-plan a second bounded node instead of broadening the first node.

## Build the Graph First

Before spawning anything, define:

1. Goal: the user-visible outcome.
2. Nodes: bounded subtasks with one owner each.
3. Edges: prerequisites between nodes.
4. Critical path: the chain that blocks completion.
5. Parallel lanes: zero-dependency or disjoint nodes that can run now.
6. Merge points: places where results must be compared, integrated, or verified together.
7. Next waves: what additional nodes will likely be launched after the current wave completes.
8. Conflict hotspots: files, symbols, or interfaces where concurrent edits are disallowed.

Keep the graph minimal. Most tasks need only 1 to 4 nodes.
If a node description starts turning into a paragraph of unrelated asks, split it or keep it local. A short paragraph of tightly related work can still be a valid node.

When possible, sketch the graph in launch waves:

- Wave 1: nodes with no unmet dependencies
- Wave 2: nodes that become unblocked after Wave 1
- Wave 3: final verification or integration lanes

Wave 1 is often the primary agent plus 0 to 2 sidecars. Launch 3 to 4 subagents only when ownership is clearly disjoint, dependencies are already satisfied, and the extra lanes will save real wall-clock time.

Do not over-plan speculative waves in detail, but identify them early enough that orchestration stays intentional.

Before Wave 1 launch, confirm this conflict checklist:

- No two write-capable nodes own the same file.
- Shared interfaces have a single designated owner.
- Nodes that depend on an interface change are downstream and initially read-only.
- Hotspot files (workspace config, shared protocol types, central registries) are either single-owner or local-only.

## Choose Local vs Delegated Work

Keep work local when:

- the next action is blocked on context you already have
- the task is faster to do than to explain
- the write scope is tiny and overlaps with your current edits
- the task is still too ambiguous to hand off cleanly
- one coherent owner can carry the whole feature, fix, or refactor lane without thrash
- the main value is in iterative judgment rather than parallel throughput
- the first-pass exploration can be done with local parallel reads, searches, or targeted commands

Delegate when:

- the subtask is concrete, independent, and materially advances the task
- the result can arrive asynchronously while you do something else
- the work has a disjoint file set or is read-only research
- success criteria fit in a short, concrete handoff
- you need independent verification, contradiction-checking, or a second evidence stream
- the work is map-style or batch-shaped enough that parallel lanes clearly reduce elapsed time
- a first local pass already narrowed the remaining unknowns into clean independent questions

If you cannot describe the handoff crisply, do not delegate yet.

## Sizing Guidance

Bias the graph toward reviewable, low-conflict chunks without overfitting to micro-scopes:

- Prefer one coherent outcome, seam, or question per agent.
- Prefer natural ownership boundaries such as a module, subsystem surface, test lane, or tightly related file set.
- Use file count as a smell, not a law. Very small write scopes are often best, but a broader lane is fine when the files move together and review stays easy.
- Prefer handoffs that are short and concrete, without optimizing for an exact line count.
- Prefer tasks that can plausibly finish without major re-scoping, even if one bounded follow-up is still likely.
- For verification lanes, prefer one claim or one tightly related check bundle per agent.
- For read-only scouts, prefer one main uncertainty or one coherent source area per agent.
- If two candidate nodes would need frequent back-and-forth to stay aligned, they probably belong in one lane.

When in doubt, lean smaller, but stop shrinking once the node already matches a natural ownership boundary. A usable patch from a coherent lane is better than an artificially tiny shard that creates coordination overhead.

## Write Better Nodes

Specify these fields for each node:

- purpose
- inputs and prerequisites
- exact output needed next
- ownership boundary: files, module, subsystem, or responsibility area
- required verification
- execution mode: read-only, write-capable, or verification-only

Prefer node shapes like:

- one explorer for one question or coherent surface
- one worker for one module, seam, or tightly related file set
- one verifier for one claim, test lane, repro, or small related check set
- one broad owner lane plus one checker lane when the implementation is coherent but correctness risk is non-trivial
- one fact-checker for one disputed assumption
- one patch lane for one bounded follow-up fix after integration feedback

Avoid node shapes like:

- "look around and see what you find"
- "fix the app" across overlapping modules
- "do QA" without a target surface or claims list
- multiple explorers on the same unanswered question
- one worker owning both a refactor and its downstream call-site integration across unrelated files
- one agent tasked with both implementing and redesigning the interface unless those decisions are inseparable and still reviewable as one lane

For write-capable nodes, include a "do-not-edit" list in the prompt when practical. This sharply reduces accidental overlap.

## Merge Conflict Protocol

Use this protocol whenever at least two write-capable nodes are active:

1. Pre-launch ownership pass:
- Assign each write node exact file ownership.
- Assign exactly one owner for shared interface definitions.
- Convert uncertain ownership nodes to read-only until boundaries are clear.
2. In-flight conflict prevention:
- Integrate completed nodes early instead of batching all merges late.
- Rebase mental model after each integration; if ownership moved, update downstream node prompts with `send_input`.
- If one node starts drifting into another node's scope, interrupt and narrow immediately.
3. Merge-point sequencing:
- Land interface-defining changes before dependent implementation nodes.
- Run lightweight verification at each merge point before launching blocked successors.
- If conflicts appear, prefer re-sharding remaining work over resolving repeated overlaps manually.
4. Conflict escalation:
- After one avoidable overlap, tighten scopes and continue.
- After two overlaps in the same area, pause parallel writes in that area and serialize ownership.

## Execution Loop

1. Sketch the DAG in a few lines before spawning.
2. Identify the first wave and the likely next wave before launching anything.
3. Launch only the nodes whose dependencies are already satisfied.
4. Start local work on the critical path immediately after spawning sidecars.
5. Avoid `wait` until you hit a real dependency wall.
6. Integrate or validate each finished node quickly, especially write nodes in high-risk areas.
7. Launch any successors that just became unblocked.
8. Re-shape the graph when findings change the plan.
9. End with a graph-level verification pass, not just per-node success.

When the graph becomes a live operations problem rather than a launch-design problem, hand off to `helm` instead of bloating this skill with long-running steering behavior.

## Parallel Patterns

Use the smallest pattern that fits:

- Broad owner + checker when one agent can cleanly own the implementation and a second lane can validate it independently.
- Fan-out / fan-in for independent questions or disjoint write scopes.
- Scout / implement / verify when uncertainty is high but the edit is centralized.
- Map / reduce for many uniform units such as rows, files, or failing cases.
- Layered pipeline when downstream work is invalid until upstream output stabilizes.
- Checker lane when risky implementation work needs an independent verification stream.

Read `references/graph-templates.md` for concrete graph shapes, a reusable node contract, and launch skeletons.

## Concurrency Heuristics

Use these defaults unless there is a strong reason not to:

- 0 active subagents is valid when the primary agent can own the task cleanly
- 1 active subagent for risky or tightly coupled edits that still benefit from one sidecar
- 2 active subagents is a healthy default when you have independent research or verification lanes
- 3 to 4 active subagents only when ownership is clearly disjoint, dependencies are already satisfied, and the extra lanes save real time
- More than 4 active nodes only for highly repetitive map-style work or read-only scouting

Cap these heuristics by the resolved config:

- `active_nodes <= max_threads`
- If `max_threads < 3`, treat the configured limit as the launch target instead of forcing extra fan-out
- If `max_depth <= 1`, every spawned node must be a leaf node
- If deeper nesting is allowed, only delegate from a subagent when that delegation is part of the written graph and clearly cheaper than routing back through the primary agent

If agent thread limits, flaky infrastructure, or empty-return agents appear, shrink the graph immediately.

## Dependency and Ownership Rules

- Put edges on facts, not guesses. If node B truly depends on node A, do not start B early.
- Do not serialize work just because it feels safer. Serialize only on real shared state, shared files, or unresolved interfaces.
- Tell every worker it is not alone in the codebase and must not revert others' edits.
- Assign disjoint write ownership whenever possible.
- If two nodes must touch adjacent code, make one exploratory and keep the actual edit in a single owner.
- Reuse an agent with `send_input` only when the same context materially helps. Otherwise spawn a fresh bounded node.
- Make ownership concrete in the prompt. Name the owned boundary as specifically as useful: exact files when known, otherwise a module, subsystem, or responsibility area.
- If ownership cannot be bounded to a clear surface or responsibility, the node is probably too broad.
- If two nodes need the same shared file, define a single owner and route the second node through that owner via handoff output, not direct edits.

## Wait Discipline

Use `wait` sparingly:

- wait when the next local step is blocked on a node result
- wait when integration requires comparing several completed siblings
- wait for verification before making a user-facing claim that depends on it

Do not wait:

- immediately after spawning by default
- just to check whether progress exists
- while meaningful local or independent work is still available

Prefer integrating one finished sibling before waiting on the next. Small merge steps reduce graph drift and conflicting assumptions.

## Failure Modes

Watch for:

- using subagents for work the primary agent could complete faster locally
- too many nodes with unclear owners
- duplicated explorers returning near-identical summaries
- implementation nodes blocked on unresolved design questions
- repeated waiting without new integration work
- broad prose where you needed a concrete artifact
- merge pain from overlapping write scopes
- agents returning `null`, empty summaries, or generic progress with no artifact
- agents repeatedly failing due to infrastructure rather than task complexity
- one node asking for edits across too many files to review safely
- repeated conflicts in the same hotspot despite "disjoint" prompts
- nodes silently widening scope to chase failing checks outside ownership

When this happens, shrink the graph:

- reduce node count
- collapse tiny adjacent lanes into one owner where appropriate
- tighten ownership
- turn ambiguous nodes into read-only scouts
- pull integration back into the primary agent
- restart only the lanes that are still useful
- freeze write access to hotspots until ownership is redefined

Recovery rules:

- If an agent returns no usable artifact, do not immediately retry the same broad prompt. Narrow it first.
- If two agents fail on infrastructure, stop scaling out and keep the next critical step local.
- If a node needs follow-up instructions larger than the original prompt, the shard was too big.
- If reintegration overhead is dominating progress, merge adjacent work back into the primary lane.
- Close stale or empty-return agents promptly so they do not consume thread budget.
- If the same conflict recurs, serialize that area and keep only one writer until integration stabilizes.

## Review Standard

Before accepting any subagent result, the primary agent should quickly verify:

- the result matches the assigned ownership
- the patch is materially complete for the node contract
- the agent did not drift into unrelated files
- the claimed verification is real and proportionate
- the output is ready to integrate without redoing the whole task locally
- the node respected scope limits and avoided out-of-scope edits

If any of these fail, either narrow the follow-up or pull the work back local.

## Final Responsibility

Keep responsibility for these in the primary agent:

- choosing the graph
- updating the graph as reality changes
- synthesizing contradictory results
- applying final integration edits unless a merge is mechanically isolated
- deciding when verification is sufficient
- writing the final user-facing response
