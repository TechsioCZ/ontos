---
type: feature
status: in_progress
created: 2026-10-20
---

# Feature: Privacy-owned authenticated Notice acknowledgement

## Feature Description

Add a narrowly supported Privacy API channel that serves the exact immutable Notice Version to an actually authorized signed-in Retail Data Subject, records that person's explicit acknowledgement, and resolves the resulting durable information-step evidence for the existing public Notice Provision Action. This supplies the missing real channel prerequisite for #1261 in Watch Stabilization Pack #1215. It does not create Consent, prove reading/comprehension, change Purpose lifecycles, or require an account for other withdrawal channels.

Privacy owns this API channel and its acknowledgement facts. Notice authoring/publication and other channels remain separate capabilities. The user explicitly approved this prerequisite and Privacy ownership; no frontend, portal redesign, Order capability, external mail delivery or new legal policy belongs to this change.

## User Story

As a signed-in Retail Data Subject with Current authority for my exact Privacy Subject,
I want to receive a particular Notice's actual wording and acknowledge that information step,
So that Privacy can retain truthful scoped provision evidence independently from any later Consent choice.

## Problem Statement

`NoticeChannelDeliveryAuthority.resolve` is currently bound only to `NoticeChannelDeliveryAuthorityUnavailableLive`. The existing public `record-notice-provision` payload deliberately rejects caller-supplied proof, evidence, outcome and timestamps. Therefore a public original V1 grant cannot obtain real Notice evidence through the currently configured channel. Existing owner-local tests explicitly insert a fixture channel fact; Commerce authentication verification mail is unrelated to processing Notice provision. Neither is acceptance for the new public flow.

The existing configured CCC Consent adapter is also deliberately withdrawal-only: it requires `CONSENT_WITHDRAW`, `WITHDRAWN` and a retained decision. It must not be relabelled to authorize a pre-grant information step.

## Solution Statement

Expose one generated, Core-governed GET presentation read and one generated, explicit-executor POST acknowledgement Action. GET verifies Current Retail Subject authority, loads the exact immutable inline Notice and its supported concrete applicability, and returns the real wording/language/content identity plus a server-authenticated presentation receipt. Only a subsequent explicit acknowledgement by that same actual signed-in authority may create an immutable acknowledgement record. The existing public Notice Provision Action resolves that record through an owner-local, transaction-bound channel authority. Consent continues to consume the resulting ordinary Notice Provision evidence through its existing contracts.

The receipt binds the actual server-served version/content digest and exact scope to the real actor, binding and session; it is correlation/integrity material, not an authentication credential, Permission, provision fact or Consent. A GET, receipt issuance, HTTP 200, publication or render/send attempt alone creates no proven provision. The POST establishes only the supported channel's explicit acknowledgement; no claim that the person read or understood the wording is made.

## Relevant Files

- `../docs/contexts/privacy/CONTEXT.md` — Current, historical truth, Subject identity, Notice/Provision versus Consent, and existing Retail `retail.consent.manage` semantics.
- `docs/architecture/MICROVERTICALS.md`, `ACTIONS.md`, `DATA_ACCESS.md`, `DATABASE.md`, `ERRORS.md` — strict ownership, real Core lifecycle, scoped repositories/RLS, and typed failures.
- `verticals/privacy/src/actions/record-notice-provision.action.ts` — current unavailable channel port and exact fact/request comparison.
- `verticals/privacy/shared/actions/record-notice-provision.ts` — preserve forbidden caller proof/evidence/outcome/time fields.
- `verticals/privacy/shared/domain/privacy-notice-provision.ts` — existing `INTERACTIVE_ACKNOWLEDGEMENT` proof and provision materialization.
- `verticals/privacy/shared/domain/privacy-notice-version.ts` — immutable content/language identity and precision-preserving effective-period comparison.
- `verticals/privacy/shared/domain/privacy-applicability.ts` — exact declared processing/applicability facts.
- `verticals/privacy/src/persistence/privacy-operation-repository.ts`, `privacy-operation-postgres-repository.ts` — owner-local subject/Notice reads and new acknowledgement persistence methods.
- `verticals/privacy/src/database/schema.ts`, `scripts/verify-db-schema.mts`, `tests/unit/database-schema-contract.test.ts` — same-owner typed ledger, RLS, immutable trigger and verifier inventory.
- `verticals/privacy/src/integrations/commerce-customer-context/commerce-customer-context-consent-withdrawal.service.ts` — retain withdrawal-only behavior; reuse its published-client observation pattern, not a fake pre-existing grant.
- `verticals/privacy/api/index.ts`, `shared/api.ts`, `src/api/privacy-client.ts`, `vertical.manifest.ts`, `vertical.registration.ts`, `package.json` — generated contract, client, registration and explicit optional assembly.
- `verticals/privacy/tests/support/privacy-retained-purpose-self-service-http.ts` and `tests/integration/privacy-retained-purpose-self-service-http-postgres.test.ts` — later explicitly leased integration with the real account/receiving proof; existing candidate remains frozen until that lease.
- `packages/core-runtime/src/testing/live-operations.ts` — root-owned test provisioning boundary; no implicit new account Action/module grants.
- `scripts/scaffolding/cli.mts` and matching generator implementations — actual supported flags/output paths. Runtime help is pending resource allocation.

### New Files

All business artifacts below must start with the named Codesmith generator; adapt the generated contracts instead of hand-creating alternate endpoints.

- `verticals/privacy/shared/resources/privacy-notice-acknowledgement.ts` — generated ResourceRef plus exact immutable acknowledgement/receipt schemas; conservative resource capabilities.
- `verticals/privacy/shared/apis/notice-presentation.ts`, `src/api/notice-presentation.read.ts`, `src/api/notice-presentation-client.ts`, `api/notice-presentation-read-server.ts` — generated module API/read/client/server, adapted to the GET below.
- `verticals/privacy/src/actions/acknowledge-privacy-notice.action.ts`, `shared/actions/acknowledge-privacy-notice.ts`, `shared/apis/acknowledge-privacy-notice-action.ts`, `src/api/acknowledge-privacy-notice-action-client.ts`, `api/acknowledge-privacy-notice-action-server.ts`, `api/acknowledge-privacy-notice-action-problems.ts` — generated Action and HTTP transport; persist only the real acknowledgement.
- `verticals/privacy/src/services/privacy-notice-presentation.service.ts` — generated owner-local service for receipt integrity/configuration and canonical content projection.
- `verticals/privacy/src/services/privacy-notice-acknowledgement-authority.service.ts` — generated owner-local service resolving a durable acknowledgement into the existing channel authority fact.
- `verticals/privacy/src/integrations/commerce-customer-context/commerce-customer-context-notice-subject-authority.service.ts` — generated external HTTP adapter for Current Retail Subject authority before a grant exists.
- `verticals/privacy/tests/unit/privacy-notice-acknowledgement.test.ts`, `privacy-notice-presentation.test.ts`, `commerce-notice-subject-authority.test.ts` — meaningful domain/protocol/authority controls.
- `verticals/privacy/tests/integration/privacy-notice-acknowledgement-postgres.test.ts` — real public GET → POST acknowledgement → public Notice Provision → original Consent evidence, including restart/concurrency/rollback controls.
- `verticals/privacy/drizzle/*_privacy_notice_acknowledgements/migration.sql` and `snapshot.json` — actual generated typed-schema migration, with a separately approved forward trigger addition where Drizzle cannot express it. Never invent a folder timestamp or edit an existing journal entry.

## Implementation Plan

### Phase 1: Foundation

Freeze/review this contract, confirm runtime generator help when resources are allocated, and run Codesmith. Define the closed supported signed-in Retail channel. Add an immutable same-owner acknowledgement ledger and generated optional service boundaries. Preserve the accepted #1261 repair, append-only Purpose versions and the withdrawal-only adapter.

### Phase 2: Core Implementation

Implement actual Current Subject authority, exact Notice GET/receipt, explicit acknowledgement Action and durable record resolution. Tests accompany each boundary. Missing configuration, unsupported scope or indeterminate authority fail closed; no test authority or request-provided owner fact can activate the production path.

### Phase 3: Integration

Connect the real acknowledgement authority to `record-notice-provision` through its scoped factory, then use the existing Consent producers. Extend the real-account fixture only under fresh root leases for actual target-reference observation and exact executor/module access for the genuinely enrolled Principal. Finish the public retained V1 grant → append V2 → withdraw V1 proof only after its independent authority/permission prerequisites are also proven.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Confirm generators and generate the supported artifacts

- [ ] Independently review this design against the actual complete #1261 scope and current guidance before application code changes.
- [ ] From the allocated GI4 `app/`, run `mise exec -- pnpm scaffold:resource -- --help`, `scaffold:module-api -- --help`, `scaffold:action -- --help`, `scaffold:action-http -- --help`, `scaffold:action-service -- --help` and `scaffold:external-http-adapter -- --help` through the same `mise exec -- pnpm` prefix. Source help/flags were read; these actual help commands have not run.
- [ ] Generate resource `privacy-notice-acknowledgement`; module API `notice-presentation` with `--authorization authenticated_principal`; Action `acknowledge-privacy-notice` with `--legal-entity-scope required --authorization action_execution --provisioning explicit`; its `action-http`; services `privacy-notice-presentation` and `privacy-notice-acknowledgement-authority`; external adapter provider `commerce-customer-context`, operation `notice-subject-authority`. Every command uses `--vertical privacy` and the existing source-supported `--resource`, `--name`, `--action`, `--service` or `--operation` flag respectively.
- [ ] Retain untouched generator preimages/output inventory, then adapt only these generated artifacts/owner slots. No new business file category or shared contract package is needed. The current module API generator writes `api/notice-presentation-read-server.ts`; preserve that owned path.

### 2. Pin request, evidence and configuration contracts with negative tests

- [ ] GET `/privacy-api/notices/:noticeVersionId/presentation` accepts only typed target references: existing Privacy Subject ID, Retail profile ID and business interaction reference as query fields. Tenant/LE/actor/binding/session come exclusively from the actual Core scope. The exact processing scope, Controller, Purpose and Purpose Version are resolved from the selected immutable Notice's declared applicability; do not infer them from a customer account or arbitrary request metadata.
- [ ] Initially support inline wording and unambiguous concrete `CONSENT_DECISION` applicability containing exact Subject, Controller, Purpose and Purpose Version facts plus processing-scope reference. Reject missing/ambiguous/contradictory required facts or artifact-only content as unsupported, without inventing a generic applicability policy or dereferencing an arbitrary artifact URL. For the initial closed channel reject additional unsupported applicability dimensions; do not silently treat a declared jurisdiction/channel/recipient condition as verified. Preserve the exact supported scope in the receipt/equality check. No language fallback or Current-version substitution.
- [ ] Response contains exact Notice Version identity, contentIdentity, wording, actual language, exact applicable-scope projection and a Redacted presentation receipt. Set `Cache-Control: no-store`; do not log/store the raw receipt or gateway/session credential. No acknowledgement/provision record is created on GET.
- [ ] The owner service signs/authenticates a versioned canonical receipt containing random presentation ID, Tenant/LE, actual Principal/Auth Binding, digest of actual session-context reference, exact Subject/profile/interaction, Notice Version/content/language/wording digest/applicability projection and trusted servedAt. A purpose-specific configured key must be separate from Shell gateway keys. Use existing JOSE with HS256 and a separately configured 32-byte base64url key (`ONTOS_PRIVACY_NOTICE_PRESENTATION_KEY`) plus a non-secret key ID (`ONTOS_PRIVACY_NOTICE_PRESENTATION_KEY_ID`); no key fallback to Shell or deployment secrets. Pin protected type `ontos-privacy-notice-presentation+jwt`, issuer `privacy.core.notice-presentation`, audience `privacy.notice-presentation.v1`, receipt schema version 1 and canonical schema; reject other algorithms/keys/types, remote key headers, excess payload authority fields, alteration and receipt input longer than 32,768 characters. This is a purpose-specific integrity envelope, not an external authentication namespace or alternative credential issuer. Never trust payload identity without signature verification and owner reload.
- [ ] Receipt validation requires the same actually Current bound session and exact owner facts, `servedAt <= acknowledgedAt`, and actual Notice effectiveness at serve and new acknowledgement time. Do not invent a legal duration or TTL; ending the session/Notice or rotating the purpose-specific key makes a still-unconsumed receipt unusable. A later historical provision resolution uses original acknowledgedAt, not today's Notice validity, and cannot rewrite retained facts. Operational key rotation/availability is trusted configuration; missing/partial/unreadable configuration returns typed unavailable.
- [ ] POST acknowledgement payload contains only the server-issued receipt and explicit `acknowledged: true`. Caller `channelProof`, success/outcome, evidence IDs, trusted times, Subject identity, Permission, verified/current flags and arbitrary owner callbacks are forbidden. A receipt is not sufficient without fresh authenticated operation authority.
- [ ] Add unit controls for all substitutions and for GET alone/no acknowledgement yielding no provision fact. Clearly distinguish information acknowledgement from Consent/Terms/comprehension.

### 3. Implement actual Current Retail Subject authority

- [ ] The new adapter receives actual immutable `OperationalScope` and owner-scoped Subject lookup, resolves the real stored Data Subject and current canonical PERSON Party, then uses fresh audience-bound public CCC clients for exact Profile → Principal → binding → `retail.consent.manage` Access Decision observations. Re-observe material Profile/Party/binding sources and make a final Access Decision before returning authority; preserve two-pass/final-check behavior without claiming a distributed atomic snapshot or TTL guarantee.
- [ ] Require actual Commerce namespace, current non-impersonated session/Auth Binding, same Tenant/SLE, exact Profile ↔ Party ↔ Privacy Subject and actual Principal equality, ACTIVE binding/authorization mutation, FULL Current permissions and ALLOWED exact manage permission. An email/name/session alone is not Subject ownership. No original Consent Decision is required for this pre-grant information step.
- [ ] Keep anonymous, operation-scoped, support, foreign Profile/Subject, pending/stale/revoked/missing permission and indeterminate owners unavailable/denied. Do not route through or broaden the existing withdrawal-only service. Preserve its existing units and safe default.
- [ ] Tests use canonical published client transport seams for source controls and actual account/Core/CCC/Party receiving for native acceptance; static ALLOWED callbacks are not public evidence.

### 4. Add immutable acknowledgement storage and replay semantics

- [ ] Extend the existing owner repositories with create/read acknowledgement operations bound to the Core-owned transaction. New `privacy.notice_acknowledgements` rows contain own acknowledgement ID/presentation ID, Tenant/LE, actual invocation/actor/binding IDs, session-reference digest, exact Subject/profile/interaction, immutable Notice Version/content/language/applicability digest and trusted servedAt/acknowledgedAt/recordedAt, plus bounded actual authority evidence references. Store no raw receipt/session/token/password or alternate business truth.
- [ ] Declare typed uniqueness for Tenant/LE/presentation ID and actual invocation; same-owner composite Notice/Subject constraints where their existing keys permit it; forced Tenant+LE RLS. Do not import a foreign owner's private tables to add foreign business FKs. Add runtime exact comparisons for every retained binding field.
- [ ] Acknowledgement is personal information-step evidence, not an unlimited-retention exception. Reuse existing Privacy owner inventory/retention classification for this new fact; prescribe no new duration or legal ground. If the actual owner contract cannot classify the new ledger, raise the concrete gap before migration rather than inventing a cleanup/DSR policy.
- [ ] Generate the forward typed-schema migration under the root-owned exclusive migration lane. Attach a new acknowledgement-only immutable trigger using existing `privacy.reject_immutable_ledger_mutation`; no replacement of existing triggers/functions, no edits to committed migrations/snapshots. Obtain the explicit narrow SQL lease for the unexpressible trigger, retain generated snapshot unchanged, and update exact verifier/table/trigger inventories.
- [ ] Same Core idempotency key follows existing committed-invocation behavior without a new acknowledgement/time; changed payload conflicts. A new invocation using the exact same valid presentation may return the same retained fact after fresh authority/exact-row verification, never a new acknowledgedAt or second fact. Different material bindings conflict. Concurrent duplicates produce one immutable row. Test failed transaction/no acknowledgement, rollback, restart/readback and UPDATE/DELETE rejection against native PostgreSQL.

### 5. Implement GET and the real acknowledgement Action

- [ ] GET is a generated `ReadRuntime` operation with required LE, authenticated-principal classification and actual module gate; its owner service resolves Current Subject authority before releasing any protected Notice/receipt. It has no private business write. If a GET transport adaptation conflicts with a generator/API rule, stop for a generator/gateway repair; do not substitute manual request parsing or an ad hoc HTTP response.
- [ ] POST is the generated explicit Action: normal assertion validation/single-use redemption, module/LE gate, actual executor check and fresh Subject authority precede receipt/current Notice validation and owner persistence. The handler sees typed owner-local services only. Read the actual clock in the Action; no client backdate, mock Current or naked DB executor.
- [ ] Return the real immutable acknowledgement reference and truthful safe metadata. No `ConsentDecision` is created/changed, no Permission/account/Party is created, no mail is sent. Domain/audit evidence remains bounded and excludes Notice wording, receipt and authentication material.
- [ ] Add typed declared HTTP 400/401/403/404/409-or-422/503/500 families as appropriate: malformed target/receipt, unusable assertion, definite denied authority, inaccessible resource, substitution/ineffective Notice, unavailable configuration/owner and unexpected sanitized failure. Reject tampered assertions before invocation/owner resolution; same Bearer replay remains 401 through actual redemption.

### 6. Resolve durable acknowledgement through the existing Provision writer

- [ ] Add an optional owner-scoped authority factory to the existing `NoticeChannelDeliveryAuthority` service, preserving its current `resolve` and unavailable default for all existing consumers. The `record-notice-provision` service factory supplies actual `OperationalScope` and its owner transaction-bound acknowledgement reader. No global pool, extra runtime, foreign private access or payload-created scope.
- [ ] For this one configured interactive channel, `claimRef` names an actual retained acknowledgement. Resolve it in the same owner scope, revalidate actual caller/Subject authority, compare all existing request fields to its immutable target and derive `PrivacyNoticeAuthorityFact` only from that row. Map its actual acknowledgement to existing `INTERACTIVE_ACKNOWLEDGEMENT`, `PROVEN_PROVISION`, exact Notice/language/Subject/Controller/Purpose/processing scope/interaction, and original acknowledgedAt. The actual Provision Action supplies its own truthful recordedAt.
- [ ] Keep caller proof/evidence/outcome/time fields forbidden. Never mark GET-only, absent acknowledgement, failed Action, queue receipt or verification email as proven. Reuse existing Notice period precision and materialization guards; a retained acknowledgement/provision remains historical truth after Notice/Purpose end.
- [ ] Add tests for absent/foreign/tampered claim, mismatched scope/Notice/language/interaction, revoked authority and outage; verify all old unavailable/other-channel tests remain fail closed. Configure the real service only when its trusted infrastructure and real owner credential acquisition are present; optional production absence remains 503 rather than activating an allow provider.

### 7. Complete native receiving and the #1261 public continuation

- [ ] Root must lease/review exact real-account target-reference observation and exact Action/module provisioning for the genuinely enrolled Commerce Principal before native execution. The current parent proves account/Attempt/Core binding only; it exposes no public Profile/Party IDs and grants executors to its setup manager only. Do not guess IDs, read private foreign SQL, fabricate a trusted Principal or grant blanket membership. Reuse an existing lawful public observation/provisioning surface if one exists; otherwise submit the smallest root-owned TEST fixture/protocol extension with negative controls and exact cleanup before coding it.
- [ ] In a guarded owned DB with actual current migrations, use real public producers for Subject, immutable Notice and V1 Purpose. Assert no acknowledgement/provision exists after publication or GET alone. Consume the real GET body/receipt, explicitly POST acknowledgement as the actual account, restart/reload owned services, invoke public Record Notice Provision with that exact acknowledgement reference, then publicly record the lawful original grant. Retain exact content/scope and actual times.
- [ ] Publicly append V2 using the accepted append-only/derived-end contract, then withdraw the retained V1 scope through the real configured authority. Current/history must show the original grant plus truthful V1 withdrawal without version substitution, backdate or original-row mutation. New grant to ended Purpose V1 remains rejected. New GET/ack to ended/future Notice is rejected; already retained valid Notice/provision evidence remains addressable for withdrawal.
- [ ] Test same-key and altered replay, fresh-token retry, concurrent acknowledgement, rollback, tampering, cross-Tenant/SLE/Subject/profile/interaction/language/version, changed/revoked binding, missing manage permission, inactive module, missing real config and owner outage. Assert failures produce no false acknowledgement/provision/grant and credentials never enter logs/artifacts.
- [ ] Use a bounded 60s deadline for each full public retained-lifecycle case, finite readiness and owned cleanup. The complete real-owner lifecycle measured 32.0s/31.7s after the required GET transport was added; the earlier 30s deadline timed out after successful business assertions. Preserve 30s deadlines on the smaller shared compatibility cases. Allocate one native lane through root; capture full host logs/hash vectors and cleanup without credentials. A repeated failure gets a fresh diagnostic reviewer, not unchanged retries. No legal/compliance or deployed-history claim.

### 8. Run validation and independent implementation review

- [ ] Run every Validation Command using the allocated actual Locki app and retain source hashes/logs. Fix all blocking findings without analyzer severity changes, authentication/RLS bypass or fixture policy distortion.
- [ ] Independent reviewer traces actual GET receipt creation → real POST → immutable acknowledgement → scoped Provision authority → original Consent → retained V1 withdrawal, including unsafe nearby controls and production unavailable defaults. Review each affected #1261 acceptance obligation; do not count the issue fully accepted from source-only/unit/account-only proof.

## Testing Strategy

### Unit Tests

Receipt purpose/algorithm/key/schema/canonicalization integrity; exact content/scope/session binding; truthful clock/period boundaries including fractional timestamps; current Retail Subject authority without a retained grant; immutable fact mapping; no GET-only fact; changed-payload replay and unsafe caller-supplied proof controls. Preserve existing withdrawal-only adapter and unavailable authority tests.

### Integration Tests

Actual generated receiving handlers and clients, real Commerce account/verified session/Attempt/Core binding, fresh audience assertions and durable redemption, real CCC/Party Current authority, native RLS/immutable trigger/uniqueness/concurrency/restart/rollback, and real public #1261 lifecycle. Unit doubles isolate contracts only and cannot satisfy public acceptance.

### Edge Cases

- Missing/partial signing/owner configuration, old/unknown key, malformed receipt, future servedAt, different session or renewed binding.
- Inline wording absent; artifact-only Notice; language mismatch; ambiguous/missing supported applicability; future/ended Notice at either GET or new acknowledgement.
- Receipt without POST, POST without actual GET receipt, foreign/currently revoked authority, simultaneous duplicate POST, acknowledged row retained after key rotation or Notice end.
- Current authority unavailable between observations; no claim of distributed atomicity or fictional commit fence.
- Consent remains separate and existing ended-Purpose new-grant guard stays effective.

## Acceptance Criteria

- [ ] The exact authenticated Subject receives the real immutable Notice wording/language/content/scope via generated governed GET; publication/GET alone proves no provision.
- [ ] Only a real same-session explicit acknowledged POST with a valid server receipt and fresh Current authority creates one immutable durable fact with truthful actual time.
- [ ] The public Provision writer derives its proof from that retained owner fact, rejects request proof/other claims, and keeps unsupported/default paths unavailable.
- [ ] The real account and private-FD fixture carry no password/cookie/token/receipt into logs, SQL evidence or public authority metadata.
- [ ] Public original grant, append V2 and retained V1 withdrawal pass with real authority; original facts remain unchanged and unsafe grants/substitutions/replays remain blocked.
- [ ] Required native receiving, schema/RLS/immutability, targeted checks, full gate/build and independent review pass on the final exact candidate.

## Validation Commands

Execute every command from allocated actual Locki `app/`. Results and remaining gates are recorded in Implementation Evidence below.

- `mise exec -- pnpm --filter @app/privacy exec rstest --project unit tests/unit/privacy-notice-acknowledgement.test.ts tests/unit/privacy-notice-presentation.test.ts tests/unit/commerce-notice-subject-authority.test.ts` — new focused source controls.
- `mise exec -- pnpm --filter @app/privacy exec rstest --project unit` — owner regressions, including existing Consent/Notice and schema contracts.
- `mise exec -- pnpm --filter @app/privacy exec rstest --project integration tests/integration/privacy-notice-acknowledgement-postgres.test.ts tests/integration/privacy-retained-purpose-self-service-http-postgres.test.ts` — root-allocated real receiving/database/account proof with the approved environment loader and host capture.
- `mise exec -- pnpm --filter @app/privacy typecheck` — source-owned owner compiler; run CCC/Core compilers too if their leased fixture/interface files change.
- `mise exec -- pnpm --filter @app/privacy db:check` — generated migration chain.
- `mise exec -- pnpm --filter @app/privacy db:verify` — run only against the recorded guarded isolated target; never ambient/source DB.
- `mise exec -- pnpm api:check` and `mise exec -- pnpm contract:check` — generated public/owner contracts.
- `mise exec -- pnpm check` — final complete repository quality gate.
- `mise exec -- pnpm build` — changed public receiving/runtime bundling requires a build.

## Review Checklist

- [ ] Every acceptance criterion is satisfied with final exact source/runtime evidence.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md` and all relevant guidance.
- [ ] MicroVertical, generated client, Core scope/executor/read/redemption, owner transaction and typed Effect boundaries remain intact.
- [ ] The new current-subject adapter does not broaden the retained-withdrawal adapter or treat a logged-in account as identity authority by itself.
- [ ] Receipt/delivery/acknowledgement/Provision/Consent remain distinct; no legal duration, universal comprehension rule or invented Current proof exists.
- [ ] RLS, immutable acknowledgement/history, exact uniqueness and replay controls pass meaningful native tests.
- [ ] No unrelated frontend, portal, Order, other channel, policy, module or environment rollout change is present.

## Notes

This is a user-approved narrow prerequisite specification. Implementation is in progress; the original planning notes below describe the starting point. Current validation is recorded in Implementation Evidence. Actual current generated output is authoritative if it differs from this source-researched inventory; report an unsupported generator boundary rather than inventing a manual replacement.

The existing parent account candidate, two helpers and all production files are unchanged by planning. Root owns shared fixture/protocol extensions and must resolve the genuine target-reference/executor observation dependency in task 7 before public acceptance; this plan does not pretend it is already available. No production text, jurisdiction, legal duration, new consent dimension or customer policy is prescribed. Inline exact applicability is an explicit supported technical subset; unsupported channels/content remain unavailable. Business receipt expiry is tied to actual session/Notice validity and configuration integrity rather than a guessed TTL. Retained acknowledgement does not grant future authority or rewrite retained Consent.

## Implementation Evidence

### Summary

The real public account now receives the exact Notice through the governed GET endpoint, acknowledges it explicitly, reloads the Privacy handler/services, derives Provision from retained acknowledgement, grants V1, appends V2 and withdraws retained V1. Independent terminal controls prove fail-closed behavior after actual binding revocation and Commerce owner shutdown. The inherited Better Auth API-key verification quota is disabled as explicitly requested; invalid, disabled and expired keys remain rejected.

### Tests Written or Updated

- `tests/integration/privacy-retained-purpose-self-service-http-postgres.test.ts` — two actual-account public journeys, typed failure controls, same-key replay, payload conflict, durable service reload, exact retained evidence and unchanged historical facts.
- `tests/integration/privacy-notice-acknowledgement-postgres.test.ts` — actual owner schema verification, concurrency, rollback, uniqueness, immutable rows and forced RLS.
- `tests/unit/notice-presentation-read-error-contract.test.ts` — declared governed read errors and signed physical GET authentication/redemption/replay controls.
- Shared Shell/Party receiving fixtures and their existing Privacy/CCC/Shell consumers — genuine mounted receiving paths and current owner schema in guarded disposable clones.

### Validation

- Real public GET journeys — **2 passed**, 32.0s and 31.7s. Exact source/log hashes: `.codex/1261-final-get-integration-20261022/validation-receipt.json` at the worktree root.
- `mise exec -- pnpm --filter @app/privacy test:unit` — **52 files, 369 tests passed**.
- `mise exec -- pnpm --filter @app/privacy typecheck` — **passed** after dependency declarations were built; upstream suggestions/messages remain visible.
- Native immutable acknowledgement and actual `db:verify` against its owned disposable target — **1 passed**; see `.codex/1261-isolated-schema-verifier-20261022/manifest.json`.
- Shared compatibility — **7 CCC, 1 Shell and 7 Privacy native cases passed** with their original 30s deadlines.
- Normal scoped formatting and type-aware/type-check Oxlint — **22 TypeScript files passed**, including both final shared Core fixture repairs; their 30 focused unit tests also passed.
- Earlier `db:check` passed. Earlier full `pnpm check`, `api:check` and `contract:check` attempts failed in the older H sandbox; H is missing newer unrelated canonical source, so these failures do not establish canonical baseline failures. Final canonical-cohort gates and required build remain pending. Do not mark this specification done from scoped success.

### Review

Independent reviews cleared the public GET transport, exact parent adaptation, typed error declaration, authorization correction, isolated schema verifier, owner schema process and analyzer models. Applicable root/application instructions and focused architecture govern the implementation. Production unavailable defaults remain deliberately fail closed.

### Deviations and Follow-ups

The two full retained-lifecycle cases use a bounded 60s deadline based on measured real-owner execution; their acceptance assertions and finite cleanup remain intact. The smaller compatibility cases retain 30s. Handler/service reload is proved; no OS process restart claim is made. The reviewed application files are integrated into canonical C with exact pre/postimage guards. Whole-repository canonical-cohort gates and final release packaging remain pending. The Privacy build compiled browser/server sources and generated the module contract/public surface, then correctly rejected promotable packaging because the source is an uncommitted workspace; release packaging requires a clean committed exact revision, not an overridden revision value. Genuine enrollment Attempt reconciliation is separately tracked; successful public provisioning is not evidence that the earlier ambiguous Attempt completed.
