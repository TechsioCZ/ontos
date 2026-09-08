import { optionRecord } from '../shared/options.ts';
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
  asNode as sharedAsNode,
  childrenOf,
  memberName as sharedMemberName,
} from '../shared/ast.ts';
import { bindingPath, isGenCallee as sharedIsGenCallee } from '../shared/effect-identity.ts';
import {
  bindingsWithExtraModules,
  collectRootNamespaces,
  collectNamedImports,
} from '../shared/imports.ts';
import { booleanOption as boolean, stringArray, safeRegExp } from '../shared/options.ts';
import { isScriptFile, isTestFile, scopePath, matchesGlobs } from '../shared/paths.ts';

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

type RuleOptions = Readonly<ReturnType<typeof readOptions>>;

function readOptions(context: Context) {
  const record = optionRecord(context.options?.[0]);
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

interface AnyNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly parent?: AnyNode | null;
  readonly [key: string]: unknown;
}

function asNode(value: unknown): AnyNode | null {
  return sharedAsNode(value, true) as AnyNode | null;
}
function parentOf(node: AnyNode | null): AnyNode | null {
  return node?.parent ?? null;
}
function unwrap(value: unknown): AnyNode | null {
  let current = asNode(value);
  for (let depth = 0; depth < 16 && current !== null; depth += 1) {
    if (!WRAPPER_TYPES.has(current.type)) break;
    const child = asNode(current.expression);
    if (child === null) break;
    current = child;
  }
  return current;
}
function memberName(node: AnyNode): string | null {
  const property = asNode(node.property);
  if (property === null) return null;
  if (node.computed !== true)
    return property.type === 'Identifier' ? (property.name as string) : null;
  return sharedMemberName(node, { templates: true, babelStrings: true });
}

interface GeneratorMatcher {
  readonly context: Context;
  readonly effectModules: readonly string[];
  readonly genMembers: readonly string[];
}

/** `Effect.gen` / `E.gen` / `X.Effect.gen` / bare `gen` (direct member import), incl. computed + optional. */
function isGenCallee(callee: AnyNode | null, matcher: GeneratorMatcher): boolean {
  return sharedIsGenCallee(
    matcher.context,
    callee as ESTree.Node | null,
    matcher.genMembers,
    matcher.effectModules,
  );
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

/** Preserve the generator traversal budget while sharing child enumeration and ordering. */
function walk(
  node: AnyNode,
  visitorKeys: Readonly<Record<string, readonly string[]>>,
  visit: Walker,
): void {
  const stack = [node];
  for (let visited = 0; stack.length > 0 && visited < 200_000; visited += 1) {
    const current = stack.pop()!;
    if (!visit(current)) continue;
    const children = childrenOf(current as unknown as ESTree.Node, visitorKeys, true);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index] as AnyNode);
    }
  }
}

/** Peel method and imported pipe calls down to their subject. */
function pipeSubject(
  current: AnyNode,
  context: Context,
  modules: readonly string[],
): AnyNode | null {
  if (current.type !== 'CallExpression') return current;
  const callee = unwrap(current.callee);
  if (callee === null) return current;
  if (MEMBER_TYPES.has(callee.type) && memberName(callee) === 'pipe') return unwrap(callee.object);
  const path = bindingPath(context, callee as unknown as ESTree.Node, modules)?.join('.') ?? '';
  if (!['pipe', 'Function.pipe'].includes(path)) return current;
  const first = Array.isArray(current.arguments) ? unwrap(current.arguments[0]) : null;
  return first ?? current;
}
function unwrapPipe(value: unknown, context: Context, modules: readonly string[]): AnyNode | null {
  let current = unwrap(value);
  for (let guard = 0; current !== null && guard < 32; guard += 1) {
    const next = pipeSubject(current, context, modules);
    if (next === current) return current;
    current = next;
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
  walk(node, visitorKeys, (current) => collectInto(current, names, visitorKeys));
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

function inScope(filename: string, options: RuleOptions): boolean {
  const path = scopePath(filename);
  if (matchesGlobs(path, options.ignore)) return false;
  const script = isScriptFile(path) || matchesGlobs(path, DEFAULT_SCRIPT_GLOBS);
  if (script && !options.includeScripts) return false;
  if (!matchesGlobs(path, options.include) && !(options.includeScripts && script)) return false;
  return options.includeTests || !isTestFile(path);
}
function singleDeclarator(statement: AnyNode): AnyNode | null {
  if (statement.type !== 'VariableDeclaration') return null;
  const declarations = statement.declarations;
  return Array.isArray(declarations) && declarations.length === 1 ? asNode(declarations[0]) : null;
}
const TRANSPARENT_MEMBERS = new Set([
  'withSpan',
  'annotateLogs',
  'timeout',
  'timeoutOption',
  'retry',
]);
function transparentArguments(
  subject: AnyNode,
  context: Context,
  modules: readonly string[],
): unknown[] | null {
  const path = bindingPath(context, subject.callee as unknown as ESTree.Node, modules);
  if (path?.length !== 2 || path[0] !== 'Effect' || !TRANSPARENT_MEMBERS.has(path[1] ?? ''))
    return null;
  return Array.isArray(subject.arguments) && subject.arguments.length >= 2
    ? subject.arguments
    : null;
}
/** Only known data-first wrappers preserve the effect; constructors and callbacks remain opaque. */
function readSubject(value: unknown, context: Context, modules: readonly string[]): AnyNode | null {
  let subject = unwrapPipe(value, context, modules);
  while (subject?.type === 'CallExpression') {
    const args = transparentArguments(subject, context, modules);
    if (args === null) break;
    subject = unwrapPipe(args[0], context, modules);
  }
  return subject;
}
function readCallee(subject: AnyNode | null, includeFunctions: boolean): AnyNode | null {
  if (subject?.type !== 'CallExpression') return null;
  const callee = unwrap(subject.callee);
  if (callee === null) return null;
  if (MEMBER_TYPES.has(callee.type)) return callee;
  return includeFunctions && callee.type === 'Identifier' ? callee : null;
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
    if (!inScope(context.filename, options)) return {};

    const program = context.sourceCode.ast;
    const rootNamespaces = collectRootNamespaces(program);
    const directMembers = collectNamedImports(
      program,
      (source) => /^effect\/(?:.*\/)?Effect$/u.test(source),
      new Set(options.genMembers),
    );
    const bindings = bindingsWithExtraModules(program, options.effectModules);
    if (!bindings.importsEffect && rootNamespaces.size === 0 && directMembers.size === 0) return {};

    const matcher: GeneratorMatcher = {
      context,
      effectModules: options.effectModules,
      genMembers: options.genMembers,
    };
    const visitorKeys = context.sourceCode.visitorKeys;
    const ordering = safeRegExp(options.orderingCalleePattern, DEFAULT_ORDERING_PATTERN);
    const analysed = new Set<number>();

    /** A single-declarator `const x = yield* <non-effect member call>` statement, or `null`. */
    const candidateOf = (statement: AnyNode): Candidate | null => {
      const declarator = singleDeclarator(statement);
      if (declarator === null) return null;
      const init = unwrap(declarator.init);
      if (init === null || init.type !== 'YieldExpression' || init.delegate !== true) return null;
      const subject = readSubject(init.argument, context, options.effectModules);
      const calleeNode = readCallee(subject, options.includeFunctionCallees);
      if (calleeNode === null) return null;
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
