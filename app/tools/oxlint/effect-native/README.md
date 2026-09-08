# Effect-native Oxlint rules

Custom diagnostic rules derived from
[`EFFECT_V4_ANTIPATTERN_AUDIT.md`](../../../docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md).
All are explicitly registered and configured at **error** severity. There are **no autofixers or
suggestions**. This change introduces enforcement, not an application migration.

See the [audit-to-rule catalog and diagnostic snapshot](../../../docs/architecture/EFFECT_V4_LINT_ENFORCEMENT.md)
for the original rule counts, primary audit mappings, and intentionally non-static guarantees.

## Run from the app workspace

```sh
# Validate the implementation, independent of existing application violations.
pnpm typecheck:lint-rules
pnpm test:lint-rules

# All production lint policies, including scripts; violations exit nonzero.
pnpm lint

# Only the Effect-native policies, with exactly the production rule settings.
pnpm lint:effect
pnpm lint:effect --json

# One rule's fixtures while developing it.
RULE=no-nested-effect-run pnpm exec rstest --project lint-rules tools/oxlint/effect-native/tests/fixtures.test.mts

# Development probe: uses FIXTURE options, which may differ from production.
node tools/oxlint/effect-native/tests/run-on-repo.mts no-nested-effect-run
```

`pnpm check` runs the dedicated rule typecheck and tests before linting the application. The CI
matrix also runs them independently in **Effect Rule Implementation**, so expected application
lint failures do not prevent verification of the detectors. Existing application violations intentionally make `pnpm lint`, `pnpm lint:effect`, and therefore `pnpm check`
fail. Do not confuse those diagnostics with a failing rule test or a plugin crash. No new dependency
or Effect test harness is installed by this change.

Both reporting commands scan `apps verticals packages scripts`. In report totals, test filenames
and test directories take precedence over `scripts/`; nested workspace scripts count as scripts.
The categories are disjoint. Counts are **diagnostics, not unique audit findings**: multiple rules
can identify different concerns at one location. `--json` includes every diagnostic and file count;
the text view explicitly limits the top-file list to 20.

## Policy boundaries

Rules use AST, import identity, lexical scopes, and explicit path/option policies. They do not have a
TypeScript checker, even though the workspace retains `typeAware`, `typeCheck`, and `denyWarnings`
for its other lint rules. Each rule's source documents its audit mapping, default scope, options,
exceptions, and limitations. Configured re-export barrels are explicit trust assumptions, not
cross-file resolution.

The audit records the original findings; focused architecture documents own current behavior.
Preserve forced outer process/framework Promise adapters, correct
Drizzle JSONB and HttpApi encoding, external test-body JSON serialization, deliberate malformed
rejection fixtures, legitimate `as const`/`satisfies`, line-preserving `.env` editing, native collection
operations, and correctly scoped fibers. Startup `Layer.orDie` requires the deliberate outer seam
and typed-cause logging; it is not a blanket library escape hatch. Operational success output is not
an observability failure.

Some checks are **review heuristics**, not semantic proofs. In particular, adjacent yields without
lexical data dependencies do not prove safe concurrency, local timeout proximity does not prove a
whole-program deadline, and identifiers/schema names cannot establish complete business semantics.
Never mechanically parallelize effects or change wire formats just to silence a diagnostic. Prefer
an audit-grounded detector correction for false positives; use a narrow, justified rule option for a
real architectural exception. Do not hide existing debt with blanket disables or zero-count
"invalid" fixtures.

These rules cannot prove runtime context propagation, tracer/exporter connectivity, redaction of
all secrets, business ordering, complete schema equivalence, cross-process ownership, or exhaustive
cross-file vocabulary reuse. Runtime/integration/property tests and architecture review still own
those guarantees. The audit's 145 clusters are not 145 syntactically decidable checks.

## Implementation layout

- `rules/<name>.ts`: `export const rule = defineRule({...})`; metadata must be diagnostic-only.
- `index.ts`: explicit production exports, never test-only auto-discovery.
- `shared/`: import/path helpers and test-only module discovery.
- `report.config.ts`: selects exactly the root configuration's Effect-native settings.
- `report.mts`: combined production-policy diagnostic report; never runs `--fix`.
- `tsconfig.json`: strict, no-emit tooling typecheck; intentionally invalid fixtures are excluded.
- `tests/fixtures/<name>/`: real Oxlint inputs, positive and negative cases, and one rule config.
- `tests/fixtures.test.mts`: actual Oxlint execution, exact positive counts where specified,
  zero negative counts, linted-file coverage, and all failures reported together.
- `tests/production-options.test.mts`: stages inputs in owned temporary workspaces outside the
  tooling/test ancestry and requires positive evidence for every rule using production settings.
  Default-config negatives are checked too; explicitly overridden option fixtures stay in their
  own suite. Set `EFFECT_NATIVE_TEST_TMPDIR` to choose a temporary root.
- `tests/paths.test.mts` and `tests/script-scope.test.mts`: verify nested script classification for
  relative, POSIX, Windows drive-letter and UNC paths, plus real Oxlint default/opt-in behavior for
  timer, dependency-parameter and factory-signature rules in app, vertical and package scripts.
- `tests/discover-rules.test.mts`: verifies isolated discovery and file-URL imports, including a
  real ESM load from a path containing spaces, URL delimiters and Unicode. Path-string coverage
  does not substitute for a native Windows run of the full harness.
- `tests/temporary-workspace.test.mts`: verifies cleanup after success and early/partial failures,
  preserving the original error and caller-owned files.
- `tests/registration.test.mts`: imports the actual plugin/config and checks exports, error severity,
  fixture coverage, preserved typed lint options, and absence of fixer/suggestion metadata.
- `tests/oxlint.test.mts`: regression coverage for loader failures, malformed JSON/diagnostics,
  inconsistent exits, empty-file runs, and stderr failures.
- `tests/launcher.test.mts`: observes a real lint process to require Node plus Oxlint's JavaScript
  entry point rather than platform-specific package-manager shims, and checks that the explicitly
  opt-in `lint:fix` command covers the same directories as reporting-only `lint`.

Each fixture configuration enables only its owned rule. The child process selects that one module
so an unfinished sibling cannot conceal its test results; the separate production registration gate
still imports **all** modules. A missing module, failed worker, or stale earlier pass is never a
successful verification. Formatting/linting intentionally exclude fixture source so adversarial
syntax and positions remain stable.

Use Node 26's direct TypeScript execution: sibling imports include `.ts`/`.mts`, and runtime enums,
parameter properties, or other transform-required syntax are not supported. Fixture paths should
mirror production ownership paths rather than enabling an entire repository through test-only
options. Additional option tests must be identified as such.

Fixture config template:

```json
{
  "jsPlugins": [{ "name": "effect-native", "specifier": "../../fixture-plugin.ts" }],
  "categories": { "correctness": "off" },
  "rules": { "effect-native/<name>": "error" }
}
```

Place examples under `invalid/` and `valid/`; `// expect-count: N` at the start of a positive fixture
pins its positive diagnostic count. False-positive repairs need negative regressions. Preserve
existing test evidence unless its expectation conflicts with the audit, and explain such corrections.

## Native interface and operator policy

`no-promise-shaped-port` covers application packages, scripts, tests, and TSX. Owned interfaces
return Effect, including generic aliases, overloads, and callback parameters. Real SDK and test
runner callbacks keep their required Promise boundary. Private helpers qualify only when lexical
references establish that boundary; an exported Promise helper remains an owned interface.

`repository-policy.config.ts` checks all repository source for `instanceof` and manual `_tag`
comparisons, switches, and assertions. Negative lint fixtures are excluded because they deliberately
contain forbidden syntax. Use Schema, native predicates, and Effect failure combinators to inspect
values; full serialized-object assertions and diagnostic tag output remain valid.

## Test runtime policy

`no-effect-run-in-tests` rejects references, calls, imports, re-exports, and dynamic imports of
`Effect.run*` inside tests, including test support and harness directories. Use `it.effect`,
`it.live`, and `it.layer` from `@app/effect-rstest` so the runner owns services, scopes,
test time, and configuration. There is no harness-path allowlist: the runner implementation in
`packages/effect-rstest/src/**` is already outside test-file scope. That vendored upstream port is
ignored by workspace lint; `packages/effect-rstest/tests/**` remains linted.

Playwright/e2e adapters remain exempt through `ignorePaths`. Type-only imports, non-Effect
bindings, and ManagedRuntime instance methods are not Effect root-function violations. Nested
Effect re-entry is diagnosed by `no-nested-effect-run`. Additional rule options are `testPaths`,
`effectModules`, and `effectModuleSources`; there is no fixer or suggestion.

The workspace import policy rejects `node:test`, `node:assert`, `node:assert/strict`,
`@rstest/core`, and the retired `@app/core-runtime/testing/effect-runtime` in application,
package, vertical, script, and tooling tests, with `tests/e2e/**` exempt for Playwright.
Test files disable Sonar's hard-coded runner detector and the async-Promise-function rule because
Effect-native test APIs and `Effect.promise`/`Effect.tryPromise` thunks are intentional.
