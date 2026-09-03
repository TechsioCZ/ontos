---
name: ontos-write-spec
description: Research an OntOS feature, bug, or chore and create one implementation-ready plan under app/specs/ using the matching template. Use when the user asks to plan, specify, ticket, or decompose OntOS work without implementing it or creating a GitHub issue.
---

# Plan OntOS work

Create one `specs/*.md` plan for the supplied Feature, Bug, or Chore. Research current owners and
contracts first; do not duplicate or contradict an existing active plan.

## Classify

- `Feature` — net-new user or product value.
- `Bug` — incorrect behavior requiring root-cause analysis and regression protection.
- `Chore` — bounded maintenance, refactoring, tooling, or documentation work.

Ask only when the answer changes observable scope, architecture, or ownership. Otherwise make the
smallest conservative assumption and record it in `Notes`.

## Research

Work from `app/`.

1. Use `$ontos-prime` when project context is stale.
2. Read `../AGENTS.md`, `AGENTS.md`, and `README.md`.
3. Use the README routing table to open only the implementation document for this concern.
4. Use `../CONTEXT-MAP.md` to select one domain context when business semantics or vocabulary are
   needed. Open only the relevant shared OntOS section when referenced.
5. Open an ADR only when the task or current guidance points to its decision.
6. Inspect the current owning code, tests, package scripts, topology, generators, and contracts.
7. Search `specs/` by capability and frontmatter before creating a file:
   - update or extend the matching `planned` or `in_progress` plan instead of creating a competitor;
   - treat `done`, `complete`, and `superseded` plans as history;
   - when a historical plan still appears current, plan the smallest explicit supersession fix.

Do not bulk-read documentation, specifications, apps, verticals, or packages. Follow references
only when they resolve an implementation decision.

## Write the plan

- Create `specs/<type>-<descriptive-name>.md` with a short kebab-case name. Do not overwrite an
  unrelated plan.
- Write one plan by default. Split only independently implementable and independently verifiable
  work; record dependencies and order.
- Use the exact matching template below and replace every placeholder.
- Ground every file, API, command, and assertion in repository evidence. Do not invent them.
- Name concrete owners and paths. Link to current authorities instead of restating their rules.
- Put tests beside the behavior they prove; do not defer all testing to the last task.
- Make the last task run every `Validation Command`.
- Discover supported business generators from `package.json` `scaffold:*` scripts. When the plan
  creates a supported artifact, make the matching generator and its current `--help` contract the
  first implementation step.
- When required business functionality has no approved generator or governed gateway, record a
  blocking developer decision instead of planning manual creation.
- For user-facing work, cover applicable loading, empty, error, forbidden, validation, conflict,
  retry, accessibility, and responsive behavior.
- Stop after writing the plan. Do not implement code, create a branch or commit, push, open a pull
  request, or create a GitHub issue.

## Relevant-file routing

Start narrow:

- `../AGENTS.md`, `AGENTS.md`, and `README.md` — scope, stop conditions, and routing.
- One document selected from `docs/architecture/`, `docs/frontend/`, or `docs/integrations/`.
- The exact owning paths under `apps/`, `verticals/`, or `packages/`.
- `package.json` and the relevant `scripts/` files for commands, generators, and validation.
- `topology/` only for deployment, ownership, or release work.
- One focused `../docs/contexts/` file or ADR only when its semantics or decision are required.
- `../docs/evidence/` only when the task explicitly asks for historical provenance.

## Feature Plan Format

```md
---
type: feature
status: planned
created: <YYYY-MM-DD>
---

# Feature: <feature name>

## Feature Description
<Describe the feature in detail, including its purpose and value to users.>

## User Story
As a <type of user>
I want to <action or goal>
So that <benefit or value>

## Problem Statement
<Clearly define the specific problem or opportunity this feature addresses.>

## Solution Statement
<Describe the proposed solution approach and how it solves the problem.>

## Relevant Files
Use these files to implement the feature:

- `<path>` — <why it is relevant>.

### New Files
- `<path>` — <purpose>. Omit this section when no new files are required.

## Implementation Plan

### Phase 1: Foundation
<Describe the foundational work needed before implementing the main feature.>

### Phase 2: Core Implementation
<Describe the main implementation work, including tests for each changed behavior.>

### Phase 3: Integration
<Describe how the feature integrates with existing functionality and boundaries.>

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. <Task name>
- [ ] <Concrete task, affected paths, and expected result.>

<Add as many ordered tasks as necessary. Put test creation or updates beside the behavior they prove. Make the last task execute every Validation Command.>

## Testing Strategy

### Unit Tests
<Describe focused unit or component tests.>

### Integration Tests
<Describe cross-module, contract, runtime, or browser tests. Write "Not required" with a reason when omitted.>

### Edge Cases
- <Boundary or failure case to test.>

## Acceptance Criteria
- [ ] <Specific, observable, independently checkable criterion.>

## Validation Commands
Execute every command to validate the feature with zero regressions.

- `<exact repository-supported command>` — <what it validates>.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist
- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes
<List assumptions, risks, dependencies, deliberate tradeoffs, and future considerations. Write "None" when empty.>
```

## Bug Plan Format

```md
---
type: bug
status: planned
created: <YYYY-MM-DD>
---

# Bug: <bug name>

## Bug Description
<Describe symptoms and expected versus actual behavior.>

## Problem Statement
<Clearly define the specific problem that must be solved.>

## Solution Statement
<Describe the proposed surgical solution.>

## Steps to Reproduce
1. <Exact reproduction step, or explain why reproduction is currently unavailable.>

## Root Cause Analysis
<Explain the evidenced root cause. Distinguish verified facts from hypotheses.>

## Relevant Files
Use these files to fix the bug:

- `<path>` — <why it is relevant>.

### New Files
- `<path>` — <purpose>. Omit this section when no new files are required.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. <Task name>
- [ ] <Concrete task, affected paths, expected result, and regression test.>

<Use the minimum changes that fix the root cause. Make the last task execute every Validation Command.>

## Testing Strategy

### Regression Tests
<Describe tests that fail before the fix and pass afterward.>

### Integration or Runtime Tests
<Describe cross-boundary or browser verification. Write "Not required" with a reason when omitted.>

### Edge Cases
- <Related boundary or failure case.>

## Acceptance Criteria
- [ ] <Observable proof that the bug and its regression are resolved.>

## Validation Commands
Execute every command to validate the bug fix with zero regressions.

- `<exact reproduction or focused test command>` — <what it validates>.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist
- [ ] Every acceptance criterion is satisfied.
- [ ] The root cause, not only the symptom, is addressed.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] Tests cover the regression and important failure paths.
- [ ] No unrelated changes or speculative refactoring remain.

## Notes
<List assumptions, risks, dependencies, and follow-ups. Write "None" when empty.>
```

## Chore Plan Format

```md
---
type: chore
status: planned
created: <YYYY-MM-DD>
---

# Chore: <chore name>

## Chore Description
<Describe the chore in detail and why it is needed.>

## Relevant Files
Use these files to accomplish the chore:

- `<path>` — <why it is relevant>.

### New Files
- `<path>` — <purpose>. Omit this section when no new files are required.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. <Task name>
- [ ] <Concrete task, affected paths, and expected result.>

<Keep the plan simple, thorough, and precise. Add tests beside behavior changes. Make the last task execute every Validation Command.>

## Testing Strategy
<Describe tests to add or update. Write "No behavioral test changes required" with a reason only when the chore cannot change behavior.>

## Acceptance Criteria
- [ ] <Specific, observable criterion for completion.>

## Validation Commands
Execute every command to validate the chore with zero regressions.

- `<exact repository-supported command>` — <what it validates>.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist
- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] Behavioral changes have tests.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes
<List assumptions, risks, dependencies, and follow-ups. Write "None" when empty.>
```

## Report

Return each created or updated plan path in implementation order and identify any unresolved
decision that blocks implementation. Do not implement the plan.
