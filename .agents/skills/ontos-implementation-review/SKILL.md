---
name: ontos-implementation-review
description: Review an existing OntOS implementation for PR readiness against its task specification, applicable AGENTS.md files, and every governing file they reference; fix in-scope failures and rerun validation until it passes or a developer/external blocker remains. Use when the user asks whether OntOS work is PR-ready, requests an implementation review, or wants completed work reviewed and repaired before opening a PR.
---

# OntOS Implementation Review

Answer one question with evidence: **Is this implementation PR-ready?**

Audit the complete change against the task specification and repository guidance. Repair every in-scope failure, validate the repair, and repeat the audit until the answer is yes or progress requires a developer decision or external state change.

## Inputs

Resolve:

- `spec_file` — the task specification supplied by the user. A uniquely identifiable file under `specs/` is acceptable. When omitted, infer it only if exactly one specification unambiguously matches the branch or implementation; otherwise ask for the path.
- `fixed_point` — the base commit, branch, tag, or merge-base for the intended PR. Prefer the user's
  value. Otherwise use the canonical `main` development branch and verify `origin/main` before
  reviewing.
- `review_diff` — committed changes from `fixed_point...HEAD` plus staged, unstaged, and relevant untracked files in the current worktree.

Treat the specification as the immutable review target. Preserve its requirements and acceptance criteria. Update status, checkboxes, or implementation evidence only when repository guidance requires it and the implementation proves the update accurate.

## 1. Establish the Review Surface

Work from `app/`.

1. Read the entire specification.
2. Capture the starting `git status --short`, current branch, resolved `fixed_point`, commit list, and complete `review_diff`.
3. Identify pre-existing or unrelated work and preserve it.
4. Confirm that the review surface is non-empty and that every changed or untracked implementation file is accounted for.

This step is complete when the exact specification, comparison base, and full set of changes under review are known.

## 2. Load the Governing Instructions

Read fresh copies of:

- `../AGENTS.md`;
- `AGENTS.md`;
- every file referenced by the applicable instructions that governs a changed file, behavior, boundary, artifact type, or validation step;
- task-relevant product and architectural context referenced by those files.

Follow references transitively when they contain further mandatory guidance. Keep that traversal scoped to guidance that can govern the review surface; do not bulk-read unrelated neighboring architecture, completed specifications, or historical evidence. For user-facing work, include all applicable frontend, accessibility, responsive, design-system, and runtime guidance. Resolve conflicts according to `AGENTS.md` and report any conflict that requires a developer decision.

This step is complete when every rule governing the reviewed change has been identified from source rather than memory.

## 3. Audit PR Readiness

Inspect `git diff --check`, the diff stat, the complete `review_diff`, relevant surrounding implementation, tests, package scripts, generated contracts, and ownership metadata.

Build a review matrix that maps each specification requirement, ordered task, acceptance criterion, edge case, test requirement, validation command, non-goal, risk, and deliberate tradeoff to concrete implementation and test evidence.

Review both axes:

### Specification

- required behavior is complete and observable;
- acceptance criteria and edge cases are proven;
- tests cover every changed behavior and important failure path;
- no requested behavior is missing, partial, or incorrectly implemented;
- the change contains no unexplained scope or public API expansion.

### Repository Guidance

- every applicable rule from both `AGENTS.md` files and their governing references is satisfied;
- required generators and generated seams are preserved;
- architecture, ownership, typed contracts, error handling, permissions, evidence, and module boundaries remain valid;
- user-facing states, accessibility, responsiveness, and design-system usage are correct when applicable;
- the diff contains no accidental edits, dead code, weak assertions, unsafe assumptions, or hand-created generated artifacts.

Classify each finding as:

- `blocker` — prevents PR readiness;
- `non_blocking` — valid follow-up that does not prevent the specified change from shipping;
- `baseline` — unrelated pre-existing failure, proven outside the review surface.

This step is complete when every specification item and applicable repository rule has explicit evidence or a concrete finding.

## 4. Fix and Re-review

For every in-scope finding that prevents PR readiness:

1. Make the smallest complete fix within the specification's scope.
2. Add or strengthen tests that fail without the fix and prove the required behavior and failure paths.
3. Follow mandatory generator and ownership rules from the loaded guidance. When required business functionality has no approved generator or gateway, record a developer blocker instead of inventing the artifact.
4. Run the narrowest relevant checks immediately and repair failures caused by the change.
5. Recompute and re-read the complete `review_diff`; a fix may create a new finding elsewhere.

Also resolve safe, directly related `non_blocking` findings when doing so does not expand scope. Record remaining follow-ups precisely.

Repeat the audit-and-fix loop until no in-scope blocker remains or the same unresolved developer/external dependency prevents further progress.

## 5. Validate the Final State

Derive commands from actual repository scripts and the specification. Run from `app/` through `mise exec -- pnpm` where required by `AGENTS.md`.

Run, in order:

1. every focused test added, modified, or needed to prove changed behavior and failure paths;
2. every validation command required by the specification;
3. `mise exec -- pnpm check`;
4. build validation when build output, routing, Module Federation, public surfaces, deployment artifacts, or runtime bundling changed;
5. browser or runtime validation when acceptance criteria are user-visible or cross-boundary.

Record each exact command and its result. Fix implementation-caused failures and rerun affected checks. Distinguish a proven unrelated baseline failure from an implementation failure; continue independent validation where possible.

Never claim a command passed unless it ran successfully in the final state.

## PR-ready Gate

Return **PR ready: yes** only when all of the following are true:

- every specification requirement and acceptance criterion is satisfied;
- every applicable instruction and referenced rule is satisfied;
- changed behavior and important failure paths have meaningful tests;
- required focused tests, specification commands, and repository quality gates pass;
- conditional build and runtime checks pass when applicable;
- `git diff --check` passes and every file in the review surface is intentional;
- no unresolved blocker, unexplained deviation, or unapproved scope expansion remains.

Return **PR ready: no** only when a developer decision, missing authority, external dependency, or proven unrelated baseline failure makes a required gate impossible after all safe in-scope fixes have been exhausted. State the exact blocker and the smallest action needed to clear it.

## Report

Lead with `PR ready: yes` or `PR ready: no`, then report:

- specification path and comparison base;
- specification and guidance coverage;
- findings discovered and fixes made;
- tests added or updated;
- every validation command and final result;
- final diff stat;
- remaining baseline failures, deviations, or follow-ups.

Do not create a branch, commit, push, PR, or issue unless the user explicitly requests it.
