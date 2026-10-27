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
 * - an exported Promise preload adapter that only joins a bounded native Effect.forEach of
 *   context-free Effect<void> steps through suspend/ignoreCause. The step, helper and adapter
 *   bindings must have exactly their expected uses. Other roots in the same file still report;
 * - type positions: `typeof Effect.runSync`, `import type { runSync } from "effect/Effect"`, interface and
 *   type-literal members, class property/method *declaration* keys named `runSync`, and re-exports
 *   (`export { runPromise }`), none of which start a fiber.
 */
import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree } from '@oxlint/plugins';

import { keyName, unwrapNode, walk as walkAst } from '../shared/ast.ts';
import { isTrackedReference, lookupVariable } from '../shared/bindings.ts';
import { bindingPath } from '../shared/effect-identity.ts';
import { bindingsFor, effectMember, type EffectBindings } from '../shared/effect-imports.ts';
import { importedName } from '../shared/imports.ts';
import { globToRegExp, isScriptFile, isTestFile, normalisePath, matchesGlobs } from '../shared/paths.ts';
import { isNonReferencePosition, isInTypePosition as inTypePosition } from '../shared/reference-positions.ts';

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

function walk(node: ESTree.Node, visit: (node: ESTree.Node) => void): void {
  walkAst(node, {}, visit, false);
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
const EXPRESSION_WRAPPERS = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);
function unwrapExpression(node: ESTree.Node): ESTree.Node {
  return unwrapNode(node, { wrappers: EXPRESSION_WRAPPERS });
}
function isInTypePosition(node: ESTree.Node): boolean {
  return inTypePosition(node, TS_EXPRESSION_NODES);
}
function staticName(key: ESTree.Node, computed: boolean): string | null {
  return keyName(key, computed, {
    templates: computed,
    rawTemplates: true,
    singleQuasi: true,
  });
}

/**
 * Collect every local that can reach an `Effect.run*` entry point.
 *
 * Type-only imports are skipped (they are erased, so no reference can start a fiber), and a bare
 * `run*` named import only counts when it comes from `effect` / `effect/Effect` — `runPromise` imported
 * from `effect/Runtime` or `effect/ManagedRuntime` is the prescribed A1 replacement, not the smell.
 */
type CollectedBindings = Omit<RunBindings, 'tracked'>;
interface ImportSource {
  readonly rootLike: boolean;
  readonly effectSubmodule: boolean;
  readonly emptySubmodule: boolean;
}
function collectNamedBinding(
  specifier: ESTree.ImportSpecifier,
  source: ImportSource,
  bindings: CollectedBindings,
): void {
  if (specifier.importKind === 'type') return;
  const imported = importedName(specifier);
  const local = specifier.local.name;
  if (source.effectSubmodule) bindings.effectSubmoduleImports.set(local, imported);
  if (imported === EFFECT_NAMESPACE && source.rootLike) {
    bindings.effectNamespaces.set(local, specifier.local);
  } else if (RUN_MEMBER.test(imported) && (source.rootLike || source.effectSubmodule)) {
    bindings.runLocals.set(local, {
      declaration: specifier.local,
      member: imported,
    });
  }
}
function collectImportBindings(
  statement: ESTree.ImportDeclaration,
  extraMatchers: readonly RegExp[],
  bindings: CollectedBindings,
): void {
  if (statement.importKind === 'type') return;
  const source = statement.source.value;
  const effectModule = SHARED_EFFECT_MODULE.test(source);
  const extraModule = !effectModule && extraMatchers.some((matcher) => matcher.test(source));
  if (!effectModule && !extraModule) return;
  const policy = {
    rootLike: extraModule || source === EFFECT_ROOT_MODULE,
    effectSubmodule: source === EFFECT_SUBMODULE,
    emptySubmodule: source.split('/').slice(1).join('/') === '',
  };
  for (const specifier of statement.specifiers) collectImportSpecifier(specifier, policy, bindings);
}
function collectImportSpecifier(
  specifier: ESTree.ImportDeclaration['specifiers'][number],
  source: ImportSource,
  bindings: CollectedBindings,
): void {
  if (specifier.type === 'ImportSpecifier') {
    collectNamedBinding(specifier, source, bindings);
  } else if (specifier.type === 'ImportNamespaceSpecifier') {
    if (source.effectSubmodule) bindings.effectNamespaces.set(specifier.local.name, specifier.local);
    else if (source.rootLike || source.emptySubmodule)
      bindings.packageNamespaces.set(specifier.local.name, specifier.local);
  }
}
function collectRunBindings(context: Context, effectModules: readonly string[]): RunBindings {
  const bindings: CollectedBindings = {
    effectNamespaces: new Map(),
    packageNamespaces: new Map(),
    runLocals: new Map(),
    effectSubmoduleImports: new Map(),
  };
  const extraMatchers = effectModules
    .filter((module) => !SHARED_EFFECT_MODULE.test(module))
    .map((module) => globToRegExp(module));
  const ast = context.sourceCode.ast;
  for (const statement of ast.body) {
    if (statement.type === 'ImportDeclaration') collectImportBindings(statement, extraMatchers, bindings);
  }
  if (bindings.effectNamespaces.size > 0 || bindings.packageNamespaces.size > 0)
    propagateLocalAliases(context, ast, bindings);
  return {
    ...bindings,
    tracked: bindings.effectNamespaces.size > 0 || bindings.packageNamespaces.size > 0 || bindings.runLocals.size > 0,
  };
}

/**
 * Follow `const Fx = Effect;`, `const Fx = Pkg.Effect;`, `const { runSync } = Effect;` and
 * `const { Effect } = Pkg;` to a fixed point, so a one-line re-binding cannot defeat the rule.
 */
function trackedNamespace(context: Context, node: ESTree.Node, namespaces: ReadonlyMap<string, ESTree.Node>): boolean {
  if (node.type !== 'Identifier') return false;
  const declaration = namespaces.get(node.name);
  return declaration !== undefined && isTrackedReference(context, node, declaration);
}
function packageEffectRoot(node: ESTree.Node): ESTree.Node | null {
  if (node.type !== 'MemberExpression') return null;
  if (staticName(node.property, node.computed) !== EFFECT_NAMESPACE) return null;
  return unwrapExpression(node.object);
}
function namespaceKind(context: Context, init: ESTree.Node, bindings: CollectedBindings): 'effect' | 'package' | null {
  if (init.type === 'Identifier') {
    if (trackedNamespace(context, init, bindings.effectNamespaces)) return 'effect';
    return trackedNamespace(context, init, bindings.packageNamespaces) ? 'package' : null;
  }
  const root = packageEffectRoot(init);
  return root !== null && trackedNamespace(context, root, bindings.packageNamespaces) ? 'effect' : null;
}
function addNamespace(map: Map<string, ESTree.Node>, target: Extract<ESTree.Node, { type: 'Identifier' }>): boolean {
  if (map.has(target.name)) return false;
  map.set(target.name, target);
  return true;
}
function addDestructuredAlias(
  property: ESTree.ObjectPattern['properties'][number],
  kind: 'effect' | 'package',
  bindings: CollectedBindings,
): boolean {
  if (property.type !== 'Property') return false;
  const name = staticName(property.key, property.computed);
  if (name === null) return false;
  const value = property.value.type === 'AssignmentPattern' ? property.value.left : property.value;
  if (value.type !== 'Identifier') return false;
  if (kind === 'package') return name === EFFECT_NAMESPACE && addNamespace(bindings.effectNamespaces, value);
  if (!RUN_MEMBER.test(name) || bindings.runLocals.has(value.name)) return false;
  bindings.runLocals.set(value.name, { declaration: value, member: name });
  return true;
}
function propagateDeclarator(
  context: Context,
  declarator: ESTree.VariableDeclarator,
  bindings: CollectedBindings,
): boolean {
  if (declarator.init === null) return false;
  const kind = namespaceKind(context, unwrapExpression(declarator.init), bindings);
  if (kind === null) return false;
  const target = declarator.id;
  if (target.type === 'Identifier')
    return addNamespace(kind === 'effect' ? bindings.effectNamespaces : bindings.packageNamespaces, target);
  if (target.type !== 'ObjectPattern') return false;
  let changed = false;
  for (const property of target.properties) {
    if (addDestructuredAlias(property, kind, bindings)) changed = true;
  }
  return changed;
}
function propagateLocalAliases(context: Context, ast: ESTree.Program, bindings: CollectedBindings): void {
  const declarators: ESTree.VariableDeclarator[] = [];
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.init !== null) declarators.push(node);
  });
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    for (const declarator of declarators) {
      if (propagateDeclarator(context, declarator, bindings)) changed = true;
    }
    if (!changed) return;
  }
}

/** `Effect.runPromise` / `E["runSync"]` / ``Fx.Effect[`runFork`]`` → the run member name. */
function runEntryPoint(context: Context, node: ESTree.MemberExpression, bindings: RunBindings): string | null {
  const member = staticName(node.property, node.computed);
  if (member === null || !RUN_MEMBER.test(member)) return null;
  const object = unwrapExpression(node.object);
  if (object.type === 'Identifier') return trackedNamespace(context, object, bindings.effectNamespaces) ? member : null;
  const root = packageEffectRoot(object);
  return root !== null && trackedNamespace(context, root, bindings.packageNamespaces) ? member : null;
}

function isFunctionNode(node: ESTree.Node): node is FunctionNode {
  return (
    node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
  );
}

/**
 * The call this function is an argument of, looking through option objects/arrays
 * (`Effect.tryPromise({ try: async () => ... })`) but never through another function.
 */
const OWNERSHIP_WRAPPERS = new Set([
  'Property',
  'ObjectExpression',
  'ArrayExpression',
  'SpreadElement',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
]);
function owningCall(fn: FunctionNode): ESTree.CallExpression | null {
  let child: ESTree.Node = fn;
  let current: ESTree.Node | null = fn.parent;
  while (current !== null) {
    if (current.type === 'CallExpression') {
      return current.arguments.some((argument) => Object.is(argument, child)) ? current : null;
    }
    if (OWNERSHIP_WRAPPERS.has(current.type)) {
      child = current;
      current = current.parent;
      continue;
    }
    return null;
  }
  return null;
}

/** A function passed to an Effect/Layer/Stream combinator (`Effect.gen`, `Effect.fn("x")(...)`, `gen(...)`). */
function isEffectOwnedFunction(fn: FunctionNode, bindings: RunBindings, shared: EffectBindings): boolean {
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
  if (member !== null) return !(member.namespace === EFFECT_NAMESPACE && RUN_MEMBER.test(member.member));
  return isPackageCombinator(callee, bindings);
}
function isPackageCombinator(callee: ESTree.MemberExpression, bindings: RunBindings): boolean {
  const root = packageEffectRoot(unwrapExpression(callee.object));
  if (root === null || root.type !== 'Identifier' || !bindings.packageNamespaces.has(root.name)) return false;
  const name = staticName(callee.property, callee.computed);
  return name !== null && !RUN_MEMBER.test(name);
}

/** True when the run site sits inside an Effect program body — the S1 nested re-entry case. */
function isInsideEffectOwnedCode(node: ESTree.Node, bindings: RunBindings, shared: EffectBindings): boolean {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== 'Program') {
    if (isFunctionNode(current) && isEffectOwnedFunction(current, bindings, shared)) return true;
    current = current.parent;
  }
  return false;
}

/** Parents where an identifier is a declaration key or module-record name, never a value reference. */
const DECLARATION_KEY_PARENTS = new Set([
  'PropertyDefinition',
  'TSAbstractPropertyDefinition',
  'MethodDefinition',
  'TSAbstractMethodDefinition',
  'AccessorProperty',
  'TSAbstractAccessorProperty',
  'TSPropertySignature',
  'TSMethodSignature',
]);
const NAME_PARENTS = new Set(['LabeledStatement', 'BreakStatement', 'ContinueStatement']);
function isDeclarationPosition(node: ESTree.Node): boolean {
  if (node.parent?.type === 'Property') return Object.is(node.parent.key, node) && !node.parent.computed;
  return isNonReferencePosition(node, {
    detached: false,
    keyParents: DECLARATION_KEY_PARENTS,
    nonReferenceParents: NAME_PARENTS,
    strictComputed: true,
  });
}

function preloadType(node: ESTree.Node | null | undefined): ESTree.Node | null {
  if (!node) return null;
  if (node.type === 'TSTypeAnnotation' || node.type === 'TSParenthesizedType') return preloadType(node.typeAnnotation);
  return node;
}

function nativePreloadEffect(context: Context, node: ESTree.Node | null): boolean {
  if (node?.type !== 'TSTypeReference' || node.typeName.type !== 'TSQualifiedName') return false;
  return (
    node.typeName.right.name === 'Effect' &&
    bindingPath(context, node.typeName.left)?.join('.') === 'Effect' &&
    node.typeArguments?.params.length === 1 &&
    node.typeArguments.params[0]?.type === 'TSVoidKeyword'
  );
}

function preloadInputType(node: ESTree.Node | null): string | null {
  return node?.type === 'TSTypeReference' && node.typeName.type === 'Identifier' && node.typeArguments === null
    ? node.typeName.name
    : null;
}

function preloadParameterType(node: ESTree.Node | undefined): ESTree.Node | null {
  return node?.type === 'Identifier' ? preloadType(node.typeAnnotation) : null;
}

function preloadStepInput(context: Context, parameter: ESTree.Node | undefined): string | null {
  if (parameter?.type !== 'RestElement' || parameter.argument.type !== 'Identifier') return null;
  const annotation = preloadType(parameter.typeAnnotation ?? parameter.argument.typeAnnotation);
  if (annotation?.type !== 'TSTypeOperator' || annotation.operator !== 'readonly') return null;
  const array = preloadType(annotation.typeAnnotation);
  const callback = array?.type === 'TSArrayType' ? preloadType(array.elementType) : null;
  return callback?.type === 'TSFunctionType' &&
    callback.params.length === 1 &&
    callback.typeParameters === null &&
    nativePreloadEffect(context, preloadType(callback.returnType))
    ? preloadInputType(preloadParameterType(callback.params[0]))
    : null;
}

function samePreloadBinding(context: Context, use: ESTree.Node | undefined, declaration: ESTree.Node): boolean {
  return (
    use?.type === 'Identifier' &&
    lookupVariable(context, use) !== null &&
    lookupVariable(context, use) === lookupVariable(context, declaration)
  );
}

function nativePreloadCall(context: Context, input: ESTree.Node, member: string): input is ESTree.CallExpression {
  return (
    input.type === 'CallExpression' &&
    !input.optional &&
    bindingPath(context, input.callee)?.join('.') === `Effect.${member}`
  );
}

function immutablePreloadUses(context: Context, binding: ESTree.Node, expected: readonly ESTree.Node[]): boolean {
  const variable = lookupVariable(context, binding);
  if (!variable || variable.defs.length !== 1) return false;
  const uses = variable.references.filter((reference) => !reference.init);
  return (
    uses.length === expected.length &&
    uses.every((reference) => !reference.isWrite() && expected.includes(reference.identifier))
  );
}

/** A bounded, context-free batch joins owner-provided steps without inventing an application runtime. */
function nativePreloadBatch(
  context: Context,
  helper: ESTree.ArrowFunctionExpression,
  steps: ESTree.Node,
  inputType: string,
): boolean {
  if (
    helper.async ||
    helper.params.length !== 1 ||
    preloadInputType(preloadParameterType(helper.params[0])) !== inputType ||
    !nativePreloadEffect(context, preloadType(helper.returnType)) ||
    !nativePreloadCall(context, helper.body, 'forEach') ||
    helper.body.arguments.length !== 3 ||
    !samePreloadBinding(context, helper.body.arguments[0], steps)
  )
    return false;
  const [, callback, options] = helper.body.arguments;
  if (
    callback?.type !== 'ArrowFunctionExpression' ||
    callback.async ||
    callback.params.length !== 1 ||
    callback.body.type !== 'CallExpression' ||
    callback.body.arguments.length !== 1 ||
    bindingPath(context, callback.body.arguments[0]!)?.join('.') !== 'Effect.ignoreCause' ||
    callback.body.callee.type !== 'MemberExpression' ||
    callback.body.callee.computed ||
    callback.body.callee.property.type !== 'Identifier' ||
    callback.body.callee.property.name !== 'pipe'
  )
    return false;
  const suspended = callback.body.callee.object;
  if (!nativePreloadCall(context, suspended, 'suspend') || suspended.arguments.length !== 1) return false;
  const thunk = suspended.arguments[0];
  if (
    thunk?.type !== 'ArrowFunctionExpression' ||
    thunk.async ||
    thunk.params.length !== 0 ||
    thunk.body.type !== 'CallExpression' ||
    thunk.body.arguments.length !== 1 ||
    !samePreloadBinding(context, thunk.body.callee, callback.params[0]!) ||
    !samePreloadBinding(context, thunk.body.arguments[0], helper.params[0]!) ||
    options?.type !== 'ObjectExpression' ||
    options.properties.length !== 2
  )
    return false;
  const bounded = options.properties.every((property) => {
    if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init') return false;
    const name = staticName(property.key, false);
    let value = property.value;
    if (name === 'concurrency' && value.type === 'Identifier') {
      const definition = lookupVariable(context, value)?.defs[0];
      if (
        definition?.node.type !== 'VariableDeclarator' ||
        definition.parent?.type !== 'VariableDeclaration' ||
        definition.parent.kind !== 'const' ||
        definition.node.init === null
      )
        return false;
      value = definition.node.init;
    }
    return (
      value.type === 'Literal' &&
      ((name === 'discard' && value.value === true) ||
        (name === 'concurrency' && typeof value.value === 'number' && Number.isInteger(value.value) && value.value > 0))
    );
  });
  const keys = new Set(
    options.properties.map((property) => (property.type === 'Property' ? staticName(property.key, false) : null)),
  );
  return (
    bounded &&
    keys.size === 2 &&
    immutablePreloadUses(context, callback.params[0]!, [thunk.body.callee]) &&
    immutablePreloadUses(context, helper.params[0]!, [thunk.body.arguments[0]!])
  );
}

function nativePreloadPromiseType(context: Context, output: ESTree.Node | null, inputType: string): boolean {
  if (output?.type !== 'TSTypeReference' || output.typeName.type !== 'Identifier') return false;
  const name = output.typeName.name;
  const alias = context.sourceCode.ast.body.flatMap((statement) => {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : null;
    return declaration?.type === 'TSTypeAliasDeclaration' && declaration.id.name === name
      ? [declaration.typeAnnotation]
      : [];
  });
  const callback = alias.length === 1 ? alias[0] : null;
  const result = callback?.type === 'TSFunctionType' ? preloadType(callback.returnType) : null;
  return (
    callback?.type === 'TSFunctionType' &&
    callback.params.length === 1 &&
    preloadInputType(preloadParameterType(callback.params[0])) === inputType &&
    result?.type === 'TSTypeReference' &&
    result.typeName.type === 'Identifier' &&
    result.typeName.name === 'Promise' &&
    (lookupVariable(context, result.typeName)?.defs.length ?? 0) === 0 &&
    result.typeArguments?.params.length === 1 &&
    result.typeArguments.params[0]?.type === 'TSVoidKeyword'
  );
}

/** Only the exported Promise adapter around this exact native preload batch is an outer framework root. */
function isNativePreloadRoot(context: Context, reference: ESTree.Node): boolean {
  const run = reference.parent;
  const awaited = run?.parent;
  const statement = awaited?.parent;
  const body = statement?.parent;
  const adapter = body?.parent;
  const returned = adapter?.parent;
  const factoryBody = returned?.parent;
  const factory = factoryBody?.parent;
  if (
    run?.type !== 'CallExpression' ||
    run.callee !== reference ||
    run.optional ||
    run.arguments.length !== 1 ||
    !nativePreloadCall(context, run, 'runPromise') ||
    awaited?.type !== 'AwaitExpression' ||
    statement?.type !== 'ExpressionStatement' ||
    body?.type !== 'BlockStatement' ||
    body.body.length !== 1 ||
    adapter?.type !== 'ArrowFunctionExpression' ||
    !adapter.async ||
    adapter.params.length !== 1 ||
    returned?.type !== 'ReturnStatement' ||
    factoryBody?.type !== 'BlockStatement' ||
    factoryBody.body.length !== 2 ||
    factory?.type !== 'ArrowFunctionExpression' ||
    factory.async ||
    factory.params.length !== 1 ||
    factory.typeParameters !== null
  )
    return false;
  const declaration = factory.parent;
  if (
    declaration?.type !== 'VariableDeclarator' ||
    declaration.id.type !== 'Identifier' ||
    declaration.parent?.type !== 'VariableDeclaration' ||
    declaration.parent.kind !== 'const' ||
    declaration.parent.parent?.type !== 'ExportNamedDeclaration' ||
    declaration.parent.parent.parent?.type !== 'Program'
  )
    return false;
  const inputType = preloadStepInput(context, factory.params[0]);
  const [helperDeclaration] = factoryBody.body;
  if (
    !inputType ||
    !nativePreloadPromiseType(context, preloadType(factory.returnType), inputType) ||
    helperDeclaration?.type !== 'VariableDeclaration' ||
    helperDeclaration.kind !== 'const' ||
    helperDeclaration.declarations.length !== 1
  )
    return false;
  const [helper] = helperDeclaration.declarations;
  const invoked = run.arguments[0];
  const rest = factory.params[0];
  if (
    helper?.id.type !== 'Identifier' ||
    helper.init?.type !== 'ArrowFunctionExpression' ||
    invoked?.type !== 'CallExpression' ||
    invoked.arguments.length !== 1 ||
    !samePreloadBinding(context, invoked.callee, helper.id) ||
    !samePreloadBinding(context, invoked.arguments[0], adapter.params[0]!) ||
    rest?.type !== 'RestElement'
  )
    return false;
  return (
    nativePreloadBatch(context, helper.init, rest.argument, inputType) &&
    immutablePreloadUses(context, rest.argument, [
      helper.init.body.type === 'CallExpression' ? helper.init.body.arguments[0]! : helper.init.body,
    ]) &&
    immutablePreloadUses(context, helper.id, [invoked.callee]) &&
    immutablePreloadUses(context, adapter.params[0]!, [invoked.arguments[0]!])
  );
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
      matchesGlobs(filename, ['apps/*/scripts/**', 'verticals/*/scripts/**', 'packages/*/scripts/**']) ||
      (matchesGlobs(filename, options.browserGlobs) && !matchesGlobs(filename, options.serverGlobs)) ||
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
        if (isNativePreloadRoot(context, node)) return;
        report(node, tracked.member);
      },
      MemberExpression(node) {
        const active = currentBindings();
        if (!active.tracked) return;
        const member = runEntryPoint(context, node, active);
        if (member === null) return;
        if (isInTypePosition(node)) return;
        if (isInsideEffectOwnedCode(node, active, sharedBindings())) return;
        if (isNativePreloadRoot(context, node)) return;
        report(node, member);
      },
    };
  },
});
