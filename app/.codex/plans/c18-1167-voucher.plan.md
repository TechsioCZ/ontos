---
name: c18-1167-voucher
overview: 'Deliver canonical Voucher identity, tenant-normalized code lookup and exact occurrence choices without consumption.'
todos:
  - id: voucher-persistence
    content: 'Adapt generated Voucher schema and services for immutable Promotion binding and permanent tenant/code attribution with database uniqueness.'
    status: completed
  - id: voucher-choice
    content: 'Implement trim and case-insensitive lookup, explicit remove-before-replace product choice validation and separate shipping voucher activation.'
    status: completed
  - id: voucher-outcomes
    content: 'Declare unknown/inactive/ineligible/malformed/unavailable/unverifiable results without leaking other tenants or voucher secrets.'
    status: completed
  - id: voucher-tests
    content: 'Test normalization, cross-tenant isolation, concurrent duplicate code publication, no recycling/rebinding and duplicate occurrence vouchers.'
    status: completed
  - id: review-1167
    content: 'Review every issue 1167 acceptance criterion and BDD, repair findings and rerun the relevant owner tests.'
    status: completed
isProject: false
---

# c18-1167-voucher

## Execution Notes

Authority: [#1167](https://github.com/TechsioCZ/ontos/issues/1167). Follow [foundation](c18-00-foundation.plan.md). Own generated Voucher contracts and owner-local lookup/binding services plus their tests. Use the lifecycle lane's immutable Promotion identity.

`LETO10`, `leto10` and `LETO10` resolve to the same Voucher within a Tenant. The normalized published code remains attributed permanently to that Voucher identity, including after retirement. A successor cannot inherit it through silent rebinding. Enforce uniqueness in PostgreSQL as well as the domain checks.

A product occurrence has one explicit choice. Reject a second voucher submitted without removing the existing choice. Model/validate the prior choice transition in owner inputs; do not add Cart persistence to remember it. Shipping vouchers use the same identity/lookup rules and a distinct target, occupying neither product nor cart monetary slots. Usability follows bound Promotion lifecycle and exact context. A wrong-tenant code must not disclose another tenant's record.

## Constraints

No usage counters, quotas, credits, implicit best-voucher replacement, Cart state or UI widget. The later evaluator must enforce cardinality even if a client bypasses choice helpers. Follow foundation constraints.

## Operator Guidance

Depends on reviewed #1165. Coordinator serializes code/schema/migration additions. Admin may consume this lane after its review while reuse and monetary work proceed separately. Include PostgreSQL uniqueness/race tests and expected typed failures, not just normalization unit tests. Run owner unit/integration tests; run db checks if this lane adds migrations. Review #1167 before its output is considered stable.
