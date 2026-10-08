# C15 owner acceptance (#1143)

This record covers #1140 implementation and #1143 owner acceptance under tracking #335, including the issue-review remediation prepared from `origin/main` at `b534baa7a7abd74cfae6e5ca38e2e1fc91393124`. Exact tested revision evidence is recorded in `review-remediation-evidence.md`. No production deployment or live external integration is claimed.

## Executable matrix

Paths below are relative to the owning vertical's `tests/`, except public contract tests under `packages/payment-term-catalog-contracts/tests/unit/` and explicitly prefixed CCC tests.

| Required area         | Executable evidence                                                                                                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical ownership   | `payment-term-public-contracts.test.ts` canonical-v2 and retained-v1 schemas; CCC `unit/customer-payment-terms.test.ts` owner-derived snapshots. No consumer identity list or concrete invoice due-date evaluator remains in the active contract.                                                                         |
| Creation              | `unit/payment-term-domain.test.ts` local IMMEDIATE and NET_DAYS bounds; `integration/source-statement-database.test.ts` qualified CREATE and explicit EXISTING mapping. Unknown meaning is rejected, never inferred from a code.                                                                                          |
| Identity              | Source database replacement creates another Ref; persisted cosmetic correction keeps semantic identity. Conflicting business codes and non-equivalent aliases fail explicitly.                                                                                                                                            |
| Historical continuity | Fresh/populated migration replay retains exact v1 rows; persisted correction/alias/retirement preserves exact revision meaning and publishes the separate lifecycle-event ledger. CCC persisted fourteen-day assignment and preference remain unchanged.                                                                  |
| Source acceptance     | Source database tests prove rejected-revision high-water fencing, exact replay after authority rotation, changed-content conflict, recovery at a later revision, and explicit accepted predecessor/successor lineage without overwriting accepted meaning on rejection.                                                   |
| Lifecycle             | Owner domain/behavior and PostgreSQL tests keep historical revision lifecycle separate from later retirement evidence, while Current resolution deliberately overlays present canonical eligibility onto requested historical semantics.                                                                                  |
| Concurrency           | Source database exact CREATE and EXISTING retries prove serialized retained results; persisted stale correction/retirement rejects without new revisions.                                                                                                                                                                 |
| References            | Public contracts and CCC `unit/payment-term-catalog-adapter.test.ts` cover missing, retired, incompatible, broken and unsupported outcomes. No silent IMMEDIATE fallback.                                                                                                                                                 |
| Governance            | Owner `integration/database-security-catalog.test.ts`, source database scope/rollback tests, HTTP closed-payload tests, and source Action tests prove EBS/namespace/route/principal binding, no unauthorized ledger/projection writes, RLS, immutable ledgers, and event-linked Outbox.                                   |
| Source evidence       | The generated governed `payment-term-source-record-history` read returns a bounded record history, highest observed decision, current accepted PaymentTermRef, and public source-statement lineage without exposing internal ledger UUIDs.                                                                                |
| Semantic invariants   | Migration validation and the revision trigger enforce within-Resource semantic immutability across every retained definition revision; duplicate lookup scans retained revisions without adding a global uniqueness rule, so governed equivalent-duplicate reconciliation remains possible.                               |
| Retirement            | `unit/payment-term-behavior.test.ts` unavailable authoritative affected-use evidence causes zero retirement writes, handler audit/events/Outbox and read evidence. Domain rejection rolls back business/audit evidence and leaves the invocation open for retry; pre-execution authorization denial evidence is separate. |

## Four named scenarios

1. **Two systems use F14:** the source database proof configures two EBS authorities; equivalent explicit mapping preserves the canonical Ref, while a different meaning creates another Ref. Qualified correlations remain distinct.
2. **Fourteen becomes thirty:** the source database proof creates a new canonical Ref. CCC `integration/payment-term-replacement-continuity-postgres.test.ts` persists fourteen-day entitlement and preference in PostgreSQL, resolves through the production public-owner adapter, and rereads unchanged original Ref, semantic revision and customer setting revision after a thirty-day definition appears.
3. **Retained calculation rule:** each populated disposable database contains a retained v1 definition before migration. Both migration runs preserve its exact row projection and historical schema; it is not relabelled as canonical v2.
4. **Unavailable open-purchase evidence:** the actual retirement handler rejects unavailable authoritative affected-use evidence without retiring a term or generating business side effects. No dummy Order service supplies a zero-use result.

## Boundaries

The source proof executes actual owner PostgreSQL routines in disposable fresh and populated databases and applies migration twice in each. The alias/history seed is an administrative retained-history fixture, not a bypass offered to application callers. CCC uses actual persistence and resolution with a declared public catalog fixture; qualified source ingestion is proved separately inside the owner. Action lifecycle/unit tests use their declared service seams and do not establish live external transport.

These proofs do not establish live Symmy/ERP connectivity, real purchases/invoices, provider collection, concrete Billing due dates, production migration or a complete Commerce flow. Existing downstream gates remain unchanged. No upstream issue, package dependency or fabricated downstream runtime is introduced. Closed #1141 is absorbed into #1140; closed #1142 remains excluded; roadmap #253 remains read-only.

## Reproduction and execution

Run inside a prepared isolated sandbox from `app/`, using the mise-managed toolchain:

```sh
mise exec -- pnpm --filter @app/payment-term-catalog-contracts test:unit
mise exec -- pnpm --filter @app/payment-term-catalog test:unit
mise exec -- pnpm --filter @app/payment-term-catalog test:integration
mise exec -- pnpm --filter @app/payment-term-catalog db:test
mise exec -- pnpm --filter @app/commerce-customer-context test:unit
mise exec -- pnpm --filter @app/commerce-customer-context exec rstest run tests/integration/payment-term-replacement-continuity-postgres.test.ts --project integration
mise exec -- pnpm check
mise exec -- pnpm test:unit
```

Build release tooling requires a clean committed Git tree and a real commit object ID. After committing, run:

```sh
ULTRAMODERN_SOURCE_REVISION="$(git rev-parse HEAD)" \
MODERN_PUBLIC_SITE_URL=http://localhost:8080 mise exec -- pnpm build
```

The local origin configures this sandbox build only. Dirty trees are intentionally identified as `workspace` even with a supplied revision; a branch-like validation string cannot replace a commit ID.

The final execution results and independent issue review are recorded in the tracked `review-remediation-evidence.md`. The unrelated Catalog language-route correction is intentionally absent from this branch.
