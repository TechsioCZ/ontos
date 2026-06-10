# Steering Playbook

Use this reference when `helm` is active and you need tighter steering language or an escalation checklist.

For plan-backed graphs, keep the handoff bundle nearby:

- exact plan selection
- explicit `--depends` edges
- `graph_id`
- `selection_hash`
- `snapshot_path`
- `state_dir`

If the run is long-lived, update `<state_dir>/operator-log.md` as lanes change owners or status.
For plan-backed runs, each worker lane should also update the `.plan.md` todo ids it owns before reporting completion or a durable blocker unless the primary lane explicitly retained plan-file ownership.

## Monitoring Loop

Run this compact loop:

1. Poll agent status only when a dependency might have cleared.
2. Inspect owned-file diffs or relevant files directly.
3. Compare the live repo state against the canonical plan.
4. Send one precise correction per drifting lane.
5. Recheck after meaningful repo movement, not on a fixed cadence.

## Drift Categories

### Silent drift

Symptoms:

- worker reports little but diffs show unexpected scope
- constants or copy diverge from the canonical plan
- tests verify wording but not behavior

Action:

- send a concrete correction naming the exact file and mismatch
- if the mismatch is stale plan state, name the exact `.plan.md` file and todo ids the worker must update

### Narration without execution

Symptoms:

- worker responds with intentions or summaries
- owned files do not change

Action:

- relaunch or redirect with a direct implementation prompt and explicit owned files
- include explicit plan-file ownership and todo ids when the lane is responsible for its own status updates
- close the superseded agent once the replacement lane is in motion and any useful context has been captured

### Ownership collision

Symptoms:

- two lanes touch the same file or interface
- one lane starts compensating for another lane’s unfinished work

Action:

- choose a single owner immediately
- interrupt the drifting lane if needed
- restate the do-not-edit boundary

### Stale assumptions

Symptoms:

- one lane changed shared behavior
- another lane still implements the old contract

Action:

- send the new fact to downstream lanes with the specific implication

## Correction Prompt Skeleton

```text
Concrete issue to fix:
- <exact mismatch>

Required course correction:
- <single decision or behavior to follow now>

Boundary:
- edit only <owned files>
- do not edit <forbidden files>
- update only these plan todos: <plan file> :: <todo ids>

Stop condition:
- <what counts as complete>
- patch the owned `.plan.md` statuses before reporting done or blocked
```

If this correction supersedes an old lane, close the obsolete agent after the handoff so the graph stays within budget.

## Relaunch Prompt Skeleton

```text
Implementation task.
You are not alone in the codebase; do not revert others' edits.
Ownership: <files>
Goal: <bounded outcome>
Concrete requirements:
- <requirement 1>
- <requirement 2>
- <requirement 3>
Plan ownership:
- update <plan file> todo ids <ids> as you progress
  mark `completed` only when the owned work lands and is verified within the lane contract
  leave `pending` if verification is still external or incomplete, and say why
Do not edit: <files or areas>
At the end, report changed files and remaining risk.
```

After relaunching, update the operator ledger and close the stale lane if it no longer owns any work.

## When To Escalate To The User

Tell the user directly when:

- two plausible directions remain and either would materially change scope
- the repo contains conflicting local changes you cannot safely reconcile
- the active graph is no longer buying time and should be collapsed

Do not escalate just because an agent needed one or two steering corrections.
