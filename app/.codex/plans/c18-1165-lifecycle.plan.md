---
name: c18-1165-lifecycle
overview: 'Implement immutable published Promotion identity, editable drafts and successor lifecycle without business revisions.'
todos:
  - id: lifecycle-storage
    content: 'Adapt generated owner schema/services for drafts, immutable publication, successor links, technical concurrency tokens and half-open Effective Periods.'
    status: completed
  - id: lifecycle-rules
    content: 'Implement draft edits, publish, scheduled successor and disable/end/retire transitions while retaining original meaning and historical references.'
    status: completed
  - id: lifecycle-tests
    content: 'Test changed meaning creates a new identity, unchanged ranking does not, boundary times, conflicting schedules and concurrent stale changes.'
    status: completed
  - id: review-1165
    content: 'Review issue 1165 and its BDD against the code and migrations, fix failures and rerun owner tests.'
    status: completed
isProject: false
---

# c18-1165-lifecycle

## Execution Notes

Authority: [#1165](https://github.com/TechsioCZ/ontos/issues/1165). Follow [foundation](c18-00-foundation.plan.md). Likely owner areas are generated `src/db/`, repository services, shared definition schemas and unit/integration tests; actual generated paths take precedence.

Immutable meaning includes amount/percentage, effect, activation, target, eligibility and Effective Period. A changed published meaning has a successor Promotion identity. Drafts remain editable before publication. Retirement changes prospective usability without rewriting the published terms or historic applications. Technical lock/version tokens are concurrency controls, not Promotion Revision resources. Ranking is separate mutable selection policy and must not mutate Promotion definitions.

This lane supplies owner-local transaction-scoped persistence operations; administration later exposes them through generated Actions. No direct business mutation endpoint or standalone database transaction belongs here. Persist canonical facts, same-tenant reference constraints and concurrency protections using typed Drizzle and the approved migration flow.

## Constraints

Do not hard-delete published or historically referenced offers; do not silently rebind vouchers or historical evidence to successors. Preserve upstream occurrences and accepted history. No automatic newest-record winner for overlapping schedules. Follow foundation constraints.

## Operator Guidance

Depends on reviewed #1164. Coordinator owns migrations, generated schema inventory/verification and metadata changes; this worker owns lifecycle domain/service code and focused tests. Use owner transaction services rather than raw executors in handlers. Integrate required owner schema verifier/RLS changes with foundation. Run owner unit/integration tests and `mise exec -- pnpm db:check` after migration generation. Review all #1165 criteria before parallel consumers start.
