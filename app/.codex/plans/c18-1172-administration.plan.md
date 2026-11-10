---
name: c18-1172-administration
overview: 'Deliver governed Promotion and Voucher management, separate priorities, preview, audit and stale-write protection.'
todos:
  - id: admin-generate
    content: 'Generate required management Actions, services, HTTP bindings and governed reads before adapting any business implementation.'
    status: completed
  - id: admin-lifecycle
    content: 'Wire draft create/edit/validate/preview, publish/read, future successor and disable/end/retire through reviewed lifecycle services.'
    status: completed
  - id: admin-voucher-policy
    content: 'Wire Voucher provision/read/disable and separate cart/free-shipping priority management with unambiguous publish validation.'
    status: completed
  - id: admin-security-audit
    content: 'Apply current main access declarations, trusted scope, optimistic concurrency, safe projections and transactional actor/reason/before-after audit.'
    status: completed
  - id: admin-tests
    content: 'Test actual governed mutation/read receiving paths for allow/deny/unavailable, stale concurrent writes, preview without publication and safe projections.'
    status: completed
  - id: verify-admin-foundation
    content: 'Verify generated management components and their port-based tests; defer final issue 1172 review until the actual preview evaluator is integrated in acceptance.'
    status: completed
isProject: false
---

# c18-1172-administration

## Execution Notes

Authority: [#1172](https://github.com/TechsioCZ/ontos/issues/1172). Follow [foundation](c18-00-foundation.plan.md). Own generated administration Actions/reads, owner adapters and management tests. Coordinator owns generator execution, registration, exports and migrations. Prefer separate coherent Action intents over an untyped generic mutation endpoint. The generator and existing module conventions determine concrete file paths.

Every management intent requires Current permission for the acting Principal in trusted Tenant/business scope. Tenant membership, Storefront access, merchant title, commercial eligibility and numeric priority grant no authority. The checked-out current AUTHORIZATION.md already specifies granular access declarations and AccessDecisionService. Recheck source/current main and #1343/#1380 status at execution; do not implement an older generic Permission key or assume an unmerged PR API.

All supported intents must be accounted for, including unpublished draft preview, scheduled successor, Voucher disable and both rankings. Published changes to activation, minimum, methods, effect, eligibility or period use a new Promotion identity. Policy changes leave offer identity intact but invalidate affected prospective proof. Validate ranking consistency before publishing; runtime still fails closed on uncertainty. No minimum means absent optional criterion. A preview never publishes or changes offers and must later use the actual #1170 owner evaluator, not a divergent calculator.

Audit records actor, exact scope, action, safe reason, affected identities and trusted time. Policy audit includes prior/new meaning and effectivity. Use Core collectors and transaction-scoped owner services. Failed transactions cannot leave partial mutations or successful audit. Concurrent stale writers conflict; do not silently overwrite. Customer-safe reads must not expose internal audit, raw source evidence, codes/secrets for unrelated vouchers or data from other scopes.

## Constraints

Backend management only. No back-office page, Storefront widget, downstream purchase orchestration, Delivery catalog or charge mutation, custom authorization framework, blanket grants or legacy import management. Follow foundation constraints.

## Operator Guidance

Depends on reviewed #1167; this node delivers management-component readiness, not final completion of issue #1172, and may run alongside reuse, arithmetic and proof lanes using the frozen evaluator port. Use explicit per-operation access declarations/risk/selectors and legal-entity behavior from the current generator, with denied and indeterminate test controls. No hard-coded grant shortcut to make native tests pass.

Generate every supported artifact first via the coordinator. For each chosen Action run `scaffold:action -- --vertical promotion --action <intent> --legal-entity-scope <declared-scope> --authorization protected` with appropriate supported risk/selectors, then `scaffold:action-service`, and `scaffold:action-http` only for its management receiving path. Generate reads using `scaffold:module-api -- --vertical promotion --name <read> --authorization protected` and supported flags. Inspect help before exact invocations; use generated policy/outbox paths only if actually required.

Run owner unit/integration suites, `mise exec -- pnpm authorization:inventory:check`, `mise exec -- pnpm api:check`, `mise exec -- pnpm module-entrypoints:check`, and db checks for schema changes. Check each management intent against #1172; a missing intent is unfinished work, not a follow-up to omit. The explicit final issue #1172 review runs in #1174 after actual preview integration and verifies every management intent against real native services, including preview without publication. Port-based tests alone cannot close the issue.

## Consistency checkpoint 2026-11-07

Management component and integrated issue review are supported by the actual 94-unit/14-native test run, safe receiving HTTP coverage, and independent Read/UUID follow-up reviews. Completion of these component tasks does not declare final acceptance: required aggregate API, tooling, quality and full build gates remain tracked in acceptance and the rollup.
