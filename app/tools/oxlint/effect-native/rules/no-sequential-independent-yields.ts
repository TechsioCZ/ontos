/**
 * effect-native/no-sequential-independent-yields
 *
 * Audit finding enforced (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`):
 *
 *   - **B1** "Make workers and independent reads declaratively concurrent" — "independent remote
 *     providers and enrichment reads are frequently sequential". Evidence:
 *     `apps/shell-super-app/api/modules/shell-resources.ts:191` and `:236`,
 *     `apps/shell-super-app/src/routes/module-entrypoint-loader.ts:32`,
 *     `packages/core-runtime/src/outbox/runtime.ts:262`, `packages/core-runtime/src/outbox/poller.ts:166`.
 *     B1's prescription: "Use `Stream`, `Schedule`, bounded `Effect.forEach`/`Effect.all`, typed retry
 *     schedules, explicit timeouts […] Preserve deterministic ordering where business semantics
 *     actually require it."
 *
 * Adjacent yields with no lexical data dependency are review candidates, not evidence of
 * semantic independence. Calls may share state, resources, failure ordering or authorization
 * requirements even if their results do not reference one another. No automatic concurrency
 * conversion is justified by this detector. B1 requires preserving business ordering.
 *
 * ## What is detected
 *
 * Inside a generator handed to `Effect.gen` / `Effect.fn` / `Effect.fnUntraced` (aliased imports,
 * `effect/Effect` submodule namespace imports, root `import * as E from "effect"` → `E.Effect.gen`,
 * direct member imports `import { gen } from "effect/Effect"`, computed `Effect["gen"]`, optional
 * `Effect?.gen`, curried `Effect.fn("name")(function* () {})` and configured re-export barrels are
 * all recognised), the rule looks at each statement list — the generator body, and every nested
 * `BlockStatement` / `SwitchCase` that is not inside a nested function.
 *
 * A statement is a *candidate read* when it is a single-declarator `const`/`let` whose initialiser is
 * a delegating `yield*` and whose pipe-unwrapped subject (`x.pipe(...)`, `pipe(x, ...)`, parens,
 * `as`, `satisfies`, `!`, optional chaining are all peeled) is one of
 *   - a `CallExpression` with a `MemberExpression` callee — `gateway.prepareSnapshot(ctx, ids)`,
 *   - a `CallExpression` with a plain `Identifier` callee — `loadHumanBindings(principalId)`
 *     (`includeFunctionCallees`, default `true`; the repository's independent reads are frequently
 *     module-local generator helpers such as `loadHumanBindings`),
 * and the callee is **not** an `effect` namespace member (`Effect.all`, `Schema.decode`, …).
 *
 * For each maximal run of adjacent candidate reads, the second and every later member of the run is
 * reported when its whole `yield*` subtree references none of the identifiers bound by any earlier
 * statement of that run. A statement that does consume an earlier binding ends the run and starts a
 * new one, so `a → b(a) → c` reports nothing for `b` and compares `c` only against `b`.
 *
 * ## What is deliberately allowed
 *
 * - **`Effect.all` / `Effect.forEach` / any `effect` combinator** — the target shape. A candidate
 *   requires a non-`effect` callee, so `const [a, b] = yield* Effect.all([...], { concurrency: 2 })`
 *   is never matched. (Bounded-concurrency policy is `require-concurrency-option`'s job.)
 * - **Service acquisition** — `const db = yield* CoreDatabase;` yields a bare `Identifier` (a
 *   `Context.Service` tag), never a call. Layer construction bodies that acquire ten services in a
 *   row are not remote reads and are never reported. `Context.Service` is blessed in "Existing
 *   patterns to preserve"; this rule leaves it entirely alone.
 * - **Ordering-bearing callees** (`orderingCalleePattern`, default matches `lock`, `acquire`,
 *   `begin`, `install`, `validate`, `verify`, `check`, `assert`, `ensure`, `require`, `recheck`,
 *   `commit`, `flush`, `transition`, `fail`, `succeed`, `complete`, `log`, `record`, `emit`,
 *   `publish`, `write`, `insert`, `update`, `delete`, `persist`, `claim` prefixes). S1's `lock →
 *   validate → install scope → recheck → execute → flush → commit` pipeline (audit S1) is an ordered
 *   program, and a `require…`/`ensure…`/`verify…` accessor is a precondition guard that must be
 *   observed before the work it protects; naming the step is how a developer declares the ordering is
 *   semantic. Such a statement is a hard barrier: it neither reports nor starts a run.
 * - **Anything separated by other statements** — an `if`, a `return`, a plain `const`, a log line or
 *   a comment-bearing statement between the two reads breaks adjacency and the run.
 * - **Destructured dependency** — `const { id } = yield* a.load(); const b = yield* c.get(id);`
 *   references `id`, so it is a genuine data dependency and is not reported.
 * - **Tests** (`includeTests`, default `false`) and **`scripts/`** (`includeScripts`, default
 *   `false`): B2 and B3 own those surfaces. Anything outside `include`, anything matching `ignore`,
 *   and any generator whose wrapper is not an `effect` `Effect.gen`/`fn`/`fnUntraced` binding (a
 *   local `const Effect = { gen }` shadow, a redux-saga generator) is untouched.
 *
 * Known limitation, stated in the rule spec: ordering that exists only in the domain (a read whose
 * result must be observed *after* an earlier side effect, without either callee saying so) is
 * indistinguishable from accidental sequencing without types. `orderingCalleePattern` is the escape
 * hatch for known ordering steps, not a proof that all other calls commute. Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree } from '@oxlint/plugins';

import {
  collectEffectBindings,
  effectMember,
  type EffectBindings,
} from '../shared/effect-imports.ts';
import { globToRegExp, isScriptFile, isTestFile, normalisePath } from '../shared/paths.ts';

/** Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`. */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const EFFECT_NAMESPACE = 'Effect';
const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_EFFECT_MODULE = /^effect\/(?:.*\/)?Effect$/u;

const DEFAULT_INCLUDE: readonly string[] = ['apps/**', 'verticals/**', 'packages/**'];
const DEFAULT_IGNORE: readonly string[] = [
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  'tools/**',
  '**/*.d.ts',
];
const DEFAULT_SCRIPT_GLOBS: readonly string[] = ['scripts/**', '**/scripts/**'];
const DEFAULT_GEN_MEMBERS: readonly string[] = ['gen', 'fn', 'fnUntraced'];
/** Barrels that re-export `Effect` verbatim, so `Effect.gen` there is the same generator. */
const DEFAULT_EFFECT_MODULES: readonly string[] = [
  '@modern-js/plugin-bff/effect-client',
  '@modern-js/plugin-bff/effect-edge',
];
/**
 * Callee prefixes that assert the step's position in a program is semantic. Mirrors the S1 target
 * pipeline (`lock → validate → install scope → recheck → execute → flush → commit`) plus the write /
 * observation verbs whose ordering is observable.
 */
const DEFAULT_ORDERING_PATTERN =
  '^(lock|acquire|begin|install|validate|verify|check|assert|ensure|require|recheck|commit|flush|transition|fail|succeed|complete|log|record|emit|publish|write|insert|update|delete|persist|claim|authenticate|authorize|reconcile|create|archive|send|notify|terminate|revoke|sync|seed|dispatch|enqueue)';

const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);
const MEMBER_TYPES: ReadonlySet<string> = new Set([
  'ComputedMemberExpression',
  'MemberExpression',
  'StaticMemberExpression',
]);
const WRAPPER_TYPES: ReadonlySet<string> = new Set([
  'ChainExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSInstantiationExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
]);

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly includeTests: boolean;
  readonly includeScripts: boolean;
  readonly includeFunctionCallees: boolean;
  readonly orderingCalleePattern: string;
  readonly genMembers: readonly string[];
  readonly effectModules: readonly string[];
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
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
    includeTests: boolean(record.includeTests, false),
    includeScripts: boolean(record.includeScripts, false),
    includeFunctionCallees: boolean(record.includeFunctionCallees, true),
    orderingCalleePattern:
      typeof record.orderingCalleePattern === 'string'
        ? record.orderingCalleePattern
        : DEFAULT_ORDERING_PATTERN,
    genMembers: stringArray(record.genMembers, DEFAULT_GEN_MEMBERS),
    effectModules: stringArray(record.effectModules, DEFAULT_EFFECT_MODULES),
  };
}

function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

interface AnyNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly parent?: AnyNode | null;
  readonly [key: string]: unknown;
}

function asNode(value: unknown): AnyNode | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { type?: unknown; start?: unknown };
  if (typeof candidate.type !== 'string' || typeof candidate.start !== 'number') return null;
  return value as AnyNode;
}

function parentOf(node: AnyNode | null): AnyNode | null {
  return (node?.parent as AnyNode | null | undefined) ?? null;
}

/** Strip parens, `!`, `as`, `satisfies` and optional-chaining wrappers to reach the real expression. */
function unwrap(value: unknown): AnyNode | null {
  let current = asNode(value);
  for (let guard = 0; current !== null && guard < 16; guard += 1) {
    if (!WRAPPER_TYPES.has(current.type)) return current;
    const inner = asNode(current.expression);
    if (inner === null) return current;
    current = inner;
  }
  return current;
}

/** Non-computed `.member`, or computed `["member"]`. */
function memberName(node: AnyNode): string | null {
  const property = asNode(node.property);
  if (property === null) return null;
  if (node.computed !== true)
    return property.type === 'Identifier' ? (property.name as string) : null;
  if (property.type === 'TemplateLiteral') return staticString(property as unknown as ESTree.Node);
  if (
    (property.type === 'Literal' || property.type === 'StringLiteral') &&
    typeof property.value === 'string'
  ) {
    return property.value;
  }
  return null;
}

/** Locals bound by `import * as X from "effect"` — `X.Effect.gen` must still be recognised. */
function collectRootNamespaces(program: ESTree.Program): ReadonlySet<string> {
  const locals = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (statement.source.value !== EFFECT_ROOT_MODULE) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') locals.add(specifier.local.name);
    }
  }
  return locals;
}

/** Locals bound by `import { gen, fn } from "effect/Effect"` — bare `gen(function* ())` must be caught. */
function collectDirectMemberImports(
  program: ESTree.Program,
  members: readonly string[],
): ReadonlySet<string> {
  const locals = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (!EFFECT_EFFECT_MODULE.test(statement.source.value)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported =
        specifier.imported.type === 'Identifier'
          ? specifier.imported.name
          : specifier.imported.value;
      if (members.includes(imported)) locals.add(specifier.local.name);
    }
  }
  return locals;
}

/** Extend `effect` bindings with named `Effect` imports from configured re-export barrels. */
function bindingsWithExtraModules(
  program: ESTree.Program,
  modules: readonly string[],
): EffectBindings {
  const base = collectEffectBindings(program);
  if (modules.length === 0) return base;
  const namespaces = new Map(base.namespaces);
  let importsEffect = base.importsEffect;
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (!modules.includes(statement.source.value)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported =
        specifier.imported.type === 'Identifier'
          ? specifier.imported.name
          : specifier.imported.value;
      if (imported !== EFFECT_NAMESPACE) continue;
      namespaces.set(specifier.local.name, EFFECT_NAMESPACE);
      importsEffect = true;
    }
  }
  return { importsEffect, namespaces };
}

interface GeneratorMatcher {
  readonly context: Context;
  readonly effectModules: readonly string[];
  readonly bindings: EffectBindings;
  readonly rootNamespaces: ReadonlySet<string>;
  readonly directMembers: ReadonlySet<string>;
  readonly genMembers: readonly string[];
}

/** `Effect.gen` / `E.gen` / `X.Effect.gen` / bare `gen` (direct member import), incl. computed + optional. */
function isGenCallee(callee: AnyNode | null, matcher: GeneratorMatcher, depth = 0): boolean {
  if (depth > 8 || callee === null) return false;
  const target = identityUnwrap(callee as unknown as ESTree.Node);
  if (target.type === 'CallExpression')
    return isGenCallee(asNode(target.callee), matcher, depth + 1);
  const path = bindingPath(matcher.context, target, matcher.effectModules);
  return path?.length === 2 && path[0] === 'Effect' && matcher.genMembers.includes(path[1] ?? '');
}

/** `true` when `fn` is a generator function handed to `Effect.gen` / `Effect.fn` / `Effect.fnUntraced`. */
function isEffectGenerator(fn: AnyNode, matcher: GeneratorMatcher): boolean {
  if (fn.generator !== true) return false;
  let outer = fn;
  while (parentOf(outer) !== null && WRAPPER_TYPES.has(parentOf(outer)!.type))
    outer = parentOf(outer)!;
  const call = parentOf(outer);
  if (call === null || call.type !== 'CallExpression') return false;
  const args = call.arguments;
  if (!Array.isArray(args)) return false;
  const present = args.some((argument) => {
    const node = unwrap(argument);
    return node !== null && node.start === fn.start && node.end === fn.end;
  });
  if (!present) return false;
  return isGenCallee(asNode(call.callee), matcher);
}

type Walker = (node: AnyNode) => boolean;

function childrenOf(
  node: AnyNode,
  visitorKeys: Readonly<Record<string, readonly string[]>>,
): AnyNode[] {
  const keys = visitorKeys[node.type];
  const names = keys ?? Object.keys(node).filter((key) => key !== 'parent' && key !== 'type');
  const children: AnyNode[] = [];
  for (const name of names) {
    const value = node[name];
    if (Array.isArray(value)) {
      for (const entry of value) {
        const child = asNode(entry);
        if (child !== null) children.push(child);
      }
      continue;
    }
    const child = asNode(value);
    if (child !== null) children.push(child);
  }
  return children;
}

/** Depth-first walk; `visit` returns `false` to skip the node's children. */
function walk(
  node: AnyNode,
  visitorKeys: Readonly<Record<string, readonly string[]>>,
  visit: Walker,
): void {
  const stack: AnyNode[] = [node];
  let guard = 0;
  while (stack.length > 0 && guard < 200_000) {
    guard += 1;
    const current = stack.pop();
    if (current === undefined) break;
    if (!visit(current)) continue;
    const children = childrenOf(current, visitorKeys);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }
}

/** Peel `x.pipe(a, b)` and `pipe(x, a, b)` down to the piped subject. */
function unwrapPipe(value: unknown, context: Context, modules: readonly string[]): AnyNode | null {
  let current = unwrap(value);
  for (let guard = 0; current !== null && guard < 32; guard += 1) {
    if (current.type !== 'CallExpression') return current;
    const callee = unwrap(current.callee);
    if (callee === null) return current;
    if (MEMBER_TYPES.has(callee.type) && memberName(callee) === 'pipe') {
      current = unwrap(callee.object);
      continue;
    }
    if (
      ['pipe', 'Function.pipe'].includes(
        bindingPath(context, callee as unknown as ESTree.Node, modules)?.join('.') ?? '',
      )
    ) {
      const args = current.arguments;
      const first = Array.isArray(args) ? unwrap(args[0]) : null;
      if (first === null) return current;
      current = first;
      continue;
    }
    return current;
  }
  return current;
}

/** Binding names introduced by a declarator pattern (object/array patterns included). */
function collectPatternNames(
  pattern: AnyNode | null,
  visitorKeys: Readonly<Record<string, readonly string[]>>,
): Set<string> {
  const names = new Set<string>();
  if (pattern === null) return names;
  walk(pattern, visitorKeys, (node) => {
    if (node.type === 'Identifier') {
      names.add(node.name as string);
      return false;
    }
    if (
      node.type === 'Property' ||
      node.type === 'ObjectProperty' ||
      node.type === 'PropertyDefinition'
    ) {
      // `{ key: local }` binds `local`; `{ key }` is shorthand and binds `key` via the same node.
      if (node.computed === true) {
        const key = asNode(node.key);
        if (key !== null)
          walk(key, visitorKeys, (inner) => {
            if (inner.type === 'Identifier') {
              names.add(inner.name as string);
              return false;
            }
            return true;
          });
      }
      const value = asNode(node.value);
      if (value !== null) {
        walk(value, visitorKeys, (inner) => {
          if (inner.type === 'Identifier') {
            names.add(inner.name as string);
            return false;
          }
          return true;
        });
      }
      return false;
    }
    return true;
  });
  return names;
}

/** Identifiers *read* by an expression: member property names and literal object keys are not reads. */
function collectReferencedNames(
  node: AnyNode,
  visitorKeys: Readonly<Record<string, readonly string[]>>,
): Set<string> {
  const names = new Set<string>();
  walk(node, visitorKeys, (current) => {
    if (current.type === 'Identifier') {
      names.add(current.name as string);
      return false;
    }
    if (MEMBER_TYPES.has(current.type) && current.computed !== true) {
      const object = asNode(current.object);
      if (object !== null)
        walk(object, visitorKeys, (inner) => collectInto(inner, names, visitorKeys));
      return false;
    }
    if (
      (current.type === 'Property' || current.type === 'ObjectProperty') &&
      current.computed !== true
    ) {
      // `{ tenantId: value }` — the key is a label, the value is a read. Shorthand shares the node.
      if (current.shorthand === true) return true;
      const value = asNode(current.value);
      if (value !== null)
        walk(value, visitorKeys, (inner) => collectInto(inner, names, visitorKeys));
      return false;
    }
    return true;
  });
  return names;
}

/** Shared visitor body so nested walks apply the same member/property rules. */
function collectInto(
  current: AnyNode,
  names: Set<string>,
  visitorKeys: Readonly<Record<string, readonly string[]>>,
): boolean {
  if (current.type === 'Identifier') {
    names.add(current.name as string);
    return false;
  }
  if (MEMBER_TYPES.has(current.type) && current.computed !== true) {
    const object = asNode(current.object);
    if (object !== null)
      walk(object, visitorKeys, (inner) => collectInto(inner, names, visitorKeys));
    return false;
  }
  if (
    (current.type === 'Property' || current.type === 'ObjectProperty') &&
    current.computed !== true
  ) {
    if (current.shorthand === true) return true;
    const value = asNode(current.value);
    if (value !== null) walk(value, visitorKeys, (inner) => collectInto(inner, names, visitorKeys));
    return false;
  }
  return true;
}

interface Candidate {
  /** The `MemberExpression` the read goes through — reported node and message label. */
  readonly calleeNode: AnyNode;
  /** Trailing property name, e.g. `prepareSnapshot` in `gateway.prepareSnapshot(...)`. */
  readonly calleeName: string;
  readonly bound: ReadonlySet<string>;
  readonly referenced: ReadonlySet<string>;
  readonly ordering: boolean;
}

function label(context: Context, node: AnyNode): string {
  const text = context.sourceCode
    .getText(node as unknown as ESTree.Node)
    .replace(/\s+/gu, ' ')
    .replace(/\s*(\??\.)\s*/gu, '$1')
    .trim();
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Report-only rule: adjacent independent `yield*` reads inside `Effect.gen` (audit B1). */
// Resolve lexical value bindings, not identifier spellings. Only immutable local aliases are
// followed; arbitrary object mutation, re-export contents and dynamic keys need type/data-flow analysis.
function lexicalVariable(context: Context, node: Extract<ESTree.Node, { type: 'Identifier' }>) {
  let scope: import('@oxlint/plugins').Scope | null = context.sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(node.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}
function staticString(node: ESTree.Node): string | null {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? null;
  return null;
}
function identityUnwrap(node: ESTree.Node): ESTree.Node {
  let current = node;
  for (;;) {
    if (current.type === 'SequenceExpression') {
      const last = current.expressions.at(-1);
      if (last === undefined) return current;
      current = last;
    } else if (
      [
        'ChainExpression',
        'ParenthesizedExpression',
        'TSAsExpression',
        'TSTypeAssertion',
        'TSNonNullExpression',
        'TSSatisfiesExpression',
        'TSInstantiationExpression',
      ].includes(current.type)
    ) {
      current = (current as unknown as { expression: ESTree.Node }).expression;
    } else return current;
  }
}
function bindingPath(
  context: Context,
  expression: ESTree.Node,
  extraModules: readonly string[] = [],
  seen = new Set<unknown>(),
): readonly string[] | null {
  const node = identityUnwrap(expression);
  if (node.type === 'MemberExpression') {
    const key =
      !node.computed && node.property.type === 'Identifier'
        ? node.property.name
        : staticString(node.property);
    const root = bindingPath(context, node.object, extraModules, seen);
    return root !== null && key !== null ? [...root, key] : null;
  }
  if (node.type !== 'Identifier') return null;
  const variable = lexicalVariable(context, node);
  if (variable === null || seen.has(variable)) return null;
  seen.add(variable);
  if (variable.defs.length !== 1) return null;
  const definition = variable.defs[0];
  if (definition === undefined) return null;
  if (definition.type === 'ImportBinding') {
    const specifier = definition.node as
      | ESTree.ImportSpecifier
      | ESTree.ImportNamespaceSpecifier
      | ESTree.ImportDefaultSpecifier;
    const declaration = definition.parent as ESTree.ImportDeclaration;
    if (declaration?.type !== 'ImportDeclaration' || declaration.importKind === 'type') return null;
    if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') return null;
    const source = declaration.source.value;
    if (source !== 'effect' && !source.startsWith('effect/') && !extraModules.includes(source))
      return null;
    const last = source.split('/').at(-1) ?? '';
    const base = source.startsWith('effect/') && /^[A-Z]/u.test(last) ? [last] : [];
    if (specifier.type === 'ImportNamespaceSpecifier') return base;
    if (specifier.type !== 'ImportSpecifier') return null;
    const imported =
      specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
    return [...base, imported];
  }
  if (definition.type !== 'Variable') return null;
  const declaration = definition.node as ESTree.VariableDeclarator;
  const parent = definition.parent as ESTree.VariableDeclaration;
  if (parent?.kind !== 'const' || declaration.init === null) return null;
  const base = bindingPath(context, declaration.init, extraModules, seen);
  if (base === null) return null;
  if (declaration.id.type === 'Identifier') return base;
  if (declaration.id.type !== 'ObjectPattern') return null;
  for (const property of declaration.id.properties) {
    if (
      property.type === 'RestElement' ||
      property.value.type !== 'Identifier' ||
      property.value.name !== node.name
    )
      continue;
    const key =
      !property.computed && property.key.type === 'Identifier'
        ? property.key.name
        : staticString(property.key);
    return key === null ? null : [...base, key];
  }
  return null;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B1: adjacent `const x = yield* service.read(...)` statements inside `Effect.gen`/`Effect.fn` ' +
        'with no lexical reference to earlier results are review candidates, not proof of safe concurrency. ' +
        'Value accessors and named ordering steps are excluded; shared state and failure ordering are unknown.',
    },
    messages: {
      sequentialIndependentYields:
        '`{{second}}` follows `{{first}}` with no syntactic reference to earlier results (audit B1). ' +
        'Review whether these are independent remote reads before using bounded Effect.all. ' +
        'Non-reference does NOT prove safe concurrency: preserve ordering for shared state, failures, ' +
        'authorization and resource limits. This is a review heuristic, not proof of an antipattern.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          includeTests: { type: 'boolean' },
          includeScripts: { type: 'boolean' },
          includeFunctionCallees: { type: 'boolean' },
          orderingCalleePattern: { type: 'string' },
          genMembers: { type: 'array', items: { type: 'string' } },
          effectModules: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: [...DEFAULT_INCLUDE],
        ignore: [...DEFAULT_IGNORE],
        includeTests: false,
        includeScripts: false,
        includeFunctionCallees: true,
        orderingCalleePattern: DEFAULT_ORDERING_PATTERN,
        genMembers: [...DEFAULT_GEN_MEMBERS],
        effectModules: [...DEFAULT_EFFECT_MODULES],
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore)) return {};
    if (!options.includeScripts && (isScriptFile(path) || matchesGlobs(path, DEFAULT_SCRIPT_GLOBS)))
      return {};
    if (
      !matchesGlobs(path, options.include) &&
      !(options.includeScripts && (isScriptFile(path) || matchesGlobs(path, DEFAULT_SCRIPT_GLOBS)))
    )
      return {};
    if (!options.includeTests && isTestFile(path)) return {};

    const program = context.sourceCode.ast;
    const rootNamespaces = collectRootNamespaces(program);
    const directMembers = collectDirectMemberImports(program, options.genMembers);
    const bindings = bindingsWithExtraModules(program, options.effectModules);
    if (!bindings.importsEffect && rootNamespaces.size === 0 && directMembers.size === 0) return {};

    const matcher: GeneratorMatcher = {
      context,
      effectModules: options.effectModules,
      bindings,
      directMembers,
      genMembers: options.genMembers,
      rootNamespaces,
    };
    const visitorKeys = context.sourceCode.visitorKeys;
    let ordering: RegExp;
    try {
      ordering = new RegExp(options.orderingCalleePattern, 'u');
    } catch {
      ordering = new RegExp(DEFAULT_ORDERING_PATTERN, 'u');
    }
    const analysed = new Set<number>();

    /** A single-declarator `const x = yield* <non-effect member call>` statement, or `null`. */
    const candidateOf = (statement: AnyNode): Candidate | null => {
      if (statement.type !== 'VariableDeclaration') return null;
      const declarations = statement.declarations;
      if (!Array.isArray(declarations) || declarations.length !== 1) return null;
      const declarator = asNode(declarations[0]);
      if (declarator === null) return null;
      const init = unwrap(declarator.init);
      if (init === null || init.type !== 'YieldExpression' || init.delegate !== true) return null;
      let subject = unwrapPipe(init.argument, context, options.effectModules);
      // Only known data-first wrappers preserve the underlying effect. Never peel arbitrary
      // Effect constructors/callbacks: map/sync may intentionally introduce ordered work.
      const transparent = new Set([
        'withSpan',
        'annotateLogs',
        'timeout',
        'timeoutOption',
        'retry',
      ]);
      while (subject?.type === 'CallExpression') {
        const path = bindingPath(context, subject.callee as ESTree.Node, options.effectModules);
        if (path?.length !== 2 || path[0] !== 'Effect' || !transparent.has(path[1] ?? '')) break;
        const args = subject.arguments;
        if (!Array.isArray(args) || args.length < 2) break;
        subject = unwrapPipe(args[0], context, options.effectModules);
      }
      if (subject === null) return null;

      let calleeNode: AnyNode | null = null;
      if (subject.type === 'CallExpression') {
        const callee = unwrap(subject.callee);
        if (callee === null) return null;
        if (MEMBER_TYPES.has(callee.type)) calleeNode = callee;
        else if (options.includeFunctionCallees && callee.type === 'Identifier')
          calleeNode = callee;
        else return null;
      } else {
        return null;
      }
      // `Effect.all(...)`, `Schema.decodeUnknown(...)`, … are the target shape, never the anti-pattern.
      if (
        bindingPath(context, calleeNode as unknown as ESTree.Node, options.effectModules) !== null
      )
        return null;
      const calleeName =
        calleeNode.type === 'Identifier' ? (calleeNode.name as string) : memberName(calleeNode);
      if (calleeName === null) return null;

      return {
        bound: collectPatternNames(asNode(declarator.id), visitorKeys),
        calleeName,
        calleeNode,
        ordering: ordering.test(calleeName),
        referenced: collectReferencedNames(init, visitorKeys),
      };
    };

    const analyseStatements = (statements: readonly unknown[]): void => {
      let head: Candidate | null = null;
      let seen = new Set<string>();
      const entries = statements.flatMap((entry) => {
        const statement = asNode(entry);
        return statement?.type === 'VariableDeclaration' && Array.isArray(statement.declarations)
          ? statement.declarations.map((declaration) => ({
              ...statement,
              declarations: [declaration],
            }))
          : [entry];
      });
      for (const entry of entries) {
        const statement = asNode(entry);
        if (statement === null) {
          head = null;
          seen = new Set();
          continue;
        }
        const candidate = candidateOf(statement);
        // A non-read statement (`if`, `return`, a plain `const`, a log) breaks adjacency.
        if (candidate === null || candidate.ordering) {
          head = null;
          seen = new Set();
          continue;
        }
        if (head === null) {
          head = candidate;
          seen = new Set(candidate.bound);
          continue;
        }
        const dependent = [...candidate.referenced].some((name) => seen.has(name));
        if (dependent) {
          head = candidate;
          seen = new Set(candidate.bound);
          continue;
        }
        context.report({
          data: { first: [...head.bound].join(', '), second: [...candidate.bound].join(', ') },
          messageId: 'sequentialIndependentYields',
          node: candidate.calleeNode as unknown as ESTree.Node,
        });
        for (const name of candidate.bound) seen.add(name);
      }
    };

    const analyseGenerator = (generator: AnyNode): void => {
      const body = asNode(generator.body);
      if (body === null) return;
      walk(body, visitorKeys, (node) => {
        if (node !== body && FUNCTION_TYPES.has(node.type)) return false;
        if (node.type === 'BlockStatement' && Array.isArray(node.body))
          analyseStatements(node.body);
        else if (node.type === 'SwitchCase' && Array.isArray(node.consequent))
          analyseStatements(node.consequent);
        return true;
      });
    };

    const visitFunction = (node: ESTree.Node): void => {
      const fn = asNode(node);
      if (fn === null || fn.generator !== true) return;
      if (analysed.has(fn.start)) return;
      if (!isEffectGenerator(fn, matcher)) return;
      analysed.add(fn.start);
      analyseGenerator(fn);
    };

    return {
      FunctionDeclaration: visitFunction,
      FunctionExpression: visitFunction,
    };
  },
});
