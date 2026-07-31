---
name: ontos-run-adw
description: Run the complete OntOS ADW workflow for one open, typed GitHub issue: record recovery state, create an issue worktree, write its specification, implement that specification, and publish implementation progress and results to the issue. Use when the user invokes Ontos Run ADW, supplies an issue number for ADW, or asks to execute the OntOS ADW workflow.
---

# Run ADW

## Input

Extract one positive integer GitHub issue number from the skill invocation. If it
is missing or ambiguous, ask the user for the issue number before running ADW.

## Execute

Work from the OntOS repository root containing `adw/adw.py`, then run:

```bash
./adw/adw.py <issue-number>
```

Pass the issue number as a separate positional argument. Do not modify project
files or substitute a direct GitHub query for this command.

The command first runs `git switch develop`. If Git cannot switch branches,
including when uncommitted work would be overwritten, the command stops before
reading or modifying GitHub and before starting Codex. Report Git's error and
ask the user to commit or stash blocking work.

After switching successfully, the command reads the issue title, content, state,
and GitHub issue type. Accept only open issues whose type is `Feature`, `Bug`, or
`Task`, normalized to `feature`, `bug`, or `task`. If the type is missing or
unsupported, stop and tell the user to set a supported issue type.

Create or update the recovery manifest in Git's common directory so the primary
checkout and every linked worktree share the same state:

```text
.git/adw/issues/<issue-number>.json
```

After loading the issue, record `issue_number`, `title`, `content`, and
`issue_type` in the manifest.

Create a branch and sibling worktree using the normalized type, issue number,
and a slug derived from the title:

```text
branch:   codex/<type>-<number>-<title-slug>
worktree: ../ontos-<type>-<number>-<title-slug>
```

The command enters the new worktree before continuing. If Git cannot create the
branch or worktree, stop before commenting on GitHub or starting Codex and
report Git's error. After successful creation, record the exact `branch_name`
and absolute `worktree_path` in the manifest.

After entering the worktree, the command posts this GitHub comment:

```text
The `$ontos-write-spec` skill will be run for this issue.
```

Before starting `$ontos-write-spec`, snapshot the Markdown files under
`app/specs/`. After posting the comment, start a new non-interactive Codex task
from the worktree's `app/` directory and invoke `$ontos-write-spec` with the
issue number, title, complete content, state, and planning type. Convert GitHub
issue type `task` to planning type `chore`. Block until the task completes or
fails.

Require `$ontos-write-spec` to create exactly one new, non-empty Markdown plan
under `app/specs/`. Record its path relative to `app/` as `plan_file` in the
manifest. If zero or multiple plans were created, stop before implementation.

Reload the manifest and require string values for `worktree_path` and
`plan_file`. Post this GitHub comment immediately before implementation:

```text
The `$ontos-implement-spec` skill will be run for this issue.
```

Start another non-interactive Codex task from `<worktree_path>/app`, invoke
`$ontos-implement-spec`, and pass the manifest's `plan_file` path as its
parameter. Pass the path, not the plan contents. Block until implementation
completes or fails.

Both nested Codex tasks inherit their normal stdout and stderr. Keep the ADW
command attached in the ChatGPT/Codex app and surface its output while it runs;
do not replace the command with a detached or background process. The Python
runner also captures each skill's final response separately without suppressing
its normal output.

After successful implementation, post the implementation skill's captured
final response to the GitHub issue:

```text
Implementation result:

<final output from $ontos-implement-spec>
```

## Completion

On success, the command has streamed the same stdout and stderr emitted by each
underlying `codex exec` invocation. Report that specification and
implementation completed and that the implementation result was posted. Do not
claim that nested output was unavailable when it was emitted by the command.

ADW accepts only issues whose GitHub state is `OPEN`. On failure, including a
closed issue, manifest failure, failed comment, invalid plan count, or failed
Codex task, report the command error and do not claim that later steps
completed. A failed branch switch or worktree creation must be reported before
any later side effect.
