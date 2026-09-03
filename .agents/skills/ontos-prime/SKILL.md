---
name: ontos-prime
description: Prime Codex for focused OntOS work by loading repository instructions, source-owned workspace facts, only the product contexts and implementation guides triggered by the task, and current Git state. Use for onboarding or before planning or implementation when context is not fresh.
---

# Prime OntOS

Prime without modifying the repository, installing dependencies, starting services, running
builds or tests, or performing Git hosting operations.

## 1. Establish the checkout

Work from `app/` and run:

```sh
pwd
git status --short
git branch --show-current
git log --oneline --decorate -n 8
git rev-parse --verify main
```

Treat `main` as the canonical comparison and pull-request base. Report material divergence and
preserve pre-existing changes.

## 2. Read the fixed entrypoints

Read:

- `../AGENTS.md`
- `AGENTS.md`
- `README.md`
- `DEVELOPMENT.md`
- `package.json`
- `pnpm-workspace.yaml`

These files route the rest of the investigation and own scripts, workspace layout, and toolchain
pointers. Do not dump `git ls-files` into context.

## 3. Follow only matching branches

- Read a specification only when the task or GitHub issue names it.
- Use `../CONTEXT-MAP.md`; open every context row whose trigger materially matches the task, which
  may be more than one for a cross-domain decision.
- Use the routing table in `README.md`; open only implementation guides that govern the intended
  files or behavior.
- Inspect source, tests, topology, generated contracts, or dependency manifests only to resolve a
  concrete relationship needed for the task.
- Do not bulk-read `../docs/`, `docs/`, `specs/`, completed plans, or historical evidence.

## 4. Report

Summarize:

- application shape and boundaries relevant to the task;
- source-owned commands, validation, and generator entrypoints;
- non-negotiable rules from the selected authorities;
- branch and worktree state, including pre-existing changes;
- unresolved facts that could change planning or implementation.
