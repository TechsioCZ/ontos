# #1284 server client relay — implementation evidence

Retained Steps 3–12 exercise the eight adapter paths below against real packaged Node owners on the
UltraModern .16 cohort. Step 13 quality and security checks remain in progress; final independent
#1284 acceptance is pending. This document records bounded results, not issue completion.

## Authority and identity

The [Shell relay policy](../../../apps/shell-super-app/api/auth/gateway-relay-policy.ts) admits
Catalog → Party and Commerce Customer Context (CCC) → Party/Market exchanges. It binds the separately
enrolled source workload to its application/build and exact live composition revision `R`. The
original authenticated Principal `P`, authentication binding and authentication-context reference
remain the actor; source workload `S` never substitutes for `P` at the provider.

The [issuer](../../../apps/shell-super-app/api/auth/gateway-relay-issuer.ts) and
[authentication service](../../../apps/shell-super-app/api/auth/gateway-relay-authentication.service.ts)
use the existing verified Core carrier, current identity and public explicit-authorization clients.
The source allowlist governs exchange requests. A returned assertion authenticates its
audience/build/`R`; it does not cryptographically restrict the receiving request to one Read. A
compromised enrolled source could request another operation subject to original `P`'s Current
permissions and receiving single-use enforcement. The exchange ledger proves replay control, not
independent execution of the source operation. The issuer retains source-capped validity and carrier
provenance. Its [ledger](../../../apps/shell-super-app/api/auth/gateway-relay-exchanges.service.ts)
atomically refuses duplicate source-JTI/exchange-ID use, including changed fingerprints; actual HTTP
rejection coverage remains part of Step 13.

Canonical, executed, linked-access and receiving-owner evidence ties the exercised paths to original
`P`, its personal API-key binding/reference and the observed `R`. Legal Entity scope follows each
entrypoint: Catalog's canonical invocation remains Tenant-only, both Party scope modes are exercised,
and the CCC paths carry the actual Legal Entity. No raw proof, token or workload credential belongs
in this evidence.

## Retained package identities

These are the mixed packages actually exercised, rather than a claim that every owner was rebuilt
from the latest source. Source revisions below are abbreviated; build markers are complete. Runtime
contract/resolved API identities and packaged release envelopes were checked against the retained
records.

| Owner                         | Source revision | Actual build marker                                                |
| ----------------------------- | --------------- | ------------------------------------------------------------------ |
| Shell                         | `2471a44bc6ef`  | `c13ad4e1ab41c9e89db5d8d4275ccd994065da1c71ff67527601dd23c5651a16` |
| Party                         | `2471a44bc6ef`  | `fa2ac3c17d2e98266aee54e095d847685d808b0b0249dd79f023f0ffee27219a` |
| Catalog                       | `2471a44bc6ef`  | `82f75a07cbb518d7bea1a33818530f2d69915bf8e722fef2ac6e5cef5300913a` |
| CCC API and permission worker | `293fd21f2afd`  | `630671cc7a50d6c9613e91376d2607cd49162ee9b3ff37693e4a523c2c880b3c` |
| Market                        | `de6bc9eb5828`  | `a3d2fa1c6d57ecc571ddb4e69c0ba9a244262d3554359b2b55988676aacf2756` |

CCC is API-only: its actual resolved marker is authoritative; a shared-workspace metadata fallback
is not. Market's frontend and federation metadata were also observed. The completed CCC worker
artifact was exported byte-for-byte from an independent clean native materialization after a
filesystem-copy failure; no SDK guard was bypassed. Its entry and 23 literal imports resolve for
direct `node worker.mjs` startup. Four unused SDK-generated absolute CLI shortcuts remain dangling
(`dotenv`, `jiti`, `proto-loader-gen-types`, `rsbuild`). This establishes direct Node execution,
not deployment or CLI portability.

## Executed adapter paths

The checked-in [native owner suite](../../../apps/shell-super-app/tests/integration/server-owner-relay-native.test.ts)
and [fixture](../../../apps/shell-super-app/tests/support/server-owner-relay-native-fixture.ts)
contain the real HTTP/process, Current permission, audit and cleanup assertions. The table below
summarizes retained Steps 3–12 outcomes without requiring local execution records. Successive phase
runs retain earlier assertions and must not be counted as independent complete suites.

| Adapter path                                     | Observed outcome and boundary                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Catalog Manufacturer → Party                     | Create and Set returned 200; exact Current relation saved. Both Party scopes recorded original `P`, not `S`. Final upstream .16 Manufacturer case passed.                                                                                                                                                                                                                |
| CCC Guest attribution → Party                    | `ATTRIBUTION_COMPLETED`, `canAcceptOrder: true`, exact saved Party/profile references; original actor receipts, owned event and exact source-JTI exchange. The strict optional root profile-reference projection has a regression test.                                                                                                                                  |
| CCC Retail Ensure → Party                        | `PROFILE_CREATED`, ACTIVE revision 1; fresh-proof repeat returned `PROFILE_ALREADY_EXISTS_ACTIVE` with the same reference/revision. Two provider reads/exchanges, four linked accesses and one creation event were observed.                                                                                                                                             |
| CCC saved-address Add → Party                    | Real owner-produced ADDRESS contact; `PARTY_BACKED` Add returned ADDED revision 1. Provider evidence retained original actor/binding/reference/Legal Entity and exact source exchange.                                                                                                                                                                                   |
| CCC saved-address Update → Party                 | Full-origin Update retained the same reference at revision 2; public List returned the exact saved value. No fabricated Party contact was substituted.                                                                                                                                                                                                                   |
| CCC invoice postal resolution → Party            | Registered default factory and seven-phase owner probe completed with an actually redeemed original-`P` scope and real Party read. Mounted invoice HTTP Read returned 403 for missing trusted Storefront context.                                                                                                                                                        |
| CCC delivery postal resolution → Party           | Registered default factory and corresponding seven-phase probe completed; second real Party read/exchange observed. Mounted delivery HTTP Read also returned 403. Neither postal probe proves final Current purchase resolution.                                                                                                                                         |
| CCC Market Bootstrap → Market eligible + resolve | Actual default factory called both Market Reads. Current eligible set was empty: tuple count 0, nonempty `completenessEvidence.ownerRevision` and exact Storefront/channel/evaluationInstant predicate; policy `NOT_EVALUATED_NO_ELIGIBLE_SELLER`, resolution `MARKET_CONFIGURATION_MISSING_OR_INCONSISTENT`. No `MARKET_RESOLVED` result or fabricated eligible tuples. |

The Retail binding path also ran the emitted registered production permission worker with its
approved subscriptions. Authorization moved from `PENDING_GRANT` and public 403 to
`BINDING_AVAILABLE`, FULL completeness, ACTIVE authorization and CURRENT authorization/permission
freshness. The exact owned activation delivery reached `done` with at least one attempt; public
profile read was allowed. The worker exited cleanly on SIGTERM.

Provider controls established that `S` really had broader Party read/module access while the five
owner Actions allowed `P` and denied `S`. Fresh revocations of `P` produced
`manufacturer_target_forbidden`/403 without changing the saved relation/revision. Failure records
truthfully remained received where no terminal domain result existed.

Physical Party shutdown separately established branch independence: the Catalog LEGAL_ENTITY Set
and exact Current readback succeeded through Core with unchanged Party audit IDs and no source
exchange; CCC COMMERCE_ONLY Add/List likewise succeeded with no Party read/exchange. These local
branches do not establish the still-required Party-dependent outage negative. Completed phases
checked owned queue count zero, revoked fixture grants and stopped child processes; the worker
phases additionally checked graceful shutdown.

The [Market PostgreSQL redemption suite](../../../verticals/commerce-market-catalog/tests/integration/gateway-assertion-redemption-postgres.test.ts)
passed three cases covering existing migration/pre-authentication ACLs, concurrent/cross-instance
replay and audience isolation, expiry/retention/cleanup, and unavailable isolated storage. The
existing production adapter is bound; cleanup has no bounded-row-count guarantee.

## Postal scope helper and remaining qualifications

[Core's test-only verified-scope helper](../../../packages/core-runtime/src/testing/native-reads.ts)
supports the
[registered postal factory probe](../../../verticals/commerce-customer-context/tests/integration/registered-postal-factory-native-probe.mts).
It requires the exact production verifier's redeemed private provenance before I/O, including Staff
namespace, audience, Legal Entity and `R`; decoded/copied contexts are refused. It preserves the
Principal through the real OperationalScope resolver, live module gate and module permission check.
The SQL transaction requires `ontos_runtime` with neither superuser nor BYPASSRLS, locks Current
composition authority at verified `R`, and installs the operational scope. Caller-provided Principal
IDs or revision strings are not authority. The
[unit regression](../../../packages/core-runtime/tests/unit/native-read-test-context.test.ts)
covers refusal before native scope/callback I/O.

This helper executes a factory callback, not the owning business Read handler: it does not establish
that handler's business authorization, Current result or evidence. The mounted postal 403s remain
the public-path result. These processes use the shared runtime database identity; they do not prove
per-owner database isolation.

Market Bootstrap added only a typed owner-fixture `trustedStorefrontId` to an independently verified
personal-key context, then used the real Shell issuer/current catalog and issuer-role registrar for
a fresh source-capped assertion. This proves the owner fixture, not a production Storefront producer.
Three original-`P` receipts and two source-JTI exchange rows with distinct exchange IDs/fingerprints
were observed. Fingerprints bind audience, `R`, correlation, operation, Principal and source
application/build. Target JTI values and private Market nonce rows were **not directly observed**;
the separate replay suite does not imply that observation.

## Current Step 13 gate

At source `9bfcca2a8eea229f64bd1b9943a5eb917cea191e`, the initial official `pnpm check`
failed after policy typecheck and **303 policy tests passed**. Core Action units recorded
**129 passed / 1 failed**: one environment-path expectation did not honor the explicit
`APP_ENV_PATH=/dev/null` override. Downstream quality/boundary checks and the complete owner unit
suite were not reached; this is not a full gate pass. All 36 accepted package artifact hashes remained
unchanged.

Mandatory actual-relay rejection/outage coverage is being added: malformed/tampered proofs, wrong
issuer/key and expired/future validity; live API-key/session/support, binding/reference and actor/context
changes; source enrollment/build/`R` and destination/operation mismatches; unavailable
issuer/current identity/composition catalog/module/ledger; HTTP replay,
changed exchange and source credential revocation; and one Party-required invocation during physical
Party outage with typed unavailability and unchanged effects. Final executed security matrix and
independent #1284 review remain pending. Missing executed coverage is not itself a demonstrated
missing production guard.

## Reproduction

Use the checked-in test/fixture prerequisites and retained matching packages, live composition,
disposable native services and real authenticated contexts. Unconfigured skipped native cases are not
acceptance evidence. Required connection and SpiceDB configuration comes securely from those existing
disposable fixture prerequisites, without consulting the repository environment file or recording
secret values. Official commands from the Locki workspace are:

```sh
locki exec --match dr4npkf0 -- sh -lc 'cd app && APP_ENV_PATH=/dev/null mise exec -- pnpm check'
locki exec --match dr4npkf0 -- sh -lc 'cd app && APP_ENV_PATH=/dev/null mise exec -- pnpm --filter @app/shell-super-app test:integration tests/integration/server-owner-relay-native.test.ts --pool.maxWorkers 1'
locki exec --match dr4npkf0 -- sh -lc 'cd app && APP_ENV_PATH=/dev/null mise exec -- pnpm --filter @app/core-runtime test:unit tests/unit/native-read-test-context.test.ts --pool.maxWorkers 1'
```

This documentation refresh did not rerun those checks. Frozen phase results above must be updated
when Step 13 completes.
