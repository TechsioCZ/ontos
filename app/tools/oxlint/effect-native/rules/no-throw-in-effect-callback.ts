/**
 * effect-native/no-throw-in-effect-callback
 *
 * Audit findings enforced (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`):
 *
 *   - **S1** "Eliminate the Effect–Promise–Effect transaction sandwich" — the Action and Read
 *     runtimes leave Effect to enter a Drizzle Promise transaction and then signal rollback by
 *     *throwing a private sentinel object* out of the Promise callback:
 *       - `packages/core-runtime/src/actions/runtime.ts:233,844,852,859,867,873` —
 *         `throw new ActionRollbackSignal(rollbackToken, Cause.fail(...))`, later recovered with
 *         `value instanceof ActionRollbackSignal && value.matches(rollbackToken)`.
 *       - `packages/core-runtime/src/reads/runtime.ts:97,107,109,493,…,620` —
 *         `throw new ReadRollback(...)`.
 *     S1 names these "private throw-based rollback sentinels" and asks for one Core-owned
 *     transaction bridge that "carr[ies] typed failures in `E` and defects/interruption in `Cause`".
 *
 *   - **A4** "Rebuild the error system around typed channels and contract-owned Problem Details" —
 *     a `throw` introduces an untyped exception path. `Effect.try` / `Effect.tryPromise` can capture
 *     the value with their catch mapper; other callbacks may produce defects. Lexical containment
 *     alone proves neither execution nor loss of typed failure identity or span coverage.
 *     A4's target is explicit: "Preserve original failures or causes when translating between
 *     layers" and "Keep unexpected defects in `Cause` until one outer HTTP seam converts them".
 *
 * This rule merges the separately proposed `no-throw-sentinel-in-effect-callback` as the
 * `throwSentinel` message variant rather than shipping two overlapping rules.
 *
 * ## What is detected
 *
 * Every `ThrowStatement` that is lexically inside an **Effect combinator callback**.
 *
 * `isInsideEffectCallback(throwStatement)`:
 *   1. Find the nearest enclosing function `F` (arrow, function expression, function declaration,
 *      generator, method — `Effect.gen(function* () {…})` included).
 *   2. From `F`, climb the wrappers that never change "which argument of which call this is" —
 *      `Property` → `ObjectExpression` (the `{ try, catch }` bag), `ArrayExpression`,
 *      `SpreadElement`, `ParenthesizedExpression`, `ChainExpression`, `TSAsExpression`,
 *      `TSSatisfiesExpression`, `TSNonNullExpression`, `TSTypeAssertion`, `TSInstantiationExpression`
 *      — until a `CallExpression` `C` is reached with the chain top among `C.arguments`.
 *   3. If `C`'s callee is an Effect namespace member (`namespaces` option), report.
 *   4. Otherwise keep climbing **transitively through outer functions**, which is what catches the
 *      real shape in `reads/runtime.ts`:
 *      `Effect.tryPromise({ try: async () => await db.transaction(async (tx) => { throw … }) })` —
 *      the inner arrow belongs to `db.transaction` (not Effect), but its *outer* arrow is the `try`
 *      property of `Effect.tryPromise`.
 *   5. Stop at `Program`.
 *
 * Effect callee recognition reuses `shared/effect-imports.ts` and additionally handles:
 *   - aliases — `import { Effect as E } from "effect"`, `E.gen(…)`;
 *   - submodule namespace imports — `import * as Effect from "effect/Effect"`;
 *   - root namespace imports — `import * as Eff from "effect"`, `Eff.Effect.gen(…)`;
 *   - direct member imports — `import { gen } from "effect/Effect"`, `gen(function* () {…})`;
 *   - computed access (`Effect["gen"]`), optional chaining (`Effect?.gen?.(…)`), and point-free
 *     `pipe(program, Effect.catchAll((error) => { … }))` (the combinator call is still the parent
 *     call of the callback);
 *   - configurable Effect re-export barrels via `effectModules`.
 *
 * The `throwSentinel` variant fires when the thrown expression (after unwrapping parens / `as` /
 * `satisfies` / `!`) is `new X(…)` or `X(…)` and `X` scope-resolves to a **module-local** binding —
 * a `ClassDeclaration`, `FunctionDeclaration`, a `VariableDeclarator`, or an import whose source
 * starts with one of `localImportPrefixes`. That is exactly `new ActionRollbackSignal(…)`,
 * `new ReadRollback(…)` and `configurationError()`; `throw new Error(…)` / `new TypeError(…)`
 * resolve to globals and get the generic message instead.
 *
 * With `mode: "effect-files"` the rule additionally reports **every** `throw` in a file that imports
 * `effect` / `effect/*` (or an `effectModules` barrel), which catches the helper-function sentinels
 * the default mode misses — `unwrapCore` in `reads/runtime.ts:94` throws `new ReadRollback(…)` from
 * a plain arrow that is only ever *called* from inside the transaction callback.
 *
 * ## What is deliberately allowed
 *
 * - `scripts/**` — operational scripts are B3 / `no-throw-in-scripts` territory, not S1/A4.
 * - Tests (`includeTests: false` by default) — the audit blesses "deliberately malformed casts in
 *   tests" and the B2 harness work is a separate migration step.
 * - Configuration parsers that throw *outside* any Effect callback — that is A3 and is owned by
 *   `no-throw-in-configuration-parser`; the default mode never reports them.
 * - Everything under the audit's "Existing patterns to preserve" and D tier: a single outer
 *   process/framework adapter seam, `Layer.orDie` at a deliberate startup root, correct Drizzle
 *   JSONB / HttpApi serialization, `JSON.stringify` in external test-fixture APIs, native array
 *   operations. None of those are `throw`s inside an Effect combinator callback.
 * - A local shadow named like an Effect namespace (`const Effect = { gen }` in scope) — the callee
 *   identifier must still resolve to an `import` binding.
 * - `throw` inside a plain (non-Effect-argument) function in default mode, `*.config.{ts,mts,mjs}`,
 *   `dist/`, `build/`, `tools/`, and anything matched by `ignore` or outside `include`.
 *
 * Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isScriptFile, isTestFile, normalisePath } from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production defaults instead of forcing the
 * fixture config to pass loosened options (which `run-on-repo.mts` reuses verbatim).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

/** S1/A4 are application-architecture findings: `scripts/**` is excluded on purpose (see B3). */
const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**'];

const DEFAULT_IGNORE = [
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  'tools/**',
  '**/*.config.ts',
  '**/*.config.mts',
  '**/*.config.mjs',
  '**/*.d.ts',
];

/**
 * Effect namespaces whose combinators take user callbacks that run *inside* a fiber. A `throw` in
 * any of them bypasses the typed failure channel of the surrounding program.
 */
const DEFAULT_NAMESPACES = [
  'Effect',
  'Layer',
  'Stream',
  'Schedule',
  'Cause',
  'Exit',
  'Option',
  'Result',
  'Match',
];

/** Import sources that make a thrown constructor "module-local" — i.e. a private sentinel. */
const DEFAULT_LOCAL_IMPORT_PREFIXES = ['./', '../', '@app/'];

/** Barrels that re-export Effect namespaces verbatim (the Modern.js BFF edge barrel). */
const DEFAULT_EFFECT_MODULES = ['@modern-js/plugin-bff/effect-edge'];

const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_SUBMODULE = /^effect\/(?:.*\/)?([A-Za-z0-9_$]+)$/u;

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** Node types that can sit between a callback and the call it is an argument of. */
const ARGUMENT_WRAPPERS = new Set([
  'ConditionalExpression',
  'LogicalExpression',
  'Property',
  'ObjectExpression',
  'ArrayExpression',
  'SpreadElement',
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
]);

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly includeTests: boolean;
  readonly mode: 'effect-callbacks' | 'effect-files';
  readonly namespaces: readonly string[];
  readonly localImportPrefixes: readonly string[];
  readonly effectModules: readonly string[];
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function readOptions(context: Context): RuleOptions {
  const raw = context.options?.[0];
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    includeTests: record.includeTests === true,
    mode: record.mode === 'effect-files' ? 'effect-files' : 'effect-callbacks',
    namespaces: stringArray(record.namespaces, DEFAULT_NAMESPACES),
    localImportPrefixes: stringArray(record.localImportPrefixes, DEFAULT_LOCAL_IMPORT_PREFIXES),
    effectModules: stringArray(record.effectModules, DEFAULT_EFFECT_MODULES),
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Strip wrappers that never change what an expression denotes. */
function unwrap(node: ESTree.Node): ESTree.Node {
  let current: ESTree.Node = node;
  for (;;) {
    if (
      current.type === 'ChainExpression' ||
      current.type === 'ParenthesizedExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSInstantiationExpression' ||
      current.type === 'TSTypeAssertion'
    ) {
      current = current.expression as ESTree.Node;
      continue;
    }
    return current;
  }
}

/** Non-computed `.name`, or computed `["name"]`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const property = unwrap(node.property);
  if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
  if (property.type === 'TemplateLiteral' && property.expressions.length === 0) {
    return property.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function lookupVariable(
  context: Context,
  identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/**
 * `true` when the identifier still resolves to an `import` binding. Unresolved names fall back to
 * `true` because the module-level import declaration already proved the binding exists; only a local
 * shadow (parameter, `const`, catch clause, …) rejects the match.
 */
function resolvesToImport(
  context: Context,
  identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
): boolean {
  const variable = lookupVariable(context, identifier);
  if (variable === null) return true;
  if (variable.defs.length === 0) return true;
  return variable.defs.some((definition) => definition.type === 'ImportBinding');
}

interface ModuleView {
  /** local identifier → Effect namespace name (`Effect`, `Layer`, …). */
  readonly namespaceLocals: ReadonlyMap<string, string>;
  /** locals bound by `import * as X from "effect"` — `X.Effect.gen(…)`. */
  readonly rootNamespaces: ReadonlySet<string>;
  /** local identifier → owning namespace, for `import { gen } from "effect/Effect"`. */
  readonly directMembers: ReadonlyMap<string, string>;
  /** whether the file imports `effect` / `effect/*` / a configured barrel at all. */
  readonly importsEffect: boolean;
}

function collectModuleView(program: ESTree.Program, options: RuleOptions): ModuleView {
  const shared = collectEffectBindings(program);
  const namespaceLocals = new Map<string, string>(shared.namespaces);
  const rootNamespaces = new Set<string>();
  const directMembers = new Map<string, string>();
  let importsEffect = shared.importsEffect;

  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    const source = statement.source.value;
    if (source === EFFECT_ROOT_MODULE) {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier') rootNamespaces.add(specifier.local.name);
      }
      continue;
    }
    const submodule = EFFECT_SUBMODULE.exec(source)?.[1];
    if (submodule !== undefined && options.namespaces.includes(submodule)) {
      // `import { gen } from "effect/Effect"` — the member is reachable without a namespace.
      for (const specifier of statement.specifiers) {
        if (specifier.type !== 'ImportSpecifier') continue;
        directMembers.set(specifier.local.name, submodule);
      }
      continue;
    }
    if (options.effectModules.includes(source)) {
      importsEffect = true;
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportSpecifier') {
          const imported =
            specifier.imported.type === 'Identifier'
              ? specifier.imported.name
              : specifier.imported.value;
          namespaceLocals.set(specifier.local.name, imported);
        } else if (specifier.type === 'ImportNamespaceSpecifier') {
          rootNamespaces.add(specifier.local.name);
        }
      }
    }
  }
  return { namespaceLocals, rootNamespaces, directMembers, importsEffect };
}

/** `Effect.gen` / `E.gen` / `Effect["gen"]` / `Eff.Effect.gen` / bare `gen` from `effect/Effect`. */
function isEffectCallee(
  context: Context,
  callee: ESTree.Node,
  view: ModuleView,
  options: RuleOptions,
): boolean {
  const target = unwrap(callee);
  if (target.type === 'CallExpression') {
    const origin = effectOrigin(context, target.callee, options.effectModules);
    return origin?.length === 2 && origin[0] === 'Effect' && origin[1] === 'fn';
  }
  const origin = effectOrigin(context, target, options.effectModules);
  if (origin?.length !== 2 || !options.namespaces.includes(origin[0]!)) return false;
  // These APIs take values/services, not callbacks; nested functions are deferred data.
  return !['succeed', 'fail', 'die', 'fromNullable', 'fromIterable'].includes(origin[1]!);
}

function parentOf(node: ESTree.Node): ESTree.Node | null {
  const parent = (node as { parent?: ESTree.Node | null }).parent;
  return parent ?? null;
}

/** Nearest enclosing function, or `null` at `Program`. */
function enclosingFunction(node: ESTree.Node): ESTree.Node | null {
  let current = parentOf(node);
  while (current !== null) {
    if (FUNCTION_TYPES.has(current.type)) return current;
    if (current.type === 'Program') return null;
    current = parentOf(current);
  }
  return null;
}

/** The `CallExpression` this node is (possibly wrapped) an argument of, or `null`. */
function argumentCall(node: ESTree.Node): ESTree.CallExpression | null {
  let current = node;
  let parent = parentOf(current);
  while (parent !== null) {
    if (parent.type === 'CallExpression') {
      const args = parent.arguments as readonly ESTree.Node[];
      return args.includes(current) ? parent : null;
    }
    if (!ARGUMENT_WRAPPERS.has(parent.type)) return null;
    if (parent.type === 'ConditionalExpression' && parent.test === current) return null;
    // A callback used as a property *key* or a shorthand method name is not an argument value.
    if (parent.type === 'Property' && (parent.value as ESTree.Node) !== current) return null;
    current = parent;
    parent = parentOf(current);
  }
  return null;
}

/**
 * Transitively: is this node lexically inside a callback passed to an Effect combinator? Nested
 * non-Effect callbacks (`db.transaction(async (tx) => …)`) keep climbing to their outer function.
 */
function isInsideEffectCallback(
  context: Context,
  node: ESTree.Node,
  view: ModuleView,
  options: RuleOptions,
): boolean {
  let cursor: ESTree.Node = node;
  for (;;) {
    const fn = enclosingFunction(cursor);
    if (fn === null) return false;
    const call = argumentCall(fn);
    if (call !== null) {
      const adapter = effectOrigin(context, call.callee, [
        'react',
        '@tanstack/react-query',
        '@tanstack/react-router',
      ]);
      if (
        adapter?.length === 1 &&
        ['useCallback', 'useMutation', 'useQuery', 'queryOptions', 'mutationOptions'].includes(
          adapter[0]!,
        )
      )
        return false;
      if (isEffectCallee(context, call.callee, view, options)) return true;
      const origin = effectOrigin(context, call.callee, options.effectModules);
      if (
        origin?.length === 2 &&
        ['succeed', 'fail', 'die', 'fromNullable', 'fromIterable'].includes(origin[1]!)
      )
        return false;
    }
    cursor = fn;
  }
}

/** The module specifier a definition came from, when the definition is an import binding. */
function importSourceOf(definition: {
  node: ESTree.Node;
  parent: ESTree.Node | null;
}): string | null {
  let current: ESTree.Node | null = definition.parent ?? definition.node;
  for (let depth = 0; current !== null && depth < 6; depth += 1) {
    if (current.type === 'ImportDeclaration') return current.source.value;
    current = parentOf(current);
  }
  return null;
}

/**
 * `new ActionRollbackSignal(token, cause)` / `configurationError()` → the sentinel name, when the
 * constructor resolves to a module-local class/function/const or a project-local import.
 * `new Error(…)` (an unresolved global) → `null`.
 */
function sentinelName(
  context: Context,
  argument: ESTree.Node,
  options: RuleOptions,
): string | null {
  const thrown = unwrap(argument);
  if (thrown.type !== 'NewExpression' && thrown.type !== 'CallExpression') return null;
  const callee = unwrap(thrown.callee as ESTree.Node);
  if (callee.type !== 'Identifier') return null;

  const variable = lookupVariable(context, callee);
  if (variable === null || variable.defs.length === 0) return null;

  for (const definition of variable.defs) {
    if (definition.type === 'ClassName' || definition.type === 'FunctionName') return callee.name;
    if (definition.type === 'Variable') return callee.name;
    if (definition.type === 'ImportBinding') {
      const source = importSourceOf(definition);
      if (
        source !== null &&
        options.localImportPrefixes.some((prefix) => source.startsWith(prefix))
      ) {
        return callee.name;
      }
    }
  }
  return null;
}

// Resolve runtime identity, not spelling. Only immutable same-file aliases are followed;
// dynamic imports, mutable rebinding and arbitrary cross-module re-exports remain unknown.
function effectOrigin(
  context: Context,
  input: ESTree.Node,
  barrels: readonly string[],
  depth = 0,
): readonly string[] | null {
  if (depth > 24) return null;
  let node = input;
  while (
    [
      'ParenthesizedExpression',
      'ChainExpression',
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'TSInstantiationExpression',
      'TSTypeAssertion',
    ].includes(node.type)
  ) {
    node = (node as { expression: ESTree.Node }).expression;
  }
  const keyOf = (key: ESTree.Node, computed: boolean): string | null => {
    if (!computed && key.type === 'Identifier') return key.name;
    if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
    if (key.type === 'TemplateLiteral' && key.expressions.length === 0)
      return key.quasis[0]?.value.cooked ?? null;
    return null;
  };
  if (node.type === 'MemberExpression') {
    const key = keyOf(node.property, node.computed);
    const base = effectOrigin(context, node.object, barrels, depth + 1);
    return base && key !== null ? [...base, key] : null;
  }
  if (node.type !== 'Identifier') return null;
  let scope: ReturnType<Context['sourceCode']['getScope']> | null =
    context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    const defs = variable?.defs.filter(
      (def) =>
        !['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSTypeParameter'].includes(
          def.node.type,
        ),
    );
    if (!variable || !defs?.length) {
      scope = scope.upper;
      continue;
    }
    if (defs.length !== 1) return null;
    const def = defs[0]!;
    if (def.type === 'ImportBinding') {
      const spec = def.node;
      const declaration = def.parent?.type === 'ImportDeclaration' ? def.parent : spec.parent;
      if (
        declaration?.type !== 'ImportDeclaration' ||
        declaration.importKind === 'type' ||
        (spec as { importKind?: string }).importKind === 'type'
      )
        return null;
      const source = declaration.source.value;
      const root = source === 'effect' || barrels.some((glob) => globToRegExp(glob).test(source));
      if (!root && !source.startsWith('effect/')) return null;
      const base = root ? [] : [source.split('/').at(-1)!];
      if (spec.type === 'ImportNamespaceSpecifier' || spec.type === 'ImportDefaultSpecifier')
        return base;
      if (spec.type !== 'ImportSpecifier') return null;
      return [
        ...base,
        spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value,
      ];
    }
    const declaration = def.node;
    if (
      declaration.type !== 'VariableDeclarator' ||
      !declaration.init ||
      declaration.parent?.type !== 'VariableDeclaration' ||
      declaration.parent.kind !== 'const'
    )
      return null;
    if (variable.references.some((reference) => reference.isWrite() && !reference.init))
      return null;
    const base = effectOrigin(context, declaration.init, barrels, depth + 1);
    if (!base) return null;
    if (declaration.id.type === 'Identifier') return base;
    if (declaration.id.type !== 'ObjectPattern') return null;
    for (const property of declaration.id.properties) {
      if (
        property.type !== 'Property' ||
        property.value.type !== 'Identifier' ||
        property.value.name !== node.name
      )
        continue;
      const key = keyOf(property.key, property.computed);
      return key === null ? null : [...base, key];
    }
    return null;
  }
  return null;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit S1 + A4: disallow `throw` inside Effect combinator callbacks (and the Drizzle transaction ' +
        'bodies nested in them), including private rollback sentinels such as `ActionRollbackSignal` and ' +
        '`ReadRollback`. Throws introduce untyped exceptions, although try/tryPromise may translate them. ' +
        'This is a lexical callback check, not execution or escape analysis. Synchronous local catches, known data-taking APIs and proven React/TanStack adapters are excluded; arbitrary framework registration, mutable aliases and helper calls remain unknown.',
    },
    messages: {
      throwInEffectCallback:
        '`throw` lexically inside an Effect callback uses an untyped exception path (audit A4 / S1); Effect.try/tryPromise may capture it, while other callbacks may produce a defect. This check does not prove execution or loss of a span. Use ' +
        '`yield* Effect.fail(new SomeTaggedError({ … }))` for expected failures, `Effect.die` for broken ' +
        'invariants, and carry rollback as a typed failure through the single Core-owned transaction bridge.',
      throwSentinel:
        'Throwing module-local `{{name}}` is a potential rollback-sentinel pattern, not a proven sentinel. Avoid exception-based control flow ' +
        '(audit S1: `ActionRollbackSignal` / `ReadRollback`). The transaction bridge should keep its body an ' +
        '`Effect<A, E, R>`, run it once at the Drizzle boundary with `Effect.runPromiseExitWith(context)`, ' +
        'and roll back on `Exit.isFailure(exit)` — carrying the typed failure in `E` and defects in `Cause` ' +
        '— instead of recovering an `instanceof {{name}}` value from a rejected promise.',
      throwInEffectFile:
        '`throw` in an Effect module (audit A4): this exception may propagate synchronously, reject a promise, ' +
        'or become a defect. File mode does not prove how this helper is called. Return a typed failure — ' +
        '`Effect.fail(new SomeTaggedError({ … }))` — or `Effect.die` for a broken invariant, so the failure ' +
        "stays visible to `catchTag`/`Match` and to the endpoint's declared error union.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          includeTests: { type: 'boolean' },
          mode: { type: 'string', enum: ['effect-callbacks', 'effect-files'] },
          namespaces: { type: 'array', items: { type: 'string' } },
          localImportPrefixes: { type: 'array', items: { type: 'string' } },
          effectModules: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: DEFAULT_INCLUDE,
        ignore: DEFAULT_IGNORE,
        includeTests: false,
        mode: 'effect-callbacks',
        namespaces: DEFAULT_NAMESPACES,
        localImportPrefixes: DEFAULT_LOCAL_IMPORT_PREFIXES,
        effectModules: DEFAULT_EFFECT_MODULES,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.include)) return {};
    if (matchesGlobs(path, options.ignore)) return {};
    // `scripts/**` throws are B3 / `no-throw-in-scripts`, never S1/A4.
    if (isScriptFile(path)) return {};
    if (!options.includeTests && isTestFile(path)) return {};

    const view = collectModuleView(context.sourceCode.ast, options);
    if (!view.importsEffect && view.rootNamespaces.size === 0 && view.directMembers.size === 0)
      return {};

    const fileMode = options.mode === 'effect-files';

    return {
      ThrowStatement(node) {
        // A synchronous local catch intercepts this throw before its callback boundary.
        let current: ESTree.Node = node;
        while (current.parent && !FUNCTION_TYPES.has(current.parent.type)) {
          const parent: ESTree.Node = current.parent;
          if (parent.type === 'TryStatement' && parent.block === current && parent.handler) return;
          current = parent;
        }
        const insideCallback = isInsideEffectCallback(context, node, view, options);
        if (!insideCallback && !fileMode) return;

        const name = sentinelName(context, node.argument as ESTree.Node, options);
        if (name !== null) {
          context.report({ node, messageId: 'throwSentinel', data: { name } });
          return;
        }
        context.report({
          node,
          messageId: insideCallback ? 'throwInEffectCallback' : 'throwInEffectFile',
        });
      },
    };
  },
});
