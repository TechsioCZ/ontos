# Availability owner acceptance (#1022)

Tests execute the real Availability evaluator, Launch policy, Currentness and public consumer handoff against controlled owner contracts. Each row names an executable test beginning `scenario N:`. They do not run private Inventory behavior or downstream application orchestration.

| Scenario | Behavior                                                                   | Test file                                                                 | Owner issues        |
| -------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------- |
| 1        | Product-only has no authoritative decision                                 | `unit/availability-owner-acceptance-authority.test.ts` (`scenario 1:`)    | #1015, #1021        |
| 2        | Exact Selection: requested 2 versus 5                                      | `unit/availability-owner-acceptance-authority.test.ts` (`scenario 2:`)    | #1015, #1018, #1019 |
| 3        | Assortment eligibility cannot create Availability authority                | `unit/availability-owner-acceptance-authority.test.ts` (`scenario 3:`)    | #1015, #1018        |
| 4        | Current zero distinct from missing/unknown                                 | `unit/availability-owner-acceptance-authority.test.ts` (`scenario 4:`)    | #1017, #1018        |
| 5        | Stale last-known 10 is neither Current 10 nor zero                         | `unit/availability-owner-acceptance-authority.test.ts` (`scenario 5:`)    | #1017, #1018, #1020 |
| 6        | Missing/unknown preserves uncertainty                                      | `unit/availability-owner-acceptance-authority.test.ts` (`scenario 6:`)    | #1017, #1018        |
| 7        | Conflicting evidence has no arbitrary winner                               | `unit/availability-owner-acceptance-authority.test.ts` (`scenario 7:`)    | #1017, #1018        |
| 8        | Unresolved Reservation effects do not prove reusable ON_HAND               | `unit/availability-owner-acceptance-authority.test.ts` (`scenario 8:`)    | #1017, #1018, #1019 |
| 9        | Multi-Position coverability without Allocation/Reservation                 | `unit/availability-owner-acceptance-authority.test.ts` (`scenario 9:`)    | #1018, #1019        |
| 10       | Incomplete known set cannot authorize negative                             | `unit/availability-owner-acceptance-authority.test.ts` (`scenario 10:`)   | #1018, #1038        |
| 11       | Only 3 safely reusable cannot partly satisfy requested 5                   | `unit/availability-owner-acceptance-authority.test.ts` (`scenario 11:`)   | #1018, #1019        |
| 12       | Selected Inventory failure cannot fallback to another backend/raw provider | `unit/availability-owner-acceptance-authority.test.ts` (`scenario 12:`)   | #1017, #1019        |
| 13       | Owner-valid retained evidence survives source outage                       | `unit/availability-owner-acceptance-currentness.test.ts` (`scenario 13:`) | #1020               |
| 14       | Final Checkout revalidates material changes                                | `unit/availability-owner-acceptance-currentness.test.ts` (`scenario 14:`) | #1020               |
| 15       | Checkout cannot authorize unproven actual commitment use                   | `unit/availability-owner-acceptance-currentness.test.ts` (`scenario 15:`) | #1020, #1021        |
| 16       | Changed Bundle R2 requires replacement; original Attempt retained          | `unit/availability-owner-acceptance-currentness.test.ts` (`scenario 16:`) | #1020, #1021        |
| 17       | Later Reservation failure preserves positive history                       | `unit/availability-owner-acceptance-currentness.test.ts` (`scenario 17:`) | #1015, #1018, #1020 |
| 18       | Later destination failure preserves Availability history                   | `unit/availability-owner-acceptance-consumers.test.ts` (`scenario 18:`)   | #1016, #1021        |
| 19       | Shipping failure/pickup success remain downstream                          | `unit/availability-owner-acceptance-consumers.test.ts` (`scenario 19:`)   | #1016, #1021        |
| 20       | Digital/service needs no physical destination/carrier                      | `unit/availability-owner-acceptance-consumers.test.ts` (`scenario 20:`)   | #1016, #1021        |
| 21       | Stale Search hit/omission carries no purchase authority                    | `unit/availability-owner-acceptance-consumers.test.ts` (`scenario 21:`)   | #1020, #1021        |
| 22       | Repeat Order requires fresh exact owner decision                           | `unit/availability-owner-acceptance-consumers.test.ts` (`scenario 22:`)   | #1015, #1020, #1021 |
| 23       | Published Inventory completeness permits multi-Position decision           | `unit/availability-owner-acceptance-authority.test.ts` (`scenario 23:`)   | #1018, #1038        |
| 24       | Missing/invalidated completeness cannot authorize negative                 | `unit/availability-owner-acceptance-authority.test.ts` (`scenario 24:`)   | #1018, #1020, #1038 |
| 25       | Owner-valid R1 not stale solely because R2 exists                          | `unit/availability-owner-acceptance-currentness.test.ts` (`scenario 25:`) | #1020               |
| 26       | Owner-invalid R1 requires actual changed owner-valid R2                    | `unit/availability-owner-acceptance-currentness.test.ts` (`scenario 26:`) | #1020, #1038        |

## Owner responsibilities

- #1015: exact Selection, Quantity, canonical Unit, trusted purchasing context; no Reservation, Confirmation or Protection authority.
- #1016: general prospective delivery boundary; exact destination, carrier and fulfillment stay downstream.
- #1017: selected Inventory public authority and truthful stock/coverage/obligation/effect meanings; no raw provider or backend fallback.
- #1018: three outcomes, exact decimal support, independent positive lower bounds, no double counting or incomplete-set negative.
- #1019: real Launch exact-quantity policy; no buffer, partial offer, backorder, preorder, supplier/optimistic fallback or ON_HAND-minus-RESERVED inference.
- #1020: owner validity at exact use, coherent snapshot retry, immutable history and owner-defined revision materiality.
- #1021: provider-neutral informational/current/unproven/historical handoff and Bundle replacement without Attempt patching.
- #1038: published producer response schema compatibility and canonical completeness envelope. Separate Inventory producer tests establish SQL snapshot/invalidation behavior with controlled Commerce authority; the registered production exact-Commerce verifier remains externally blocked, so these are not successful live-composition evidence; Availability never infers completeness from known Position IDs, completed pagination, row counts or private data.

## Controlled fixtures and limits

`support/availability-currentness.ts` constructs typed public owner evidence; `support/availability-owner-acceptance.ts` composes real Availability behavior with controlled owner proof. The per-Position contract remains STOCK_EVIDENCE_ONLY with physicalOnHandReusableProof NOT_PROVIDED. Reuse requires separately supplied owner qualification. Owner validity is an explicit input, never inferred from successful query completion.

Controlled downstream delivery/Search/Checkout/Order/Reservation observations establish ownership boundaries; those applications are not implemented here. Live cross-domain orchestration #874 and production acceptance #880 remain parked.

## Review remediation regressions (#1014)

The original 26 scenarios remain owner-contract acceptance. The deployed Availability API is intentionally foundation-only until #874: preserved schemas/client and owner-local reads/services are future contracts, not a registered business read. `unit/availability-runtime-publication.test.ts` exercises the actual runtime without injected owner layers: readiness 200 and current-availability 404. Build contract/public-output generation confirms no business APIs, pages, components or Search; final deployment packaging remains blocked by the API-only build marker's `sourceRevision: workspace`.

| Audit addition                               | Executable evidence                                                                                                                                 | Result / boundary                                                                                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production Inventory exact-Commerce COMPLETE | #1038 registered composition                                                                                                                        | Blocked: Commerce production provides unavailable authority and the approved API-key issuer cannot delegate the purchase actor; no fake verifier installed. |
| Availability business publication            | `unit/availability-runtime-publication.test.ts`                                                                                                     | Actual foundation runtime; business read absent.                                                                                                            |
| Independently selected authority             | `unit/availability-decision.test.ts`: coherent alternate backend; `unit/availability-consumer-contract.test.ts`: selected-authority failure handoff | Controlled owner qualification, real evaluator/currentness/consumer; mismatch stays INDETERMINATE.                                                          |
| ON_HAND 10, reusable 0                       | `unit/availability-decision.test.ts`: constrained reusable zero                                                                                     | Authoritative insufficiency; not CURRENT_ZERO.                                                                                                              |
| All Positions UNUSABLE                       | Same constrained-zero regression                                                                                                                    | Not vacuous physical zero.                                                                                                                                  |
| Fresh same business context                  | `unit/availability-subject.test.ts`; `unit/availability-consumer-contract.test.ts`: fresh verification reaches owner authority                      | Business identity allows revalidation; exact proof lineage remains material; immutable historical-only handoff.                                             |
| Unchanged owner records reordered            | `unit/availability-currentness.test.ts`: owner evidence array order changes                                                                         | UNCHANGED; five unique owner records still required.                                                                                                        |
| Policy coherence across retries              | `unit/availability-currentness.test.ts`: exact policy before each bounded owner verification                                                        | Policy → verify on each attempt; evaluator uses the attested candidate, without post-verification policy replacement.                                       |
| Truthful public authority reason             | `unit/availability-consumer-contract.test.ts`: independently selected authority failure                                                             | SELECTED_AUTHORITY_MISMATCH survives sanitized handoff without provider configuration fields.                                                               |

Further guards reject valid cross-actor, Purchasing Subject, context reference and foreign-Tenant identity reuse; duplicate owner records and proofs for fresh-but-different exact evidence fail closed. Full gates and remaining developer blockers are recorded in the local review-remediation handoff. Passing controlled owner tests does not establish #874 live orchestration or production acceptance #880.
