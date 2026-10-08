# Issue #335 review-remediation evidence

This record covers the ten findings in `issue_335_spec_mismatch_review.md`. It records the exact tested remediation revision, commands, outcomes, environment qualification, and boundaries without secrets or connection details.

## Revision identity

- Remediation head: `5250147167139b810e6b5bba51be55f542cf2749`
- Remediation commits: `35d522004` and `525014716`
- Pre-remediation implementation head: `1f927c72c328cfcfd0e12fbd09740e304c0f2c1c`
- Prepared `origin/main`: `b534baa7a7abd74cfae6e5ca38e2e1fc91393124`
- Toolchain: Node.js 26.7.0; pnpm 12.4.2 through `mise`
- Environment: local macOS development services with disposable PostgreSQL databases for migration replay

## Review findings

- H1: rejected authorized revisions advance the persisted high-water barrier; lower and competing revisions are retained as stale/ambiguous decisions.
- H2: exact immutable statement replay and conflict detection run before mutable authority checks; novel statements still require current authority.
- H3: the Action injects Core principal identity; the HTTP payload rejects principal spoofing; PostgreSQL binds principal to exact EBS, namespace, and route and writes nothing when unauthorized. Under the documented attested-integration convention, that configured route principal attests every opaque source-record ID submitted within the authenticated route; no separate per-record ACL is claimed.
- M1: owner-local source-record state and append-only accepted lineage publish statement identities and PaymentTermRefs through a bounded governed historical read.
- M2: every definition revision is validated and trigger-enforced against revision 1 semantics; duplicate lookup scans retained revisions without adding global uniqueness.
- M3: history publishes retained revision meaning plus a separate lifecycle ledger; Current overlays present lifecycle onto requested historical semantics.
- M4: this tracked artifact binds the verification below to the exact remediation head.
- M5: the branch was prepared from the recorded main SHA; the remediation adds no package, lockfile, workspace, CCC, or unrelated route change relative to the pre-remediation head.
- L1/L2: the unrelated Catalog language-route correction is absent, while the owner endpoints, events, and required generated registration remain intact.

## Verification

The following commands passed at the remediation head unless a qualification is stated:

| Command                                                                                                                                                                  | Result                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `mise exec -- pnpm --filter @app/payment-term-catalog-contracts test:unit`                                                                                               | 11/11 passed                                               |
| `mise exec -- pnpm --filter @app/payment-term-catalog test:unit`                                                                                                         | 56/56 passed                                               |
| `mise exec -- pnpm --filter @app/payment-term-catalog test:integration`                                                                                                  | 3/3 passed, including fresh and populated double migration |
| `mise exec -- pnpm --filter @app/payment-term-catalog db:test`                                                                                                           | 5/5 passed                                                 |
| `mise exec -- pnpm --filter @app/commerce-customer-context test:unit`                                                                                                    | 1008/1008 passed                                           |
| `mise exec -- pnpm --filter @app/commerce-customer-context exec rstest run tests/integration/payment-term-replacement-continuity-postgres.test.ts --project integration` | 1/1 passed                                                 |
| `pnpm lint`                                                                                                                                                              | passed                                                     |
| `pnpm typecheck`                                                                                                                                                         | passed                                                     |
| `pnpm format:check`                                                                                                                                                      | 5,922 files passed                                         |
| `pnpm quality:audit`, `pnpm quality:audit:gate`, `pnpm lint:suppressions`                                                                                                | passed; clone/complexity output remains advisory           |
| `pnpm skills:check`, `pnpm i18n:boundaries`, `pnpm api:check`, `pnpm api:check:ontos`, `pnpm contract:check`, `pnpm performance:readiness`                               | passed                                                     |
| `ULTRAMODERN_SOURCE_REVISION=5250147167139b810e6b5bba51be55f542cf2749 MODERN_PUBLIC_SITE_URL=http://localhost:8080 pnpm build`                                           | passed from a clean committed tree                         |

`pnpm check` was attempted twice. Its first run passed 242/242 lint-rule tests, 119/119 Core Action tests, database/Lean-Core/entrypoint/module-contract gates, then the JSCPD child exceeded its fixed five-minute timeout. The isolated `pnpm quality:audit` retry passed, and every remaining gate passed through the commands listed above. The second chained run stopped when three Oxlint fixture child processes timed out; those same lint-rule tests had already passed in the first run. No product diagnostic was suppressed or changed.

`pnpm test:unit` ran the workspace until unrelated Assortment workers failed to start within 90 seconds. All 193 Assortment assertions that started passed; the two reported files then passed 14/14 with `--pool.maxWorkers 1`. Pnpm canceled later Pricing and Shell test jobs after the worker-start failure. This is recorded as an environment concurrency limitation, not as a successful monolithic workspace-unit run.

`git diff --name-only 1f927c72c328cfcfd0e12fbd09740e304c0f2c1c...5250147167139b810e6b5bba51be55f542cf2749 -- package.json pnpm-lock.yaml pnpm-workspace.yaml verticals/commerce-customer-context packages` returned no paths.

## Independent review

- Standards review found two issues: the new history entrypoint needed `historical_read` plus inactive-module proof, and its revision schema duplicated the owner domain schema. Both are fixed in `525014716` and the owner unit suite passes 56/56.
- Spec review found the attested source-record trust convention unstated and M4 evidence not yet tracked. The convention is now explicit in the acceptance record and this committed artifact resolves M4.

## Boundaries

No live ERP/Symmy transport, production migration, Billing calculation, Payment/Order runtime, or complete Commerce flow is claimed. Source-ingest fixtures are owner-local. CCC verification consumes the published owner contract and proves persisted assignment continuity only.
