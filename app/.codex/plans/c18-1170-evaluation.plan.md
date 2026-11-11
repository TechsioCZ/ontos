---
name: c18-1170-evaluation
overview: 'Compose the real Promotion owner evaluator with explicit typed outcomes and merchandise-first shipping completion.'
todos:
  - id: evaluation-facts
    content: 'Load complete authoritative Current owner facts under exact trusted context and preserve scoped evidence and typed load failures.'
    status: completed
  - id: evaluation-merchandise
    content: 'Compose product vouchers then one ranked cart offer into complete exact merchandise proof or proven business absence without waiting for Delivery.'
    status: completed
  - id: evaluation-shipping
    content: 'Evaluate shipping only from bound Current monetary proof, required publication and selected Delivery evidence; join without reapplying monetary benefits.'
    status: completed
  - id: evaluation-outcomes
    content: 'Return distinct complete/applied, proven-none, invalid, conflict, unavailable and unverifiable outcomes and invalidate material changes between stages.'
    status: completed
  - id: evaluation-tests
    content: 'Exercise real owner services and staged proof verification, races, outage versus absence and every issue 1170 BDD using external fact-port doubles only.'
    status: completed
  - id: review-1170
    content: 'Review issue 1170 end to end, fix failures and rerun owner unit/integration suites.'
    status: completed
isProject: false
---

# c18-1170-evaluation

## Execution Notes

Authority: [#1170](https://github.com/TechsioCZ/ontos/issues/1170). Follow [foundation](c18-00-foundation.plan.md). Own evaluator orchestration, owner fact-loading services and integration tests. Consume reviewed selection, arithmetic and Voucher modules plus the verified proof component rather than rewriting their business rules.

Stage one issues complete Current merchandise evidence with 0..N product applications and 0..1 cart application or proven absence. It cannot wait for Shipping. Stage two consumes authoritative published merchandise only when its optional minimum needs it, plus selected external Delivery evidence. Preserve exact purchase and result bindings, separate shipping ranking and fresh validity. Material changes in purchase, Promotion/Voucher, basis, selected Delivery or either relevant priority require new prospective evaluation. Do not combine stale monetary proof with a new shipping winner.

Effect error declarations must distinguish invalid binding/request, configuration conflict, required owner unavailable and evidence unverifiable. Business not-applicable means proven facts; no positive capacity has its own explicit reason. A full empty application set requires complete relevant evidence. Shipping failure may coexist with independently completed monetary evidence, but cannot become a complete shipping/payable success. Preserve application identity and exact attribution across repeated proof verification.

Evaluation and reads run through the existing governed owner lifecycle where exposed. Administration preview can call this owner-local service through its generated governed read. Do not introduce the downstream evaluation/proof transport/API or consumer orchestration excluded by #1171. Native tests must run the real owner repository/services, not only a fake evaluator.

## Constraints

No Pricing publication implementation, NET-to-GROSS conversion, TAX or Delivery pricing, payable composition, downstream API wiring or production activation. No fake zero result on timeout and no stale-allow proof lease. Follow foundation constraints.

## Operator Guidance

Depends on reviewed #1166 and verified #1171 proof-component readiness; #1168/#1169 arrive transitively through selection. Administration may be developed in parallel against the frozen preview/evaluation port, but final preview wiring is verified in #1174. Integrate store generation/currentness under owner transaction conventions and test material inserts as well as modifications. Run owner unit/integration suites plus the read-only Pricing contract regressions; independent review checks actual service composition and evidence, not just pure helper tests.
