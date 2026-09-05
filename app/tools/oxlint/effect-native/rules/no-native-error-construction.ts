/**
 * effect-native/no-native-error-construction
 *
 * Audit findings enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *
 *   - **A4** "Rebuild the error system around typed channels and contract-owned Problem Details" —
 *     the audit records "roughly 113 manual `_tag` comparisons, numerous blanket `mapError`
 *     collapses, duplicated endpoint Problem schemas, and approximately 20 local defect-to-500
 *     seams", with the stated target "Define each expected failure as `Schema.TaggedError`" and
 *     "Keep unexpected defects in `Cause` until one outer HTTP seam converts them into a sanitized
 *     typed internal problem". A `new Error("...")` is the exact opposite: an untyped, unserialisable
 *     value with no `_tag`, no Schema, no endpoint declaration and no RFC 9457 payload. Thrown, it
 *     leaves the typed `E` channel entirely and lands in the defect channel; caught, the only thing a
 *     caller can do with it is re-read its `message` string.
 *
 *   - **A5** "Introduce an Effect-shaped persistence seam and typed database failures" — "PostgreSQL
 *     failures are either walked manually through unknown `.cause` chains or collapsed into generic
 *     retryable 503 errors", and the target is "a Core-owned database failure taxonomy and one
 *     decoder". Native `Error`/`TypeError` construction at repository and transaction seams is what
 *     forces those `.cause` walks and `instanceof Error` narrowing in the first place.
 *
 *     Concrete evidence the rule exists for (all still present at the time of writing):
 *       - `packages/core-runtime/src/actions/repository.ts:98` — `throw new TypeError('Action
 *         payloads must not contain cyclic values')` inside the canonicalisation walker.
 *       - `packages/core-runtime/src/actions/repository.ts:360` — `throw new Error('A non-idempotent
 *         invocation insert unexpectedly conflicted')`, an uncertain-commit invariant that never
 *         reaches the caller as a typed reason.
 *       - `apps/shell-super-app/api/modules/deployment-allowlist.ts:36..122` — eleven
 *         `throw new TypeError(...)` calls doing by hand what one `Schema` decode does typed (also A7).
 *       - `apps/shell-super-app/api/auth/config.ts:52..65` and
 *         `apps/shell-super-app/api/auth/gateway-issuer-config.ts:59..104` — configuration and JWK
 *         validation throwing untyped `Error`s (also A3).
 *       - `packages/core-runtime/src/install/stage-context-bootstrap.ts:430` — `cause instanceof
 *         Error`, structural re-narrowing of a value that should already be a tagged failure.
 *
 * ## What is detected
 *
 * Four shapes, each reported on the node that constructs or inspects the native error — never on the
 * enclosing `throw`/`if` statement, so this rule composes with (and does not double-report against)
 * the throw-oriented rules such as `no-throw-in-configuration-parser`.
 *
 *   1. `nativeErrorConstruction` — `new Error(...)`, `new TypeError(...)`, and the rest of
 *      `errorConstructors`, where the callee is the **unshadowed global**. Also matches the global
 *      reached through a container (`new globalThis.Error(...)`, `new window["TypeError"](...)`),
 *      through parentheses/`as` casts, and with type arguments.
 *   2. `nativeErrorCall` — the same constructors invoked without `new` (`throw Error("boom")`,
 *      `TypeError("boom")`), which produces an identical untyped value.
 *   3. `nativeErrorSubclass` — `class DatabaseError extends Error {}` (or `extends AggregateError`,
 *      `extends globalThis.TypeError`, …). A hand-rolled error hierarchy is a second, competing
 *      error authority beside the contract's `Schema.TaggedError`s: it has no encoded form, so it
 *      cannot cross the HttpApi boundary, and callers must discriminate it with `instanceof` instead
 *      of `Effect.catchTag`.
 *   4. `nativeErrorInstanceof` — `value instanceof Error` (and the rest of the list). Structural
 *      re-narrowing of a failure the type system should already have discriminated; the audit's A4
 *      target is `Effect.catchTag`/`Effect.catchTags` and exhaustive `Match` over a tagged union.
 *   5. `captureStackTrace` — `Error.captureStackTrace(...)` (called or referenced, static or
 *      computed key). Hand-managed V8 stack surgery only exists to make a hand-rolled error class
 *      presentable; `Cause` already carries the stack, and `Schema.TaggedError` already carries the
 *      structured fields.
 *
 * Every shape resolves its identifier through the scope chain first: a local binding, parameter,
 * import, class or catch-clause parameter named `Error` is **not** the global and is never reported.
 *
 * ## What is deliberately allowed
 *
 *   - **Every audit-blessed pattern in "Existing patterns to preserve" and D tier.** None of them
 *     construct or inspect a native error: the single outer process/framework `Effect.runPromise`
 *     adapter seam, `Layer.orDie` at a deliberate startup root, correct Drizzle JSONB and HttpApi
 *     serialization, `JSON.stringify` in external test-fixture APIs, deliberately malformed casts in
 *     tests, and native array/object operations with no semantic gain are all untouched by
 *     construction. The Effect-native replacements — `Schema.TaggedError`, `Effect.fail`,
 *     `Effect.die`, `Cause.die`, `Effect.catchTag(s)`, `Match` — contain no `new Error`.
 *   - **Any shadowed or injected binding.** `const Error = MyDomainError`, `function f(Error: Ctor)`,
 *     `import { TypeError } from "./fixtures.ts"`, `catch (Error) {}`, `class Error {}` — the scope
 *     chain is walked and any definition at all disqualifies the match. Aliases and namespace
 *     imports of `effect` submodules therefore never collide with this rule: `Schema.TaggedError`,
 *     `Data.TaggedError`, `Cause.UnknownError` and friends are member expressions on an imported
 *     namespace, not the global constructor.
 *   - **Tests** (`includeTests: false` by default). D tier blesses "deliberately malformed casts in
 *     tests proving rejection behavior", and B2 records that the Effect test harness does not exist
 *     yet, so test doubles legitimately synthesise rejection values (`Effect.die(new Error(...))` in
 *     `apps/shell-super-app/tests/**`). Flip `includeTests: true` once B2's `itEffect`/`itLayer`
 *     harness lands.
 *   - **Scripts, `tools/`, build output and declaration files** (`ignore` globs). A8 says scripts
 *     must be brought under gates as part of its own workstream ("Bring `scripts/` and
 *     `tools/oxlint` under explicit TypeScript and anti-slop gates"), and B3 explicitly keeps "one
 *     small process-exit adapter at the executable edge"; this rule does not pre-empt that work.
 *   - **Framework configuration files** (`ignoreConfigFiles: true` by default): known Modern.js/Rspack/Drizzle and test/build-host config basenames, not arbitrary `*.config.ts` /
 *     `*.config.mts` such as `apps/shell-super-app/modern.config.ts`,
 *     `drizzle.config.ts` run
 *     inside Modern.js/Rspack/Drizzle build hosts that have no Effect runtime and treat a thrown
 *     `Error` as their build-failure protocol. A7 targets the *Schemas* those files decode through,
 *     not the throw at the build-tool boundary.
 *   - **Type positions.** `catch (error: unknown)`, `error: Error` annotations, `extends Error` on an
 *     `interface`, `typeof Error` and `Error["prototype"]` type queries parse as TS type nodes, not
 *     as `NewExpression`/`Class.superClass`/`instanceof`, so they never reach the visitors.
 *
 * `falsePositiveRisks` note from the rule spec: definition-time validators such as
 * `packages/core-runtime/src/modules/manifest.ts` are flagged **deliberately**. They are exactly the
 * "hundreds of overlapping hand-authored shapes" A2 and A7 call out; a manifest is a document that
 * should be decoded through a Schema, and its rejections should be typed decode failures.
 *
 * Scope lives in the rule (`include` defaults to `apps/**`, `verticals/**`, `packages/**`), so
 * `oxlint.config.ts` only needs `'effect-native/no-native-error-construction': 'error'`.
 *
 * Report-only: no fixers, no suggestions.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { bindingsFor } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the production defaults instead of forcing the fixture
 * config to loosen options (`run-on-repo.mts` reuses that same config against the real repository).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

/** Globals through which the ambient error constructors can be reached as a property. */
const CONTAINER_GLOBALS = new Set(['globalThis', 'global', 'window', 'self', 'frames']);

/** Framework/build configuration files: a thrown `Error` is the build host's failure protocol. */
const CONFIG_FILE =
  /(?:^|\/)(?:modern|rspack|drizzle(?:\.[^/]+)?|playwright|rstest|tailwind|module-federation|oxfmt|oxlint)\.config\.[cm]?[jt]sx?$/u;

const DEFAULT_INCLUDE: readonly string[] = ['apps/**', 'verticals/**', 'packages/**'];

/**
 * A8 owns bringing `scripts/` and `tools/` under gates; `dist`/`build`/`.d.ts` are not authored code.
 * The scripts glob also covers app-local script folders such as `apps/shell-super-app/scripts/`.
 */
const DEFAULT_IGNORE: readonly string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/generated/**',
  '**/scripts/**',
  'tools/**',
  '**/*.d.ts',
];

const DEFAULT_ERROR_CONSTRUCTORS: readonly string[] = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
];

interface RuleOptions {
  readonly errorConstructors: readonly string[];
  readonly ignore: readonly string[];
  readonly ignoreConfigFiles: boolean;
  readonly include: readonly string[];
  readonly includeTests: boolean;
  readonly requireEffectImport: boolean;
}

const DEFAULTS: RuleOptions = {
  errorConstructors: DEFAULT_ERROR_CONSTRUCTORS,
  ignore: DEFAULT_IGNORE,
  ignoreConfigFiles: true,
  include: DEFAULT_INCLUDE,
  includeTests: false,
  requireEffectImport: false,
};

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Partial<Record<keyof RuleOptions, unknown>>;
  const include = stringList(given.include, DEFAULTS.include);
  const constructors = stringList(given.errorConstructors, DEFAULTS.errorConstructors);
  return {
    errorConstructors: constructors.length > 0 ? constructors : DEFAULTS.errorConstructors,
    ignore: stringList(given.ignore, DEFAULTS.ignore),
    ignoreConfigFiles: boolean(given.ignoreConfigFiles, DEFAULTS.ignoreConfigFiles),
    include: include.length > 0 ? include : DEFAULTS.include,
    includeTests: boolean(given.includeTests, DEFAULTS.includeTests),
    requireEffectImport: boolean(given.requireEffectImport, DEFAULTS.requireEffectImport),
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Wrappers that do not change which value an expression evaluates to. */
const TRANSPARENT_WRAPPERS = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!TRANSPARENT_WRAPPERS.has(current.type)) return current;
    const inner = (current as { expression?: AnyNode }).expression;
    if (inner === undefined) return current;
    current = inner;
  }
  return current;
}

/** `Error.captureStackTrace` / `Error["captureStackTrace"]` → the string; a dynamic key → `null`. */
function staticPropertyName(node: ESTree.MemberExpression): string | null {
  const property = node.property as AnyNode;
  if (!node.computed)
    return property.type === 'Identifier' ? (property as ESTree.IdentifierName).name : null;
  if (property.type === 'TemplateLiteral' && property.expressions.length === 0)
    return property.quasis[0]?.value.cooked ?? null;
  if (property.type !== 'Literal') return null;
  const value = (property as { value?: unknown }).value;
  return typeof value === 'string' ? value : null;
}

function resolveVariable(context: Context, name: string, from: AnyNode): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(from);
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (
      variable !== undefined &&
      variable.defs.some(
        (def) =>
          !['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSTypeParameter'].includes(
            def.node.type,
          ),
      )
    )
      return variable;
    scope = scope.upper;
  }
  return null;
}

/** `true` when `node` is the ambient global `name` — not a local, parameter, class or import. */
function isUnshadowedGlobal(context: Context, node: AnyNode, name: string): boolean {
  if (node.type !== 'Identifier') return false;
  if ((node as ESTree.IdentifierReference).name !== name) return false;
  const variable = resolveVariable(context, name, node);
  return variable === null || variable.defs.length === 0;
}

/** Effect-native rule: failures are `Schema.TaggedError` values, never native `Error` objects. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A4/A5: native `Error`/`TypeError`/… construction, `extends Error` hierarchies, `instanceof Error` narrowing and `Error.captureStackTrace` build untyped, unserialisable failures that escape the Effect error channel into the defect channel. Model expected failures as `Schema.TaggedError` + `Effect.fail`, invariants as typed defects via `Effect.die`/`Cause.die`, and decode manifests, topology documents and configuration through `Schema` instead of throwing. Runtime globals and immutable local aliases are resolved syntactically; dynamic construction and cross-module aliases remain unknown.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#a4-rebuild-the-error-system-around-typed-channels-and-contract-owned-problem-details',
    },
    messages: {
      nativeErrorConstruction:
        'Audit A4/A5: native `new {{name}}(…)` in Effect application code produces an untyped, unserialisable failure with no `_tag`, no Schema and no endpoint declaration — thrown, it leaves the typed `E` channel and lands in the defect channel. Model an expected failure as `class SomethingError extends Schema.TaggedError<SomethingError>()("SomethingError", { … }) {}` returned via `Effect.fail`, an invariant as a typed defect via `Effect.die`/`Cause.die`, and a malformed document or configuration value as a `Schema` decode failure instead of a throw.',
      nativeErrorCall:
        'Audit A4/A5: `{{name}}(…)` called without `new` still produces a native `{{name}}` — an untyped, unserialisable failure outside the Effect error channel. Return a `Schema.TaggedError` through `Effect.fail`, or `Effect.die` for an invariant, so the failure has a `_tag`, an encoded form and a declared place on the HttpApi contract.',
      nativeErrorSubclass:
        "Audit A4/A5: `class … extends {{name}}` creates a second error authority beside the contract's tagged failures — it has no encoded form, so it cannot cross the HttpApi boundary, and callers must discriminate it with `instanceof` instead of `Effect.catchTag`. Declare it as `Schema.TaggedError` (or `Data.TaggedError` for a purely internal defect) and register it on the owning endpoint so the RFC 9457 payload and HTTP status derive from the contract.",
      nativeErrorInstanceof:
        'Audit A4/A5: `instanceof {{name}}` re-narrows a failure structurally, which the audit records as the reason unknown `.cause` chains get walked by hand and distinct causes collapse into one generic 503. Discriminate the typed failure union instead — `Effect.catchTag`/`Effect.catchTags` or an exhaustive `Match` over the `_tag` — and keep genuinely unexpected values in `Cause` until the single outer HTTP seam sanitises them.',
      captureStackTrace:
        'Audit A4/A5: `Error.captureStackTrace` is V8 stack surgery that only exists to make a hand-rolled error class presentable. `Cause` already carries the stack and the interruption/defect distinction, and `Schema.TaggedError` already carries the structured fields — drop the hand-built class and let `Cause` own the trace.',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          errorConstructors: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Global constructor names treated as native errors (default: Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError, AggregateError).',
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs excluded from the rule (default: node_modules, dist, build, .next, generated, **/scripts/**, tools/**, *.d.ts — A8 owns bringing scripts and tools under gates).',
          },
          ignoreConfigFiles: {
            type: 'boolean',
            description:
              "Skip known build/framework config basenames (modern, rspack, drizzle, playwright, rstest, tailwind, module-federation, oxfmt, oxlint), not arbitrary *.config files, where a thrown Error is the build host's failure protocol (default: true).",
          },
          include: {
            type: 'array',
            items: { type: 'string' },
            description: 'Globs the rule applies to (default: apps/**, verticals/**, packages/**).',
          },
          includeTests: {
            type: 'boolean',
            description:
              "Also check test files (default: false — D tier blesses deliberately malformed values in tests and B2's Effect test harness does not exist yet).",
          },
          requireEffectImport: {
            type: 'boolean',
            description:
              'Only report in files that import from `effect`/`effect/*` (default: false — a file with no Effect import is exactly where the escape hatch hides).',
          },
        },
      },
    ],
    defaultOptions: [
      {
        errorConstructors: [...DEFAULT_ERROR_CONSTRUCTORS],
        ignore: [...DEFAULT_IGNORE],
        ignoreConfigFiles: true,
        include: [...DEFAULT_INCLUDE],
        includeTests: false,
        requireEffectImport: false,
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.include)) return {};
    if (matchesGlobs(path, options.ignore)) return {};
    if (!options.includeTests && isTestFile(path)) return {};
    if (options.ignoreConfigFiles && CONFIG_FILE.test(path)) return {};
    if (options.requireEffectImport && !bindingsFor(context).importsEffect) return {};

    const constructors = new Set(options.errorConstructors);

    const report = (node: AnyNode, messageId: string, name: string): void => {
      context.report({ node, messageId, data: { name } });
    };

    /**
     * The native error constructor an expression evaluates to, or `null`.
     * Accepts the bare unshadowed global and the same global reached through a container global
     * (`globalThis.Error`, `window["TypeError"]`), through parens, `as` casts and optional chains.
     */
    const nativeErrorName = (node: AnyNode, depth = 0): string | null => {
      if (depth > 24) return null;
      const inner = unwrap(node);
      if (inner.type === 'Identifier') {
        const name = (inner as ESTree.IdentifierReference).name;
        if (constructors.has(name) && isUnshadowedGlobal(context, inner, name)) return name;
        const variable = resolveVariable(context, name, inner);
        if (
          !variable ||
          variable.defs.length !== 1 ||
          variable.references.some((r) => r.isWrite() && !r.init)
        )
          return null;
        const declaration = variable.defs[0]?.node;
        if (
          declaration?.type !== 'VariableDeclarator' ||
          !declaration.init ||
          declaration.parent?.type !== 'VariableDeclaration' ||
          declaration.parent.kind !== 'const'
        )
          return null;
        if (declaration.id.type === 'Identifier')
          return nativeErrorName(declaration.init, depth + 1);
        const container = unwrap(declaration.init);
        if (
          container.type !== 'Identifier' ||
          !CONTAINER_GLOBALS.has(container.name) ||
          !isUnshadowedGlobal(context, container, container.name) ||
          declaration.id.type !== 'ObjectPattern'
        )
          return null;
        for (const property of declaration.id.properties) {
          if (
            property.type !== 'Property' ||
            property.value.type !== 'Identifier' ||
            property.value.name !== name
          )
            continue;
          const key =
            !property.computed && property.key.type === 'Identifier'
              ? property.key.name
              : property.key.type === 'Literal'
                ? property.key.value
                : property.key.type === 'TemplateLiteral' && property.key.expressions.length === 0
                  ? property.key.quasis[0]?.value.cooked
                  : null;
          if (typeof key === 'string' && constructors.has(key)) return key;
        }
        return null;
      }
      if (inner.type !== 'MemberExpression') return null;
      const member = inner as ESTree.MemberExpression;
      const name = staticPropertyName(member);
      if (name === null || !constructors.has(name)) return null;
      const container = unwrap(member.object as AnyNode);
      if (container.type !== 'Identifier') return null;
      const containerName = (container as ESTree.IdentifierReference).name;
      if (!CONTAINER_GLOBALS.has(containerName)) return null;
      return isUnshadowedGlobal(context, container, containerName) ? name : null;
    };

    return {
      // `new Error(...)`, `new TypeError(...)`, `new globalThis.RangeError(...)`.
      NewExpression(node) {
        const name = nativeErrorName(node.callee as AnyNode);
        if (name === null) return;
        report(node as unknown as AnyNode, 'nativeErrorConstruction', name);
      },

      // `throw Error("boom")` / `TypeError("boom")` — identical value, no `new`.
      CallExpression(node) {
        const name = nativeErrorName(node.callee as AnyNode);
        if (name === null) return;
        report(node as unknown as AnyNode, 'nativeErrorCall', name);
      },

      // `class DatabaseError extends Error {}`.
      ClassDeclaration(node) {
        if (node.declare) return;
        const superClass = node.superClass as AnyNode | null;
        if (superClass === null) return;
        const name = nativeErrorName(superClass);
        if (name === null) return;
        report(superClass, 'nativeErrorSubclass', name);
      },
      ClassExpression(node) {
        const superClass = node.superClass as AnyNode | null;
        if (superClass === null) return;
        const name = nativeErrorName(superClass);
        if (name === null) return;
        report(superClass, 'nativeErrorSubclass', name);
      },

      // `cause instanceof Error`.
      BinaryExpression(node) {
        if (node.operator !== 'instanceof') return;
        const name = nativeErrorName(node.right as AnyNode);
        if (name === null) return;
        report(node as unknown as AnyNode, 'nativeErrorInstanceof', name);
      },

      // `Error.captureStackTrace(self, Ctor)` — called or referenced point-free.
      MemberExpression(node) {
        if (staticPropertyName(node) !== 'captureStackTrace') return;
        if (nativeErrorName(node.object as AnyNode) === null) return;
        report(node as unknown as AnyNode, 'captureStackTrace', 'Error');
      },
    };
  },
});
