/**
 * effect-native/no-bare-effect-run — audit finding A1 (root composition), supporting A9 (frontend runtime).
 *
 * Detected: every *value* reference to an `Effect.run*` entry point (`runPromise`, `runPromiseExit`,
 * `runSync`, `runSyncExit`, `runFork`, `runCallback`, ...) in server/library code that is NOT lexically
 * inside an Effect-owned program. Both call sites (`Effect.runPromise(program)`) and point-free
 * references (`pipe(program, Effect.runPromise)`, `queue.map(Effect.runPromise)`,
 * `const run = Effect.runPromise`) are reported, including:
 *
 * - aliased imports (`import { Effect as E } from "effect"`);
 * - submodule namespace imports (`import * as Effect from "effect/Effect"`);
 * - whole-package namespace imports (`import * as Fx from "effect"` → `Fx.Effect.runSync(...)`);
 * - directly imported entry points (`import { runPromise } from "effect/Effect"`);
 * - namespace re-binding (`const Fx = E;`) and namespace destructuring (`const { runSync } = Effect;`);
 * - optional chaining (`Effect?.runPromise`), computed access (`Effect["runPromise"]`), template-literal
 *   computed access (``Effect[`runPromise`]``) and `as`/`satisfies`/`!`-wrapped namespaces.
 *
 * A1 blesses bare `Effect.runPromise` only at the single outer process/framework adapter seam; forced
 * Promise adapters (better-auth hooks, `apps/shell-super-app/api/auth/service.ts:231`) must capture the
 * host `ManagedRuntime` instead of starting a fresh root fiber with no Layer graph, tracer or config.
 *
 * Deliberately allowed (never reported):
 * - the adapter seam files listed in the `adapterFiles` option (D tier: Promise adapters forced by
 *   React, TanStack, Modern.js, Playwright, Drizzle and Node process entrypoints, kept at one seam).
 *   The default list is deliberately tiny — three real files — and is a blanket file exemption, so a new
 *   forced adapter must be added to the option (reviewed once, in one place) rather than disabled inline;
 * - browser code (`browserGlobs`, minus `serverGlobs`), owned by A9 / `no-scattered-browser-effect-run`;
 *   server services/db/actions under src remain governed here, matching the browser rule's exclusions;
 * - tests (`isTestFile`) and operational scripts (`isScriptFile`, including package-local
 *   `<workspace>/scripts/**` entrypoints whose single top-level run is the process-exit adapter B3 keeps);
 * - run calls nested inside Effect-owned code (`Effect.gen`, `Effect.fn`, `Effect.tryPromise({ try })`,
 *   `Effect.flatMap(...)` callbacks, `Layer.effect(...)`, ...): that deep re-entry is the S1 finding and
 *   belongs to `no-nested-effect-run`, so the two rules partition the run sites instead of double-reporting;
 * - `ManagedRuntime`/`Runtime` entry points — `runtime.runPromise(...)`, `Runtime.runPromise(handle)(p)`
 *   and their named-import form `import { runPromise } from "effect/Runtime"` — which are the prescribed
 *   A1 replacement rather than the anti-pattern;
 * - type positions: `typeof Effect.runSync`, `import type { runSync } from "effect/Effect"`, interface and
 *   type-literal members, class property/method *declaration* keys named `runSync`, and re-exports
 *   (`export { runPromise }`), none of which start a fiber.
 */
import { defineRule } from '@oxlint/plugins';

import { bindingsFor, effectMember, type EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isScriptFile, isTestFile, normalisePath } from '../shared/paths.ts';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

/** `runPromise`, `runSync`, `runFork`, `run` — but not `runtime`. */
const RUN_MEMBER = /^run(?:[A-Z]|$)/u;

const EFFECT_NAMESPACE = 'Effect';

/** Modules already tracked by `shared/effect-imports.ts`; the option only adds further sources. */
const SHARED_EFFECT_MODULE = /^effect(?:\/.*)?$/u;

/** Only these module sources bind a *bare* `run*` identifier that starts a root fiber. */
const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_SUBMODULE = 'effect/Effect';

const DEFAULT_ADAPTER_FILES: readonly string[] = [
  'apps/*/api/index.ts',
  'verticals/*/api/index.ts',
  'packages/core-runtime/src/outbox/process.ts',
];

const DEFAULT_BROWSER_GLOBS: readonly string[] = ['apps/*/src/**', 'verticals/*/src/**'];
// Mirror the browser rule's server exclusions: these are still server/library code.
const DEFAULT_SERVER_GLOBS: readonly string[] = [
  '**/src/db/**',
  '**/src/server/**',
  '**/src/services/**',
  '**/src/actions/**',
  '**/*.server.ts',
  '**/*.server.tsx',
];

const DEFAULT_EFFECT_MODULES: readonly string[] = ['effect', 'effect/**'];

/** Workspace roots a scope glob is written against. */
const WORKSPACE_MARKERS: readonly string[] = ['/apps/', '/verticals/', '/packages/', '/scripts/'];

/**
 * Absolute filename → the workspace-relative path the scope globs are written against.
 *
 * The *first* marker after the repository root wins, so `apps/shell-super-app/api/verticals/x.ts`
 * stays an `apps/**` file instead of collapsing to `verticals/x.ts` and silently matching the
 * `verticals/*​/api/index.ts` adapter glob. `/tools/` is deliberately not a marker: the plugin's own
 * fixtures live under `tools/oxlint/effect-native/tests/fixtures/<rule>/{invalid,valid}/apps/...` and
 * must classify as the workspace location they simulate.
 */
function workspacePath(filename: string): string {
  const unified = filename.replaceAll('\\', '/');
  let best = -1;
  for (const marker of WORKSPACE_MARKERS) {
    const at = unified.indexOf(marker);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  if (best !== -1) return unified.slice(best + 1);
  for (const marker of WORKSPACE_MARKERS) {
    const bare = marker.slice(1);
    if (unified.startsWith(bare)) return unified;
  }
  return normalisePath(unified);
}

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function;

interface RuleOptions {
  readonly adapterFiles: readonly string[];
  readonly browserGlobs: readonly string[];
  readonly serverGlobs: readonly string[];
  readonly effectModules: readonly string[];
}

function readGlobs(option: unknown, key: string, fallback: readonly string[]): readonly string[] {
  if (typeof option !== 'object' || option === null || Array.isArray(option)) return fallback;
  const value = (option as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return fallback;
  const globs = value.filter((entry): entry is string => typeof entry === 'string');
  return globs.length === 0 ? fallback : globs;
}

function readOptions(context: Context): RuleOptions {
  const option: unknown = context.options?.[0];
  return {
    adapterFiles: readGlobs(option, 'adapterFiles', DEFAULT_ADAPTER_FILES),
    browserGlobs: readGlobs(option, 'browserGlobs', DEFAULT_BROWSER_GLOBS),
    serverGlobs: readGlobs(option, 'serverGlobs', DEFAULT_SERVER_GLOBS),
    effectModules: readGlobs(option, 'effectModules', DEFAULT_EFFECT_MODULES),
  };
}

/** Match a workspace-relative path against globs directly (never re-normalising an already relative path). */
function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/**
 * Local bindings that can start a root fiber, tracked precisely enough to survive aliasing,
 * destructuring, re-binding and type-only imports.
 */
interface RunBindings {
  /** local name → declaring identifier node, for locals bound to the `Effect` namespace object. */
  readonly effectNamespaces: Map<string, ESTree.Node>;
  /** local name → declaring identifier node, for `import * as Fx from "effect"` package namespaces. */
  readonly packageNamespaces: Map<string, ESTree.Node>;
  /** local name → `{ member, declaration }` for bare run entry points (`import { runPromise }`, destructuring). */
  readonly runLocals: Map<string, { member: string; declaration: ESTree.Node }>;
  /** local name → imported name for value imports from `effect/Effect` (used for ownership detection). */
  readonly effectSubmoduleImports: Map<string, string>;
  /** Whether anything at all is tracked; when false the visitors bail immediately. */
  readonly tracked: boolean;
}

function isNode(value: unknown): value is ESTree.Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/** Depth-first walk over the AST, skipping the circular `parent` links. */
function walk(node: ESTree.Node, visit: (node: ESTree.Node) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value: unknown = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const entry of value) if (isNode(entry)) walk(entry, visit);
    } else if (isNode(value)) walk(value, visit);
  }
}

/** TS nodes that still contain runtime expressions; every other `TS*` ancestor means a type position. */
const TS_EXPRESSION_NODES = new Set<string>([
  'TSAsExpression',
  'TSInstantiationExpression',
  'TSModuleBlock',
  'TSModuleDeclaration',
  'TSNonNullExpression',
  'TSParameterProperty',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
]);

/** Strip parentheses and expression-level TS wrappers so `(Effect as typeof Effect).runSync` is still seen. */
function unwrapExpression(node: ESTree.Node): ESTree.Node {
  let current = node;
  for (;;) {
    if (
      current.type === 'ParenthesizedExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSInstantiationExpression' ||
      current.type === 'TSTypeAssertion'
    ) {
      const inner: unknown = (current as unknown as Record<string, unknown>)['expression'];
      if (!isNode(inner)) return current;
      current = inner;
      continue;
    }
    return current;
  }
}

/** True when the node only ever appears in an erased type position (`typeof X`, interface member, ...). */
function isInTypePosition(node: ESTree.Node): boolean {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== 'Program') {
    if (current.type.startsWith('TS') && !TS_EXPRESSION_NODES.has(current.type)) return true;
    current = current.parent;
  }
  return false;
}

function staticName(key: ESTree.Node, computed: boolean): string | null {
  if (!computed) {
    if (key.type === 'Identifier') return key.name;
    if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
    return null;
  }
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0 && key.quasis.length === 1) {
    const quasi = key.quasis[0];
    return quasi === undefined ? null : (quasi.value.cooked ?? quasi.value.raw);
  }
  return null;
}

function importedName(specifier: ESTree.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : specifier.imported.value;
}

/**
 * Collect every local that can reach an `Effect.run*` entry point.
 *
 * Type-only imports are skipped (they are erased, so no reference can start a fiber), and a bare
 * `run*` named import only counts when it comes from `effect` / `effect/Effect` — `runPromise` imported
 * from `effect/Runtime` or `effect/ManagedRuntime` is the prescribed A1 replacement, not the smell.
 */
function collectRunBindings(context: Context, effectModules: readonly string[]): RunBindings {
  const effectNamespaces = new Map<string, ESTree.Node>();
  const packageNamespaces = new Map<string, ESTree.Node>();
  const runLocals = new Map<string, { member: string; declaration: ESTree.Node }>();
  const effectSubmoduleImports = new Map<string, string>();
  const extraMatchers = effectModules
    .filter((module) => !SHARED_EFFECT_MODULE.test(module))
    .map((module) => globToRegExp(module));

  const ast = context.sourceCode.ast;
  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (statement.importKind === 'type') continue;
    const source = statement.source.value;
    const isEffectModule = SHARED_EFFECT_MODULE.test(source);
    const isExtraModule = !isEffectModule && extraMatchers.some((matcher) => matcher.test(source));
    if (!isEffectModule && !isExtraModule) continue;
    const submodule = source.split('/').slice(1).join('/');
    const isRootLike = isExtraModule || source === EFFECT_ROOT_MODULE;
    const isEffectSubmodule = source === EFFECT_SUBMODULE;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier') {
        if (specifier.importKind === 'type') continue;
        const imported = importedName(specifier);
        const local = specifier.local.name;
        if (isEffectSubmodule) effectSubmoduleImports.set(local, imported);
        if (imported === EFFECT_NAMESPACE && isRootLike) {
          effectNamespaces.set(local, specifier.local);
        } else if (RUN_MEMBER.test(imported) && (isRootLike || isEffectSubmodule)) {
          runLocals.set(local, { declaration: specifier.local, member: imported });
        }
      } else if (specifier.type === 'ImportNamespaceSpecifier') {
        if (isEffectSubmodule) effectNamespaces.set(specifier.local.name, specifier.local);
        else if (isRootLike || submodule === '')
          packageNamespaces.set(specifier.local.name, specifier.local);
      }
    }
  }

  if (effectNamespaces.size > 0 || packageNamespaces.size > 0) {
    propagateLocalAliases(context, ast, effectNamespaces, packageNamespaces, runLocals);
  }

  return {
    effectNamespaces,
    effectSubmoduleImports,
    packageNamespaces,
    runLocals,
    tracked: effectNamespaces.size > 0 || packageNamespaces.size > 0 || runLocals.size > 0,
  };
}

/**
 * Follow `const Fx = Effect;`, `const Fx = Pkg.Effect;`, `const { runSync } = Effect;` and
 * `const { Effect } = Pkg;` to a fixed point, so a one-line re-binding cannot defeat the rule.
 */
function propagateLocalAliases(
  context: Context,
  ast: ESTree.Program,
  effectNamespaces: Map<string, ESTree.Node>,
  packageNamespaces: Map<string, ESTree.Node>,
  runLocals: Map<string, { member: string; declaration: ESTree.Node }>,
): void {
  const declarators: ESTree.VariableDeclarator[] = [];
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.init !== null) declarators.push(node);
  });
  if (declarators.length === 0) return;

  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    const add = (map: Map<string, ESTree.Node>, name: string, declaration: ESTree.Node): void => {
      if (map.has(name)) return;
      map.set(name, declaration);
      changed = true;
    };
    for (const declarator of declarators) {
      const init = declarator.init === null ? null : unwrapExpression(declarator.init);
      if (init === null) continue;
      let kind: 'effect' | 'package' | null = null;
      if (init.type === 'Identifier') {
        const effect = effectNamespaces.get(init.name);
        const root = packageNamespaces.get(init.name);
        if (effect !== undefined && isTrackedReference(context, init, effect)) kind = 'effect';
        else if (root !== undefined && isTrackedReference(context, init, root)) kind = 'package';
      } else if (init.type === 'MemberExpression') {
        const object = unwrapExpression(init.object);
        const property = staticName(init.property, init.computed);
        if (object.type === 'Identifier' && property === EFFECT_NAMESPACE) {
          const declaration = packageNamespaces.get(object.name);
          if (declaration !== undefined && isTrackedReference(context, object, declaration))
            kind = 'effect';
        }
      }
      if (kind === null) continue;
      const target = declarator.id;
      if (target.type === 'Identifier') {
        add(kind === 'effect' ? effectNamespaces : packageNamespaces, target.name, target);
        continue;
      }
      if (target.type !== 'ObjectPattern') continue;
      for (const property of target.properties) {
        if (property.type !== 'Property') continue;
        const name = staticName(property.key, property.computed);
        if (name === null) continue;
        const value =
          property.value.type === 'AssignmentPattern' ? property.value.left : property.value;
        if (value.type !== 'Identifier') continue;
        if (kind === 'package') {
          if (name === EFFECT_NAMESPACE) add(effectNamespaces, value.name, value);
          continue;
        }
        if (!RUN_MEMBER.test(name) || runLocals.has(value.name)) continue;
        runLocals.set(value.name, { declaration: value, member: name });
        changed = true;
      }
    }
    if (!changed) return;
  }
}

function resolveVariable(context: Context, identifier: ESTree.Node): Variable | null {
  if (identifier.type !== 'Identifier') return null;
  let scope: Scope | null = context.sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/**
 * True when `identifier` really resolves to the tracked declaration, so a shadowing parameter, local or
 * destructuring key with the same name is never reported. An unresolvable identifier is trusted (oxlint's
 * scope analysis does not model every TS construct), which keeps the rule strict by default.
 */
function isTrackedReference(
  context: Context,
  identifier: ESTree.Node,
  declaration: ESTree.Node,
): boolean {
  const variable = resolveVariable(context, identifier);
  if (variable === null) return true;
  if (variable.defs.length === 0) return false;
  return variable.defs.some((definition) => Object.is(definition.name, declaration));
}

/** `Effect.runPromise` / `E["runSync"]` / ``Fx.Effect[`runFork`]`` → the run member name. */
function runEntryPoint(
  context: Context,
  node: ESTree.MemberExpression,
  bindings: RunBindings,
): string | null {
  const member = staticName(node.property, node.computed);
  if (member === null || !RUN_MEMBER.test(member)) return null;
  const object = unwrapExpression(node.object);
  if (object.type === 'Identifier') {
    const declaration = bindings.effectNamespaces.get(object.name);
    if (declaration === undefined) return null;
    return isTrackedReference(context, object, declaration) ? member : null;
  }
  if (object.type !== 'MemberExpression') return null;
  // `import * as Fx from "effect"` → `Fx.Effect.runSync(...)`.
  if (staticName(object.property, object.computed) !== EFFECT_NAMESPACE) return null;
  const root = unwrapExpression(object.object);
  if (root.type !== 'Identifier') return null;
  const declaration = bindings.packageNamespaces.get(root.name);
  if (declaration === undefined) return null;
  return isTrackedReference(context, root, declaration) ? member : null;
}

function isFunctionNode(node: ESTree.Node): node is FunctionNode {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression'
  );
}

/**
 * The call this function is an argument of, looking through option objects/arrays
 * (`Effect.tryPromise({ try: async () => ... })`) but never through another function.
 */
function owningCall(fn: FunctionNode): ESTree.CallExpression | null {
  let child: ESTree.Node = fn;
  let current: ESTree.Node | null = fn.parent;
  while (current !== null) {
    if (current.type === 'CallExpression') {
      return current.arguments.some((argument) => Object.is(argument, child)) ? current : null;
    }
    if (
      current.type === 'Property' ||
      current.type === 'ObjectExpression' ||
      current.type === 'ArrayExpression' ||
      current.type === 'SpreadElement' ||
      current.type === 'ParenthesizedExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression'
    ) {
      child = current;
      current = current.parent;
      continue;
    }
    return null;
  }
  return null;
}

/** A function passed to an Effect/Layer/Stream combinator (`Effect.gen`, `Effect.fn("x")(...)`, `gen(...)`). */
function isEffectOwnedFunction(
  fn: FunctionNode,
  bindings: RunBindings,
  shared: EffectBindings,
): boolean {
  const call = owningCall(fn);
  if (call === null) return false;
  // `Effect.fn("name")(function* () { ... })` and `Effect.fn()(...)`.
  const rawCallee = call.callee.type === 'CallExpression' ? call.callee.callee : call.callee;
  const callee = unwrapExpression(rawCallee);
  if (callee.type === 'Identifier') {
    // `import { gen } from "effect/Effect"` — a directly imported combinator owns its callback too.
    const imported = bindings.effectSubmoduleImports.get(callee.name);
    return imported !== undefined && !RUN_MEMBER.test(imported);
  }
  if (callee.type !== 'MemberExpression') return false;
  const member = effectMember(callee, shared);
  if (member !== null)
    return !(member.namespace === EFFECT_NAMESPACE && RUN_MEMBER.test(member.member));
  // `Fx.Effect.gen(...)` through a whole-package namespace import.
  const object = unwrapExpression(callee.object);
  if (object.type !== 'MemberExpression') return false;
  if (staticName(object.property, object.computed) !== EFFECT_NAMESPACE) return false;
  const root = unwrapExpression(object.object);
  if (root.type !== 'Identifier' || !bindings.packageNamespaces.has(root.name)) return false;
  const name = staticName(callee.property, callee.computed);
  return name !== null && !RUN_MEMBER.test(name);
}

/** True when the run site sits inside an Effect program body — the S1 nested re-entry case. */
function isInsideEffectOwnedCode(
  node: ESTree.Node,
  bindings: RunBindings,
  shared: EffectBindings,
): boolean {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== 'Program') {
    if (isFunctionNode(current) && isEffectOwnedFunction(current, bindings, shared)) return true;
    current = current.parent;
  }
  return false;
}

/** Parents where an identifier is a declaration key or module-record name, never a value reference. */
function isDeclarationPosition(node: ESTree.Node): boolean {
  const parent: ESTree.Node | null = node.parent;
  if (parent === null) return false;
  switch (parent.type) {
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return true;
    case 'MemberExpression':
      return Object.is(parent.property, node) && !parent.computed;
    case 'Property':
      return Object.is(parent.key, node) && !parent.computed;
    case 'PropertyDefinition':
    case 'TSAbstractPropertyDefinition':
    case 'MethodDefinition':
    case 'TSAbstractMethodDefinition':
    case 'AccessorProperty':
    case 'TSAbstractAccessorProperty':
    case 'TSPropertySignature':
    case 'TSMethodSignature':
      return (
        Object.is((parent as unknown as { key?: unknown }).key, node) && parent.computed !== true
      );
    default:
      return false;
  }
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A1 (supporting A9): disallow bare `Effect.run*` entry points in server and library code outside the single process/framework adapter seam; capture the host ManagedRuntime instead.',
    },
    messages: {
      bareEffectRun:
        'Bare `Effect.{{member}}` outside the composition root creates an ad hoc runtime with no Layer graph, tracer, logger or config (audit A1). Run through the host ManagedRuntime captured at the single adapter seam (`const runtime = ManagedRuntime.make(appLayer)` then `runtime.{{member}}(...)`), or keep the code an `Effect` and let the caller compose it.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          adapterFiles: { type: 'array', items: { type: 'string' } },
          browserGlobs: { type: 'array', items: { type: 'string' } },
          serverGlobs: { type: 'array', items: { type: 'string' } },
          effectModules: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        adapterFiles: [...DEFAULT_ADAPTER_FILES],
        browserGlobs: [...DEFAULT_BROWSER_GLOBS],
        serverGlobs: [...DEFAULT_SERVER_GLOBS],
        effectModules: [...DEFAULT_EFFECT_MODULES],
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const filename = workspacePath(context.filename);
    if (
      isTestFile(filename) ||
      isScriptFile(filename) ||
      matchesGlobs(filename, [
        'apps/*/scripts/**',
        'verticals/*/scripts/**',
        'packages/*/scripts/**',
      ]) ||
      (matchesGlobs(filename, options.browserGlobs) &&
        !matchesGlobs(filename, options.serverGlobs)) ||
      matchesGlobs(filename, options.adapterFiles)
    ) {
      return {};
    }

    let bindings: RunBindings | null = null;
    let shared: EffectBindings | null = null;
    const currentBindings = (): RunBindings => {
      bindings ??= collectRunBindings(context, options.effectModules);
      return bindings;
    };
    const sharedBindings = (): EffectBindings => {
      shared ??= bindingsFor(context);
      return shared;
    };

    const reported = new Set<string>();
    const report = (node: ESTree.Node, member: string): void => {
      const key = `${node.start}:${node.end}`;
      if (reported.has(key)) return;
      reported.add(key);
      context.report({ data: { member }, messageId: 'bareEffectRun', node });
    };

    return {
      Identifier(node) {
        const active = currentBindings();
        if (!active.tracked) return;
        const tracked = active.runLocals.get(node.name);
        if (tracked === undefined) return;
        if (Object.is(node, tracked.declaration)) return;
        if (isDeclarationPosition(node) || isInTypePosition(node)) return;
        if (!isTrackedReference(context, node, tracked.declaration)) return;
        if (isInsideEffectOwnedCode(node, active, sharedBindings())) return;
        report(node, tracked.member);
      },
      MemberExpression(node) {
        const active = currentBindings();
        if (!active.tracked) return;
        const member = runEntryPoint(context, node, active);
        if (member === null) return;
        if (isInTypePosition(node)) return;
        if (isInsideEffectOwnedCode(node, active, sharedBindings())) return;
        report(node, member);
      },
    };
  },
});
