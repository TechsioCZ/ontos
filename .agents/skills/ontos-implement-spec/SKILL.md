---
name: ontos-implement-spec
description: Implement one approved OntOS plan from app/specs/, including writing required tests, running targeted and repository validation, reviewing and fixing the diff against the complete specification, applicable AGENTS.md files, and all relevant referenced guidance. Use when the user explicitly asks to implement a named or uniquely identifiable OntOS specification.
---

# Implement the Following Plan

Follow the `Instructions` to implement the `Plan`, execute the `Application Validation Test Suite`, complete the `Review`, fix every in-scope finding, then `Report` the completed work.

## Instructions

- Work from the OntOS `app/` directory.
- Create a new Git Worktree
- Read the plan, think hard about the plan, and implement the plan.
- If project context is not fresh, use `$ontos-prime` before continuing.
- Read `../AGENTS.md`, `AGENTS.md`, and every relevant guidance file referenced by `AGENTS.md`. Do not rely on memory or a previous summary.
- Read the relevant source, tests, package scripts, topology, and product context before changing code.
- Capture the starting `git status --short`. Preserve unrelated and pre-existing changes.
- Accept only a plan with status `planned` or `in_progress`. Change `planned` to `in_progress` before implementation.
- Stay inside the plan's requirements and non-goals. Ask before making a materially different architectural or product decision.

## Plan

Use the `specs/*.md` path supplied with the skill invocation. A uniquely identifiable basename is acceptable. If no path is supplied, proceed only when exactly one planned specification unambiguously matches the request; otherwise ask which plan to implement.

## Implementation

- Execute every `Step by Step Task` in order, top to bottom.
- Run every mandatory Codesmith generator from `app/` before adapting its generated output:
  - Action: `mise exec -- pnpm scaffold:action -- --vertical <vertical> --action <action>`
  - MicroVertical page: `mise exec -- pnpm scaffold:microvertical-page -- --vertical <vertical> --page <page>`
  - Outbox Message: `mise exec -- pnpm scaffold:outbox-message -- --vertical <vertical> --action <action> --topic <topic>`
  - Global Policy: `mise exec -- pnpm scaffold:policy -- --scope global --policy <policy>`
  - MicroVertical Policy: `mise exec -- pnpm scaffold:policy -- --scope microvertical --policy <policy> --vertical <vertical>`
- Use a generator's `--help` option to discover supported customization flags. Never recreate its initial files or wiring manually.
- Do not create business-functionality files directly. If a required business file type has no Codesmith generator, stop and ask the developer how to proceed.
- Follow existing patterns and preserve strict MicroVertical deployment seams, the generated Effect BFF client seam, typed Action state changes, and typed Effect error contracts.
- Write new tests or update existing tests for every changed behavior and important failure path. Validation commands are not a substitute for test coverage.
- Keep tests owned by the deployable package they validate:
  - shell tests live under `apps/<shell>/tests/`;
  - each MicroVertical's tests live under `apps/<microvertical>/tests/`;
  - shared-package tests live under `packages/<package>/tests/`.
- Organize each package-owned test tree by level as applicable: `tests/unit/`, `tests/integration/`, and `tests/e2e/`. Do not place test files in production `src/` unless an explicit repository instruction requires colocated tests.
- Update test-runner discovery, imports, and package scripts when adding or moving package-owned tests.
- Run focused tests after each meaningful implementation slice and fix failures before continuing.
- Mark each plan task complete only after its implementation and tests are verified.

# Application Validation Test Suite

Execute comprehensive validation for the changed OntOS behavior and capture accurate evidence in the plan.

## Purpose

Proactively identify and fix implementation problems before completion:

- syntax, type, import, format, and lint failures;
- broken focused, component, contract, or integration tests;
- architecture and generated-contract violations;
- build or runtime regressions;
- user-visible loading, empty, error, accessibility, and interaction failures.

## Variables

`TEST_COMMAND_TIMEOUT`: 5 minutes unless an existing repository command normally needs longer.

## Test Instructions

- Run commands from `app/` through `mise exec -- pnpm`.
- Derive focused commands from actual package scripts and the plan. Do not invent commands.
- Record the exact command and whether it passed, failed, or was not run with a reason.
- If a command fails because of the implementation, fix the failure and rerun it.
- If an unrelated baseline failure occurs, record it precisely and continue with independent validation when possible.
- Never claim a test passed when it was not run.

## Test Execution Sequence

### 1. Focused Tests

Run the smallest tests that prove each changed behavior and important failure path. Include all tests added or modified during implementation.

### 2. Plan Validation Commands

Run every command under the plan's `Validation Commands` in the specified order.

### 3. Repository Quality Gate

Run:

```bash
mise exec -- pnpm check
```

### 4. Build Validation

Run `mise exec -- pnpm build` when the plan requires it or the change affects build output, Module Federation, routing, public surfaces, deployment artifacts, or runtime bundling.

### 5. Runtime or Browser Validation

When acceptance criteria involve user-visible or cross-boundary behavior, run the relevant application and validate the critical path in a browser. Tests remain required; runtime validation does not replace them.

# Review

Review the completed work against the specification file, applicable agent instructions, and the final diff. Fix issues found during the review rather than merely reporting them.

## Review Variables

- `spec_file`: the resolved `specs/*.md` plan.
- `review_image_dir`: `app/.codex/reports/review/<spec-basename>/` when screenshots are applicable.

## Review Instructions

1. Inspect:
   - `git status --short`
   - `git diff --check`
   - `git diff --stat`
   - the complete task-relevant final diff
2. Re-read:
   - `../AGENTS.md`;
   - `AGENTS.md`;
   - every relevant file referenced by `AGENTS.md`, including:
     - `docs/architecture/MICROVERTICALS.md`;
     - `docs/architecture/ACTIONS.md`;
     - `docs/architecture/ERRORS.md`;
     - `docs/architecture/ULTRAMODERN.md`;
     - `docs/frontend/FRONTEND.md` for user-facing work;
   - relevant product or architectural context under `../docs/`.
3. Compare the final implementation with the complete plan:
   - description, problem, and solution;
   - requirements and non-goals;
   - every ordered task;
   - testing strategy and validation commands;
   - every acceptance criterion;
   - review checklist, risks, assumptions, and deliberate tradeoffs.
4. Check specifically for:
   - unintended scope or API expansion;
   - MicroVertical boundary violations or imports across private implementations;
   - state changes that bypass typed Actions;
   - missing Action lifecycle, transaction, event, permission, policy, or evidence behavior;
   - expected failures that bypass declared typed Effect errors or use incorrect HTTP statuses;
   - frontend calls that bypass the generated Effect BFF client;
   - missing tests, weak assertions, and untested failure paths;
   - incorrect loading, empty, error, forbidden, validation, conflict, retry, accessibility, or responsive behavior;
   - UI that bypasses `@techsio/ui-kit`, introduces plain CSS, or creates a component without required developer approval;
   - dead code, duplication, unsafe assumptions, accidental edits, and generated files recreated by hand.
5. For applicable UI work:
   - use browser validation to review critical functionality against the plan;
   - capture only 1–5 useful screenshots and store them in `review_image_dir`;
   - use screenshots as review evidence, not as a substitute for tests.
6. Classify findings when useful:
   - `skippable` — a real non-blocking issue;
   - `tech_debt` — non-blocking but creates future maintenance cost;
   - `blocker` — prevents release or violates a required behavior or architecture rule.
7. Fix every in-scope finding. Rerun affected tests and validation commands after each review fix. Rerun `mise exec -- pnpm check` when code changed.

## Completion

Set the plan status to `done` only when:

- every implementation task and acceptance criterion is complete;
- tests were written or updated for every changed behavior and important failure path;
- required focused tests, plan validation commands, and the final quality gate pass;
- the final diff complies with `../AGENTS.md`, `AGENTS.md`, and every relevant referenced guidance file;
- review findings are resolved or explicitly accepted by the developer;
- the final diff contains no unexplained changes.

If adequate confidence is impossible, set the status to `blocked`, preserve accurate task checkboxes, and record the blocker without claiming completion.

Create or update one section in the plan:

```md
## Implementation Evidence

### Summary

- <What was implemented.>

### Changed Files

<Concise output from git diff --stat.>

### Tests Written or Updated

- `<test path>` — <behavior and failure path it proves>.

### Validation

- `<exact command>` — <passed, failed, or not run; include the reason>.

### Review

- <AGENTS.md files and referenced guidance reviewed, findings, fixes, and any screenshots.>

### Deviations and Follow-ups

- <Deviation, accepted finding, baseline failure, or follow-up. Write "None" when empty.>
```

## Report

- Summarize the completed work in a concise bullet list.
- Report the plan path and final status.
- Report tests written or updated and every validation command with its result.
- Report review findings and fixes, including compliance with both applicable `AGENTS.md` files and their relevant referenced guidance.
- Report files and total lines changed with `git diff --stat`.
- Report blockers, deviations, or follow-ups.

Do not create branches, commits, pushes, pull requests, or GitHub issues unless the user explicitly requests those actions.
