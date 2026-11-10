---
type: feature
status: done
created: 2026-11-06
---

# C18 Promotion owner

## Scope and approved implementation plan

Implement issue #1160 and its existing fourteen descendants, #1161 through #1174, under the exact accepted C18 plan graph. This specification is the implementation-status record for the already approved plan bundle, not a new scope or architecture decision.

The complete issue criteria and BDD remain authoritative. Their execution-start snapshots are in `.codex/plan-graphs/c18-promotion-1160/issues.json`. The exact plan selection, dependency overlay, per-issue coverage and ownership are in [.codex/plans/c18-99-rollup.plan.md](../.codex/plans/c18-99-rollup.plan.md). Read [foundation](../.codex/plans/c18-00-foundation.plan.md) and every assigned leaf plan before implementation. Follow their todo order and graph dependencies. Component readiness for #1171/#1172 is distinct from their final independent issue reviews after native integration in #1174.

## Step by step tasks

- [x] Prepare and verify the required isolated Locki sandbox and generated owner according to foundation.
- [x] Execute the thirteen selected plans in dependency order, with disjoint subagent ownership and independent review of every issue.
- [x] Complete native owner acceptance, all required validation, and the parent/root reviews.

## Constraints and acceptance

All invariants, tests, accepted numerical examples, generator rules, validation commands and review criteria in the selected plans apply without weakening. The implementation is confined to the Promotion owner and necessary application infrastructure. #253 and closed issues are read-only. No downstream Pricing adoption, GROSS producer, Cart/Checkout/Order/Delivery orchestration, UI, legacy import or production activation is authorized. Current owner permission, trusted scope, module-state, Effect, Drizzle and independent deployment rules remain mandatory.

## Validation commands

Run the owner-native unit and integration scripts established by generation, the existing Pricing contract regressions, and every command in the #1174 acceptance plan. Final gates include `mise exec -- pnpm db:check`, `mise exec -- pnpm db:verify`, `mise exec -- pnpm api:check`, `mise exec -- pnpm contract:check`, `mise exec -- pnpm authorization:inventory:check`, `mise exec -- pnpm check:local --scope tooling`, `mise exec -- pnpm check`, and `mise exec -- pnpm build`. Validate database grants where changed. Run project commands inside Locki from `app/`.

## Final owner acceptance, 2026-11-09

C18 owner scope is complete for #1160 and all fourteen descendants #1161–#1174. All thirteen selected plans and all 64 todos are complete. Independent parent, root and artifact reviews found no remaining blocker. The fifteen live issue bodies still exactly match the execution snapshots; each issue remains open with exactly `status:now`. No GitHub issue, execution label or roadmap #253 was modified.

The application consumes the published `3.9.3-ultramodern.19` cohort. Normal pnpm installation regenerated the lockfile. The existing strict age, trust, lifecycle, compiler and lint policies remain enforced. No local-registry dependency, package patch, ignored lifecycle or hook bypass is retained.

### Repairs and exact validation revisions

- `c1bbf7760357014ad533cad817d21fc301c7721c` updates the published framework cohort. All workspace unit scripts passed, reporting 10,258 unit tests, including 96 Promotion units. Promotion's 14 native PostgreSQL/Core/HTTP cases, Core's native fixture, 32 shared Party cases, two isolated CI Party-worker cases and 33 Catalog cases passed. Database checks, migrations, schema/grant verification, tooling, authorization inventory, backend federation, composition-build, canonical migrator and host-worker proofs passed in their recorded scopes. Logs and exact commands are under `.codex/plan-graphs/c18-promotion-1160/promotion-portability-runs/published19-final-20261109T152308Z-4607/`. These outcomes retain c1 source attribution; later commits do not change their business/schema/tooling inputs.
- `ec9d6e1074288918b8ddebddab4a40abd60708ac` adds the mandated `/.well-known` locale-redirect exclusions in Assortment, Inventory, Privacy and Projects, and restores Party browser-test ESM output using the existing Shell test-plugin pattern. Actual Party component tests passed: two files, three tests. Full GNU build passed with supported serial workspace concurrency in 593.091 seconds; full `pnpm check --concurrency 2` passed in 438.468 seconds. Fresh Alpine build and all nineteen materializations passed; eighteen isolated runtime proofs passed. Projects alone still lacked its real DOM UI identity. Evidence is under `promotion-portability-runs/published19-serial-20261109T171820Z-385289/`.
- `728c51829104ccfeba9e62db2ab00af1746a3e54` binds the existing Projects layout to its generated `ultramodernUiMarker.build`; it changes no form or business behavior. Projects units passed. Full serial GNU build passed in 583.757 seconds; full `pnpm check --concurrency 2` passed in 428.391 seconds. The normal pinned-musl Projects build, materializer, public SDK envelope verification and unchanged source-hidden runtime proof passed in 345.089 seconds. Public contract, actual DOM UI marker, server rendering without fallback, emitted assets and executed Module Federation exports all passed. The wrapper finished `command_exit=0` and `source_exit=0`, with all 14,581 source paths equal before/after. Evidence is under `promotion-portability-runs/published19-projects-ui-20261109T183511Z-658479/`.

Project commands ran through Locki, mise and pinned pnpm. The successful full GNU build profile sets `PNPM_CONFIG_WORKSPACE_CONCURRENCY=1`, `NODE_OPTIONS=--max-old-space-size=4096` and the actual frozen Git SHA as `ULTRAMODERN_SOURCE_REVISION`. Both framework/OntOS API checks, typecheck, lint, quality gate, contracts, module entrypoints, database boundaries, formatting, i18n boundaries and lint-rule tests passed inside the recorded full gates. Tooling and business/native tests remain separate evidence; they are not inferred from `pnpm check`.

### Qualified per-unit artifact result

All nineteen selected units have actual passing immutable-artifact proofs on the same locked published `.19` cohort. The candidate combines eighteen unchanged artifacts at `ec9d6e1074288918b8ddebddab4a40abd60708ac` with the repaired Projects artifact at `728c51829104ccfeba9e62db2ab00af1746a3e54`. The exact subsequent source diff is only `verticals/projects/src/routes/layout.tsx`. Each artifact retains its own source, digest, SDK seals, inventory and proof hashes. This is explicitly a **qualified per-unit candidate**, with `uniformSourceMatrix=false`, not a successful uniform-SHA matrix or a new identity assigned to old bytes.

The reconciliation command was `pnpm exec node .codex/plan-graphs/c18-promotion-1160/published19-update/qualified19.mjs <closed-728c-run> <its-node-artifact-matrix> <new-output-directory>`. It exited zero and produced `published19-update/qualified-final-728c51829/qualified19.json` and `.md`. It checked both source closures, the exact reviewed layout diff, unchanged strict proof/classifier bytes, exact cohort/lock, all nineteen actual gate results and digests, public contracts, MF evidence and SDK envelope bindings. The compact map below records the selected bytes.

| Unit                      | Actual source | Artifact SHA256                                                    |
| ------------------------- | ------------- | ------------------------------------------------------------------ |
| party-registry            | `ec9d6e107`   | `54d8a45c0382c985a4ce9ef18df4a6ad157b27854d56877ce0f7b9271f6237c3` |
| commerce-customer-context | `ec9d6e107`   | `d682f1c9544f8c7cf03bca9dc89e0a8c31812c539b0b386d12aa0272185eab68` |
| payment-term-catalog      | `ec9d6e107`   | `1f5824ced3fe5cf4c51cc3844e1b1c1c52586c5ebf697aec94895c22108e7c66` |
| commerce-market-catalog   | `ec9d6e107`   | `c2fbde12e9c8c0b1955b1f9d6cbc9f7acdf9eebe2e2339e7d4e554832c21df49` |
| catalog                   | `ec9d6e107`   | `a81f8b529eb3d7a075ae7df48de2eaf1c03b0135e80d2cf44e9843214de9bef7` |
| pricing                   | `ec9d6e107`   | `21ff4f552ca7e7d9c0484a2498561e18dc0125bc4bf62c17ae1d55637b26c6e6` |
| storefront-registry       | `ec9d6e107`   | `0b130ceae26c73ecd9596706f3a8d007a9e9fc095f0d602c404c97a411969462` |
| price-group-catalog       | `ec9d6e107`   | `db48b67ffa60f37e987b2dc3cc89fb455406cf6311b6735df549c427f12e0f34` |
| inventory                 | `ec9d6e107`   | `096711779670b3cae551ff11b28d482bc512582e1f0f1545989c63af89cfb469` |
| assortment                | `ec9d6e107`   | `59bb9705eddfcfb5c59620e06c3a10eb6116005a3130702b46bb4c4f2b1e15bb` |
| availability              | `ec9d6e107`   | `8059253cc53e9da4689f6cbd42b8b7937d5d925b0a8e2c6324be85303c6bb1a2` |
| privacy                   | `ec9d6e107`   | `83fbcd6c288de403d7e0f40ebeba43e7508f205829855a1181e5b9436d18491f` |
| tax                       | `ec9d6e107`   | `e06f731fe4e807323db8c43ed1510d80d5f91ee40dcb854b9cb60f9a75323a31` |
| projects                  | `728c51829`   | `8a13db5e076f42e9776ae8c860cae5adca3b904b7c2445a8c9ba53a93b91c50f` |
| commerce-cart             | `ec9d6e107`   | `40757e1375e5cc40cfdae3b59860c70feef0ab37520277c0b984bb1d235f440e` |
| commerce-order            | `ec9d6e107`   | `7b7da163c40bfc9e998a52c700b96ca79d4b218cb37d9c0bcf5930688c2d4ab6` |
| promotion                 | `ec9d6e107`   | `d59cc470b09925f19906bd995f4e9e213630586194d9eadce922fd66493020d4` |
| shell-super-app           | `ec9d6e107`   | `adc30553a60851f1d4b013d5b85fe2c3457aae0dc858eee9da73e907022d1c98` |
| outbox-worker-host        | `ec9d6e107`   | `a944e023f30d54c50dd205ee6350b55b0c09cdb4556d0de72ec56e71af26afa1` |

Five unselected dedicated workers are not credited as passed. Migrator infrastructure has its own c1 proof. Separate per-unit probes do not assert cross-unit remote page rendering, production composition promotion or deployment. The old ec9 Projects failure and aggregate `command_exit=139/source_exit=0` remain failures; no receipt was rewritten. Earlier c1 routing failures and the interrupted parallel GNU build also remain recorded. The parallel build ended with `SIGKILL`, with no compiler diagnostic and no confirmed kernel/cgroup OOM cause; the supported serial build then passed.

### Per-issue review and downstream handoff

| Issues                            | Completed review scope                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| #1164, #1165, #1166; parent #1161 | Five families, immutable lifecycle/successor, all layer combinations and explicit ranking.                                   |
| #1167, #1168, #1169; parent #1162 | Permanent normalized Voucher identity/binding, repeatability, authoritative basis and exact scale-18 allocation/publication. |
| #1170, #1171                      | Integrated fact loading/evaluation, staged monetary/shipping proof, source binding, Current versus authentic history.        |
| #1172, #1173                      | Generated management Actions/Reads/HTTP, trusted scope and Current permissions, canonical source and no legacy import.       |
| #1174, parent #1163, root #1160   | Native integrated acceptance, all sixteen root invariants and BDD, required gates and qualified immutable-artifact evidence. |

Final review records are `.codex/plan-graphs/c18-promotion-1160/published19-update/final-parent-conditional-review.md` and `.codex/reports/c18-final-published19-artifact-review-728c51829.md`. They retain the crossed component reviews in `c18-1160-coordinator-review.md`, `c18-1160-independent-review.md` and `c18-1160-acceptance-review.md`; an author's own test execution is not presented as independent code approval. Review of the routing fix, Projects identity binding, focused producer and reconciliation was crossed between the coordinator and other agents.

Promotion remains inactive and excluded from the reviewed release intent. No Pricing adoption, authoritative GROSS producer, Storefront/Cart/Checkout/Order/Delivery orchestration, legacy migration or production activation was added. Pricing's existing installed-Promotion fence remains intact. Owner-issued monetary evidence and conditional shipping evidence are ready for the separately gated downstream handoff; missing required GROSS/Delivery facts remain typed non-success.

The checkpoints below are historical and superseded where they describe pending acceptance or an unresolved publication prerequisite.

## Historical framework repair checkpoint, 2026-11-08

OntOS commit `1fced8d73` aligns the exact declared Rsbuild 2.2.13 / Rspack 2.2.9 cohort; the aligned original SSR probe still failed. Framework branch `codex/ontos-native-i18n-ssr`, commit `0889ac34174f996973405d64c662b5559dbbc1f0`, fixes the native factory's eager backend dependency with one direct instance-module import. Its compiler regression failed before the repair and passes afterwards; all 67 native i18n tests, all 51 framework build tasks, canonical fork-boundary checks and normal commit hooks passed.

The normal release preparer produced all 49 local `.19` cohort packages. An isolated Alpine OntOS copy installed them normally, rebuilt Privacy and Party, and passed the original SSR request without fallback. The unchanged materializer then passed through the framework's official exact-artifact local registry and source-qualification policy. The complete focused Party artifact proof passed with source trees hidden, network disabled, public SDK envelopes verified, genuine SSR, emitted assets and executed MF exports. The first runtime attempt exposed a harness mistake: the published Node ABI selects the manifest-declared named container. Correcting that consumer and awaiting exposed factories passed 29 controls and the runtime proof against identical artifact bytes.

This is focused local-candidate evidence, not the full nineteen-unit matrix or a final published-dependency gate. The application baseline remains `1fced8d73`; only the isolated copy's dependency declarations and pnpm-generated lockfile differ. All 11,387 checked non-runtime source files otherwise match. The framework candidate source is recorded separately as 0889; no artifact identity was relabelled.

The next external prerequisite is submission and publication of the reviewed framework repair through its trusted workflow. After an approved full-cohort release, update OntOS normally and run the unchanged complete artifact and repository gates on the final dependency state. No remote publication, push, issue mutation or downstream adoption occurred. Status remains `in_progress`, with the same 58 completed and six pending graph todos. Details and failed attempts: `.codex/reports/c18-upstream-native-i18n-fix-0889.md`.

## Historical continuation checkpoint, 2026-11-07

This checkpoint supersedes the earlier Cart/Order-anchor and completion assessments. The retained implementation checkpoint `bb85c1d73` has the same Git tree as `1f6fdd6c0`: it includes the reviewed public-SDK final Node normalization/resealing repair, with 48 focused controls and complete tooling passing at 1f6. Earlier f05 standard build/full check, 96 Promotion units, 14 native owner cases and corrected environment-specific native proofs remain attributed to their actual revisions.

Final acceptance is blocked by actual Party SSR in the pinned native i18n/compiler/Module Federation cohort. Two real Alpine build pairs passed; their direct SSR probes still returned client fallback with `TypeError: n is not a function`. The second output retained all six requested eager flags, but the generated integration still synchronously consumes an async provider. Full unchanged-source closure passed. Unsuccessful application-sharing experiments were reverted; no dependency patch, SSR/sharing bypass or acceptance exception is retained.

The required complete artifact matrix is not established. The 1f6 aggregate check also remains explicitly failed because it ran against stale compiled contracts before a new build; all its other steps passed. No historical result is relabelled as a current full-gate success. The next prerequisite is a tested compatible framework/cohort correction, followed by the unchanged final build/runtime/repository checks.

All fifteen live issue bodies still match the reviewed criteria and retain exactly `status:now`. Status remains `in_progress`, with 58 of 64 todos complete and the same six pending acceptance/rollup tasks. Scope and downstream exclusions are unchanged. Exact results, revisions, failed attempts, reviewer provenance and the remaining boundary are in `.codex/reports/c18-bounded-ssr-verdict.md` and `.codex/reports/c18-party-ssr-runtime-probe-review.md`.

## Earlier source review and validation, 2026-11-07

This checkpoint supersedes the earlier completion assessment below. Source repairs are implemented and independently reviewed: configured zero-benefit cart candidates no longer displace applicable offers; Shipping definitions reject unsupported Catalog Selection targeting; native HTTP tests compile the actual public pinned release identity; and the API-only tooling fixture inherits its normal Git-bridge environment through the existing Effect subprocess API. The supported generated default Node module profile is used without changing public contracts or federation ABI.

The OntOS runtime gateway now stages the actual normal built Node output, validates source identity and path/regular-file/symlink boundaries, preserves runtime metadata, supplies only the published default serve command when absent, and delegates dependency normalization/installation to the existing public finalizer. Successful finalization is followed by ordinary `npm rebuild` to repair executable links copied from the installer's deleted temporary directory. Both subprocess failures remain blocking and normal lifecycle policy remains enabled. Eighteen focused gateway tests and typed lint passed. The legacy Outbox fixture now models actual HTTP output and verifies both HTTP and worker finalizer/rebuild sequencing. The source collector excludes only canonical workspace-root `.zerops/runtime` generated output, with authored declaration, nested-path, testing-import and private-database invalid controls preserved.

Promotion's materialized runtime passed both glibc Linux and Alpine/musl portability profiles at implementation revision `e5cc327ad`. These are owner-local artifact results, with actual normal dependency installation/finalization and isolated runtime probes; they do not prove the complete required all-Node artifact matrix. The broader matrix remains unproven: Cart/Order executed build-host anchors are a baseline artifact obstacle, not repaired by this C18 scope. No requirement, gate or downstream exclusion is waived or changed.

Final frozen validation of clean implementation revision `1b6ee79c18ba8da49588ca09d3598fd087b24857` passed all 24 recorded commands, including 96 owner unit tests, 14 native PostgreSQL/Core/HTTP cases, complete tooling, authorization, database/trust checks, `pnpm check --concurrency 2` and the standard complete `pnpm build`. The final materialized Promotion runtime passed isolated Linux readiness and public-contract probes with that exact revision. All 14,578 source entries match before/after; command and source checks both exited zero. Alpine/musl proof remains explicitly attributed to e5cc; authored owner/runtime/materializer/dependency sources are unchanged between those revisions; each artifact retains its actual release identity. Exact commands, identities, digests and evidence are in `.codex/reports/c18-fresh-implementation-review.md`. Later edits only correct review/status documentation. Earlier results remain revision-specific historical evidence. Source review execution and local Promotion proof are distinct from final #1174/#1163/#1160 acceptance.

The specification remains `in_progress`. All six remaining acceptance/rollup todos remain pending, so the graph currently records 58 completed of 64. No downstream Pricing adoption, GROSS producer, Cart/Checkout/Order/Delivery orchestration, production rollout or activation is implemented or authorized. See `.codex/reports/c18-fresh-implementation-review.md`, `.codex/reports/c18-final-materializer-source-review.md` and `.codex/reports/c18-final-scope-consistency-review.md` for review provenance and limits.

## Earlier implementation evidence, superseded where noted

### Summary

The generated API-only `commerce.promotion` owner now implements five closed Launch families, immutable publication and lifecycle, permanent normalized Voucher identities, exact monetary selection/allocation, staged owner-issued proofs and protected backend management. The owner remains inactive and absent from the reviewed application release intent. Pricing implementation and its module-not-installed fence are unchanged.

### Changed Files

The active Locki branch contains the Promotion owner, generated typed transports, owner schema/migrations/verifier and tests, scoped grants, topology/workspace metadata, and narrow Core test-fixture repairs needed to exercise the existing Current authorization fences. The primary checkout's unrelated changes remain preserved. The final scope is recorded in `.codex/reports/c18-final-validation-review.md`; no unrelated source was added.

### Tests Written or Updated

- Owner unit suites cover definitions, lifecycle, administration, Voucher identity/reuse, all fixed/percentage pairs, scale-18 allocation, selection, Current/history proof binding, temporal basis boundaries and safe read/source authority contracts.
- Native PostgreSQL suites cover owner RLS/grants/uniqueness, actual Core management Actions, exact request evidence, rollback/current permission/module-state gates, staged issuance, all five families and persisted Voucher reuse across distinct purchases.
- Native HTTP acceptance covers real Ed25519 verification, production single-use redemption, generated typed clients, tenant isolation and typed authentication/permission/source outages.
- Core-owned fixture regressions exercise the real Ready/Changing execution fence; the fixture's read-only module-state control uses the existing test gateway.

### Validation

- Exact plan-graph strict validation passed for thirteen plans and fifteen dependency edges.
- Frozen sandbox setup, local services and baseline migrations/verifiers passed.
- Promotion DB check/migrate/verify passed for eleven typed tables, forced Tenant RLS, immutable runtime grants and its separate journal.
- Latest completed owner run passed all 94 unit tests and 14 actual PostgreSQL/Core/HTTP integration tests, including retirement followed by unchanged Historical proof replay. Logs: `canonical-owner-identity-final.log` and `canonical-owner-identity-lint.log`.
- Pricing regressions passed 1,018 owner tests and 388 contract tests. Pricing source is unchanged.
- Final public Core fixture unit regression passed 42 tests; the existing native Ready/Changing fence regression also passed. Generic state typing retains the narrow Market fixture return type.
- Aggregate database check, application schema/journal verification and database trust audit passed. Promotion verifies eleven typed tables with forced Tenant RLS and scoped immutable grants.
- Final `pnpm check --concurrency 2` passed in full, including workspace typecheck, 7,735-file lint with zero warnings/errors, both framework and OntOS API checks, module-entrypoint/contract/database boundaries, formatting, quality gate and 4,871 lint-rule tests. The canonical unaliased identity repair passes both full API validators and its actual-contract regression with invalid controls. No rule severity or diagnostic was bypassed.
- Available-unit inventory repairs passed Cloudflare35, immutable-release91, worker-mode16 and provider-generator14 cases; canonical provider drift check passed. Release intent remains unchanged.
- Generated proposal-export model regression passed17 cases with actual pinned Knip and nearby invalid controls. The model adds proven generated consumers, not an ignore or gate exception. An extra direct lint invocation on the policy-excluded existing model file still reports pre-existing diagnostics outside the changed code; configured root lint and its severity remain unchanged.
- Earlier generation/tooling subprocess timeouts were traced to 9p dependency resolution, plus missing hermetic `/usr/bin/jq` and Python prerequisites. Normal frozen installation now uses pnpm's supported native virtual store with unchanged lockfile and enabled lifecycle scripts. Project commands remain in the same Locki worktree. No timeout was increased.
- Final complete tooling passed: 1,597 scripts tests across 97 files, 125 deployment-impact tests and all 190 generation tests. This supersedes the earlier interrupted/failed checkpoints. Full quality audit and its blocking gate passed with zero Knip findings.
- All thirteen commands in `continued-validation/results.json` passed, including separate authorization inventory, fresh owner 94-unit/14-native runs, Core fixture 42-unit/one-native runs, Pricing 1,018-unit/388-contract runs, aggregate DB check/verify/trust audit and Promotion compile-only build. The standard parallel full application build subsequently passed on clean implementation commit `f679e3789d735844baca6a246591294de4b36eb6`.
- Native filesystem validation retained the exact required Locki app path. Five manifests agree on all 14,576 source paths before copying, after copying and after validation; command and source checks both exited zero. No source/build artifact was synchronized back. Only evidence/status documentation changed afterwards and received targeted formatting validation.
- Historical interruptions are retained as historical evidence only. The last overnight interruption was an orderly host shutdown on 2026-11-06; an earlier 60 GiB VM had exhausted host memory. The supported VM limit is now 32 GiB. The current completed run exited zero.

### Review

Independent component and integrated issue reviews are recorded in `.codex/reports/c18-1160-independent-review.md`, `.codex/reports/c18-1160-acceptance-review.md` and `.codex/reports/c18-1160-coordinator-review.md`. Findings already repaired include unsafe generated deploy wiring, stale client paths, omitted test typechecking, partial Data Access targets, policy omission, stale temporal basis evidence and missing explicit zero-capacity explanations. Actual management/draft-preview receiving tests and the retirement-history native scenario passed. Canonical owner-ID regression tests additionally reject uppercase/mixed-case Promotion/Voucher UUIDs before case-sensitive joins. A consistency review on 2026-11-07 reconciles all fifteen issues and distinguishes component readiness from uncompleted final gates; see `.codex/reports/c18-consistency-plan-evidence.md` and `.codex/reports/c18-consistency-infrastructure.md`. Final per-criterion source assessments are in `.codex/reports/c18-final-parent-review.md` and `.codex/reports/c18-final-foundation-acceptance-review.md`. They found no additional source defect and retain the required full-build condition. The earlier f679 completion assessment recorded accepted owner-scope outcomes for all fifteen issues and all 64 graph tasks complete. That assessment is historical and superseded by the current review above; current acceptance and rollup statuses remain authoritative. Downstream adoption and production rollout remain excluded.

### Deviations and Follow-ups

The authorized normal-hook implementation commit is `f679e3789d735844baca6a246591294de4b36eb6`. Its mandatory formatter and Effect/TSGo/Oxlint jobs ran inside the sandbox and passed. The full standard parallel `pnpm build` passed on that clean revision, including every workspace MicroVertical, Shell, MF types and performance readiness. All 14,576 source paths match across build manifests before/after build and after runtime smoke. Actual compiled Promotion readiness returned HTTP 200, source revision `f679e3789d735844baca6a246591294de4b36eb6`, matching markers and no version skew in the canonical validated build namespace. Only completion/evidence metadata changed afterwards; no executable source changed.

The user-authorized local Locki/Lefthook repair preserves mandatory jobs and the original Git proxy restrictions. A trusted isolated-config manager coordinates private Git metadata on the host; all repository jobs execute inside the existing sandbox. Eighteen controller regressions, seven real SSH relay regressions, typecheck/lint and independent security reviews passed. A real 600-query Git stress test reproduced lost successful responses before the relay repair and passed all 600 after it. No source revision was forced and no release-identity fence was weakened. Tool repair sources and patches live outside the OntOS diff; see `.codex/reports/locki-lefthook-repair.md`.

Earlier dirty-revision, hook initialization and output-loss failures remain historical evidence and are superseded by the successful clean build. The compiled readiness probe is an owner-local build/runtime proof, not a relocated artifact or production cutover proof; production adoption remains outside C18. That earlier completion assessment is superseded; the current open acceptance gate is recorded above.

No product-scope expansion. External Pricing/TAX/Delivery producers remain conditional owner ports; unavailable authority returns typed non-success. The tests label those producers as owner acceptance doubles and do not claim downstream integration.

Global ranking/basis management requires a Tenant-scoped assertion without a selected Legal Entity. The existing public API-key gateway issuer and generated `WithAuthorization`/gateway override clients support that backend path. A normal selected-Legal-Entity session assertion is correctly refused; no Shell context-projection or UI adoption is implemented here.

The umbrella specification records lifecycle status separately because plan-graph forbids top-level status and tracks individual todo status instead. No GitHub issue, label, comment or roadmap mutation has been performed. The authorized local implementation commit and normal hooks completed successfully; completion documentation records the final accepted scope. No push, deployment or production activation is authorized or performed.
