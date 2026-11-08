# Inventory context port — bounded acceptance and producer handoff

This records issue [#1286](https://github.com/TechsioCZ/ontos/issues/1286), under H1094-02=B. It is delivery evidence, not a new authority or production producer contract. Source baseline: `c87dd2fc0c0dfad35a529e04ceb779daf4d2f5b5` (reviewed map over the current main cohort). Independent issue review and the final shared quality gate remain coordinator gates.

## Existing contract

The existing registered Action is `commerce.inventory.create-inventory-reservation`, schema version `1`, mounted at `POST /inventory/actions/create-inventory-reservation`. Its [payload/result/error schemas](../../../verticals/inventory/shared/domain/inventory-reservation-create.ts) and [actual Action/service factory](../../../verticals/inventory/src/actions/create-inventory-reservation.action.ts) remain unchanged. There is no newly invented standalone context schema version or public producer API.

The existing Inventory-private [InventoryReservationCommerceContextAuthorityPort](../../../verticals/inventory/src/services/inventory-reservation-commerce-context.ts) accepts exact `tenantId`, `customerConfigurationId`, `legalEntityId`, `storefrontId`, and the original `effectId`. `resolveCurrent` returns the existing [TrustedCurrentCommercePurchasingContextSchema](../../../verticals/inventory/shared/domain/stock-sharing-eligibility.ts) meaning or typed `InventoryReservationCreateUnavailable`.

The qualified result contains Tenant, Customer Configuration, Selling Legal Entity, Channel, Commerce Market, Storefront, owner evidence and observation. The canonical qualification is defined in the [Inventory context](../../../../docs/contexts/inventory/CONTEXT.md) and referenced by the [Commerce context](../../../../docs/contexts/commerce/CONTEXT.md). It does not add Principal, Permission, Cart, Purchasing Subject, Assortment, Price Group or operation time to Stock Sharing Eligibility identity.

The provider is a trusted Inventory composition dependency. Decoding a payload, a `CURRENT_OWNER_VERIFIED` literal, a ResourceRef or a valid credential does not establish authoritative provenance. The default port remains typed unavailable. A future production adapter must resolve Current owner evidence under its accepted trust contract; this delivery adds neither a freshness TTL nor a second verifier/registry.

## Executed owner-level evidence

The [PostgreSQL acceptance suite](../../../verticals/inventory/tests/integration/review-remediation-confirmation-protection-postgres.test.ts) uses the actual registered Action, its actual default service factory, Core Action permission/lifecycle processing, owner persistence and registered Outbox worker. Its context and selected-backend providers are explicitly identified contract-conforming fixtures. Principal scope resolution, executor permission, ContextAccess and module-entrypoint inputs are controlled Core test fixtures; these executions do not prove live production grants, a public Commerce producer, receiving HTTP authentication or production E2E. Existing global Composition authority fixture state is restored after each scoped scenario.

| Requirement                                                   | Executed evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contract-conforming provider reaches the actual factory       | Captured exact authority request; accepted context retained in the result; one durable create intent and dispatch request.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Missing, stale, unavailable or indeterminate Current evidence | Four authority failure cases preserve the declared typed failure; no create effect, ledger, obligation or Outbox message is written.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Contradictory identity/evidence                               | Eight schema-valid provider results disagree on Tenant, Customer Configuration, seller, Channel, Market, Storefront, evidence or observation; each is rejected without context repair and before new effects.                                                                                                                                                                                                                                                                                                                                          |
| Shape-valid caller context is not provenance                  | The caller payload containing `CURRENT_OWNER_VERIFIED` fails through the unresolved default authority with no new effect/dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Equal stock scope does not equal Permission                   | P1 and P2 submit identical stock context. Core checks the exact business permission separately; P2 is durably rejected before authority resolution while P1 creates one intent. This is controlled permission-port evidence, not a live SpiceDB grant claim.                                                                                                                                                                                                                                                                                           |
| Original uncertain effect is recovered                        | A fresh Action stages the intent; the registered worker observes an indeterminate selected-backend outcome and publishes its existing reconciliation redispatch. An Action retry retains the original request while the default Current-context port is unavailable. The next registered-worker cycle and terminal Action replay preserve the original Attempt, effect, Reservation, selected authority, Quantity and Unit. Both backend requests are exactly the original request; there is one create-effect row, one ledger row and one obligation. |
| Bounded completion retains the future obligation              | The handoff below preserves the existing roadmap obligation. No producer, Cart, Checkout, Order, Availability or exact Position-set capability is activated.                                                                                                                                                                                                                                                                                                                                                                                           |

Final native suite result: **18 tests PASS**, exit `0`. It includes the two existing Action/worker/Protection scenarios; their deliberate crash-recovery diagnostic is expected. The six focused existing unit suites also passed: **39 tests**, covering exact replay, indeterminate retry, concurrent all-or-nothing allocation, Quantity/Unit preservation, owner contracts and Stock Sharing Eligibility. Targeted Oxlint passed with zero warnings/errors, using `Schema.is` for tagged errors. All four changed source/evidence/context files passed formatting. No production behavior rewrite was necessary; existing port and service behavior is verified at this bounded seam.

Commands run inside Locki from `app/`, with `mise exec -- pnpm`:

```sh
mise exec -- pnpm --filter @app/inventory exec rstest --project integration --pool.maxWorkers 1 tests/integration/review-remediation-confirmation-protection-postgres.test.ts
mise exec -- pnpm --filter @app/inventory exec rstest --project unit --pool.maxWorkers 1 tests/unit/inventory-reservation-create.test.ts tests/unit/inventory-concurrent-reservations.test.ts tests/unit/inventory-owner-contract-acceptance.test.ts tests/unit/inventory-action-business-permissions.test.ts tests/unit/stock-sharing-eligibility.test.ts tests/unit/stock-sharing-eligibility-service.test.ts
mise exec -- pnpm exec oxlint --no-error-on-unmatched-pattern verticals/inventory/tests/integration/review-remediation-confirmation-protection-postgres.test.ts
```

Sanitized operator logs are retained under `.codex/plans/ontos-1094/evidence/1286-owner-port-*.log`. The final repository-wide gate and integrated #1297 acceptance are separate coordinator checks; this record does not claim them executed.

## Deferred production producer

### Dependency declaration boundary

The consuming registered Action is `commerce.inventory.create-inventory-reservation`, whose
descriptor has schema version `1`. That version belongs to the Action; the existing
`InventoryReservationCommerceContextAuthorityPort` has no separately versioned public producer
operation. Its `TrustedCurrentCommercePurchasingContextSchema` and `CURRENT_OWNER_VERIFIED` literal
remain qualified evidence shape, not proof of provenance.

The Current-context requirement applies to a new create intent after original-effect lookup.
Original-effect recovery retains its existing branch before acquiring a new Current-context fact.
The public-operation dependency declarations added for #1287 therefore must not invent a provider
module, endpoint or port version to represent this unresolved production producer. The existing
owner-local port, typed unavailable default, executed bounded acceptance above and producer handoff
below remain the truthful declaration boundary. This clarification records no new test execution or
production integration.

The existing [#253 step-29 handoff comment](https://github.com/TechsioCZ/ontos/issues/253#issuecomment-5661414584) requires the proper Commerce/Cart owner to deliver and identify the real production producer when that step is activated. It must establish qualified Current context from its actual owners and integrate through Inventory's existing port without importing private cross-owner code or treating caller assertions as owner evidence.

At step 34, [#877](https://github.com/TechsioCZ/ontos/issues/877) must prove the public producer → governed Inventory Action → exactly selected Reservation Authority path with real provenance, permissions, scope/currentness, exact Quantity/Unit and original-effect recovery. Step 29 does not itself introduce Reservations. Completing bounded #1286 does not complete that production journey or remove its prerequisites.

No issue, comment, hierarchy or status was changed. #253 remains read-only. Availability #874, Inventory Position-set `EXACT_COMMERCE_SCOPE`, production DB isolation/security readiness and production deployment remain outside this bounded delivery.
