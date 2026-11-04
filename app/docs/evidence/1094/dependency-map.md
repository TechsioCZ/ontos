# #1283 MicroVertical dependency map

This is **pinned source evidence** for #1094/#1283 at `ed7ecb1fcf395ccfbffab7c2bff3edf0c0c15a2f`, collected on 29 October 2026. It is not a new registry, live environment inventory, product authority or production acceptance report. Current rules remain in the routed architecture/context documents; current scope remains in the owning issues.

The [machine-readable map](dependency-map.json) records every one of the 22 normalized cross-business static import directions (210 occurrences), all exact source path/line references and public specifiers, fourteen explicit package/module/deployment identities, thirteen reviewed release-intent members, and the source headers of all 34 workers. Build/import reachability is separate from synchronous public calls, Outbox subscriptions and Core infrastructure.

## Identity and state

Module identity is read from each package's `modernjs.ontosModule.moduleId`; deployment identity is read from `modernjs.appId`. Do not derive either from the package path. The current representation has one implicit standard implementation; this map does not add a serialized implementationId. A private build change does not create another owner, Resource identity or grant.

The pinned release intent excludes Availability. That is a reviewed publication input, **not observed active Composition membership**. Source existence, private registration/default assembly, deployed artifact, active Composition membership, Tenant Module State, operation availability and Current Permission remain separate columns. Unobserved live columns are NOT_VERIFIED in the JSON; no generic active state stands in for them.

Exact public export/schema source is recorded per edge. Existing v1 operation identifiers retain their meaning; deployment manifest schema-format equality alone does not prove semantic compatibility. #1287 must prove actual required/provided semantics without inventing a generic version platform.

Composition Revision identifies the immutable assembly. Its Observation Snapshot carries observedAt/validUntil. Neither is a business Effective Period or an Accepted Order Snapshot. Refreshing deployment observation does not revive an ended assignment or revoked Permission.

## Required-operation classification

The JSON's separate `synchronousOperations` inventory records **30 consumer-specific public operations** with exact public operation/client identities, branch and absence semantics, typed consumer failures, target/scope/provenance, actual adapter/factory/mount anchors and provider permission declarations where resolved. `synchronousOperationVariants` adds seven distinct evidence-replay/final-fence paths. These rows deliberately distinguish mounted browser defaults, configured API-key issuers, unavailable context/issuer defaults, source-only adapters and unmounted native Actions. Missing exact provider target details have an individually named source check; they are not treated as known permissions.

Important source limits: Pricing's separate same-Principal purchase-context issuer has an unavailable default; its CCC final-fence methods stop at an always-failing singleton verification gate before the inner group replay. Pricing's native read explicitly supplies only the CCC group credential layer, while its Action runtime supplies four owner credential layers. CCC Quantity has a mounted configuration layer but no production adapter caller and an unavailable authoritative Cart-context factory. These are actual source assembly distinctions, not generic provider outages or successful runtime integrations.

The JSON contains all source occurrences. This table gives the decision-relevant meaning of the synchronous owner boundaries and schema-only relationships; each actual branch retains its owning contract and declared error.

| Consumer → provider                  | Required evidence / legitimate independence                                                                                                                     | Implementation owner                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Catalog → Party                      | PARTY Manufacturer requires exact authoritative Party detail; LEGAL_ENTITY instead uses the governed Core Legal Entity read                                     | #1284/#1287                            |
| CCC → Party                          | Guest/retail identity and PARTY_BACKED postal facts require Party; COMMERCE_ONLY address is independent                                                         | #1284/#1287                            |
| CCC → Market                         | Market Bootstrap needs eligible-tuple/Market resolution evidence; outage cannot pick an arbitrary Market                                                        | #1284/#1287                            |
| CCC → PriceGroup                     | Complete Current assignment set: zero may yield NONE; one requires Current catalog validation; multiple is inconsistent; outage/incomplete evidence is not NONE | #1287                                  |
| CCC → Pricing                        | Supported currency/decision facts retain owner currentness/completeness                                                                                         | #1287/#1288                            |
| CCC → PaymentTerm                    | Applicable entitlement/resolution branches retain Current catalog authority                                                                                     | #1287; retirement #1140/#1143 separate |
| CCC → Catalog                        | Public Quantity contract/adapter and Selection/revision schemas; dormant default wiring is a cleanup candidate, not permission to delete the contract           | #1288                                  |
| Market → Storefront                  | Association administration requires Current exact Storefront scope; unrelated Market Reads do not                                                               | #1285/#1287                            |
| Market → CCC                         | Retirement assessment/reserve requires complete Current installed-reference-owner evidence, including suspended or unavailable installed owners                 | #1285/#1287                            |
| PaymentTerm → CCC                    | Existing affected-use/reserve public contracts remain separately owned adoption                                                                                 | #1140/#1143; mapping #1287             |
| Assortment → CCC                     | Public complete Current membership/verification contract; adoption remains #692                                                                                 | #1287; #692 separate                   |
| Inventory → Catalog                  | Public Selection/Product Unit stock-demand/binding vocabulary; an import alone is not a new runtime call                                                        | #1287                                  |
| Inventory → CCC                      | Exact relevant Position-set purchase-context types/verification; distinct from the Reservation context producer and #1286 port                                  | #1038/PR #1144; #1286/#1287 mapping    |
| Pricing → Catalog                    | Applicable Selection/quantity-basis/purpose-equivalence/fee-target branches require exact owner evidence                                                        | #1287                                  |
| Pricing → CCC/Market/PriceGroup      | Applicable subject/context, PriceGroup resolution, Current Market and compatibility/final-fence evidence                                                        | #1287                                  |
| Availability → Inventory/Catalog/CCC | Source public schemas/contracts exist; no production adoption or #874 activation follows                                                                        | #874 separate                          |
| Party/CCC → Privacy                  | Published handoff, dispatched schemas and public completion clients; execution stays recipient-local                                                            | #1258 baseline; #1287 metadata         |

Every receiving boundary retains independently checked trusted Principal/Tenant/SLE, exact target, normal Module State, permission, provenance and currentness/completeness. A transport credential or permission definition is not a grant. A provider-required fact cannot become complete empty data, NONE, business allow or a fallback seller on outage.

Reciprocal CCC↔Market and CCC↔Pricing edges describe distinct operations. They do not prove an intrinsic installation cycle. Intrinsic install/activation requirements must come from accepted declarations, not imports or HTTP direction.

The source-resolved Party and Market clients in the #1284 adapters still select browser credential acquisition. Current factories must be corrected through approved server issuance with the original acting Principal and admitted revision; a broader fixed service key is not an implicit substitute. Native Market API assembly at this baseline exposes reads/readiness; existence of Action helpers does not prove mounted administration Actions.

## Outbox graph and Core infrastructure

There are 34 registered workers across five owners: Party 16, CCC 9, PriceGroup 1, Inventory 6 and Privacy 2. Thirty-one subscriptions are owner-local. The three cross-owner subscriptions are:

| Producer / topic                                | Consumer / worker                                          | Source                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| privacy.core / privacy.measure.dispatched       | party.registry / execute-privacy-measure-worker            | Party src/workers/execute-privacy-measure.worker.ts; published Privacy schema |
| privacy.core / privacy.measure.dispatched       | commerce.customer-context / execute-privacy-measure-worker | CCC src/workers/execute-privacy-measure.worker.ts; published Privacy schema   |
| party.registry / party.registry.party-merged.v1 | commerce.customer-context / reconcile-party-merge          | CCC src/workers/reconcile-party-merge.worker.ts; published Party schema       |

The Party Merge subscription remains a retained/dormant contract: source registration and merge-readiness do not establish a completed production Merge Action. Neither producer absence in current source nor a stopped process proves zero historical messages or obligations. #186/#327 own activation.

Core owns exact producer/topic matching against the complete Composition subscription catalog, consumer-state-gated claim, leases, attempt clocks, retries, checkpoints and trusted worker context. Owner registrations and handlers remain private. The current runtime captures a clock per delivery (#1234 source evidence), resolves a private handler only after eligible claim, and retains the admitted revision. Source Action/completion identity must remain exact; #1258 actual drain/crash acceptance is not inferred from a helper or unmerged PR.

Source anchors: core-runtime/src/outbox/process.ts, repository.ts, runtime.ts and completion-publication.ts. The generated outbox-worker-host.generated.mts derives five owner entries. Host and dedicated modes both keep workers on Zerops; OUTBOX_WORKER_MODE is independent from DEPLOY_TARGET. The shared host has separate owner runtimes but one shared process/scope: a loop failure can stop its siblings. This residual failure domain is not dedicated production isolation or proof of separate DB roles.

## Metadata findings and cleanup candidates

- Party's twelve public Privacy imports are absent from its package dependency metadata, though its TS references include Privacy.
- CCC's thirteen public Privacy imports are absent from both package dependency and TS-reference metadata.
- These are source-proven build-map discrepancies, not demonstrated private-import breaches. Preserve them in #1287 impact/declaration work and assess the actual #1215/#1258 baseline before changing metadata.
- Six design-token TS references have no token import/CSS use in the source census: CCC, PaymentTerm, PriceGroup, Pricing, Storefront and Tax. They are #1288 candidates; actual affected typecheck/build is still NOT_VERIFIED. Preserve real browser token consumers.
- Six owner→extracted-contract directions are same-owner relationships, not cross-business dependencies: Pricing, PriceGroup, PaymentTerm and Storefront to their respective contract packages, and CCC to its two retirement contract packages.

## Absence, bounded Inventory and remaining gates

The CCC Composition absence helper uses historical UNIMPLEMENTED text in sourceId/digest while proving absence from the approved Composition. Preserve exact sourceId, generation, ownerRevision and digest. Present+suspended, present+unavailable, never-used absent owner and previously used owner with historical obligations are not interchangeable.

The existing InventoryReservationCommerceContextAuthorityPort defaults to typed unavailable before new Reservation/backend effects. #1286 is scoped to deliver its bounded Inventory-owned context validation/fail-closed/owner tests. Shape or CURRENT_OWNER_VERIFIED literal is not provenance, and equal stock-sharing scope does not grant two Principals equal permission.

The existing read-only roadmap handoff remains [#253, comment 5661414584, step 29](https://github.com/TechsioCZ/ontos/issues/253#issuecomment-5661414584): later Cart/Commerce work identifies the real producer; step 34/#877 proves public producer → Inventory Action → selected Reservation Authority. This map neither edits the roadmap nor activates that work. #174 DB pilot, #692, #1140/#1143, #186/#327, #874 and #892 remain separately scoped.

#1294 retains the accepted MIN active-refresh scope and truthfully reports shared observation/expiry effects. #174 alone does not block bounded #1094 acceptance, but implemented database safeguards remain mandatory and universal isolation/production security is not claimed.

## Evidence level, delta and verification handoff

- Baseline local and remote main: ed7ecb1fcf395ccfbffab7c2bff3edf0c0c15a2f; issue bodies/status gates were refetched and all fifteen children remained OPEN + specified + status:now.
- PR #1325 remains open/unmerged at bf90cdf5cab6e9bd824736d1d52f6b9b536fca5d. No claim from that PR is treated as delivered current behavior.
- Independent read-only build/import and Outbox scouts checked the same baseline, package exports and registrations. Source inventory is complete for the recorded static forms; dynamic import/SQL and live state remain explicitly unproven.
- Actual sandbox preparation, local owner migrations/bootstrap and exact DB schema verification completed after installing missing OpenSSL. This proves the local setup, not production behavior or any #1284–#1297 acceptance.
- No application behavior test has yet run for this map. Documentation/census integrity checks prove paths, counts, identities and coverage only.
- Every JSON edge carries a concrete runtime verification handoff. Owning issues must trace actual registration/default factory and run their required positive/negative/currentness/permission/fault/retry/native-provider evidence before runtime delivery is claimed.
- Relevant #1215 merge changes require a targeted affected-row delta and rebaseline. #1297 reconciles the final map against delivered declarations, actual membership/build counts and all six DM findings.

W00 BDD coverage: reciprocal-call classification, independent state columns, build versus business identity, bounded port/deferred producer distinction, required-fact failure truthfulness and current-main stabilization delta are explicit above and in the JSON. All runtime availability, live grant, staging and production dimensions remain NOT_VERIFIED until their owning checks execute.

## Post-baseline main delta — 29 October 2026

A final fetch observed main `e934cb32861877da450f0de2b14a0af84794daf9`, 18 commits/78 changed files after the source census. All fourteen package module/deployment identities were rechecked and agree. The source anchors/counts above deliberately retain their original census SHA.

The delta upgrades UltraModern/Effect/compiler and security dependencies, separates crypto-only owner imports from Node HTTP initialization, and repairs mapped SQL transaction recovery/tagged Outbox finalizer failures. Preserve those fixes during the next implementation rebaseline. The exact Shell issuer, source-proof provenance, gateway and affected Catalog/CCC adapter files are byte-unchanged, so the missing actor-preserving exchange prerequisite remains. No new deployed owner identity was introduced.

PR #1325 remains open/unmerged; its latest observed head is `4ae2c34f5a6aa91da28108c70b80d1a4144208e3`. Its claims remain unshipped evidence. Before business changes, synchronize branch/runtime to current main and rerun affected gates. Executed checks on this map branch cover the retained census baseline, not the newer dependency cohort.

## Implementation deltas — 31 October 2026

The original census above and its source counts remain pinned historical evidence. The JSON's
`implementationDeltas` records the following later delivered or in-progress slices without
relabeling the original anchors, observed membership, grants or availability as current facts.

- #1284 at `b6203518e`, draft [PR #1345](https://github.com/TechsioCZ/ontos/pull/1345): the approved Catalog/CCC server transports now preserve original P through the existing bounded issuer. Source workload authentication remains distinct from independent receiving permissions. The executed proof and remaining postal-Read qualifications are in [server-client-relay.md](server-client-relay.md).
- #1285 at `6b32c593f`, draft [PR #1348](https://github.com/TechsioCZ/ontos/pull/1348), with main integrated by normal merges from `72149af1c`: all eight native Market business Actions and default retirement assembly are implemented and independently reviewed. Actual public Storefront validation and CCC assessment/reserve/recovery preserve actor, revision, audit and original-effect identity. Installed CCC suspension blocks retirement; never-used absent future owners remain absent. Shell/Storefront/CCC are explicitly qualified native fixture deployments. Pricing is an actual downstream regression. Full local checks/build pass; no production activation or merged-PR claim is made.
- #1286: the registered Inventory consumer Action, existing qualified proof port, typed unavailable default and original-effect recovery have bounded executed owner-level acceptance. Neither a separately versioned port nor a production producer operation exists. See [inventory-context-port.md](inventory-context-port.md); the #253/29 → #877/34 handoff remains.
- #1287 at schema checkpoint `1955e25d1` is in progress. Exact Action/Read operation-version claims and owner-authored requirements now have validated declaration/projection support. Actual owner declarations and lifecycle/entrypoint enforcement are not yet accepted. A concrete CCC→PriceGroup configured-key Principal substitution and source/target LE-scope conflict has a separately reviewed proposal pending human approval; no new enrollment or projection is implemented.

The current main was refetched as `72149af1c` before #1287. These deltas do not recompute the old
22-direction/210-occurrence census, claim a current owner/member count, or turn fixture execution
into production availability. #1297 still reconciles the final actual map and measured composition.
