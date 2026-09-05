/**
 * effect-native/no-async-script-program
 *
 * Audit findings enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *   - B3 "Convert consequential operational scripts into Effect programs" —
 *     "Approximately 79 of 103 scripts are primarily async/await; hundreds of manual throws and
 *     several independent argv parsers remain. Use scoped resources, shared Layers, typed errors,
 *     Schema decoders, and `effect/unstable/cli`. Keep one small process-exit adapter at the
 *     executable edge."
 *   - A8 "Fix the generators before generating more code" — "Generators currently emit
 *     Promise-first browser code ... Bring `scripts/` and `tools/oxlint` under explicit
 *     TypeScript and anti-slop gates." Scaffold scripts are themselves async/await programs and
 *     therefore emit async/await programs.
 *
 * An async/await script loses everything the Effect runtime owns: typed failure channels
 * (`E`), interruption, `Scope`-managed resources (pools, clients, file handles), `Layer` sharing
 * across steps, `ConfigProvider`, `Clock`, spans and log annotations. A script written as
 * `Effect.gen` / `Effect.fn` keeps all of it and still exits through one small process adapter.
 *
 * What is detected (scripts/** only, tests excluded):
 *   1. `asyncFunction` — every `async` function/method/arrow declared in a script. The script's
 *      work belongs in `Effect.gen` / `Effect.fn`, with Promises converted only at the driver edge.
 *   2. `topLevelAwait` — an `await` evaluated during module evaluation (no enclosing function)
 *      whose argument is not a run adapter call. Each such await makes the module itself a Promise
 *      program: there is no fiber, no scope and no error channel around it.
 *   3. `topLevelForAwait` — a module-level `for await (... of ...)` loop; the Effect-native form is
 *      `Stream` (or `Effect.forEach` over a pulled chunk) inside the program.
 *
 * What is deliberately allowed (audit "Existing patterns to preserve" + D tier):
 *   - The driver edge itself: an async function that is the first argument of, or the `try`
 *     property of the object passed to, `Effect.tryPromise` / `Effect.promise` / `Effect.callback`
 *     (configurable via `driverEdgeCallees`). "Promise adapters forced by React, TanStack,
 *     Modern.js, Playwright, Drizzle, and Node process entrypoints" stay legal there, and async
 *     closures nested *inside* such a driver-edge function are Promise-land by construction and
 *     are not reported either.
 *   - The single outer process adapter: `await Effect.runPromise(main())`,
 *     `await Effect.runPromiseExit(main())`, `await pipe(main(), Effect.runPromise)` and
 *     `await runtime.runPromise(main())` (a captured `ManagedRuntime`, which A1 explicitly asks
 *     for) never report. How *many* run sites a script may have is `no-effect-run-in-scripts`'
 *     concern, not this rule's.
 *   - `await` inside an async function is never reported separately — the enclosing async function
 *     is the single diagnostic, so counts track functions, not statements.
 *   - Test files (`scripts/tests/**`, `*.test.mts`, …) are out of scope; B2 owns the test harness.
 *   - Identifiers merely *named* `Effect` (a local object, another package) do not create a driver
 *     edge: the binding must come from `effect` / `effect/*` via shared/effect-imports.ts.
 *
 * Scope lives in the rule: `scripts/**` minus test files by default, so `oxlint.config.ts` only
 * needs `'effect-native/no-async-script-program': 'error'`. `allowPaths` exempts globs (for
 * scripts whose async callbacks are demanded by a third-party API); `scriptPaths` force-includes
 * globs (the fixtures live under `tools/`, so they opt in that way).
 *
 * Report-only: no fixers, no suggestions.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Ranged, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings, effectMember } from '../shared/effect-imports.ts';
import type { EffectBindings as ImportedEffectBindings } from '../shared/effect-imports.ts';
type EffectBindings = ImportedEffectBindings & { context: Context };
import { globToRegExp, isScriptFile, isTestFile, matchesAny } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

/** Run adapters that legitimately sit at the executable edge (`Effect.*` or a `ManagedRuntime`). */
const RUN_ADAPTER = /^run(?:Promise|Sync|Fork|Callback)(?:Exit)?(?:With)?$/u;

/** Wrappers that do not change "is this expression the callee / argument of its parent". */
const TRANSPARENT_PARENTS = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

const FUNCTION_LIKE = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
  'StaticBlock',
]);

/** Length of the `async` / `await` keyword, used to anchor a diagnostic on the keyword itself. */
const KEYWORD_LENGTH = 5;

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly driverEdgeCallees: readonly string[];
  readonly reportTopLevelAwait: boolean;
  readonly scriptPaths: readonly string[];
}

const DEFAULTS: RuleOptions = {
  allowPaths: [],
  driverEdgeCallees: ['Effect.tryPromise', 'Effect.promise', 'Effect.callback'],
  reportTopLevelAwait: true,
  scriptPaths: [],
};

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Partial<Record<keyof RuleOptions, unknown>>;
  const strings = (value: unknown, fallback: readonly string[]): readonly string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
      ? (value as readonly string[])
      : fallback;
  return {
    allowPaths: strings(given.allowPaths, DEFAULTS.allowPaths),
    driverEdgeCallees: strings(given.driverEdgeCallees, DEFAULTS.driverEdgeCallees),
    reportTopLevelAwait:
      typeof given.reportTopLevelAwait === 'boolean'
        ? given.reportTopLevelAwait
        : DEFAULTS.reportTopLevelAwait,
    scriptPaths: strings(given.scriptPaths, DEFAULTS.scriptPaths),
  };
}

function parentOf(node: AnyNode): AnyNode | null {
  return (node as { parent?: AnyNode | null }).parent ?? null;
}

/** Climb through parentheses/type wrappers; returns the outermost equivalent node and its parent. */
function skipWrappers(node: AnyNode): { readonly node: AnyNode; readonly parent: AnyNode | null } {
  let current = node;
  let parent = parentOf(current);
  while (parent !== null && TRANSPARENT_PARENTS.has(parent.type)) {
    current = parent;
    parent = parentOf(current);
  }
  return { node: current, parent };
}

/** Peel wrappers *downwards*, e.g. `(await x)` / `x as Promise<void>` around an expression. */
function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (TRANSPARENT_PARENTS.has(current.type)) {
    const inner = (current as { expression?: AnyNode }).expression;
    if (inner === undefined || inner === null) return current;
    current = inner;
  }
  return current;
}

function nearestFunction(node: AnyNode): AnyNode | null {
  let current = parentOf(node);
  while (current !== null) {
    if (FUNCTION_LIKE.has(current.type)) return current;
    current = parentOf(current);
  }
  return null;
}

/** Static property name of a member expression, including `x["name"]`. */
function staticPropertyName(node: ESTree.MemberExpression): string | null {
  const property = syntax(node.property) as AnyNode;
  if (!node.computed)
    return property.type === 'Identifier' ? (property as ESTree.IdentifierName).name : null;
  if (property.type !== 'Literal') return null;
  const value = (property as { value?: unknown }).value;
  return typeof value === 'string' ? value : null;
}

/** Static key name of an object property / class member, including `{ ["try"]: … }`. */
function staticKeyName(node: AnyNode): string | null {
  const property = node as { computed?: boolean; key?: AnyNode };
  const key = syntax(property.key);
  if (key === undefined || key === null) return null;
  if (property.computed !== true) {
    if (key.type === 'Identifier') return (key as ESTree.IdentifierName).name;
    if (key.type === 'Literal') {
      const value = (key as { value?: unknown }).value;
      return typeof value === 'string' ? value : null;
    }
    return null;
  }
  if (key.type === 'TemplateLiteral') return literalText(key);
  if (key.type !== 'Literal') return null;
  const value = (key as { value?: unknown }).value;
  return typeof value === 'string' ? value : null;
}

/**
 * `Effect.tryPromise` (also `Effect["tryPromise"]`, `E.tryPromise` via `import { Effect as E }`,
 * and `import * as Effect from "effect/Effect"`) resolved to its *exported* namespace name.
 */
function qualifiedEffectName(node: AnyNode, bindings: EffectBindings): string | null {
  return provenance(bindings.context, node);
}

/** `call` is one of the configured driver-edge constructors (`Effect.tryPromise`, …). */
function isDriverEdgeCall(
  call: AnyNode,
  bindings: EffectBindings,
  callees: readonly string[],
): boolean {
  if (call.type !== 'CallExpression') return false;
  const qualified = qualifiedEffectName(
    unwrap((call as ESTree.CallExpression).callee as AnyNode),
    bindings,
  );
  return qualified !== null && callees.includes(qualified);
}

/** The node is the first argument of `call`, ignoring parenthesis/type wrappers. */
function isFirstArgumentOf(node: AnyNode, call: AnyNode): boolean {
  if (call.type !== 'CallExpression') return false;
  const first = (call as ESTree.CallExpression).arguments[0];
  return first !== undefined && unwrap(first as AnyNode) === unwrap(node);
}

/**
 * The function sits at a driver edge:
 *   `Effect.promise(async () => …)`, `Effect.callback(async (resume) => …)` or
 *   `Effect.tryPromise({ try: async () => …, catch: toFailure })`.
 */
function isDriverEdgeFunction(
  fn: AnyNode,
  bindings: EffectBindings,
  callees: readonly string[],
): boolean {
  const { node, parent } = skipWrappers(fn);
  if (parent === null) return false;
  if (isFirstArgumentOf(node, parent)) return isDriverEdgeCall(parent, bindings, callees);
  if (parent.type !== 'Property') return false;
  if ((parent as Extract<ESTree.Node, { type: 'Property' }>).value !== node) return false;
  if (staticKeyName(parent) !== 'try') return false;
  const object = parentOf(parent);
  if (object === null || object.type !== 'ObjectExpression') return false;
  const outer = skipWrappers(object);
  return outer.parent !== null && isFirstArgumentOf(outer.node, outer.parent)
    ? isDriverEdgeCall(outer.parent, bindings, callees)
    : false;
}

/** The function, or any enclosing function, is a driver-edge Promise seam. */
function insideDriverEdge(
  fn: AnyNode,
  bindings: EffectBindings,
  callees: readonly string[],
): boolean {
  let current: AnyNode | null = fn;
  while (current !== null) {
    if (isDriverEdgeFunction(current, bindings, callees)) return true;
    current = nearestFunction(current);
  }
  return false;
}

/**
 * `Effect.runPromise(main())`, `Effect.runPromiseExit(main())`, `runtime.runPromise(main())`
 * (a captured `ManagedRuntime`, the A1 target) or a `pipe`/`.pipe` chain ending in such a member.
 */
function isRunAdapterExpression(node: AnyNode, context: Context): boolean {
  const expression = syntax(node);
  if (expression?.type !== 'CallExpression') return false;
  const callee = syntax(expression.callee);
  const identity = provenance(context, callee);
  if (
    identity &&
    /^(?:Effect|Runtime)\.run(?:Promise|Sync|Fork|Callback)(?:Exit)?(?:With)?$/u.test(identity)
  )
    return true;
  if (
    callee?.type === 'MemberExpression' &&
    ['then', 'catch', 'finally'].includes(propertyText(callee) ?? '')
  )
    return isRunAdapterExpression(callee.object, context);
  const isPipe =
    identity === 'pipe' || (callee?.type === 'MemberExpression' && propertyText(callee) === 'pipe');
  return (
    isPipe &&
    expression.arguments.some((arg: AnyNode) =>
      /^(?:Effect|Runtime)\.run(?:Promise|Sync|Fork|Callback)(?:Exit)?(?:With)?$/u.test(
        provenance(context, arg) ?? '',
      ),
    )
  );
}

/** A tight report anchor: the declared name, the member key, or the `async` keyword itself. */
function functionAnchor(fn: AnyNode): Ranged {
  const parent = parentOf(fn);
  if (parent !== null) {
    const keyed = parent as { key?: AnyNode; value?: AnyNode; id?: AnyNode; init?: AnyNode };
    if (
      (parent.type === 'Property' ||
        parent.type === 'MethodDefinition' ||
        parent.type === 'PropertyDefinition' ||
        parent.type === 'TSAbstractMethodDefinition') &&
      keyed.value === fn &&
      keyed.key !== undefined &&
      keyed.key !== null
    ) {
      return { range: [...(keyed.key as ESTree.Span).range] };
    }
    if (
      parent.type === 'VariableDeclarator' &&
      keyed.init === fn &&
      keyed.id?.type === 'Identifier'
    ) {
      return { range: [...(keyed.id as ESTree.Span).range] };
    }
  }
  const declared = (fn as { id?: AnyNode | null }).id;
  if (declared !== undefined && declared !== null && declared.type === 'Identifier') {
    return { range: [...(declared as ESTree.Span).range] };
  }
  return keywordAnchor(fn, KEYWORD_LENGTH);
}

/** Anchor a diagnostic on the leading keyword (`async`, `await`, `for`) instead of a whole body. */
function keywordAnchor(node: AnyNode, length: number): Ranged {
  const span = node as ESTree.Span;
  return { range: [span.start, Math.min(span.start + length, span.end)] };
}

/** A readable name for the reported function, used in the diagnostic text. */
function functionLabel(fn: AnyNode): string {
  const parent = parentOf(fn);
  if (parent !== null) {
    const keyed = parent as { key?: AnyNode; value?: AnyNode; id?: AnyNode; init?: AnyNode };
    if (keyed.value === fn) {
      const key = staticKeyName(parent);
      if (key !== null) return key;
    }
    if (
      parent.type === 'VariableDeclarator' &&
      keyed.init === fn &&
      keyed.id?.type === 'Identifier'
    ) {
      return (keyed.id as ESTree.IdentifierName).name;
    }
  }
  const declared = (fn as { id?: AnyNode | null }).id;
  if (declared !== undefined && declared !== null && declared.type === 'Identifier') {
    return (declared as ESTree.IdentifierName).name;
  }
  return 'this callback';
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B3/A8: operational scripts must be Effect programs. Every async function in scripts/** is reported unless it is the driver-edge Promise seam of Effect.tryPromise/promise/callback, and module-level await/await using outside a lexically identified Effect.run* or ManagedRuntime adapter is reported. Immutable local aliases and Promise tails are supported; opaque imported runtimes and framework callback contracts require explicit path configuration.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#b3-convert-consequential-operational-scripts-into-effect-programs',
    },
    messages: {
      asyncFunction:
        'Audit B3/A8: `{{label}}` is an async/await program, so this script has no typed failure channel, no interruption, no Scope for its pools/clients and no shared Layer. Express it as Effect.gen (or Effect.fn for a named operation) returning Effect<A, E, R>, and convert Promises only inside Effect.tryPromise({ try, catch }) at the driver edge.',
      topLevelAwait:
        "Audit B3: top-level `await` outside the single Effect.run* entry adapter makes this module a Promise program — the awaited work runs with no fiber, no Scope and no error channel. Move it into the script's Effect program and keep one `await Effect.runPromiseExit(main())` process-exit adapter at the executable edge.",
      topLevelForAwait:
        "Audit B3: a module-level `for await` loop iterates outside any fiber, so cancellation, typed failures and resource release are lost. Consume the source as a Stream (or Effect.forEach over a pulled chunk) inside the script's Effect program.",
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
              'Globs of script files exempted from this rule, e.g. scripts whose async callbacks are demanded by a third-party API (default: none).',
          },
          driverEdgeCallees: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Qualified Effect constructors whose first argument (or `try` property) may be an async function (default: ["Effect.tryPromise", "Effect.promise", "Effect.callback"]).',
          },
          reportTopLevelAwait: {
            type: 'boolean',
            description:
              'Report module-level `await` / `for await` outside the Effect.run* entry adapter (default: true).',
          },
          scriptPaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs treated as in-scope scripts, bypassing the built-in scripts/** and test-file detection (default: none; the rule fixtures use it).',
          },
        },
      },
    ],
    defaultOptions: [
      {
        allowPaths: [],
        driverEdgeCallees: ['Effect.tryPromise', 'Effect.promise', 'Effect.callback'],
        reportTopLevelAwait: true,
        scriptPaths: [],
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    const filename = context.filename;
    // `scriptPaths` is an explicit opt-in that overrides both built-in scope checks.
    const forced = matchesAny(filename, options.scriptPaths);
    if (!forced && !inScriptScope(scriptScope(filename))) return {};
    if (options.allowPaths.some((glob) => globToRegExp(glob).test(scriptScope(filename))))
      return {};

    let bindings: EffectBindings = { importsEffect: false, namespaces: new Map(), context };

    const reportAsync = (node: AnyNode, isAsync: boolean): void => {
      if (!isAsync) return;
      // Overload signatures / ambient declarations have no body and no behaviour to migrate.
      const body = (node as { body?: unknown }).body;
      if (body === undefined || body === null) return;
      if (insideDriverEdge(node, bindings, options.driverEdgeCallees)) return;
      context.report({
        node: functionAnchor(node),
        messageId: 'asyncFunction',
        data: { label: functionLabel(node) },
      });
    };

    return {
      Program(node) {
        bindings = { ...collectEffectBindings(node), context };
      },
      ArrowFunctionExpression(node) {
        reportAsync(node as unknown as AnyNode, node.async);
      },
      FunctionDeclaration(node) {
        reportAsync(node as unknown as AnyNode, node.async === true);
      },
      FunctionExpression(node) {
        reportAsync(node as unknown as AnyNode, node.async === true);
      },
      AwaitExpression(node) {
        if (!options.reportTopLevelAwait) return;
        const site = node as unknown as AnyNode;
        // `await` inside an async function is covered by the `asyncFunction` diagnostic.
        if (nearestFunction(site) !== null) return;
        if (isRunAdapterExpression(node.argument as unknown as AnyNode, context)) return;
        context.report({ node: keywordAnchor(site, KEYWORD_LENGTH), messageId: 'topLevelAwait' });
      },
      VariableDeclaration(node) {
        if (
          options.reportTopLevelAwait &&
          node.kind === 'await using' &&
          nearestFunction(node) === null
        )
          context.report({ node: keywordAnchor(node, KEYWORD_LENGTH), messageId: 'topLevelAwait' });
      },
      ForOfStatement(node) {
        if (!options.reportTopLevelAwait || node.await !== true) return;
        const site = node as unknown as AnyNode;
        if (nearestFunction(site) !== null) return;
        context.report({ node: keywordAnchor(site, 3), messageId: 'topLevelForAwait' });
      },
    };
  },
});

/** Bounded, lexical provenance only; no type checker or interprocedural/data-flow inference. */
type Syntax = ESTree.Node & Record<string, any>;
function syntax(node: unknown): Syntax | null {
  let n = node as Syntax | null;
  while (
    n &&
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'TSTypeAssertion',
      'TSInstantiationExpression',
      'ParenthesizedExpression',
      'ChainExpression',
      'AwaitExpression',
    ].includes(n.type)
  )
    n = n.expression ?? n.argument;
  return n;
}
function lexicalVariable(context: Context, node: Syntax): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope) {
    const v = scope.set.get(node.name);
    if (v) return v;
    scope = scope.upper;
  }
  return null;
}
function literalText(node: unknown): string | null {
  const n = syntax(node);
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'TemplateLiteral' && n.expressions.length === 0)
    return n.quasis[0]?.value.cooked ?? null;
  return null;
}
function propertyText(node: unknown): string | null {
  const n = node as Syntax;
  const key = syntax(n.property ?? n.key);
  return !n.computed && key?.type === 'Identifier' ? key.name : literalText(key);
}
function moduleIdentity(source: string): string {
  if (/^(?:node:)?(?:process|console|util|module)$/.test(source))
    return source.replace(/^node:/, '');
  if (source === 'effect/Effect') return 'Effect';
  if (source === 'effect/ManagedRuntime') return 'ManagedRuntime';
  return source;
}
function bindingPath(pattern: Syntax, name: string): string[] | null {
  if (pattern.type === 'Identifier') return pattern.name === name ? [] : null;
  if (pattern.type === 'AssignmentPattern') return bindingPath(pattern.left, name);
  if (pattern.type !== 'ObjectPattern') return null;
  for (const p of pattern.properties) {
    if (p.type !== 'Property') continue;
    const key = propertyText(p),
      tail = bindingPath(p.value, name);
    if (key !== null && tail !== null) return [key, ...tail];
  }
  return null;
}
function provenance(context: Context, node: unknown, seen = new Set<Variable>()): string | null {
  const n = syntax(node);
  if (!n) return null;
  if (n.type === 'Identifier') {
    const v = lexicalVariable(context, n);
    if (!v || v.defs.length === 0)
      return [
        'process',
        'console',
        'Bun',
        'globalThis',
        'global',
        'window',
        'self',
        'require',
        'Array',
        'Set',
      ].includes(n.name)
        ? n.name
        : null;
    if (seen.has(v) || v.defs.length !== 1) return null;
    const next = new Set(seen);
    next.add(v);
    const def = v.defs[0] as any;
    if (def.type === 'ImportBinding') {
      const spec = def.node as Syntax;
      const decl = (def.parent ?? spec.parent) as Syntax;
      if (decl.importKind === 'type' || spec.importKind === 'type') return null;
      const source = literalText(decl.source);
      if (!source) return null;
      const base = moduleIdentity(source);
      if (spec.type === 'ImportNamespaceSpecifier' || spec.type === 'ImportDefaultSpecifier')
        return base;
      const name = spec.imported?.name ?? spec.imported?.value;
      if (name === 'default') return base;
      if (base === 'effect') return name;
      return `${base}.${name}`;
    }
    if (def.type !== 'Variable' || def.node.type !== 'VariableDeclarator') return null;
    // A declaration is not a reaching-definition analysis: reassigned aliases are unknown.
    if (v.references.some((r: any) => r.init !== true && r.isWrite())) return null;
    const d = def.node as Syntax;
    const base = provenance(context, d.init, next),
      path = bindingPath(d.id, n.name);
    return base !== null && path !== null ? [base, ...path].join('.') : null;
  }
  if (n.type === 'MemberExpression') {
    const base = provenance(context, n.object, seen),
      key = propertyText(n);
    if (base === null || key === null) return null;
    if (
      ['globalThis', 'global', 'window', 'self'].includes(base) &&
      ['process', 'console', 'Bun'].includes(key)
    )
      return key;
    if (['process', 'console', 'util', 'module'].includes(base) && key === 'default') return base;
    if (base === 'effect') return key;
    return `${base}.${key}`;
  }
  if (n.type === 'ImportExpression') {
    const text = literalText(n.source);
    return text === null ? null : moduleIdentity(text);
  }
  if (n.type === 'CallExpression') {
    const callee = provenance(context, n.callee, seen);
    if (callee === 'require') {
      const text = literalText(n.arguments[0]);
      return text === null ? null : moduleIdentity(text);
    }
    if (callee === 'module.createRequire') return 'require';
    if (callee === 'ManagedRuntime.make') return 'Runtime';
  }
  return null;
}
/** Only value references, never property names, bindings or TS-only identifiers. */
function valueReference(context: Context, node: unknown): boolean {
  const n = node as Syntax,
    p = n.parent as Syntax | undefined;
  if (!p) return false;
  if (p.type.startsWith('Import') || p.type === 'ExportSpecifier') return false;
  if (p.type === 'MemberExpression' && p.property === n && !p.computed) return false;
  if (
    [
      'Property',
      'PropertyDefinition',
      'MethodDefinition',
      'TSPropertySignature',
      'TSMethodSignature',
    ].includes(p.type) &&
    p.key === n &&
    !p.computed &&
    !(p.shorthand && p.value === n)
  )
    return false;
  if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(p.type)) return false;
  let child: Syntax = n;
  let parent: Syntax | null = p;
  while (parent) {
    if (
      parent.type.startsWith('TS') &&
      !(
        [
          'TSAsExpression',
          'TSSatisfiesExpression',
          'TSNonNullExpression',
          'TSTypeAssertion',
          'TSInstantiationExpression',
        ].includes(parent.type) && parent.expression === child
      )
    )
      return false;
    if (
      parent.type.endsWith('Statement') ||
      parent.type.endsWith('Declaration') ||
      parent.type.includes('Function')
    )
      break;
    child = parent;
    parent = parent.parent as Syntax | null;
  }
  const v = lexicalVariable(context, n);
  return (
    !v ||
    v.references.some(
      (r: any) =>
        r.identifier === n &&
        r.isRead() &&
        (typeof r.isValueReference !== 'function' || r.isValueReference()),
    )
  );
}
/** Strip fixture scaffolding first; do not renormalise a relative script path around inner markers. */
function scriptScope(filename: string): string {
  const unified = filename.replaceAll('\\', '/');
  const fixture = unified.match(
    /(?:^|\/)tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\/(.*)$/u,
  );
  if (fixture) return fixture[1];
  if (!unified.startsWith('/') && !/^[A-Za-z]:\//u.test(unified))
    return unified.replace(/^\.\//, '');
  const match = unified.match(/(?:^|\/)((?:apps|packages|verticals|scripts|tools)\/.*)$/u);
  return match?.[1] ?? unified;
}
function inScriptScope(path: string): boolean {
  return (
    /(?:^|\/)scripts\//u.test(path) &&
    !/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec|test-d|spec-d)\.[cm]?[jt]sx?$/u.test(path)
  );
}
