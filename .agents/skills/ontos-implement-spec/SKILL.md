---
name: ontos-implement-spec
description: Implement one approved OntOS specification in a required Locki sandbox, including package-owned tests, focused and repository validation, final diff review, and accurate implementation evidence. Use when the user explicitly asks to implement a named or uniquely identifiable plan under app/specs/.
---

# Implement an OntOS specification

Resolve the named plan, implement every ordered task, validate the result, fix in-scope review
findings, and update the plan with accurate evidence.

## Locki sandbox

> [!IMPORTANT]
> Implement only in a Locki sandbox. Never create a worktree manually or edit the primary checkout.

1. Read [`app/DEVELOPMENT.md`](../../../app/DEVELOPMENT.md).
2. If `LOCKI_SANDBOX_ID` is set, use the current sandbox.
3. Otherwise derive a lower-kebab slug from the specification basename and run from the primary
   `app/` directory:

   ```sh
   mise exec -- pnpm sandbox:new -- <feature-slug> --no-ai
   ```

4. Continue from the returned sandbox `app/` directory. For host control:

   ```sh
   locki exec --match <sandbox-id> -- sh -lc 'cd app && <command>'
   ```

The repository script owns Locki availability, minimum version, committed workflow inputs, setup,
and recovery checks. If it fails, preserve its exact error and stop; do not create a fallback
worktree. If this agent cannot continue in the returned sandbox, stop after preparation and tell the
developer to resume with `locki ai --match <sandbox-id>`.

## Resolve the plan

Use the supplied `specs/*.md` path or a unique basename. Without a path, proceed only when exactly
one `planned` or `in_progress` specification matches the request; otherwise ask which plan to use.

Read the complete plan. Accept only `planned` or `in_progress`; change `planned` to `in_progress`
before implementation.

## Prepare

From the sandbox `app/` directory:

1. Capture `git status --short --branch`; preserve unrelated changes.
2. Read `../AGENTS.md`, `AGENTS.md`, and `README.md`.
3. Read only the implementation documents named by the plan or selected by the README routing table.
4. Read one focused context or ADR only when the plan requires its business semantics or decision.
5. Inspect the relevant source, tests, package scripts, topology, and generated contracts.
6. Use `$ontos-prime` first when project context is stale.

Do not browse completed specifications or broad documentation trees for background.

## Implement

- Execute every `Step by Step Task` in order.
- Stay inside the plan's requirements and non-goals. Ask before changing observable product scope or
  architecture beyond the approved plan.
- Discover the current generator catalog from `package.json` `scaffold:*` scripts. For every
  supported business artifact, run the matching generator first and inspect its current interface:

  ```sh
  mise exec -- pnpm scaffold:<artifact> -- --help
  ```

- Adapt generated output; never recreate generated wiring manually. If the required artifact has no
  approved generator or governed gateway, stop and record the blocking decision.
- Preserve owner-local MicroVertical data and executables, generated Effect BFF clients, typed
  Actions, governed reads, and tagged expected errors.
- Add or update tests beside every changed behavior and important failure path.
- Keep tests with their deployable owner:
  - Shell: `apps/<shell>/tests/{unit,integration,e2e}/`
  - MicroVertical: `verticals/<vertical>/tests/{unit,integration,e2e}/`
  - Shared package: `packages/<package>/tests/{unit,integration}/`
- Update test discovery and package scripts when adding or moving tests.
- Run the narrowest relevant tests after each meaningful slice. Mark a plan checkbox complete only
  after its implementation and tests are verified.

## Validate

Run from `app/` through `mise exec -- pnpm`. Derive commands from current package scripts; do not
invent them. Record the exact command and `passed`, `failed`, or `not run` with a reason.

1. Run focused tests for every changed behavior and failure path.
2. Run every command under the plan's `Validation Commands`, in order.
3. Run the repository gate:

   ```bash
   mise exec -- pnpm check
   ```

4. Run `mise exec -- pnpm build` when required by the plan or when the change affects routing,
   public surfaces, Module Federation, deployment artifacts, or runtime bundling.
5. Run the applicable browser or runtime path when acceptance criteria are user-visible or
   cross-boundary. This supplements tests; it does not replace them.

Fix implementation-caused failures and rerun the affected commands. Record unrelated baseline
failures precisely and continue with independent checks where possible. Never report an unrun test
as passed.

## Review and fix

Inspect:

```bash
git status --short
git diff --check
git diff --stat
git diff
```

Then re-read the plan, applicable agent instructions, and the focused current guidance used during
implementation. Compare the final diff with every task, acceptance criterion, non-goal, test
strategy, and validation command.

Check specifically for:

- unintended scope or public API expansion;
- private imports or transactions across MicroVerticals;
- state changes outside typed Actions or reads outside their governed lifecycle;
- missing authorization, policy, evidence, transaction, event, or outbox behavior;
- untyped expected errors or incorrect HTTP mappings;
- frontend calls outside generated Effect BFF clients;
- generated artifacts recreated manually;
- missing or weak failure-path tests;
- incorrect loading, empty, forbidden, validation, conflict, retry, accessibility, or responsive
  behavior;
- UI outside `@techsio/ui-kit`, plain CSS, or an unapproved component;
- duplication, dead code, unsafe assumptions, or unrelated edits.

For applicable UI work, validate the critical browser path and retain only 1–5 useful screenshots
under `app/.codex/reports/review/<spec-basename>/`.

Fix every in-scope finding, rerun affected tests, and rerun `mise exec -- pnpm check` after code
changes. Classify only unresolved findings as `skippable`, `tech_debt`, or `blocker`.

## Complete the plan

Set status to `done` only when all tasks and acceptance criteria are complete, changed behavior has
tests, required validation passes, review findings are resolved or explicitly accepted, and the
diff has no unexplained changes. Otherwise set status to `blocked`, preserve truthful checkboxes,
and record the blocker.

Create or update exactly one section:

```md
## Implementation Evidence

### Summary

- <What was implemented.>

### Changed Files

<Concise `git diff --stat` output.>

### Tests Written or Updated

- `<test path>` — <behavior and failure path proved>.

### Validation

- `<exact command>` — <passed, failed, or not run; include the reason>.

### Review

- <Instructions and focused guidance reviewed, findings, fixes, and screenshots.>

### Deviations and Follow-ups

- <Deviation, accepted finding, baseline failure, or follow-up. Write "None" when empty.>
```

## Report

Report the plan path and final status, implemented behavior, tests, every validation result, review
findings and fixes, `git diff --stat`, and any blocker or deviation.

The required Locki feature branch is part of this workflow. Do not create additional branches,
commits, pushes, pull requests, or GitHub issues unless the user explicitly requests them.
