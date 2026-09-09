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

import {
  asNode as sharedAsNode,
  FUNCTION_TYPES,
  identityUnwrap,
  nearestFunction as enclosingFunction,
  parentOf,
  walk,
  type Syntax as AnyNode,
} from '../shared/ast.ts';
import { lookupVariable as lexicalVariable } from '../shared/bindings.ts';
import { isGenCallee } from '../shared/effect-identity.ts';
import { bindingsWithExtraModules, collectDirectMemberImports, collectRootNamespaces } from '../shared/imports.ts';
import { optionRecord } from '../shared/options.ts';
import { booleanOption as boolean, stringArray } from '../shared/options.ts';
import { isScriptFile, isTestFile, matchesGlobs, scopePath } from '../shared/paths.ts';

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**'];
const DEFAULT_IGNORE = ['**/dist/**', '**/build/**', '**/node_modules/**', 'tools/**', '**/*.d.ts'];
/** Wrappers whose generator argument is an Effect program body. */
const DEFAULT_GEN_MEMBERS = ['gen', 'fn', 'fnUntraced'];
/** Barrels that re-export `Effect` verbatim, so `Effect.gen` there is the same generator. */
const DEFAULT_EFFECT_MODULES = ['@modern-js/plugin-bff/effect-client', '@modern-js/plugin-bff/effect-edge'];

const MEMBER_TYPES = new Set(['ComputedMemberExpression', 'MemberExpression', 'StaticMemberExpression']);
const LOOP_LABELS: Record<string, string> = {
  DoWhileStatement: 'do...while',
  ForInStatement: 'for...in',
  ForOfStatement: 'for...of',
  ForStatement: 'for',
  WhileStatement: 'while',
};

type RuleOptions = Readonly<ReturnType<typeof readOptions>>;

function readOptions(context: Context) {
  const record = optionRecord(context.options?.[0]);
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

const LOOP_EXPRESSION_WRAPPERS = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSNonNullExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSInstantiationExpression',
]);

function asNode(value: unknown): AnyNode | null {
  return sharedAsNode(value, true);
}

/** Keep the loop walker's 16-hop bound and validate every wrapper child's span. */
function unwrap(value: unknown): AnyNode | null {
  let current = asNode(value);
  for (let depth = 0; current !== null && depth < 16; depth += 1) {
    if (!LOOP_EXPRESSION_WRAPPERS.has(current.type)) return current;
    const inner = asNode(current.expression);
    if (inner === null) return current;
    current = inner;
  }
  return current;
}

/** A return exits the loop unless a surrounding try can override it. */
function isTerminalYield(node: AnyNode, loop: AnyNode): boolean {
  let parent = parentOf(node);
  while (parent !== null && unwrap(parent) === node) parent = parentOf(parent);
  if (parent?.type !== 'ReturnStatement') return false;
  while (parent !== null && parent !== loop) {
    if (parent.type === 'TryStatement') return false;
    parent = parentOf(parent);
  }
  return true;
}

/**
 * `true` when the loop contains a delegating `yield*` that belongs to the loop's own generator —
 * nested functions (including nested generators) own their own yields and are not descended into.
 */
function containsDelegatingYield(loop: AnyNode, visitorKeys: Readonly<Record<string, readonly string[]>>): boolean {
  let found = false;
  walk(loop, visitorKeys, (node) => {
    if (found) return false;
    if (node !== loop && FUNCTION_TYPES.has(node.type)) return false;
    if (node.type === 'YieldExpression' && node.delegate === true) {
      // Returns in try/finally may be overridden, so those yields still sequence effects.
      found = !isTerminalYield(node, loop);
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
      const variable = lexicalVariable(context, target);
      if (variable !== null) assigned.add(variable);
    }
    return true;
  });
  const mutatesOuter = [...assigned].some((variable) =>
    variable.defs.some((definition) => definition.node.start < loop.start || definition.node.end > loop.end),
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
    pattern.type === 'ObjectPattern' ? pattern.properties : pattern.type === 'ArrayPattern' ? pattern.elements : [];
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

function isIncludedFile(context: Context, options: RuleOptions): boolean {
  const path = scopePath(context.filename);
  if (matchesGlobs(path, options.ignore)) return false;
  const inScripts = isScriptFile(path);
  if (!options.includeScripts && inScripts) return false;
  // Opting scripts in also widens the default include globs.
  if (!matchesGlobs(path, options.include) && !(options.includeScripts && inScripts)) return false;
  return options.includeTests || !isTestFile(path);
}

function allowsUnmutatingForOf(loop: AnyNode, options: RuleOptions, mutatesOuter: boolean): boolean {
  return options.allowForOfWithoutMutation && loop.type === 'ForOfStatement' && !mutatesOuter;
}

function hasGeneratorImports(program: ESTree.Program, options: RuleOptions): boolean {
  const rootNamespaces = collectRootNamespaces(program);
  const directMembers = collectDirectMemberImports(program, new Map([['Effect', new Set(options.genMembers)]]));
  const bindings = bindingsWithExtraModules(program, options.effectModules);
  return bindings.importsEffect || rootNamespaces.size > 0 || directMembers.size > 0;
}

function generatorDefinitionValue(
  context: Context,
  definition: import('@oxlint/plugins').Variable['defs'][number] | undefined,
  seen: Set<unknown>,
): ESTree.Node | null {
  if (definition?.type === 'FunctionName') return definition.node;
  if (definition?.type !== 'Variable') return null;
  const declaration = definition.node as ESTree.VariableDeclarator;
  if ((definition.parent as ESTree.VariableDeclaration)?.kind !== 'const') return null;
  return declaration.init === null ? null : generatorValue(context, declaration.init, seen);
}

function generatorValue(context: Context, value: ESTree.Node, seen = new Set<unknown>()): ESTree.Node | null {
  const node = identityUnwrap(value);
  if (node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration') return node.generator ? node : null;
  if (node.type !== 'Identifier') return null;
  const variable = lexicalVariable(context, node);
  if (variable === null || seen.has(variable) || variable.defs.length !== 1) return null;
  seen.add(variable);
  return generatorDefinitionValue(context, variable.defs[0], seen);
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
    if (!isIncludedFile(context, options)) return {};
    if (!hasGeneratorImports(context.sourceCode.ast, options)) return {};

    const visitorKeys = context.sourceCode.visitorKeys;
    const generatorLets = new Map<number, readonly DeclaredBinding[]>();
    const reportedCounters = new Set<number>();
    const effectGenerators = new Set<number>();
    const loops: { node: ESTree.Node; fn: AnyNode | null }[] = [];
    const reportCounters = (
      loop: AnyNode,
      fn: AnyNode,
      assigned: ReadonlySet<import('@oxlint/plugins').Variable>,
      label: string,
    ): void => {
      let declarations = generatorLets.get(fn.start);
      if (declarations === undefined) {
        declarations = collectGeneratorLets(fn, visitorKeys);
        generatorLets.set(fn.start, declarations);
      }
      for (const declaration of declarations) {
        if (declaration.start >= loop.start && declaration.end <= loop.end) continue;
        const variable = lexicalVariable(context, declaration.idNode);
        if (variable === null || !assigned.has(variable)) continue;
        if (reportedCounters.has(declaration.start)) continue;
        reportedCounters.add(declaration.start);
        context.report({
          data: { loop: label, name: declaration.name },
          messageId: 'mutableCounter',
          node: declaration.idNode,
        });
      }
    };

    const checkLoop = (node: ESTree.Node, fn: AnyNode | null): void => {
      const loop = asNode(node);
      if (loop === null) return;
      const label = LOOP_LABELS[loop.type] ?? loop.type;

      if (fn === null || !effectGenerators.has(fn.start)) return;
      if (!containsDelegatingYield(loop, visitorKeys)) return;

      const mutations = collectLoopMutations(loop, context, visitorKeys);
      if (allowsUnmutatingForOf(loop, options, mutations.mutatesOuter)) return;

      const keyword = context.sourceCode.getFirstToken(node);
      context.report({
        data: { loop: label },
        messageId: 'imperativeLoop',
        node: (keyword ?? node) as ESTree.Node,
      });

      if (options.flagCounters) reportCounters(loop, fn, mutations.assigned, label);
    };

    const collectLoop = (node: ESTree.Node): void => {
      loops.push({ node, fn: enclosingFunction(node) });
    };
    return {
      CallExpression(node) {
        if (!isGenCallee(context, asNode(node.callee), options.genMembers, options.effectModules)) return;
        for (const argument of node.arguments) {
          const generator = generatorValue(context, argument);
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
