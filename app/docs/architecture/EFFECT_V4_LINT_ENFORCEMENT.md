# Effect v4 lint enforcement

Diagnostic-only implementation of [the existing audit](EFFECT_V4_ANTIPATTERN_AUDIT.md).
No application violations are repaired, no new dependencies are installed, and none of the
71 custom rules supplies autofixes or suggestions. All 71 are enabled as errors.

## Verified snapshot

- Source snapshot: main commit `9adca84e`, with the lint tooling at `1531cfb6`. No application-source
  changes are included in this PR; upstream application changes were retained during rebase.
- Existing lint toolchain: Oxlint 1.79.0, `@oxlint/plugins` 1.79.0, Node 26.8.1 locally.
- Scope: `apps verticals packages scripts`, including Party Registry; **753 files linted**.
- Effect policy report: **5,286 diagnostics in 517 files**; **70 rules report**, one has zero hits.
- Disjoint groups: **3,054 source**, **1,296 tests**, **936 scripts**. Test paths take precedence.
- Dedicated strict tooling typecheck and **162 tests pass**, covering **2,248 fixture source
  files**, production defaults, registration, reporting failures, temporary cleanup, nested-script
  scope and isolated file-URL discovery.
- The Effect-only scan completes without a plugin crash and exits 1 intentionally because
  application debt is reported, not repaired.

Before rebase, the package-script gates and scoped formatting passed. Full lint on the original
`e38c97c` source snapshot produced 9,395 errors: 3,862 Effect and 5,533 other-policy diagnostics,
including five unused-disable directives. Those are **historical**, not the rebased totals above.

**Clean-install CI on `1531cfb6`:** [run 33979642298](https://github.com/TechsioCZ/ontos/actions/runs/33979642298)
passes all non-lint validation jobs, including strict rule types and 162/162 tests, application
Typecheck, Format, Workspace Contract, database integration, generation, and Node/Workerd artifact
proofs. Full lint intentionally reports **12,031 errors on 753 files**; stage deployment is skipped.

**Local environment:** installed application dependencies still lag main's updated lockfile, so
pnpm package wrappers can report `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`. No local dependency install was
performed; unchanged installed lint/compiler binaries were invoked directly. The separate clean
CI run provides synchronized verification, but neither run is a successful full `pnpm check`
because application lint debt remains. The Effect-only AST scan does not typecheck application
dependencies.

Counts are diagnostic occurrences, **not unique audit clusters** or proof of independent bugs. Several rules can report at one source location. Zero hits does not mean a rule is disabled:
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
| [`no-ad-hoc-argv-in-scripts`](../../tools/oxlint/effect-native/rules/no-ad-hoc-argv-in-scripts.ts)                                           | B3    |    24 |      0 |     0 |      24 |
| [`no-ambient-date`](../../tools/oxlint/effect-native/rules/no-ambient-date.ts)                                                               | B5    |    77 |     43 |    16 |      18 |
| [`no-ambient-process-env`](../../tools/oxlint/effect-native/rules/no-ambient-process-env.ts)                                                 | A3    |   127 |     20 |    32 |      75 |
| [`no-async-script-program`](../../tools/oxlint/effect-native/rules/no-async-script-program.ts)                                               | B3    |   182 |      0 |     0 |     182 |
| [`no-bare-effect-run`](../../tools/oxlint/effect-native/rules/no-bare-effect-run.ts)                                                         | A1    |     3 |      3 |     0 |       0 |
| [`no-console-in-scripts`](../../tools/oxlint/effect-native/rules/no-console-in-scripts.ts)                                                   | B3    |    26 |      0 |     0 |      26 |
| [`no-dependency-parameters`](../../tools/oxlint/effect-native/rules/no-dependency-parameters.ts)                                             | B4    |    96 |     96 |     0 |       0 |
| [`no-direct-node-io-in-scripts`](../../tools/oxlint/effect-native/rules/no-direct-node-io-in-scripts.ts)                                     | B3    |    54 |      0 |     0 |      54 |
| [`no-dotenv-loading`](../../tools/oxlint/effect-native/rules/no-dotenv-loading.ts)                                                           | A3    |    28 |     20 |     2 |       6 |
| [`no-driver-failure-inspection`](../../tools/oxlint/effect-native/rules/no-driver-failure-inspection.ts)                                     | A5    |    43 |     43 |     0 |       0 |
| [`no-duplicate-literal-vocabulary`](../../tools/oxlint/effect-native/rules/no-duplicate-literal-vocabulary.ts)                               | B5    |     9 |      9 |     0 |       0 |
| [`no-effect-provide-in-library`](../../tools/oxlint/effect-native/rules/no-effect-provide-in-library.ts)                                     | A1    |     5 |      5 |     0 |       0 |
| [`no-effect-run-in-scripts`](../../tools/oxlint/effect-native/rules/no-effect-run-in-scripts.ts)                                             | B3    |     2 |      0 |     0 |       2 |
| [`no-effect-run-in-tests`](../../tools/oxlint/effect-native/rules/no-effect-run-in-tests.ts)                                                 | B2    |   970 |      0 |   970 |       0 |
| [`no-environment-record-type`](../../tools/oxlint/effect-native/rules/no-environment-record-type.ts)                                         | A3    |    37 |     33 |     0 |       4 |
| [`no-failure-discarding-error-callback`](../../tools/oxlint/effect-native/rules/no-failure-discarding-error-callback.ts)                     | A4    |   234 |    234 |     0 |       0 |
| [`no-hand-built-http-server-in-tests`](../../tools/oxlint/effect-native/rules/no-hand-built-http-server-in-tests.ts)                         | B2    |     9 |      0 |     9 |       0 |
| [`no-hand-built-problem-details`](../../tools/oxlint/effect-native/rules/no-hand-built-problem-details.ts)                                   | A4    |   194 |    194 |     0 |       0 |
| [`no-hand-parsed-environment-value`](../../tools/oxlint/effect-native/rules/no-hand-parsed-environment-value.ts)                             | A3    |   113 |     95 |     1 |      17 |
| [`no-hand-rolled-tagged-union`](../../tools/oxlint/effect-native/rules/no-hand-rolled-tagged-union.ts)                                       | B5    |    66 |     64 |     2 |       0 |
| [`no-imperative-loop-in-effect-gen`](../../tools/oxlint/effect-native/rules/no-imperative-loop-in-effect-gen.ts)                             | B1    |    56 |     56 |     0 |       0 |
| [`no-interface-first-codec`](../../tools/oxlint/effect-native/rules/no-interface-first-codec.ts)                                             | A2    |    36 |     36 |     0 |       0 |
| [`no-json-schema-as-document-contract`](../../tools/oxlint/effect-native/rules/no-json-schema-as-document-contract.ts)                       | A7    |    15 |     15 |     0 |       0 |
| [`no-layer-fresh`](../../tools/oxlint/effect-native/rules/no-layer-fresh.ts)                                                                 | A1    |     1 |      1 |     0 |       0 |
| [`no-layer-or-die-outside-root`](../../tools/oxlint/effect-native/rules/no-layer-or-die-outside-root.ts)                                     | A1    |    12 |     12 |     0 |       0 |
| [`no-layer-provide-in-library`](../../tools/oxlint/effect-native/rules/no-layer-provide-in-library.ts)                                       | A1    |    31 |     31 |     0 |       0 |
| [`no-literal-union-type-alias`](../../tools/oxlint/effect-native/rules/no-literal-union-type-alias.ts)                                       | B5    |    34 |     19 |     4 |      11 |
| [`no-local-defect-seam`](../../tools/oxlint/effect-native/rules/no-local-defect-seam.ts)                                                     | A4    |    50 |     50 |     0 |       0 |
| [`no-manual-config-in-scaffold-templates`](../../tools/oxlint/effect-native/rules/no-manual-config-in-scaffold-templates.ts)                 | A8    |     3 |      0 |     0 |       3 |
| [`no-manual-cookie-serialization`](../../tools/oxlint/effect-native/rules/no-manual-cookie-serialization.ts)                                 | C1    |     7 |      7 |     0 |       0 |
| [`no-manual-error-handling-in-scaffold-templates`](../../tools/oxlint/effect-native/rules/no-manual-error-handling-in-scaffold-templates.ts) | A8    |     4 |      0 |     0 |       4 |
| [`no-manual-identity-annotations`](../../tools/oxlint/effect-native/rules/no-manual-identity-annotations.ts)                                 | A6    |    47 |     47 |     0 |       0 |
| [`no-manual-route-param-parsing`](../../tools/oxlint/effect-native/rules/no-manual-route-param-parsing.ts)                                   | A9    |     3 |      3 |     0 |       0 |
| [`no-manual-tag-comparison`](../../tools/oxlint/effect-native/rules/no-manual-tag-comparison.ts)                                             | C2    |   271 |    195 |    76 |       0 |
| [`no-native-error-construction`](../../tools/oxlint/effect-native/rules/no-native-error-construction.ts)                                     | A4    |   143 |    143 |     0 |       0 |
| [`no-native-json-parse`](../../tools/oxlint/effect-native/rules/no-native-json-parse.ts)                                                     | C1    |    44 |      8 |     0 |      36 |
| [`no-native-json-stringify`](../../tools/oxlint/effect-native/rules/no-native-json-stringify.ts)                                             | C1    |   100 |     36 |     0 |      64 |
| [`no-native-timers`](../../tools/oxlint/effect-native/rules/no-native-timers.ts)                                                             | B1    |    14 |      2 |    12 |       0 |
| [`no-nested-effect-run`](../../tools/oxlint/effect-native/rules/no-nested-effect-run.ts)                                                     | S1    |    19 |     19 |     0 |       0 |
| [`no-nullable-schema-field`](../../tools/oxlint/effect-native/rules/no-nullable-schema-field.ts)                                             | B5    |   121 |    121 |     0 |       0 |
| [`no-nullable-service-outcome`](../../tools/oxlint/effect-native/rules/no-nullable-service-outcome.ts)                                       | B5    |    25 |     24 |     0 |       1 |
| [`no-per-operation-http-api-client`](../../tools/oxlint/effect-native/rules/no-per-operation-http-api-client.ts)                             | B1    |    74 |     74 |     0 |       0 |
| [`no-per-request-key-material`](../../tools/oxlint/effect-native/rules/no-per-request-key-material.ts)                                       | B1    |     4 |      3 |     0 |       1 |
| [`no-process-exit-outside-script-entry`](../../tools/oxlint/effect-native/rules/no-process-exit-outside-script-entry.ts)                     | B3    |    15 |      0 |     0 |      15 |
| [`no-promise-first-scaffold-templates`](../../tools/oxlint/effect-native/rules/no-promise-first-scaffold-templates.ts)                       | A8    |     4 |      0 |     0 |       4 |
| [`no-promise-shaped-port`](../../tools/oxlint/effect-native/rules/no-promise-shaped-port.ts)                                                 | A5    |    53 |     53 |     0 |       0 |
| [`no-raw-effect-adt-tag-check`](../../tools/oxlint/effect-native/rules/no-raw-effect-adt-tag-check.ts)                                       | C2    |    21 |     16 |     5 |       0 |
| [`no-refinement-outside-schema`](../../tools/oxlint/effect-native/rules/no-refinement-outside-schema.ts)                                     | A2    |    46 |     35 |     1 |      10 |
| [`no-route-local-error-classifier`](../../tools/oxlint/effect-native/rules/no-route-local-error-classifier.ts)                               | A4    |     9 |      9 |     0 |       0 |
| [`no-runtime-construction-outside-root`](../../tools/oxlint/effect-native/rules/no-runtime-construction-outside-root.ts)                     | A1    |     0 |      0 |     0 |       0 |
| [`no-scattered-browser-effect-run`](../../tools/oxlint/effect-native/rules/no-scattered-browser-effect-run.ts)                               | A9    |    13 |     13 |     0 |       0 |
| [`no-sequential-independent-yields`](../../tools/oxlint/effect-native/rules/no-sequential-independent-yields.ts)                             | B1    |    13 |     13 |     0 |       0 |
| [`no-string-timestamp-schema`](../../tools/oxlint/effect-native/rules/no-string-timestamp-schema.ts)                                         | B5    |    36 |     27 |     1 |       8 |
| [`no-structural-document-walking`](../../tools/oxlint/effect-native/rules/no-structural-document-walking.ts)                                 | A7    |    60 |     32 |     0 |      28 |
| [`no-symbol-slotted-operation-record`](../../tools/oxlint/effect-native/rules/no-symbol-slotted-operation-record.ts)                         | B4    |    24 |     24 |     0 |       0 |
| [`no-sync-schema-codec`](../../tools/oxlint/effect-native/rules/no-sync-schema-codec.ts)                                                     | C1    |    34 |     29 |     0 |       5 |
| [`no-threaded-correlation-parameter`](../../tools/oxlint/effect-native/rules/no-threaded-correlation-parameter.ts)                           | A6    |    86 |     86 |     0 |       0 |
| [`no-throw-in-configuration-parser`](../../tools/oxlint/effect-native/rules/no-throw-in-configuration-parser.ts)                             | A3    |    28 |     28 |     0 |       0 |
| [`no-throw-in-effect-callback`](../../tools/oxlint/effect-native/rules/no-throw-in-effect-callback.ts)                                       | A4    |    69 |     69 |     0 |       0 |
| [`no-throw-in-scripts`](../../tools/oxlint/effect-native/rules/no-throw-in-scripts.ts)                                                       | B3    |   317 |      0 |     0 |     317 |
| [`no-unbranded-identifier-schema`](../../tools/oxlint/effect-native/rules/no-unbranded-identifier-schema.ts)                                 | A2    |   230 |    199 |    30 |       1 |
| [`no-unjustified-file-wide-lint-suppression`](../../tools/oxlint/effect-native/rules/no-unjustified-file-wide-lint-suppression.ts)           | A8    |   299 |    153 |   133 |      13 |
| [`no-unmanaged-mutable-state`](../../tools/oxlint/effect-native/rules/no-unmanaged-mutable-state.ts)                                         | C3    |    10 |     10 |     0 |       0 |
| [`no-unredacted-secret-field`](../../tools/oxlint/effect-native/rules/no-unredacted-secret-field.ts)                                         | A3    |    96 |     89 |     0 |       7 |
| [`no-wide-factory-signature`](../../tools/oxlint/effect-native/rules/no-wide-factory-signature.ts)                                           | B4    |    33 |     33 |     0 |       0 |
| [`prefer-effect-fn-for-operations`](../../tools/oxlint/effect-native/rules/prefer-effect-fn-for-operations.ts)                               | B4    |   189 |    189 |     0 |       0 |
| [`prefer-match-over-tag-switch`](../../tools/oxlint/effect-native/rules/prefer-match-over-tag-switch.ts)                                     | C2    |    39 |     37 |     2 |       0 |
| [`require-concurrency-option`](../../tools/oxlint/effect-native/rules/require-concurrency-option.ts)                                         | B1    |    21 |     21 |     0 |       0 |
| [`require-context-service-for-service-interface`](../../tools/oxlint/effect-native/rules/require-context-service-for-service-interface.ts)   | B4    |    13 |     13 |     0 |       0 |
| [`require-observability-layers-at-runtime-root`](../../tools/oxlint/effect-native/rules/require-observability-layers-at-runtime-root.ts)     | A6    |    12 |     12 |     0 |       0 |
| [`require-timeout-on-external-effect`](../../tools/oxlint/effect-native/rules/require-timeout-on-external-effect.ts)                         | B1    |   103 |    103 |     0 |       0 |

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
