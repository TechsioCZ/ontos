---
name: ontos-prime
description: Prime an agent for focused OntOS work by inspecting repository state, executable workspace sources, application guardrails, and only the task-relevant documentation. Use when onboarding, refreshing stale project context, or preparing to plan or implement a specific OntOS change.
---

# Prime OntOS

Inspect enough current evidence to start the supplied task without bulk-loading the repository.

## Root

Work from `app/`. The Git repository root is its parent.

## Inspect state

```bash
pwd
git rev-parse --show-toplevel
git status --short --branch
git branch --show-current
```

Inspect `package.json`, `pnpm-workspace.yaml`, and only the package or directory listings needed to
locate the task owner. Do not run `git ls-files` or dump broad trees into context.

## Read progressively

1. Read `../AGENTS.md`, `AGENTS.md`, and `README.md`.
2. Read `DEVELOPMENT.md` only for branch, sandbox, or local startup work.
3. Use the README routing table to open one implementation document for the supplied concern.
4. Use `../CONTEXT-MAP.md` to select one domain context when terminology or business semantics are
   needed. Open only a referenced shared OntOS section when the selected context leaves a shared
   term unclear.
5. Open an ADR only when current guidance or the task points to that decision.
6. Open a specification only when the task names it. Completed or superseded specifications are
   historical evidence, not background reading.

Read source and tests only to resolve a concrete ownership or architecture question. Do not
bulk-read `../docs/`, `docs/`, `specs/`, or historical evidence.

## Establish

- Identify the Shell, current MicroVerticals, shared packages, topology, generators, package-owned
  tests, and relevant validation scripts.
- Treat `main` as the development and pull-request base. Report branch divergence that can affect
  the task.
- Confirm the owner-local MicroVertical seam, generated Effect BFF boundary, typed Action rule, and
  tagged expected-error rule from their current owners.
- Discover supported generators from `package.json` `scaffold:*` scripts; inspect only the relevant
  command with `--help`.
- Run pnpm commands from `app/` as `mise exec -- pnpm <command>`.

## Report

Summarize the application owner, relevant boundaries, supported commands, current worktree state,
pre-existing changes, and unresolved facts that can change the next step.

Do not modify files, install dependencies, start services, run builds or tests, or perform Git
hosting operations while priming.
