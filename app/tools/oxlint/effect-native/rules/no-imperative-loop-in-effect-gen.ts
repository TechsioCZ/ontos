/**
 * effect-native/no-imperative-loop-in-effect-gen
 *
 * Audit finding enforced (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`):
 *
 *   - **B1** "Make workers and independent reads declaratively concurrent" — "The outbox uses
 *     fixed-interval imperative polling; independent remote providers and enrichment reads are
 *     frequently sequential […] Use `Stream`, `Schedule`, bounded `Effect.forEach`/`Effect.all`,
 *     typed retry schedules, explicit timeouts, and interruption-aware worker scopes."
 *     Evidence: `packages/core-runtime/src/outbox/runtime.ts:262` — a `while (claimed <
 *     validated.maxDeliveries)` loop inside `Effect.gen(function* runOutboxCycleEffect())` that
 *     drives five mutable counters (`claimed`, `dead`, `failed`, `retried`, `succeeded`) around a
 *     `yield* repository.claimNext(...)`; `apps/shell-super-app/api/modules/shell-resources.ts:191`
 *     and `:236`, and `apps/shell-super-app/src/routes/module-entrypoint-loader.ts:32`, where
 *     independent reads run one after another in a `for … of` body.
 *
 * A `for`/`for…of`/`for…in`/`while`/`do…while` whose body delegates to Effect (`yield*`) is a
 * hand-written sequential fold. Yields remain interruptible; syntax cannot establish independence.
 * Declarative loops make scheduling and accumulator policy explicit while preserving ordering:
 *
 *   - iterate a collection            → `Effect.forEach(items, f, { concurrency })`
 *   - independent reads               → `Effect.all([a, b, c], { concurrency: 4 })`
 *   - fold state across items         → `Effect.reduce(items, initial, f)`
 *   - claim/drain until exhausted     → `Effect.iterate(state, { while, body })` / `Effect.loop`
 *   - poll on an interval             → `Effect.repeat(tick, Schedule.spaced(...))`
 *   - paginated / unbounded producers → `Stream.paginateEffect` + `Stream.runFold`
 *
 * ## What is detected
 *
 * 1. **Imperative loops.** `WhileStatement`, `DoWhileStatement`, `ForStatement`, `ForOfStatement`
 *    and `ForInStatement` whose *nearest enclosing function* is a generator handed to `Effect.gen`,
 *    `Effect.fn` or `Effect.fnUntraced`, and which contain a delegating `yield*` anywhere in the
 *    loop (head **or** body) without descending into a nested function. Reported on the loop
 *    keyword.
 *
 *    Recognised generator wrappers: `Effect.gen(function* () {})`, `Effect.gen(this, function* ())`,
 *    `Effect.fn("name")(function* () {})`, `Effect.fnUntraced(function* () {})`; aliased imports
 *    (`import { Effect as E } from "effect"`), submodule namespace imports (`import * as Effect from
 *    "effect/Effect"`), root namespace imports (`import * as E from "effect"` → `E.Effect.gen`),
 *    direct member imports (`import { gen } from "effect/Effect"`), computed access
 *    (`Effect["gen"]`), optional chaining (`Effect?.gen`) and the configured re-export barrels
 *    (`effectModules`, default the Modern.js BFF Effect clients).
 *
 * 2. **Mutable accumulators** (`flagCounters`, default `true`). Each `let`/`var` declared in the
 *    generator body outside such a loop and assigned or updated inside it is reported on its
 *    declarator. These are the five outbox counters: the state an `Effect.reduce`/`Effect.iterate`
 *    fold would carry in its accumulator.
 *
 * ## What is deliberately allowed
 *
 * - **Loops with no `yield*`.** A `for (const row of rows) total += row.count` is native array/object
 *   work, which the D tier blesses ("Native array/object operations where Effect collection APIs add
 *   no semantic value"). Only loops that actually sequence Effects are reported.
 * - **Loops outside `Effect.gen`.** Plain `async`/sync helpers, framework adapters, React components
 *   and every other D-tier Promise seam are untouched: the rule needs an Effect generator.
 * - **`Effect.forEach` / `Effect.all` / `Effect.reduce` / `Stream` callbacks** — the target shape.
 *   A `yield*` inside a nested arrow function belongs to that arrow, not to the loop, and the
 *   nearest-enclosing-function check keeps it out.
 * - **`for…of` without outer mutation** when `allowForOfWithoutMutation` is enabled (default
 *   `false`, because a bare sequential `for (const a of actions) yield* ensure(a)` is exactly the
 *   B1 "independent reads are frequently sequential" finding).
 * - **Tests** (`includeTests`, default `false`) and **`scripts/`** (`includeScripts`, default
 *   `false`): B2 and B3 own those surfaces and prescribe a different migration.
 * - Anything outside `include`, anything matching `ignore`, and any generator whose wrapper is not
 *   an `effect` `Effect.gen`/`fn`/`fnUntraced` binding (a local `const Effect = { gen }` shadow, an
 *   unrelated `saga.gen`, a plain redux-saga generator).
 *
 * Known limitation: without type information the rule cannot prove a dependent claim loop
 * (`while` + `break` on a sentinel) has no declarative equivalent — it does, `Effect.iterate`, so
 * those stay reported on purpose. Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree } from '@oxlint/plugins';

import { collectEffectBindings, type EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isScriptFile, isTestFile, normalisePath } from '../shared/paths.ts';

/** Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`. */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const EFFECT_NAMESPACE = 'Effect';
const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_EFFECT_MODULE = /^effect\/(?:.*\/)?Effect$/u;

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**'];
const DEFAULT_IGNORE = ['**/dist/**', '**/build/**', '**/node_modules/**', 'tools/**', '**/*.d.ts'];
const DEFAULT_SCRIPT_GLOBS = ['scripts/**', '**/scripts/**'];
/** Wrappers whose generator argument is an Effect program body. */
const DEFAULT_GEN_MEMBERS = ['gen', 'fn', 'fnUntraced'];
/** Barrels that re-export `Effect` verbatim, so `Effect.gen` there is the same generator. */
const DEFAULT_EFFECT_MODULES = [
  '@modern-js/plugin-bff/effect-client',
  '@modern-js/plugin-bff/effect-edge',
];

const FUNCTION_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);
const MEMBER_TYPES = new Set([
  'ComputedMemberExpression',
  'MemberExpression',
  'StaticMemberExpression',
]);
const LOOP_LABELS: Record<string, string> = {
  DoWhileStatement: 'do...while',
  ForInStatement: 'for...in',
  ForOfStatement: 'for...of',
  ForStatement: 'for',
  WhileStatement: 'while',
};

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly includeTests: boolean;
  readonly includeScripts: boolean;
  readonly allowForOfWithoutMutation: boolean;
  readonly flagCounters: boolean;
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
    allowForOfWithoutMutation: boolean(record.allowForOfWithoutMutation, false),
    flagCounters: boolean(record.flagCounters, true),
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
    if (
      current.type !== 'ParenthesizedExpression' &&
      current.type !== 'ChainExpression' &&
      current.type !== 'TSNonNullExpression' &&
      current.type !== 'TSAsExpression' &&
      current.type !== 'TSSatisfiesExpression' &&
      current.type !== 'TSInstantiationExpression'
    ) {
      return current;
    }
    const inner = asNode(current.expression);
    if (inner === null) return current;
    current = inner;
  }
  return current;
}

/** Non-computed `.gen`, or computed `["gen"]`. */
function memberName(node: AnyNode): string | null {
  const property = asNode(node.property);
  if (property === null) return null;
  if (node.computed !== true)
    return property.type === 'Identifier' ? (property.name as string) : null;
  if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
  if (property.type === 'StringLiteral' && typeof property.value === 'string')
    return property.value;
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
function isGenCallee(callee: AnyNode | null, matcher: GeneratorMatcher): boolean {
  if (callee === null) return false;
  const target = identityUnwrap(callee as unknown as ESTree.Node);
  if (target.type === 'CallExpression') return isGenCallee(asNode(target.callee), matcher);
  const path = bindingPath(matcher.context, target, matcher.effectModules);
  return path?.length === 2 && path[0] === 'Effect' && matcher.genMembers.includes(path[1] ?? '');
}

/** Nearest enclosing function of `node`, or `null` at `Program` level. */
function enclosingFunction(node: AnyNode): AnyNode | null {
  let current = parentOf(node);
  while (current !== null) {
    if (FUNCTION_TYPES.has(current.type)) return current;
    current = parentOf(current);
  }
  return null;
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
  while (stack.length > 0) {
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

/**
 * `true` when the loop contains a delegating `yield*` that belongs to the loop's own generator —
 * nested functions (including nested generators) own their own yields and are not descended into.
 */
function containsDelegatingYield(
  loop: AnyNode,
  visitorKeys: Readonly<Record<string, readonly string[]>>,
): boolean {
  let found = false;
  walk(loop, visitorKeys, (node) => {
    if (found) return false;
    if (node !== loop && FUNCTION_TYPES.has(node.type)) return false;
    if (node.type === 'YieldExpression' && node.delegate === true) {
      // A pure search that returns its only yield cannot sequence effects across iterations.
      // A return inside try/finally may be overridden, and a throw may be caught: keep those.
      let parent = parentOf(node);
      while (parent !== null && unwrap(parent) === node) parent = parentOf(parent);
      let terminal = parent?.type === 'ReturnStatement';
      while (terminal && parent !== null && parent !== loop) {
        if (parent.type === 'TryStatement') terminal = false;
        parent = parentOf(parent);
      }
      if (!terminal) found = true;
      return false;
    }
    return true;
  });
  return found;
}

/** Resolve assignment roots by variable identity; a nested shadow cannot hide or implicate
 * a same-spelled outer accumulator. Property writes count as mutation of the root binding. */
function collectLoopMutations(
  loop: AnyNode,
  context: Context,
  visitorKeys: Readonly<Record<string, readonly string[]>>,
) {
  const assigned = new Set<import('@oxlint/plugins').Variable>();
  walk(loop, visitorKeys, (node) => {
    let target =
      node.type === 'AssignmentExpression'
        ? asNode(node.left)
        : node.type === 'UpdateExpression'
          ? asNode(node.argument)
          : null;
    if (target === null) return true;
    target = unwrap(target);
    while (target !== null && MEMBER_TYPES.has(target.type)) target = unwrap(target.object);
    if (target?.type === 'Identifier') {
      const variable = lexicalVariable(
        context,
        target as unknown as Extract<ESTree.Node, { type: 'Identifier' }>,
      );
      if (variable !== null) assigned.add(variable);
    }
    return true;
  });
  const mutatesOuter = [...assigned].some((variable) =>
    variable.defs.some(
      (definition) => definition.node.start < loop.start || definition.node.end > loop.end,
    ),
  );
  return { assigned, mutatesOuter };
}

function patternIdentifiers(pattern: AnyNode): AnyNode[] {
  if (pattern.type === 'Identifier') return [pattern];
  if (pattern.type === 'RestElement') {
    const argument = asNode(pattern.argument);
    return argument === null ? [] : patternIdentifiers(argument);
  }
  if (pattern.type === 'AssignmentPattern') {
    const left = asNode(pattern.left);
    return left === null ? [] : patternIdentifiers(left);
  }
  const entries =
    pattern.type === 'ObjectPattern'
      ? pattern.properties
      : pattern.type === 'ArrayPattern'
        ? pattern.elements
        : [];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const node = asNode(entry);
    if (node === null) return [];
    const binding = node.type === 'Property' ? asNode(node.value) : node;
    return binding === null ? [] : patternIdentifiers(binding);
  });
}

interface DeclaredBinding {
  readonly name: string;
  readonly idNode: AnyNode;
  readonly start: number;
  readonly end: number;
}

/**
 * `let` / `var` declarations in the generator's own body (nested functions excluded): the candidate
 * accumulators an `Effect.reduce` / `Effect.iterate` state would replace.
 */
function collectGeneratorLets(
  generator: AnyNode,
  visitorKeys: Readonly<Record<string, readonly string[]>>,
): readonly DeclaredBinding[] {
  const declarations: DeclaredBinding[] = [];
  const body = asNode(generator.body);
  if (body === null) return declarations;
  walk(body, visitorKeys, (node) => {
    if (FUNCTION_TYPES.has(node.type)) return false;
    if (node.type !== 'VariableDeclaration') return true;
    const kind = node.kind;
    if (kind !== 'let' && kind !== 'var') return true;
    const declaratorList = node.declarations;
    if (!Array.isArray(declaratorList)) return true;
    for (const entry of declaratorList) {
      const declarator = asNode(entry);
      if (declarator === null) continue;
      const id = asNode(declarator.id);
      if (id === null) continue;
      for (const binding of patternIdentifiers(id))
        declarations.push({
          end: declarator.end,
          idNode: binding,
          name: binding.name as string,
          start: binding.start,
        });
    }
    return true;
  });
  return declarations;
}

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
        'Audit B1: disallow `while`/`do...while`/`for`/`for...of`/`for...in` loops that sequence `yield*` ' +
        'inside `Effect.gen`/`Effect.fn`. Use `Effect.forEach` with a concurrency bound, `Effect.all`, ' +
        '`Effect.reduce`, `Effect.iterate`/`Effect.loop`, `Effect.repeat(Schedule…)` or ' +
        '`Stream.paginateEffect`, and fold state instead of mutating `let` counters. Syntax cannot prove safe concurrency.',
    },
    messages: {
      imperativeLoop:
        'Imperative `{{loop}}` loop with `yield*` inside `Effect.gen` (audit B1: ' +
        '`packages/core-runtime/src/outbox/runtime.ts:262`). Review its scheduling and accumulation policy; syntax does not establish independence. Use ' +
        '`Effect.forEach(items, f, { concurrency })` / `Effect.all` for independent work, ' +
        '`Effect.reduce(items, initial, f)` to fold, `Effect.iterate`/`Effect.loop` or ' +
        '`Effect.repeat(tick, Schedule.recurWhile(...))` for claim/poll loops, and ' +
        '`Stream.paginateEffect` for unbounded producers — folding results instead of `let` counters.',
      mutableCounter:
        '`{{name}}` is a mutable accumulator declared in an `Effect.gen` body and mutated inside an ' +
        'imperative `{{loop}}` loop (audit B1: the outbox cycle carries five such counters at ' +
        '`packages/core-runtime/src/outbox/runtime.ts:261`). Carry it as the state of ' +
        '`Effect.reduce`/`Effect.iterate`/`Effect.loop`, or fold the `Effect.forEach` results, so the value ' +
        'is part of the Effect instead of escaping it.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          includeTests: { type: 'boolean' },
          includeScripts: { type: 'boolean' },
          allowForOfWithoutMutation: { type: 'boolean' },
          flagCounters: { type: 'boolean' },
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
        allowForOfWithoutMutation: false,
        flagCounters: true,
        genMembers: [...DEFAULT_GEN_MEMBERS],
        effectModules: [...DEFAULT_EFFECT_MODULES],
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore)) return {};
    const inScripts = isScriptFile(path) || matchesGlobs(path, DEFAULT_SCRIPT_GLOBS);
    if (!options.includeScripts && inScripts) return {};
    // `includeScripts` also widens `include`, so the root `scripts/` tree is reachable without
    // restating the default `include` globs in the config.
    if (!matchesGlobs(path, options.include) && !(options.includeScripts && inScripts)) return {};
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
    const generatorLets = new Map<number, readonly DeclaredBinding[]>();
    const reportedCounters = new Set<number>();
    const effectGenerators = new Set<number>();
    const loops: { node: ESTree.Node; fn: AnyNode | null }[] = [];
    const generatorValue = (value: ESTree.Node, seen = new Set<unknown>()): ESTree.Node | null => {
      const node = identityUnwrap(value);
      if (node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration')
        return node.generator ? node : null;
      if (node.type !== 'Identifier') return null;
      const variable = lexicalVariable(context, node);
      if (variable === null || seen.has(variable) || variable.defs.length !== 1) return null;
      seen.add(variable);
      const def = variable.defs[0];
      if (def?.type === 'FunctionName') return def.node;
      if (def?.type !== 'Variable') return null;
      const decl = def.node as ESTree.VariableDeclarator;
      return (def.parent as ESTree.VariableDeclaration)?.kind === 'const' && decl.init !== null
        ? generatorValue(decl.init, seen)
        : null;
    };

    const checkLoop = (node: ESTree.Node, fn: AnyNode | null): void => {
      const loop = asNode(node);
      if (loop === null) return;
      const label = LOOP_LABELS[loop.type] ?? loop.type;

      if (fn === null || !effectGenerators.has(fn.start)) return;
      if (!containsDelegatingYield(loop, visitorKeys)) return;

      const mutations = collectLoopMutations(loop, context, visitorKeys);
      const mutatesOuter = mutations.mutatesOuter;
      if (options.allowForOfWithoutMutation && loop.type === 'ForOfStatement' && !mutatesOuter)
        return;

      const keyword = context.sourceCode.getFirstToken(node);
      context.report({
        data: { loop: label },
        messageId: 'imperativeLoop',
        node: (keyword ?? node) as ESTree.Node,
      });

      if (!options.flagCounters) return;
      let declarations = generatorLets.get(fn.start);
      if (declarations === undefined) {
        declarations = collectGeneratorLets(fn, visitorKeys);
        generatorLets.set(fn.start, declarations);
      }
      for (const declaration of declarations) {
        if (declaration.start >= loop.start && declaration.end <= loop.end) continue;
        const variable = lexicalVariable(
          context,
          declaration.idNode as unknown as Extract<ESTree.Node, { type: 'Identifier' }>,
        );
        if (variable === null || !mutations.assigned.has(variable)) continue;
        if (reportedCounters.has(declaration.start)) continue;
        reportedCounters.add(declaration.start);
        context.report({
          data: { loop: label, name: declaration.name },
          messageId: 'mutableCounter',
          node: declaration.idNode as unknown as ESTree.Node,
        });
      }
    };

    const collectLoop = (node: ESTree.Node): void => {
      loops.push({ node, fn: enclosingFunction(node as unknown as AnyNode) });
    };
    return {
      CallExpression(node) {
        if (!isGenCallee(asNode(node.callee), matcher)) return;
        for (const argument of node.arguments) {
          const generator = generatorValue(argument);
          if (generator !== null) effectGenerators.add(generator.start);
        }
      },
      DoWhileStatement: collectLoop,
      ForInStatement: collectLoop,
      ForOfStatement: collectLoop,
      ForStatement: collectLoop,
      WhileStatement: collectLoop,
      'Program:exit'() {
        for (const { node, fn } of loops) checkLoop(node, fn);
      },
    };
  },
});
