/**
 * effect-native/no-effect-run-in-scripts
 *
 * Audit findings enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *   - B3 "Convert consequential operational scripts into Effect programs" —
 *     "Keep one small process-exit adapter at the executable edge."
 *     Evidence: `scripts/migrate-contacts-authorization.mts:291`, `scripts/scaffolding/cli.mts:683`.
 *   - A1 "Establish one process-level Layer and ManagedRuntime composition model" — every extra
 *     root fiber is an ad hoc runtime with no Layer graph, tracer, logger or `ConfigProvider`.
 *   - S1 "Eliminate the Effect–Promise–Effect transaction sandwich" — repeated root fibers drop
 *     spans, log annotations, `Context.Reference` values, `Clock`, `Scope` and interruption.
 *
 * What is detected (operational scripts only, tests excluded):
 *   1. `nestedRun` — an `Effect.run*` site that is not at the executable edge: it sits inside a
 *      helper, callback, class member or exported library function. Each call starts a fresh root
 *      fiber that cannot see the script's Layer, ConfigProvider, Scope or interruption.
 *   2. `runInLoop` — a run site at the edge but inside a `for`/`while` loop: one syntactic site,
 *      one root fiber *per iteration*. This is exactly S1's repeated deep re-entry, and it is the
 *      cheapest way to launder a nested run, so it is reported even though it is "the only" site.
 *   3. `extraRun` — more than `maxRunSites` (default 1) *simultaneously reachable* run sites at the
 *      edge. Sites in sibling branches of one `if`/`else` chain or `switch` are mutually exclusive
 *      (standard CLI mode dispatch: `prepare | verify | finalize`), so they count as one site.
 *   4. `promiseChainOnRun` — `.then` / `.catch` chained onto a run call, which turns typed failures
 *      back into Promise rejections; `promiseFinallyOnRun` — `.finally` cleanup that belongs in
 *      `Effect.ensuring` / `Effect.scoped` inside the program.
 *
 * Evasions that are deliberately still detected (a script must not be able to silence this rule by
 * spelling the runner differently): aliased namespace imports (`import { Effect as E }`), submodule
 * namespace imports (`import * as Effect from "effect/Effect"`), whole-package namespace imports
 * (`import * as Fx from "effect"` -> `Fx.Effect.runSync`), direct named imports of the runner
 * (`import { runPromise } from "effect/Effect"`), local aliases (`const run = Effect.runPromise`),
 * namespace destructuring (`const { runFork } = Effect`), namespace re-binding (`const Fx = Effect`),
 * computed access (`Effect["runSync"]`), template-literal computed access, optional chaining,
 * `as`/`satisfies`/`!` wrappers, point-free use (`pipe(program, Effect.runPromise)`), and
 * `.ts` / `.mts` / `.tsx` sources alike.
 *
 * What is deliberately allowed (audit "Existing patterns to preserve" + D tier):
 *   - "Bare `Effect.runPromise` is acceptable at the single outer process or framework adapter seam;
 *     the problem is repeated deep re-entry." One run site at the executable edge never reports:
 *     top-level code, the `if (import.meta.url === pathToFileURL(process.argv[1]).href)` guard, a
 *     top-level IIFE, or a Program-level `main` that is only invoked from module-evaluation code —
 *     including when that `main` is also `export`ed / `export default`ed (a re-export is not an
 *     invocation, and `scripts/scaffolding/*​/scaffold.mts` are written that way).
 *   - Node process entrypoint Promise adapters (D tier): `await Effect.runPromiseExit(main())`
 *     plus `process.exitCode`, `Exit.match`, `try`/`catch` around the single seam.
 *   - `Layer.orDie` at a deliberate startup boundary and every other non-`run*` Effect API.
 *   - Mutually exclusive CLI mode dispatch — one root fiber ever starts.
 *   - `runtime.runPromise(...)` on a `ManagedRuntime` instance: A1 explicitly prescribes capturing
 *     the runtime at forced Promise adapters, so it is the fix, not the smell.
 *   - Test files (`scripts/tests/**`, `*.test.mts`, …) — B2 owns the test harness.
 *   - Identifiers that merely *look* like the Effect namespace: the object must resolve through
 *     `context.sourceCode.getScope` to the real `effect` import binding, so a shadowing parameter,
 *     local object or same-named import from another package never reports.
 *
 * At most one diagnostic per run site, priority `nestedRun` > `runInLoop` > `extraRun` >
 * `promiseChainOnRun` / `promiseFinallyOnRun`, so the count equals the number of offending sites.
 *
 * Scope lives in the rule (`scripts/**` plus workspace-local `<workspace>/*​/scripts/**`, minus test
 * files), so `oxlint.config.ts` only needs `'effect-native/no-effect-run-in-scripts': 'error'`.
 * `allowPaths` exempts globs; `scriptPaths` force-includes globs (the fixtures opt in that way).
 *
 * Report-only: no fixers, no suggestions.
 */
import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree } from '@oxlint/plugins';

import {
  parentOf,
  keyName,
  unwrapNode,
  skipWrappers as sharedSkipWrappers,
  walk as walkAst,
} from '../shared/ast.ts';
import {
  resolveVariable,
  isTrackedReference as trackedReference,
} from '../shared/bindings.ts';
import {
  collectEffectBindings,
  effectMember,
} from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { importedName } from '../shared/imports.ts';
import { isScriptFile, isTestFile, matchesAny } from '../shared/paths.ts';
import {
  isNonReferencePosition,
  isInTypePosition as inTypePosition,
} from '../shared/reference-positions.ts';
import {
  nearestFunction,
  isTopLevel,
  programLevelFunctionName,
} from '../shared/script-entry.ts';

/** `runPromise`, `runPromiseExit`, `runSync`, `runSyncExit`, `runFork`, `runCallback`, `run*With`. */
const RUN_MEMBER = /^run[A-Z]/u;

const EFFECT_MODULE = /^effect(?:\/.*)?$/u;

const PROMISE_CHAIN_METHODS = new Set(['then', 'catch']);
const CLEANUP_CHAIN_METHOD = 'finally';

/** Loops turn one syntactic run site into one root fiber per iteration (S1). */
const LOOP_NODES = new Set([
  'DoWhileStatement',
  'ForInStatement',
  'ForOfStatement',
  'ForStatement',
  'WhileStatement',
]);

/** Wrappers that do not change "is this expression the callee / object / init of its parent". */
const TRANSPARENT_PARENTS = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

/** `TS*` nodes that still contain runtime expressions; any other `TS*` ancestor is a type position. */
const TS_EXPRESSION_NODES = new Set([
  'TSAsExpression',
  'TSInstantiationExpression',
  'TSModuleBlock',
  'TSModuleDeclaration',
  'TSNonNullExpression',
  'TSParameterProperty',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
]);

const FUNCTION_LIKE = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
  'StaticBlock',
]);

/** Export syntax: a re-export mentions the entrypoint without ever invoking it. */
const EXPORT_REFERENCE_PARENTS = new Set([
  'ExportSpecifier',
  'ExportDefaultDeclaration',
  'ExportNamedDeclaration',
  'ExportAllDeclaration',
  'TSExportAssignment',
]);

/**
 * Workspace-local operational scripts (`apps/<app>/scripts/**`, …). `shared/paths.ts#isScriptFile`
 * only recognises the repo-root `scripts/` prefix, so these globs extend the regression guard to
 * every workspace entrypoint without touching the shared helper.
 */
const DEFAULT_SCRIPT_GLOBS: readonly string[] = [
  'scripts/**',
  'apps/*/scripts/**',
  'verticals/*/scripts/**',
  'packages/*/scripts/**',
  'tools/*/scripts/**',
];

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly maxRunSites: number;
  readonly reportPromiseChain: boolean;
  readonly effectModules: readonly string[];
  readonly scriptGlobs: readonly string[];
  readonly scriptPaths: readonly string[];
}

const DEFAULTS: RuleOptions = {
  allowPaths: [],
  maxRunSites: 1,
  reportPromiseChain: true,
  effectModules: ['Effect'],
  scriptGlobs: DEFAULT_SCRIPT_GLOBS,
  scriptPaths: [],
};

type AnyNode = ESTree.Node;

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Partial<Record<keyof RuleOptions, unknown>>;
  const strings = (
    value: unknown,
    fallback: readonly string[]
  ): readonly string[] =>
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string') &&
    value.length > 0
      ? (value as readonly string[])
      : fallback;
  return {
    allowPaths: strings(given.allowPaths, DEFAULTS.allowPaths),
    maxRunSites:
      typeof given.maxRunSites === 'number' &&
      Number.isInteger(given.maxRunSites) &&
      given.maxRunSites >= 0
        ? given.maxRunSites
        : DEFAULTS.maxRunSites,
    reportPromiseChain:
      typeof given.reportPromiseChain === 'boolean'
        ? given.reportPromiseChain
        : DEFAULTS.reportPromiseChain,
    effectModules: strings(given.effectModules, DEFAULTS.effectModules),
    scriptGlobs: strings(given.scriptGlobs, DEFAULTS.scriptGlobs),
    scriptPaths: strings(given.scriptPaths, DEFAULTS.scriptPaths),
  };
}

/** Preserve this rule's narrower transparent-wrapper policy. */
function skipWrappers(node: AnyNode) {
  return sharedSkipWrappers(node, TRANSPARENT_PARENTS);
}
function unwrapExpression(node: AnyNode): AnyNode {
  return unwrapNode(node, { wrappers: TRANSPARENT_PARENTS });
}
function isInTypePosition(node: AnyNode): boolean {
  return inTypePosition(node, TS_EXPRESSION_NODES);
}
const DECLARATION_PARENTS = new Set([
  'LabeledStatement',
  'BreakStatement',
  'ContinueStatement',
]);
const DECLARATION_KEYS = new Set([
  'Property',
  'PropertyDefinition',
  'MethodDefinition',
  'AccessorProperty',
]);
function isDeclarationPosition(node: AnyNode): boolean {
  return isNonReferencePosition(node, {
    detached: false,
    nonReferenceParents: DECLARATION_PARENTS,
    keyParents: DECLARATION_KEYS,
    strictComputed: true,
  });
}
function staticName(key: AnyNode, computed: boolean): string | null {
  return keyName(key, computed, {
    templates: computed,
    rawTemplates: true,
    singleQuasi: true,
  });
}

function sameSpan(left: AnyNode, right: AnyNode): boolean {
  return (
    (left as ESTree.Span).start === (right as ESTree.Span).start &&
    (left as ESTree.Span).end === (right as ESTree.Span).end
  );
}

function isTrackedReference(
  context: Context,
  identifier: AnyNode,
  declaration: AnyNode
): boolean {
  return trackedReference(context, identifier, declaration, sameSpan);
}

interface NamespaceBinding {
  readonly namespace: string;
  readonly declaration: AnyNode;
}

interface RunLocalBinding {
  readonly member: string;
  readonly namespace: string;
  readonly declaration: AnyNode;
}

/** Local bindings that can start a root fiber, tracked through aliasing, destructuring and re-binding. */
interface RunBindings {
  /** local name -> the `Effect`-like namespace object it holds. */
  readonly namespaces: Map<string, NamespaceBinding>;
  /** local name -> declaring identifier for `import * as Fx from "effect"` package namespaces. */
  readonly packages: Map<string, AnyNode>;
  /** local name -> a bare runner (`import { runPromise }`, `const run = …`, `const { runFork } = …`). */
  readonly runLocals: Map<string, RunLocalBinding>;
  readonly tracked: boolean;
}

/**
 * Collect every local that can reach an `Effect.run*` entry point. Type-only imports are skipped:
 * they are erased, so no reference can start a fiber.
 */
interface BindingState {
  readonly context: Context;
  readonly namespaces: Map<string, NamespaceBinding>;
  readonly packages: Map<string, AnyNode>;
  readonly runLocals: Map<string, RunLocalBinding>;
  readonly effectModules: readonly string[];
}
function collectNamedRunner(
  state: BindingState,
  specifier: ESTree.ImportSpecifier,
  source: string
): void {
  if (specifier.importKind === 'type') return;
  const imported = importedName(specifier);
  const local = specifier.local;
  const submodule = source.split('/').at(-1) ?? '';
  if (state.effectModules.includes(imported)) {
    state.namespaces.set(local.name, {
      declaration: local,
      namespace: imported,
    });
  } else if (
    RUN_MEMBER.test(imported) &&
    (source === 'effect' || state.effectModules.includes(submodule))
  ) {
    state.runLocals.set(local.name, {
      declaration: local,
      member: imported,
      namespace:
        source === 'effect' ? (state.effectModules[0] ?? 'Effect') : submodule,
    });
  }
}
function collectRunnerImport(
  state: BindingState,
  statement: ESTree.ImportDeclaration
): void {
  if (
    statement.importKind === 'type' ||
    !EFFECT_MODULE.test(statement.source.value)
  )
    return;
  const source = statement.source.value;
  const submodule = source.split('/').at(-1) ?? '';
  for (const specifier of statement.specifiers) {
    if (specifier.type === 'ImportSpecifier')
      collectNamedRunner(state, specifier, source);
    else if (specifier.type === 'ImportNamespaceSpecifier') {
      if (source === 'effect')
        state.packages.set(specifier.local.name, specifier.local);
      else if (state.effectModules.includes(submodule))
        state.namespaces.set(specifier.local.name, {
          declaration: specifier.local,
          namespace: submodule,
        });
    }
  }
}
function collectRunBindings(
  context: Context,
  program: ESTree.Program,
  effectModules: readonly string[]
): RunBindings {
  const state: BindingState = {
    context,
    effectModules,
    namespaces: new Map(),
    packages: new Map(),
    runLocals: new Map(),
  };
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration')
      collectRunnerImport(state, statement);
  }
  if (state.namespaces.size > 0 || state.packages.size > 0)
    propagateAliases(state, program);
  return {
    namespaces: state.namespaces,
    packages: state.packages,
    runLocals: state.runLocals,
    tracked:
      state.namespaces.size > 0 ||
      state.packages.size > 0 ||
      state.runLocals.size > 0,
  };
}
type AliasKind = NamespaceBinding | 'package';
function packageNamespace(
  state: BindingState,
  member: ESTree.MemberExpression
): NamespaceBinding | null {
  const name = staticName(member.property, member.computed);
  if (name === null || !state.effectModules.includes(name)) return null;
  const object = unwrapExpression(member.object);
  if (object.type !== 'Identifier') return null;
  const declaration = state.packages.get(object.name);
  return declaration !== undefined &&
    isTrackedReference(state.context, object, declaration)
    ? { declaration: object, namespace: name }
    : null;
}
function aliasKind(state: BindingState, init: AnyNode): AliasKind | null {
  if (init.type === 'MemberExpression') return packageNamespace(state, init);
  if (init.type !== 'Identifier') return null;
  const known = state.namespaces.get(init.name);
  if (
    known !== undefined &&
    isTrackedReference(state.context, init, known.declaration)
  )
    return known;
  const declaration = state.packages.get(init.name);
  return declaration !== undefined &&
    isTrackedReference(state.context, init, declaration)
    ? 'package'
    : null;
}
function addBinding<T>(map: Map<string, T>, name: string, value: T): boolean {
  if (map.has(name)) return false;
  map.set(name, value);
  return true;
}
function bindAlias(
  state: BindingState,
  target: ESTree.BindingIdentifier,
  kind: AliasKind
): boolean {
  return kind === 'package'
    ? addBinding(state.packages, target.name, target)
    : addBinding(state.namespaces, target.name, {
        declaration: target,
        namespace: kind.namespace,
      });
}
function bindProperty(
  state: BindingState,
  property: Extract<
    ESTree.ObjectPattern['properties'][number],
    { type: 'Property' }
  >,
  kind: AliasKind
): boolean {
  const key = staticName(property.key, property.computed);
  if (key === null) return false;
  const value =
    property.value.type === 'AssignmentPattern'
      ? property.value.left
      : property.value;
  if (value.type !== 'Identifier') return false;
  if (kind === 'package') {
    return (
      state.effectModules.includes(key) &&
      addBinding(state.namespaces, value.name, {
        declaration: value,
        namespace: key,
      })
    );
  }
  return (
    RUN_MEMBER.test(key) &&
    addBinding(state.runLocals, value.name, {
      declaration: value,
      member: key,
      namespace: kind.namespace,
    })
  );
}
function runnerAlias(
  state: BindingState,
  init: AnyNode
): { member: string; namespace: string } | null {
  if (init.type !== 'MemberExpression') return null;
  const namespace = namespaceOfObject(
    state.context,
    init,
    state.namespaces,
    state.packages,
    state.effectModules
  );
  const member = staticName(init.property, init.computed);
  return namespace !== null && member !== null && RUN_MEMBER.test(member)
    ? { member, namespace }
    : null;
}
function propagateDeclarator(
  state: BindingState,
  declarator: ESTree.VariableDeclarator
): boolean {
  if (declarator.init == null) return false;
  const init = unwrapExpression(declarator.init);
  const target = declarator.id;
  const runner = runnerAlias(state, init);
  if (runner !== null) {
    return (
      target.type === 'Identifier' &&
      addBinding(state.runLocals, target.name, {
        declaration: target,
        ...runner,
      })
    );
  }
  const kind = aliasKind(state, init);
  if (kind === null) return false;
  if (target.type === 'Identifier') return bindAlias(state, target, kind);
  if (target.type !== 'ObjectPattern') return false;
  let changed = false;
  for (const property of target.properties) {
    if (property.type === 'Property' && bindProperty(state, property, kind))
      changed = true;
  }
  return changed;
}
/** Bounded fixed point retains declaration order and the original five-pass limit. */
function propagateAliases(state: BindingState, program: ESTree.Program): void {
  const declarators: ESTree.VariableDeclarator[] = [];
  walkAst(
    program,
    {},
    (node) => {
      if (node.type === 'VariableDeclarator' && node.init != null)
        declarators.push(node);
    },
    false
  );
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    for (const declarator of declarators) {
      if (propagateDeclarator(state, declarator)) changed = true;
    }
    if (!changed) return;
  }
}

/** The `Effect`-like namespace a member expression's *object* denotes (structure only, no scope). */
function namespaceOfObject(
  context: Context,
  node: ESTree.MemberExpression,
  namespaces: ReadonlyMap<string, NamespaceBinding>,
  packages: ReadonlyMap<string, AnyNode>,
  effectModules: readonly string[]
): string | null {
  const object = unwrapExpression(node.object as unknown as AnyNode);
  if (object.type === 'Identifier') {
    const binding = namespaces.get((object as ESTree.IdentifierReference).name);
    return binding !== undefined &&
      isTrackedReference(context, object, binding.declaration)
      ? binding.namespace
      : null;
  }
  if (object.type !== 'MemberExpression') return null;
  const inner = object as ESTree.MemberExpression;
  const name = staticName(inner.property as unknown as AnyNode, inner.computed);
  if (name === null || !effectModules.includes(name)) return null;
  const root = unwrapExpression(inner.object as unknown as AnyNode);
  if (root.type !== 'Identifier') return null;
  const declaration = packages.get((root as ESTree.IdentifierReference).name);
  return declaration !== undefined &&
    isTrackedReference(context, root, declaration)
    ? name
    : null;
}

/**
 * `Effect.runPromise` — also `E["runSync"]`, the template-literal computed form and
 * `Fx.Effect.runPromise` — where the namespace identifier really resolves to the `effect` import.
 */
function runMember(
  context: Context,
  node: ESTree.MemberExpression,
  bindings: RunBindings,
  shared: EffectBindings,
  effectModules: readonly string[]
): { readonly namespace: string; readonly member: string } | null {
  const member = staticName(node.property as unknown as AnyNode, node.computed);
  if (member === null || !RUN_MEMBER.test(member)) return null;
  const object = unwrapExpression(node.object as unknown as AnyNode);
  if (object.type === 'Identifier') {
    const tracked = bindings.namespaces.get(
      (object as ESTree.IdentifierReference).name
    );
    if (tracked === undefined) return null;
    // Cross-check with the shared import tracker for the plain `Effect.runPromise` shape.
    const namespace =
      effectMember(node as unknown as ESTree.Node, shared)?.namespace ??
      tracked.namespace;
    if (!effectModules.includes(namespace)) return null;
    if (!isTrackedReference(context, object, tracked.declaration)) return null;
    return { member, namespace };
  }
  return packageRunMember(context, object, bindings, effectModules, member);
}
function packageRunMember(
  context: Context,
  object: AnyNode,
  bindings: RunBindings,
  effectModules: readonly string[],
  member: string
): { namespace: string; member: string } | null {
  if (object.type !== 'MemberExpression') return null;
  // `import * as Fx from "effect"` -> `Fx.Effect.runSync(...)`.
  const inner = object as ESTree.MemberExpression;
  const namespace = staticName(
    inner.property as unknown as AnyNode,
    inner.computed
  );
  if (namespace === null || !effectModules.includes(namespace)) return null;
  const root = unwrapExpression(inner.object as unknown as AnyNode);
  if (root.type !== 'Identifier') return null;
  const declaration = bindings.packages.get(
    (root as ESTree.IdentifierReference).name
  );
  if (declaration === undefined) return null;
  if (!isTrackedReference(context, root, declaration)) return null;
  return { member, namespace };
}

/** Return a call only when the wrapped expression is its callee. */
function invocation(node: AnyNode): ESTree.CallExpression | null {
  const wrapped = skipWrappers(node);
  return wrapped.parent?.type === 'CallExpression' &&
    wrapped.parent.callee === wrapped.node
    ? wrapped.parent
    : null;
}
function isTopLevelImmediatelyInvoked(fn: AnyNode): boolean {
  const call = invocation(fn);
  return call !== null && isTopLevel(call);
}

/** `export { main }` / `export default main` mention the entrypoint without invoking it. */
function isExportReference(identifier: AnyNode): boolean {
  const parent = parentOf(identifier);
  return parent !== null && EXPORT_REFERENCE_PARENTS.has(parent.type);
}

/**
 * Every *invocation* of `main` happens during module evaluation (top level, or the
 * `import.meta.url === pathToFileURL(process.argv[1]).href` guard). Re-exports are ignored: an
 * `export { main }` / `export default main` specifier is a module-record name, not a call, and the
 * repo's scaffold entrypoints are written that way.
 */
function isOnlyCalledFromTopLevel(
  context: Context,
  fn: AnyNode,
  name: string
): boolean {
  const variable = resolveVariable(context, name, fn);
  if (variable === null) return false;
  const bindingOffsets = new Set(
    variable.identifiers.map(
      (identifier) => (identifier as unknown as ESTree.Span).start
    )
  );
  const uses = variable.references.filter(
    (reference) =>
      reference.init !== true &&
      !bindingOffsets.has(
        (reference.identifier as unknown as ESTree.Span).start
      ) &&
      !isExportReference(reference.identifier as unknown as AnyNode)
  );
  if (uses.length === 0) return false;
  return uses.every((reference) =>
    isTopLevelImmediatelyInvoked(reference.identifier as AnyNode)
  );
}

/**
 * The executable edge of a script: module-evaluation code, a top-level IIFE, or a Program-level
 * `main` that is only ever invoked from module-evaluation code (exported or not).
 */
function isEntryPosition(context: Context, site: AnyNode): boolean {
  const fn = nearestFunction(site);
  if (fn === null) return true;
  if (nearestFunction(fn) !== null) return false;
  if (isTopLevelImmediatelyInvoked(fn)) return true;
  const name = programLevelFunctionName(fn);
  if (name === null) return false;
  return isOnlyCalledFromTopLevel(context, fn, name);
}

/** A run site that re-enters Effect once per iteration of an enclosing loop (S1). */
function isInLoop(site: AnyNode): boolean {
  let current = parentOf(site);
  while (current !== null) {
    if (FUNCTION_LIKE.has(current.type)) return false;
    if (LOOP_NODES.has(current.type)) return true;
    current = parentOf(current);
  }
  return false;
}

/** Only definite case termination proves mutually exclusive dispatch; fallthrough can run both. */
function switchHasNoFallthrough(node: ESTree.SwitchStatement): boolean {
  const terminates = (statement: ESTree.Node | undefined): boolean => {
    if (statement === undefined) return false;
    if (
      statement.type === 'BreakStatement' ||
      statement.type === 'ReturnStatement' ||
      statement.type === 'ThrowStatement'
    )
      return true;
    if (statement.type === 'BlockStatement')
      return terminates(statement.body.at(-1));
    if (statement.type === 'IfStatement')
      return (
        terminates(statement.consequent) &&
        statement.alternate !== null &&
        terminates(statement.alternate)
      );
    return false;
  };
  return node.cases
    .slice(0, -1)
    .every(
      (branch) =>
        branch.consequent.length === 0 || terminates(branch.consequent.at(-1))
    );
}

interface Decision {
  readonly id: number;
  readonly branch: string;
}

/**
 * The chain of mutually exclusive branch choices (outermost first) leading to a node: `if`/`else`
 * arms, `switch` cases and conditional-expression arms. Two sites whose paths diverge at the same
 * decision node can never both start a root fiber in one process run.
 */
function decisionPath(site: AnyNode): readonly Decision[] {
  const path: Decision[] = [];
  let child = site;
  let current = parentOf(child);
  while (current !== null) {
    if (
      current.type === 'IfStatement' ||
      current.type === 'ConditionalExpression'
    ) {
      const branching = current as unknown as {
        consequent?: unknown;
        alternate?: unknown;
      };
      if (branching.consequent === child)
        path.push({ branch: 'then', id: (current as ESTree.Span).start });
      else if (branching.alternate === child)
        path.push({ branch: 'else', id: (current as ESTree.Span).start });
    } else if (current.type === 'SwitchCase') {
      const parent = parentOf(current);
      if (
        parent !== null &&
        parent.type === 'SwitchStatement' &&
        switchHasNoFallthrough(parent as ESTree.SwitchStatement)
      ) {
        path.push({
          branch: `case:${(current as ESTree.Span).start}`,
          id: (parent as ESTree.Span).start,
        });
      }
    }
    child = current;
    current = parentOf(current);
  }
  return path.reverse();
}

/** `true` when two run sites live in different branches of the same `if` chain / `switch`. */
function mutuallyExclusive(
  left: readonly Decision[],
  right: readonly Decision[]
): boolean {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return false;
    if (a.id !== b.id) return false;
    if (a.branch !== b.branch) return true;
  }
  return false;
}

/** `.then` / `.catch` / `.finally` invoked directly on a run call. */
function promiseChainMethod(site: AnyNode): string | null {
  if (site.type !== 'CallExpression') return null;
  const chained = skipWrappers(site);
  const member = chained.parent;
  if (member === null || member.type !== 'MemberExpression') return null;
  if ((member as ESTree.MemberExpression).object !== chained.node) return null;
  const method = staticName(
    (member as ESTree.MemberExpression).property as unknown as AnyNode,
    (member as ESTree.MemberExpression).computed
  );
  if (
    method === null ||
    (!PROMISE_CHAIN_METHODS.has(method) && method !== CLEANUP_CHAIN_METHOD)
  )
    return null;
  return invocation(member) !== null ? method : null;
}

function isAliasInitializer(node: AnyNode): boolean {
  const wrapped = skipWrappers(node);
  const parent = wrapped.parent;
  return (
    parent?.type === 'VariableDeclarator' &&
    parent.init === wrapped.node &&
    parent.id.type === 'Identifier'
  );
}
function chargeSlot(
  charged: Array<Array<readonly Decision[]>>,
  path: readonly Decision[]
): number {
  const slot = charged.findIndex((alternatives) =>
    alternatives.every((other) => mutuallyExclusive(other, path))
  );
  if (slot !== -1) {
    charged[slot]?.push(path);
    return slot;
  }
  charged.push([path]);
  return charged.length - 1;
}

interface RunSite {
  readonly node: AnyNode;
  readonly namespace: string;
  readonly member: string;
  readonly start: number;
  readonly end: number;
}

/** Effect-native rule: a script starts exactly one root fiber, at its executable edge. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B3/A1/S1: operational scripts may start a root fiber (Effect.run*) only once, at the executable edge. Nested runs, runs inside loops, extra simultaneously reachable runs and .then/.catch/.finally chains on a run call are reported.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#b3-convert-consequential-operational-scripts-into-effect-programs',
    },
    messages: {
      nestedRun:
        "Audit B3/A1: {{namespace}}.{{member}} inside a function starts a new root fiber, so this script's Layer, ConfigProvider, Scope, Clock, spans, log annotations and interruption never reach it. Return an Effect<A, E, R> from this function and run it once at the executable edge (Effect.runPromiseExit(main()) under the import.meta.url guard).",
      runInLoop:
        'Audit B3/S1: {{namespace}}.{{member}} inside a loop starts one root fiber per iteration, rebuilding the runtime and losing the shared Layer, Scope and interruption each time. Iterate inside the program with Effect.forEach (add { concurrency } for fan-out) and keep the single run at the edge.',
      extraRun:
        'Audit B3/S1: this script already starts a root fiber at its executable edge, and {{namespace}}.{{member}} starts another one with its own context. Compose the programs into one Effect (Effect.all / Effect.gen / Effect.andThen) and run that single Effect once.',
      promiseChainOnRun:
        'Audit B3/A1: .{{method}}() on {{namespace}}.{{member}} turns typed failures back into Promise rejections and erases the error channel. Use Effect.runPromiseExit + Exit.match (or handle failures inside the Effect with Effect.catchTag / Effect.tapErrorCause) and set process.exitCode from the Exit.',
      promiseFinallyOnRun:
        'Audit B3/A1: .finally() on {{namespace}}.{{member}} runs cleanup outside the program, after the fiber and its Scope are already gone. Release resources inside the Effect with Effect.ensuring / Effect.acquireRelease / Effect.scoped and run that scoped program once at the edge.',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowPaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs of script files exempted from this rule (default: none).',
          },
          maxRunSites: {
            type: 'integer',
            minimum: 0,
            description:
              'How many simultaneously reachable Effect.run* sites the executable edge may contain (default: 1).',
          },
          reportPromiseChain: {
            type: 'boolean',
            description:
              'Report .then/.catch/.finally chained onto a run call (default: true).',
          },
          effectModules: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Effect namespaces whose run* members start a root fiber (default: ["Effect"]).',
          },
          scriptGlobs: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs of operational scripts in scope, in addition to shared/paths.ts isScriptFile (default: scripts/** plus <workspace>/*/scripts/**).',
          },
          scriptPaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs treated as in-scope scripts, bypassing both the script-path and test-file detection (default: none; the rule fixtures use it).',
          },
        },
      },
    ],
    defaultOptions: [
      {
        allowPaths: [],
        maxRunSites: 1,
        reportPromiseChain: true,
        effectModules: ['Effect'],
        scriptGlobs: [...DEFAULT_SCRIPT_GLOBS],
        scriptPaths: [],
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options?.[0]);
    const filename = context.filename;
    // `scriptPaths` is an explicit opt-in that overrides both built-in scope checks.
    const forced = matchesAny(filename, options.scriptPaths);
    if (!forced) {
      const inScope =
        isScriptFile(filename) || matchesAny(filename, options.scriptGlobs);
      if (!inScope || isTestFile(filename)) return {};
    }
    if (matchesAny(filename, options.allowPaths)) return {};

    let shared: EffectBindings | null = null;
    let bindings: RunBindings | null = null;
    const sites: RunSite[] = [];
    const seen = new Set<string>();

    const addSite = (
      node: AnyNode,
      namespace: string,
      member: string
    ): void => {
      const start = (node as ESTree.Span).start;
      const end = (node as ESTree.Span).end;
      const key = `${start}:${end}`;
      if (seen.has(key)) return;
      seen.add(key);
      sites.push({ end, member, namespace, node, start });
    };

    return {
      Program(node) {
        shared = collectEffectBindings(node);
        bindings = collectRunBindings(context, node, options.effectModules);
      },
      MemberExpression(node) {
        if (bindings === null || shared === null || !bindings.tracked) return;
        const matched = runMember(
          context,
          node,
          bindings,
          shared,
          options.effectModules
        );
        if (matched === null) return;
        const self = node as unknown as AnyNode;
        if (isInTypePosition(self)) return;
        const call = invocation(self);
        if (call !== null) {
          addSite(call, matched.namespace, matched.member);
          return;
        }
        if (isAliasInitializer(self)) return;
        // A point-free reference (`pipe(program, Effect.runPromise)`) still starts a root fiber.
        addSite(self, matched.namespace, matched.member);
      },
      Identifier(node) {
        if (bindings === null || bindings.runLocals.size === 0) return;
        const identifier = node as unknown as AnyNode;
        const tracked = bindings.runLocals.get(
          (node as ESTree.IdentifierReference).name
        );
        if (tracked === undefined) return;
        if (sameSpan(identifier, tracked.declaration)) return;
        if (isDeclarationPosition(identifier) || isInTypePosition(identifier))
          return;
        if (!isTrackedReference(context, identifier, tracked.declaration))
          return;
        addSite(
          invocation(identifier) ?? identifier,
          tracked.namespace,
          tracked.member
        );
      },
      'Program:exit'() {
        if (sites.length === 0) return;
        const ordered = [...sites].sort(
          (left, right) => left.start - right.start || right.end - left.end
        );
        // Skip run sites nested inside another run site's expression; the outer one is the report.
        const outer = ordered.filter(
          (site) =>
            !ordered.some(
              (other) =>
                other !== site &&
                other.start <= site.start &&
                site.end <= other.end &&
                !(other.start === site.start && other.end === site.end)
            )
        );
        const charged: Array<Array<readonly Decision[]>> = [];
        for (const site of outer) {
          const data = { member: site.member, namespace: site.namespace };
          if (!isEntryPosition(context, site.node)) {
            context.report({ node: site.node, messageId: 'nestedRun', data });
            continue;
          }
          const path = decisionPath(site.node);
          // A slot may be reused only if this site is exclusive with EVERY alternative
          // already occupying it, not merely one site in some other branch.
          const slot = chargeSlot(charged, path);
          if (isInLoop(site.node)) {
            context.report({ node: site.node, messageId: 'runInLoop', data });
            continue;
          }
          if (slot >= options.maxRunSites) {
            context.report({ node: site.node, messageId: 'extraRun', data });
            continue;
          }
          const method = options.reportPromiseChain
            ? promiseChainMethod(site.node)
            : null;
          if (method === CLEANUP_CHAIN_METHOD) {
            context.report({
              node: site.node,
              messageId: 'promiseFinallyOnRun',
              data,
            });
          } else if (method !== null) {
            context.report({
              node: site.node,
              messageId: 'promiseChainOnRun',
              data: { ...data, method },
            });
          }
        }
      },
    };
  },
});
