---
name: ontos-prime
description: Prime Codex for work in the OntOS application by reading the tracked file set, repository instructions, project overview, required architecture guidance, toolchain, and worktree state, then summarizing the codebase. Use when the user asks to prime, onboard, or understand OntOS, or before OntOS planning or implementation when project context is not fresh.
---

# Prime

> Execute the following sections to understand the codebase, then summarize your understanding.

## Project Root

Work from the `app/` directory inside the OntOS repository. Treat `app/` as the application root even though the Git repository root is its parent.

## Run

```bash
pwd
git ls-files
git status --short
```

Inspect `package.json` and `pnpm-workspace.yaml` to understand workspace packages, scripts, and the repository-managed toolchain. Inspect additional directory listings only when they clarify the application structure.

## Read

Read these files:

- `../AGENTS.md`
- `AGENTS.md`
- `README.md`

Use the routing table in `README.md` to read only the implementation document relevant to the
upcoming task. Use `../CONTEXT-MAP.md` to select at most the relevant product context, and open an
ADR only when the task or current guidance points to that decision. Do not bulk-read `../docs/`,
`docs/`, or completed specifications.

## Instructions

- Identify the shell application, MicroVerticals, shared packages, topology, generators, tests, and validation commands.
- Preserve the strict deployment seams between MicroVerticals and the generated Effect BFF seam inside each MicroVertical.
- Note that every state change must use a typed Action and every expected failure must remain a declared typed Effect error.
- Note the mandatory Codesmith generators from `README.md`. Generated output is the required starting point for supported business file types.
- Run pnpm commands from `app/` as `mise exec -- pnpm <command>`.
- Keep the investigation focused. Read more source only to resolve an important architectural relationship or prepare for the supplied task.

## Report

Summarize:

- the application shape and important boundaries;
- the development, testing, and validation commands;
- the non-negotiable architecture and generator rules;
- the current worktree state, including pre-existing changes;
- uncertainties that could affect subsequent planning or implementation.

Do not modify files, install dependencies, start services, run builds or tests, or perform Git hosting operations while priming.
