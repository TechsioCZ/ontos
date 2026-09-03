---
name: ontos-write-spec
description: Research an OntOS feature, bug, or chore and create an implementation-ready Markdown plan or ticket under app/specs/ using the matching feature, bug, or chore format. Use when the user asks to plan, specify, ticket, or decompose OntOS work without implementing it or creating a GitHub issue.
---

# Feature, Bug, or Chore Planning

Create a new plan in `specs/*.md` to implement the `Feature`, resolve the `Bug`, or accomplish the `Chore` using the matching exact `Plan Format`. Follow the `Instructions` to create the plan and use the `Relevant Files` to focus on the right files.

## Input

Use the request supplied with the skill invocation. Classify it as one of:

- `Feature` — net-new user or product value;
- `Bug` — incorrect behavior that requires root-cause analysis and regression protection;
- `Chore` — maintenance, refactoring, tooling, documentation, or another bounded non-feature task.

Ask a question only when its answer would materially change scope, observable behavior, or architecture. Otherwise make the smallest conservative assumption and record it in `Notes`.

## Instructions

- Work from the OntOS `app/` directory.
- If project context is not fresh, use `$ontos-prime` before continuing.
- Read `../AGENTS.md`, `AGENTS.md`, and `README.md`, then only the implementation documents and
  product contexts whose routing triggers match the requested behavior. Do not follow unrelated
  references transitively.
- Research the real codebase to understand existing patterns, architecture, conventions, tests,
  package scripts, and ownership before planning.
- Create the plan in `specs/<type>-<descriptive-name>.md`, using a short kebab-case description. Do not overwrite an existing plan.
- Write one plan by default. Split the request only when the pieces can be implemented and validated independently; record dependencies and intended order.
- Use the matching `Plan Format` below.
- Replace every `<placeholder>` in the selected format. Add as much detail as needed to complete the work successfully.
- Be precise and implementation-ready without inventing APIs, files, or validation commands that repository research does not support.
- Follow existing patterns and conventions. Do not reinvent the wheel or add an abstraction without a concrete reuse case.
- Include tests throughout `Step by Step Tasks`; do not defer all test writing until the final step.
- Make the last task run the `Validation Commands`.
- When the change creates a supported business artifact, derive its `scaffold:*` script from
  `package.json`, inspect `--help`, and put that generator first in the implementation tasks. Run it
  from `app/` through `mise exec -- pnpm`.
- If business functionality requires a new file type without a Codesmith generator, record a blocking developer decision instead of planning to create it manually.
- For user-facing work, plan loading, empty, error, forbidden, validation, conflict, retry, accessibility, and responsive behavior as applicable.
- Stop after writing the plan. Do not implement it, modify application code, create a branch or commit, push, open a pull request, or create a GitHub issue.

## Relevant Files

Start with `../AGENTS.md`, `AGENTS.md`, and `README.md`. Then branch by the request:

| Trigger                                      | Inspect                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| Product meaning or cross-domain invariants   | Matching rows from `../CONTEXT-MAP.md`                                  |
| Durable architecture rationale               | The one relevant ADR selected through `../docs/README.md`                |
| Current implementation mechanics             | Matching rows from the `README.md` routing table                         |
| Shell behavior                               | Relevant files under `apps/` and their owner-local tests                 |
| MicroVertical behavior                       | The owning `verticals/<name>/` package and its tests                      |
| Shared runtime or contracts                  | Relevant `packages/`, consumers, and contract tests                       |
| Generators, validation, topology, or delivery| Relevant `scripts/`, `package.json`, `topology/`, or workflow sources     |

Open only matched paths. Completed specifications and delivery evidence are provenance, not planning
guidance, unless the request explicitly asks for them.

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

Return the path to each created plan in implementation order and identify any unresolved decision that blocks implementation. Do not implement the plan.
