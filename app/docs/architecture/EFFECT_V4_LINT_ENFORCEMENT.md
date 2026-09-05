# Effect v4 lint enforcement

Diagnostic-only implementation of [the existing audit](EFFECT_V4_ANTIPATTERN_AUDIT.md).
No application violations are repaired, no new dependencies are installed, and none of the
71 custom rules supplies autofixes or suggestions. All 71 are enabled as errors.

## Verified snapshot

- Source snapshot: audit commit `e38c97c`, with the new lint tooling; application sources unchanged.
- Oxlint 1.79.0; Effect 4.0.0-beta.107; Node 26.8.1.
- Scope: `apps verticals packages scripts`; 465 files linted.
- Effect policy report: **3,862 diagnostics in 321 files**; **70 rules report**, one has zero hits.
- Disjoint groups: **2,028 source**, **946 tests**, **888 scripts**. Test paths take precedence.
- Full production lint: **9,395 errors**, comprising the same **3,862 Effect** diagnostics and
  **5,533 other-policy** diagnostics (including five unused-disable directives). No plugin crash.
- Lint exits 1 intentionally: this is newly enforced debt, not an application migration.
- Dedicated strict tooling typecheck passes. Fixture/production/registration/harness tests pass;
  run the commands below for the current test count and results.

Counts are diagnostic occurrences, **not unique audit clusters** or proof of 3,862 independent
bugs. Several rules can report at one source location. Zero hits does not mean a rule is disabled:
`no-runtime-construction-outside-root` has verified positive fixture coverage.

## Reproduce

From `app/`:

```sh
pnpm typecheck:lint-rules
pnpm test:lint-rules
pnpm lint:effect
pnpm lint:effect --json
pnpm lint
```

`lint:effect --json` includes every diagnostic, every affected file, and all 71 rule totals.
The text report explicitly caps only the top-file display at 20. `pnpm check` includes the rule
gates before application lint; existing reported violations intentionally block it. No `--fix`
command was run. The implementation [README](../../tools/oxlint/effect-native/README.md) describes
fixture development, options, and the fail-closed process harness.

## Audit-to-rule catalog

The audit column is the **primary** section, not an exclusive mapping. Cross-cutting findings
(for example B2 time control, A1 reusable clients, A4 ADTs) can also motivate these rules.
Follow each rule link for its exact detection policy, defaults, exemptions, and limitations.

| Rule                                                                                                                                         | Audit | Total | Source | Tests | Scripts |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----: | -----: | ----: | ------: |
| [`no-ad-hoc-argv-in-scripts`](../../tools/oxlint/effect-native/rules/no-ad-hoc-argv-in-scripts.ts)                                           | B3    |    23 |      0 |     0 |      23 |
| [`no-ambient-date`](../../tools/oxlint/effect-native/rules/no-ambient-date.ts)                                                               | B5    |    56 |     19 |    19 |      18 |
| [`no-ambient-process-env`](../../tools/oxlint/effect-native/rules/no-ambient-process-env.ts)                                                 | A3    |   140 |     18 |    46 |      76 |
| [`no-async-script-program`](../../tools/oxlint/effect-native/rules/no-async-script-program.ts)                                               | B3    |   165 |      0 |     0 |     165 |
| [`no-bare-effect-run`](../../tools/oxlint/effect-native/rules/no-bare-effect-run.ts)                                                         | A1    |     1 |      1 |     0 |       0 |
| [`no-console-in-scripts`](../../tools/oxlint/effect-native/rules/no-console-in-scripts.ts)                                                   | B3    |    24 |      0 |     0 |      24 |
| [`no-dependency-parameters`](../../tools/oxlint/effect-native/rules/no-dependency-parameters.ts)                                             | B4    |    68 |     68 |     0 |       0 |
| [`no-direct-node-io-in-scripts`](../../tools/oxlint/effect-native/rules/no-direct-node-io-in-scripts.ts)                                     | B3    |    48 |      0 |     0 |      48 |
| [`no-dotenv-loading`](../../tools/oxlint/effect-native/rules/no-dotenv-loading.ts)                                                           | A3    |    26 |     18 |     2 |       6 |
| [`no-driver-failure-inspection`](../../tools/oxlint/effect-native/rules/no-driver-failure-inspection.ts)                                     | A5    |    33 |     33 |     0 |       0 |
| [`no-duplicate-literal-vocabulary`](../../tools/oxlint/effect-native/rules/no-duplicate-literal-vocabulary.ts)                               | B5    |     5 |      5 |     0 |       0 |
| [`no-effect-provide-in-library`](../../tools/oxlint/effect-native/rules/no-effect-provide-in-library.ts)                                     | A1    |     4 |      4 |     0 |       0 |
| [`no-effect-run-in-scripts`](../../tools/oxlint/effect-native/rules/no-effect-run-in-scripts.ts)                                             | B3    |     2 |      0 |     0 |       2 |
| [`no-effect-run-in-tests`](../../tools/oxlint/effect-native/rules/no-effect-run-in-tests.ts)                                                 | B2    |   683 |      0 |   683 |       0 |
| [`no-environment-record-type`](../../tools/oxlint/effect-native/rules/no-environment-record-type.ts)                                         | A3    |    26 |     23 |     0 |       3 |
| [`no-failure-discarding-error-callback`](../../tools/oxlint/effect-native/rules/no-failure-discarding-error-callback.ts)                     | A4    |   134 |    134 |     0 |       0 |
| [`no-hand-built-http-server-in-tests`](../../tools/oxlint/effect-native/rules/no-hand-built-http-server-in-tests.ts)                         | B2    |     9 |      0 |     9 |       0 |
| [`no-hand-built-problem-details`](../../tools/oxlint/effect-native/rules/no-hand-built-problem-details.ts)                                   | A4    |    68 |     68 |     0 |       0 |
| [`no-hand-parsed-environment-value`](../../tools/oxlint/effect-native/rules/no-hand-parsed-environment-value.ts)                             | A3    |   104 |     83 |     1 |      20 |
| [`no-hand-rolled-tagged-union`](../../tools/oxlint/effect-native/rules/no-hand-rolled-tagged-union.ts)                                       | B5    |    32 |     31 |     1 |       0 |
| [`no-imperative-loop-in-effect-gen`](../../tools/oxlint/effect-native/rules/no-imperative-loop-in-effect-gen.ts)                             | B1    |    14 |     14 |     0 |       0 |
| [`no-interface-first-codec`](../../tools/oxlint/effect-native/rules/no-interface-first-codec.ts)                                             | A2    |    34 |     34 |     0 |       0 |
| [`no-json-schema-as-document-contract`](../../tools/oxlint/effect-native/rules/no-json-schema-as-document-contract.ts)                       | A7    |    15 |     15 |     0 |       0 |
| [`no-layer-fresh`](../../tools/oxlint/effect-native/rules/no-layer-fresh.ts)                                                                 | A1    |     1 |      1 |     0 |       0 |
| [`no-layer-or-die-outside-root`](../../tools/oxlint/effect-native/rules/no-layer-or-die-outside-root.ts)                                     | A1    |    10 |     10 |     0 |       0 |
| [`no-layer-provide-in-library`](../../tools/oxlint/effect-native/rules/no-layer-provide-in-library.ts)                                       | A1    |    21 |     21 |     0 |       0 |
| [`no-literal-union-type-alias`](../../tools/oxlint/effect-native/rules/no-literal-union-type-alias.ts)                                       | B5    |    41 |     26 |     4 |      11 |
| [`no-local-defect-seam`](../../tools/oxlint/effect-native/rules/no-local-defect-seam.ts)                                                     | A4    |    53 |     53 |     0 |       0 |
| [`no-manual-config-in-scaffold-templates`](../../tools/oxlint/effect-native/rules/no-manual-config-in-scaffold-templates.ts)                 | A8    |    36 |      0 |     0 |      36 |
| [`no-manual-cookie-serialization`](../../tools/oxlint/effect-native/rules/no-manual-cookie-serialization.ts)                                 | C1    |     7 |      7 |     0 |       0 |
| [`no-manual-error-handling-in-scaffold-templates`](../../tools/oxlint/effect-native/rules/no-manual-error-handling-in-scaffold-templates.ts) | A8    |    10 |      0 |     0 |      10 |
| [`no-manual-identity-annotations`](../../tools/oxlint/effect-native/rules/no-manual-identity-annotations.ts)                                 | A6    |    52 |     52 |     0 |       0 |
| [`no-manual-route-param-parsing`](../../tools/oxlint/effect-native/rules/no-manual-route-param-parsing.ts)                                   | A9    |    13 |     13 |     0 |       0 |
| [`no-manual-tag-comparison`](../../tools/oxlint/effect-native/rules/no-manual-tag-comparison.ts)                                             | C2    |   166 |    130 |    36 |       0 |
| [`no-native-error-construction`](../../tools/oxlint/effect-native/rules/no-native-error-construction.ts)                                     | A4    |   115 |    115 |     0 |       0 |
| [`no-native-json-parse`](../../tools/oxlint/effect-native/rules/no-native-json-parse.ts)                                                     | C1    |    38 |      8 |     0 |      30 |
| [`no-native-json-stringify`](../../tools/oxlint/effect-native/rules/no-native-json-stringify.ts)                                             | C1    |    77 |     15 |     0 |      62 |
| [`no-native-timers`](../../tools/oxlint/effect-native/rules/no-native-timers.ts)                                                             | B1    |     8 |      2 |     6 |       0 |
| [`no-nested-effect-run`](../../tools/oxlint/effect-native/rules/no-nested-effect-run.ts)                                                     | S1    |    17 |     17 |     0 |       0 |
| [`no-nullable-schema-field`](../../tools/oxlint/effect-native/rules/no-nullable-schema-field.ts)                                             | B5    |    40 |     40 |     0 |       0 |
| [`no-nullable-service-outcome`](../../tools/oxlint/effect-native/rules/no-nullable-service-outcome.ts)                                       | B5    |    17 |     16 |     0 |       1 |
| [`no-per-operation-http-api-client`](../../tools/oxlint/effect-native/rules/no-per-operation-http-api-client.ts)                             | B1    |    43 |     43 |     0 |       0 |
| [`no-per-request-key-material`](../../tools/oxlint/effect-native/rules/no-per-request-key-material.ts)                                       | B1    |     3 |      2 |     0 |       1 |
| [`no-process-exit-outside-script-entry`](../../tools/oxlint/effect-native/rules/no-process-exit-outside-script-entry.ts)                     | B3    |    14 |      0 |     0 |      14 |
| [`no-promise-first-scaffold-templates`](../../tools/oxlint/effect-native/rules/no-promise-first-scaffold-templates.ts)                       | A8    |     4 |      0 |     0 |       4 |
| [`no-promise-shaped-port`](../../tools/oxlint/effect-native/rules/no-promise-shaped-port.ts)                                                 | A5    |    47 |     47 |     0 |       0 |
| [`no-raw-effect-adt-tag-check`](../../tools/oxlint/effect-native/rules/no-raw-effect-adt-tag-check.ts)                                       | C2    |    19 |     16 |     3 |       0 |
| [`no-refinement-outside-schema`](../../tools/oxlint/effect-native/rules/no-refinement-outside-schema.ts)                                     | A2    |    43 |     29 |     4 |      10 |
| [`no-route-local-error-classifier`](../../tools/oxlint/effect-native/rules/no-route-local-error-classifier.ts)                               | A4    |    26 |     26 |     0 |       0 |
| [`no-runtime-construction-outside-root`](../../tools/oxlint/effect-native/rules/no-runtime-construction-outside-root.ts)                     | A1    |     0 |      0 |     0 |       0 |
| [`no-scattered-browser-effect-run`](../../tools/oxlint/effect-native/rules/no-scattered-browser-effect-run.ts)                               | A9    |    32 |     32 |     0 |       0 |
| [`no-sequential-independent-yields`](../../tools/oxlint/effect-native/rules/no-sequential-independent-yields.ts)                             | B1    |     3 |      3 |     0 |       0 |
| [`no-string-timestamp-schema`](../../tools/oxlint/effect-native/rules/no-string-timestamp-schema.ts)                                         | B5    |    32 |     23 |     1 |       8 |
| [`no-structural-document-walking`](../../tools/oxlint/effect-native/rules/no-structural-document-walking.ts)                                 | A7    |    57 |     29 |     0 |      28 |
| [`no-symbol-slotted-operation-record`](../../tools/oxlint/effect-native/rules/no-symbol-slotted-operation-record.ts)                         | B4    |    18 |     18 |     0 |       0 |
| [`no-sync-schema-codec`](../../tools/oxlint/effect-native/rules/no-sync-schema-codec.ts)                                                     | C1    |    21 |     17 |     0 |       4 |
| [`no-threaded-correlation-parameter`](../../tools/oxlint/effect-native/rules/no-threaded-correlation-parameter.ts)                           | A6    |    46 |     46 |     0 |       0 |
| [`no-throw-in-configuration-parser`](../../tools/oxlint/effect-native/rules/no-throw-in-configuration-parser.ts)                             | A3    |    26 |     26 |     0 |       0 |
| [`no-throw-in-effect-callback`](../../tools/oxlint/effect-native/rules/no-throw-in-effect-callback.ts)                                       | A4    |    61 |     61 |     0 |       0 |
| [`no-throw-in-scripts`](../../tools/oxlint/effect-native/rules/no-throw-in-scripts.ts)                                                       | B3    |   269 |      0 |     0 |     269 |
| [`no-unbranded-identifier-schema`](../../tools/oxlint/effect-native/rules/no-unbranded-identifier-schema.ts)                                 | A2    |   154 |    126 |    28 |       0 |
| [`no-unjustified-file-wide-lint-suppression`](../../tools/oxlint/effect-native/rules/no-unjustified-file-wide-lint-suppression.ts)           | A8    |   209 |     99 |   101 |       9 |
| [`no-unmanaged-mutable-state`](../../tools/oxlint/effect-native/rules/no-unmanaged-mutable-state.ts)                                         | C3    |    11 |     11 |     0 |       0 |
| [`no-unredacted-secret-field`](../../tools/oxlint/effect-native/rules/no-unredacted-secret-field.ts)                                         | A3    |    41 |     35 |     0 |       6 |
| [`no-wide-factory-signature`](../../tools/oxlint/effect-native/rules/no-wide-factory-signature.ts)                                           | B4    |    23 |     23 |     0 |       0 |
| [`prefer-effect-fn-for-operations`](../../tools/oxlint/effect-native/rules/prefer-effect-fn-for-operations.ts)                               | B4    |    75 |     75 |     0 |       0 |
| [`prefer-match-over-tag-switch`](../../tools/oxlint/effect-native/rules/prefer-match-over-tag-switch.ts)                                     | C2    |    34 |     32 |     2 |       0 |
| [`require-concurrency-option`](../../tools/oxlint/effect-native/rules/require-concurrency-option.ts)                                         | B1    |    11 |     11 |     0 |       0 |
| [`require-context-service-for-service-interface`](../../tools/oxlint/effect-native/rules/require-context-service-for-service-interface.ts)   | B4    |    11 |     11 |     0 |       0 |
| [`require-observability-layers-at-runtime-root`](../../tools/oxlint/effect-native/rules/require-observability-layers-at-runtime-root.ts)     | A6    |     9 |      9 |     0 |       0 |
| [`require-timeout-on-external-effect`](../../tools/oxlint/effect-native/rules/require-timeout-on-external-effect.ts)                         | B1    |    84 |     84 |     0 |       0 |

## Boundaries that remain review work

- AST/scope evidence is not a TypeScript semantic checker or cross-file dataflow engine.
  Imported barrels, opaque aliases, arbitrary dynamic keys, external schemas and indirect
  ownership require explicit configuration or review; syntax alone cannot establish them.
- Sequential-yield and timeout checks are **review candidates**, not proofs of safe concurrency
  or end-to-end deadlines. Never parallelize writes/authentication/reconciliation mechanically.
- Schema/tag/secret/temporal-name policies cannot establish complete domain semantics. Nullable
  wire encodings may be deliberate; any later codec migration requires round-trip verification.
- Runtime/layer/observability checks cannot prove resource lifetimes, Layer installation, context
  propagation, exporter connectivity, redaction completeness, or application-wide composition.
- Effect-shaped port checks cannot create transaction affinity or prove rollback behavior. S1
  still needs transactional integration evidence; a syntactically clean port is insufficient.
- A7 shared contract authority, vocabulary reuse, and schema equivalence remain cross-file
  architecture work beyond the local structural/document and schema detectors.
- A8 template checks are lexical: arbitrary generated/dynamically assembled source and real
  scaffold quality still need generator tests and emitted-project gates.
- B2 flags raw runners/time control but does not install or certify an Effect test harness.
  `@effect/vitest` was not added.

## Audit exceptions preserved

Forced React/TanStack/Modern.js/Playwright/Drizzle/Node Promise boundaries, the deliberately
owned outer runner seam, startup `Layer.orDie` after typed-cause logging, JSONB/HttpApi encoding,
external test APIs requiring serialized bodies, malformed rejection-test casts, legitimate
`as const`/`satisfies`, line-preserving `.env` edits, native collections, recursive JSON array
normalization and correctly scoped fibers are not blanket migration targets. Operational
success console output remains allowed. The dropped Rspack injected-global finding stays dropped.

Exemptions are bounded by the local evidence/options each rule documents, not a guarantee that
every opaque implementation is classified correctly. Correct a confirmed false positive in the
detector with a regression; do not silence genuine architectural debt with blanket disables.

## Verification design

- Real Oxlint processes run all positive and negative inputs; exact counts are asserted where
  declared. Explicit file lists and file-count checks prevent ignored-directory inputs from
  masquerading as verified tests. Declaration syntax is tested in ordinary `.ts` files.
- Production-default checks stage copies outside `tools/**/tests` ancestry so fixture paths
  do not accidentally select a test-only scope. Option overrides remain separate evidence.
- Loader errors, malformed output, unexpected diagnostics, inconsistent exits, empty-file
  reports and stderr failures fail the harness rather than being reported as zero violations.
- Registration imports the actual plugin/config and checks complete rule coverage, error
  severity, preserved typed lint settings, and absence of fixer/suggestion metadata.
- Temporary workspaces are owned, cleaned on success/failure/normal termination, and covered
  by early/partial-failure and termination regressions. SIGKILL/host loss cannot be cleaned
  synchronously; use an isolated temporary root when running under an external supervisor.
- Existing application tests and application fixes are outside this change. Full `pnpm check`
  cannot pass while intentionally reported lint debt remains.
