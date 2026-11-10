---
name: c18-1174-acceptance
overview: 'Verify every C18 owner capability and its safe downstream handoff with native tests while keeping integrations gated.'
todos:
  - id: acceptance-matrix
    content: 'Map every root/branch/leaf criterion and BDD to real native tests, explicitly separating owner evidence from downstream doubles and missing integrations.'
    status: completed
  - id: acceptance-native
    content: 'Run real generated management paths, repositories, evaluator and proof verification together; complete preview wiring and repair cross-lane failures.'
    status: completed
  - id: review-1171
    content: 'Independently review all issue 1171 criteria and BDD against the real integrated owner fact-loading and proof/currentness services; repair findings and rerun native tests.'
    status: completed
  - id: review-1172
    content: 'Independently review all issue 1172 management intents and BDD after actual preview evaluator wiring, including real governed reads/writes; repair findings and rerun native tests.'
    status: completed
  - id: acceptance-money-shipping
    content: 'Prove exact benefits, one-publication boundary, published threshold/currentness, independent shipping entitlement and typed missing GROSS/Delivery outcomes.'
    status: completed
  - id: acceptance-isolation
    content: 'Verify denied/indeterminate scope and permissions, retries/concurrency, unrelated composition continuity and unchanged Pricing module-not-installed fence.'
    status: completed
  - id: acceptance-full-gates
    content: 'Run targeted suites, repository checks, database/migration verification, tooling and builds required by changed deployment artifacts; repair failures without bypasses.'
    status: completed
  - id: review-1174
    content: 'Independently review issue 1174 plus integrated behavior, repair findings and rerun affected/full required validation before parent rollup.'
    status: completed
isProject: false
---

# c18-1174-acceptance

## Final accepted checkpoint, 2026-11-09

The complete requested owner scope and all required reviews are accepted. The tracked specification `specs/feature-c18-promotion-owner.md` records exact commands, revisions, preserved failures and the qualified nineteen-unit result: eighteen immutable artifacts at `ec9d6e107` and repaired Projects at `728c51829`, each with its own actual identity and source closure. This is not a uniform-SHA aggregate pass. All six previously pending acceptance/rollup outcomes are now complete; all 64 plan todos are completed. Pricing/GROSS/Commerce/Delivery adoption and production activation remain separate gates. Earlier checkpoints below are historical.

## Execution Notes

Authority: [#1174](https://github.com/TechsioCZ/ontos/issues/1174). Follow [foundation](c18-00-foundation.plan.md). Own integrated owner acceptance and necessary narrow cross-lane repairs, with the coordinator integrating shared files.

The coverage matrix must include all five supported families, immutable lifecycle/successor, canonical normalized non-recyclable codes, reuse, one product slot per occurrence, all four product/cart combinations, explicit cart ranking and separate shipping ranking, agreement-first basis resolution, capacity/zero behavior, scale-18 conservation and exact evidence. Include every numerical and failure scenario from #1169. Preserve all original occurrences including ineligible ones in purchase identity, without making them allocation recipients.

Exercise merchandise completion before Delivery choice. Later shipping consumes exactly the matching published merchandise result and selected owner-issued Delivery evidence; no minimum means no monetary threshold requirement. Missing required GROSS publication, changed priority between stages, wrong publication basis or stale offer evidence is typed non-success. Verify automatic and voucher free shipping, threshold equality, below-threshold post-discount value, methods, periods, ranking conflicts and authoritative-zero versus missing charge. Owner-local external evidence doubles prove C18 responses, not real Delivery/Pricing/TAX integration.

Prove no double application, no payment/tax deduction or invented Shipping charge. Preserve immutable accepted evidence after retirement and policy changes. Use locally authored Promotion test inputs conforming to public Pricing contracts and permitted public pure helpers to establish the existing `0.945 -> 0.95/+0.005` and two `1.005 -> 1.01` sum `2.02` publication boundaries, without importing another deployment's private fixtures/tests, modifying Pricing adoption or claiming GROSS output.

Current Pricing intentionally fails closed once Promotion is installed without #894. Test the owner in an isolated permitted test composition. Keep active production Commerce composition unchanged and document this adoption gate in the acceptance handoff. Unrelated compositions must not gain an eager Promotion dependency. No production release/activation is part of acceptance.

## Constraints

Do not solve failing end-to-end consumer tests by implementing downstream work, relabeling issues, relaxing fences or substituting safe outcomes with zero. If a real external prerequisite prevents a required test, report the exact blocker and retain unfinished todos; do not call it passed. Follow foundation constraints.

## Operator Guidance

Depends on reviewed #1173, which joins evaluation and administration component readiness. Final #1171/#1172 review occurs here after real integration; their earlier readiness nodes never assert issue completion. Use an independent review subagent after the implementation lanes; give it full root/branch/leaf scope and current rules. Fix confirmed in-scope findings and rerun relevant checks, with no artificial review-round cap.

Commands from `app/`, after the generated owner scripts are confirmed: `mise exec -- pnpm --filter @app/promotion test:unit`, `mise exec -- pnpm --filter @app/promotion test:integration`; if a separate schema-only package exists, its own test/typecheck scripts too. Existing regressions: `mise exec -- pnpm --filter @app/pricing-contracts test:unit` and `mise exec -- pnpm --filter @app/pricing test:unit`. These commands rely on actual scripts; add missing owner test wiring in foundation using the generated/native repository conventions, never silently omit a suite.

Required final checks: `mise exec -- pnpm db:check`, `mise exec -- pnpm db:verify` against the prepared isolated database, `mise exec -- pnpm database-trust:audit` where grant/schema registration changed, `mise exec -- pnpm api:check`, `mise exec -- pnpm contract:check`, `mise exec -- pnpm authorization:inventory:check`, `mise exec -- pnpm check:local --scope tooling`, `mise exec -- pnpm check`, and `mise exec -- pnpm build` because a new deployable owner changes runtime/bundling artifacts. Run native database integration/migration tests against actual PostgreSQL, not only mocks. Full check does not include unit, integration, tooling or builds; each is separate evidence. If memory is below 32 GB use `mise exec -- pnpm check --concurrency 2` as documented. Format only intended files. Preserve hooks and diagnostics. Record commands, outcomes, revision and unresolved external limits; do not claim production acceptance.

## Consistency checkpoint 2026-11-07

Management component and integrated issue review are supported by the actual 94-unit/14-native test run, safe receiving HTTP coverage, and independent Read/UUID follow-up reviews. Completion of these component tasks does not declare final acceptance: required aggregate API, tooling, quality and full build gates remain tracked in acceptance and the rollup.

## Earlier owner handoff, superseded by fresh review, 2026-11-07

All required owner tests, complete repository and tooling gates, database/trust checks and the standard parallel full build passed. The build validated implementation commit `f679e3789d735844baca6a246591294de4b36eb6`; all source manifests match before/after build and compiled runtime smoke. Actual built Promotion readiness returned HTTP 200 with that exact revision and consistent marker in the canonical build namespace. Final independent issue/parent/root reviews accepted the complete requested owner scope; see `.codex/reports/c18-final-parent-review.md`, `.codex/reports/c18-final-foundation-acceptance-review.md` and `.codex/reports/c18-final-validation-review.md`. No downstream adoption, production activation, roadmap mutation or issue closure was performed. Remaining changes after validated executable source are completion/evidence documentation only.

## Earlier review checkpoint, 2026-11-07

The prior accepted handoff is historical and superseded. The repaired source and Promotion glibc Linux plus Alpine/musl materialized-runtime profiles passed at `e5cc327ad`; this proves Promotion owner-local portability, not the complete required all-Node artifact matrix. Cart/Order executed build-host anchors remain a baseline artifact obstacle outside this C18 repair. The gate is not waived and no requirement or scope changed.

Final frozen validation of clean implementation revision `1b6ee79c18ba8da49588ca09d3598fd087b24857` passed all 24 recorded commands, including complete tooling, owner/native and Pricing/Core regressions, authorization/database/trust checks, full `pnpm check --concurrency 2`, complete `pnpm build`, and final isolated materialized Promotion readiness/public-contract proof. All 14,578 source entries match and command/source exits are zero. Later changes only correct status/evidence documentation; the runtime proof retains its actual implementation SHA. All six remaining acceptance/rollup todos stay pending, including executed source reviews whose final acceptance depends on unfinished predecessors. The current graph remains 58 completed of 64, with no all-64-complete claim. See `.codex/reports/c18-fresh-implementation-review.md` and `.codex/reports/c18-final-scope-consistency-review.md`.

## Continuation checkpoint, 2026-11-07

This checkpoint supersedes the earlier Cart/Order-anchor and completion assessments. The retained implementation checkpoint `bb85c1d73` has the same Git tree as `1f6fdd6c0`: it includes the reviewed public-SDK final Node normalization/resealing repair, with 48 focused controls and complete tooling passing at 1f6. Earlier f05 standard build/full check, 96 Promotion units, 14 native owner cases and corrected environment-specific native proofs remain attributed to their actual revisions.

Final acceptance is blocked by actual Party SSR in the pinned native i18n/compiler/Module Federation cohort. Two real Alpine build pairs passed; their direct SSR probes still returned client fallback with `TypeError: n is not a function`. The second output retained all six requested eager flags, but the generated integration still synchronously consumes an async provider. Full unchanged-source closure passed. Unsuccessful application-sharing experiments were reverted; no dependency patch, SSR/sharing bypass or acceptance exception is retained.

The required complete artifact matrix is not established. The 1f6 aggregate check also remains explicitly failed because it ran against stale compiled contracts before a new build; all its other steps passed. No historical result is relabelled as a current full-gate success. The next prerequisite is a tested compatible framework/cohort correction, followed by the unchanged final build/runtime/repository checks.

All fifteen live issue bodies still match the reviewed criteria and retain exactly `status:now`. Status remains `in_progress`, with 58 of 64 todos complete and the same six pending acceptance/rollup tasks. Scope and downstream exclusions are unchanged. Exact results, revisions, failed attempts, reviewer provenance and the remaining boundary are in `.codex/reports/c18-bounded-ssr-verdict.md` and `.codex/reports/c18-party-ssr-runtime-probe-review.md`.

## Framework repair checkpoint, 2026-11-08

OntOS commit `1fced8d73` aligns the exact declared Rsbuild 2.2.13 / Rspack 2.2.9 cohort; the aligned original SSR probe still failed. Framework branch `codex/ontos-native-i18n-ssr`, commit `0889ac34174f996973405d64c662b5559dbbc1f0`, fixes the native factory's eager backend dependency with one direct instance-module import. Its compiler regression failed before the repair and passes afterwards; all 67 native i18n tests, all 51 framework build tasks, canonical fork-boundary checks and normal commit hooks passed.

The normal release preparer produced all 49 local `.19` cohort packages. An isolated Alpine OntOS copy installed them normally, rebuilt Privacy and Party, and passed the original SSR request without fallback. The unchanged materializer then passed through the framework's official exact-artifact local registry and source-qualification policy. The complete focused Party artifact proof passed with source trees hidden, network disabled, public SDK envelopes verified, genuine SSR, emitted assets and executed MF exports. The first runtime attempt exposed a harness mistake: the published Node ABI selects the manifest-declared named container. Correcting that consumer and awaiting exposed factories passed 29 controls and the runtime proof against identical artifact bytes.

This is focused local-candidate evidence, not the full nineteen-unit matrix or a final published-dependency gate. The application baseline remains `1fced8d73`; only the isolated copy's dependency declarations and pnpm-generated lockfile differ. All 11,387 checked non-runtime source files otherwise match. The framework candidate source is recorded separately as 0889; no artifact identity was relabelled.

The next external prerequisite is submission and publication of the reviewed framework repair through its trusted workflow. After an approved full-cohort release, update OntOS normally and run the unchanged complete artifact and repository gates on the final dependency state. No remote publication, push, issue mutation or downstream adoption occurred. Status remains `in_progress`, with the same 58 completed and six pending graph todos. Details and failed attempts: `.codex/reports/c18-upstream-native-i18n-fix-0889.md`.
