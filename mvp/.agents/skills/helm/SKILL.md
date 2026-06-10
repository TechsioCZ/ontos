---
name: helm
description: Lead an already-running subagent graph by monitoring active agents, checking live diffs and tool output, steering lanes with `send_input`, interrupting drift, reassigning stalled work, and keeping the user updated. Use when Codex is the helm of a live multi-agent effort and the main challenge is operational control rather than initial graph design. Pair with `subagent-graph` when the graph first needs to be designed, then use `helm` to run it.
---

# Helm

Lead a live multi-agent rollout once workers are already in flight. Keep ownership clear, monitor drift early, and steer the graph continuously instead of waiting blindly for agents to finish.

Read `references/steering-playbook.md` when you need prompt skeletons, escalation triggers, or a tighter monitoring loop.

## Core Posture

- Stay on the bridge. Do not disappear into unrelated local work while multiple agents are active.
- Treat steering as active control, not passive waiting.
- Monitor both agent status and repo state. An agent can say little while still landing code, or say a lot while drifting.
- Push precise corrections. Prefer one concrete course correction over broad re-explanations.
- Keep the user informed with short, factual progress updates when the graph is live.
- Close or interrupt agents deliberately when they stop paying rent.

## Boundary With Subagent Graph

Use `subagent-graph` first when you still need to decide:

- whether to delegate at all
- graph shape
- launch waves
- ownership boundaries
- dependency edges

Use `helm` when those decisions mostly exist and the work now requires:

- watching active lanes
- spotting drift or conflicts
- sending corrective guidance
- rebalancing or relaunching agents
- integrating partial results safely

If the graph is backed by plan files, refresh the current frontier with `dag` before reshaping lanes so steering decisions follow the latest checked-off todos. Keep the handoff exact by reusing a selection that resolves to the same plan files, or by carrying the same explicit `--graph-id` when helming must stay attached to one saved slot.
If you need to change the selected plan set or dependency overlay, re-run `plan-graph validate` first so the updated graph does not introduce orphaned selected plans before you steer agents against it.

## Plan-Backed Control Record

When the graph comes from `.plan.md` files, keep one canonical control bundle in view while helming:

- the exact plan selection: explicit `--plan` paths, or `--plans-root` plus `--glob`
- any explicit `--depends source:target` edges
- the resolved `graph_id`
- `selection_hash`
- `snapshot_path` and `state_dir`

Refresh that bundle with `dag --format json` before major reshapes. If the rollout is long-lived, keep a minimal operator ledger at `<state_dir>/operator-log.md` with lane, agent id, owner, status, blocker, and next action so a resumed helm session can reattach quickly.
If the frontier suddenly shows a wrapper or summary plan as a runnable lane, treat that as a graph-structure check and confirm the selected plans are still properly linked rather than assuming execution priorities changed on their own.

When lanes own work that corresponds to specific todos in `.plan.md` files, make the lane update those todo statuses itself as part of the task. Do not centralize routine todo checkoffs back on the primary lane unless the worker lacks write ownership for the plan files or the plan state is intentionally held by a single integrator.

Every plan-backed launch or correction should state:

- which `.plan.md` file(s) the lane owns for status updates
- which todo ids it is responsible for moving
- when to mark a todo `completed`, leave it `pending`, or report it as blocked
- that the worker should update the plan file before its final report whenever the status change is justified by the landed work

## Helm Loop

Repeat this loop while the graph is active:

1. Check active agent status with `wait` sparingly and review notifications when they arrive.
2. Inspect live diffs or owned files directly instead of trusting status messages alone.
3. Compare the live state against the canonical plan or launch contract.
4. Identify one of four states for each lane:
   - on course
   - blocked
   - drifting
   - done
5. Act immediately:
   - `on course`: leave it alone
   - `blocked`: send the missing fact or narrow the task
   - `drifting`: interrupt or redirect with explicit do and do-not-edit guidance
   - `done`: review quickly, integrate mentally, then close the agent if no longer needed
6. Tell the user what changed if it materially affects confidence, timeline, or scope.
7. For plan-backed lanes, confirm the worker updated the relevant `.plan.md` todo status itself before closing the lane; if not, either steer it to do so or record the exception explicitly in the operator log.

## What To Monitor

Check these continuously when two or more agents are active:

- ownership drift into another lane's files
- stale assumptions after one lane changes a shared interface
- duplicate work across two agents
- unaddressed plan mismatches
- workers who land code but leave their owned `.plan.md` todos stale
- hidden hardcoded constants or copied text that conflict with the canonical plan
- tests that only verify wording instead of the real behavior
- agents that acknowledged guidance without actually implementing it

## Steering Actions

Use the smallest action that fixes the problem:

- `send_input` for normal course corrections, plan clarifications, or new evidence
- `send_input interrupt=true` when an agent is actively drifting or about to touch forbidden files
- `spawn_agent` for a replacement lane when an agent stalled, returned only narration, or closed without landing the owned work
- `close_agent` when a lane is complete, irrelevant, or no longer worth the thread budget
- After relaunching or superseding a lane, explicitly close the obsolete agent once you have captured any remaining useful context. Do not leak thread budget on dead lanes.

Every corrective prompt should include:

- the exact mismatch or risk
- the single decision to follow now
- the owned files or boundary
- the exact `.plan.md` file and todo ids whose status the lane owns
- the stop condition

## Steering Rules

- Never broadcast vague “align to plan” reminders when you can name the exact mismatch.
- Prefer file-level or behavior-level corrections over architectural essays.
- If two lanes start to collide, choose one owner immediately and narrow the other lane.
- If a worker acknowledged guidance but did not execute, relaunch the lane with a direct implementation prompt.
- If a lane lands partial structure without tests, steer it to add the assertions that prove the intended behavior.
- If a plan-backed lane lands the owned work but fails to update its todo statuses, steer it to patch the `.plan.md` file itself before you accept the lane as done.
- If the repo state already reveals the answer, do not ask the user or the worker to rediscover it.

## User Updates

While helming, keep updates short and concrete:

- what lane is healthy
- what lane is drifting
- what correction you sent
- whether a blocker exists

Do not summarize every agent message. Synthesize the operational state for the user.

## Finish Criteria

End the helming loop only when:

- every active lane is either complete or intentionally closed
- remaining work is back to a single coherent owner or a fresh graph
- critical mismatches with the canonical plan are resolved or explicitly surfaced
- the user has a clear picture of current status and next risk
