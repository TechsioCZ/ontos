import { optionRecord } from '../shared/options.ts';
/**
 * effect-native/require-concurrency-option
 *
 * Audit finding: **B1** — "Make workers and independent reads declaratively concurrent"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`). B1 records that "independent remote providers
 * and enrichment reads are frequently sequential" and prescribes "bounded `Effect.forEach`/`Effect.all`".
 * Evidence sites: `apps/shell-super-app/api/modules/shell-resources.ts:191,236`,
 * `apps/shell-super-app/src/routes/module-entrypoint-loader.ts:32`.
 *
 * Every Effect fan-out combinator defaults to `concurrency: 1` — i.e. strictly sequential. A fan-out
 * written without an options argument therefore reads like parallelism but executes serially, and the
 * omission is invisible at the call site: nothing in the source distinguishes "sequential because the
 * business rule demands ordering" from "sequential because nobody typed `{ concurrency }`". This rule
 * forces that decision to be spelled out, exactly as B1 asks ("Preserve deterministic ordering where
 * business semantics actually require it" — which means writing `{ concurrency: 1 }` on purpose).
 *
 * What is detected
 * ----------------
 * A `CallExpression` whose callee resolves to an `effect` fan-out member:
 *   - `Effect.forEach`, `Effect.all`, `Effect.allWith`, `Effect.allSuccesses`, `Effect.partition`,
 *     `Effect.validateAll`, `Effect.reduceEffect` (legacy configurable/version-dependent shapes)
 *   - `Stream.mapEffect`, `Stream.flatMap`, `Stream.forEach` (configurable via `streamMembers`)
 * is reported when its options argument is absent, or is an `ObjectExpression` that carries no
 * `concurrency` property. With `allowUnbounded: false` (the default) an explicit
 * `concurrency: "unbounded"` / `"inherit"` is reported too: unbounded fan-out over remote providers,
 * a database pool or SpiceDB is a load-shedding hazard, not a concurrency policy.
 *
 * Robustness:
 *   - Import bindings come from `shared/effect-imports.ts`, so aliases (`import { Effect as Fx }`),
 *     submodule namespace imports (`import * as Effect from "effect/Effect"`), root namespace imports
 *     (`import * as EFX from "effect"` → `EFX.Effect.forEach`) and direct member imports
 *     (`import { forEach } from "effect/Effect"`) are all recognised. `reexportModules` widens that to
 *     the BFF barrels (`@modern-js/plugin-bff/effect-edge` / `effect-client`), which re-export Effect's
 *     namespaces verbatim and carry the whole Shell/vertical API surface.
 *   - Computed access (`Effect["forEach"]`), optional chaining (`Effect?.forEach(...)`), parenthesised
 *     and `as`/`satisfies`/`!`-wrapped callees are all resolved.
 *   - Data-last usage is understood: the options argument shifts left one slot when the call is a
 *     curried application (`Effect.forEach((load) => …)(loads)` — the real shape at
 *     `module-entrypoint-loader.ts:32`), when it sits inside `pipe(subject, …)` / `subject.pipe(…)`,
 *     or when a callback-taking member receives a function as its first argument.
 *   - Locally shadowed identifiers (`const Effect = { forEach }`) are ignored via scope lookup.
 *   - `.ts`, `.mts` and `.tsx` are all handled.
 *
 * What is deliberately allowed
 * ----------------------------
 * - Any call that already passes `concurrency` — including `{ concurrency: 1 }`, which is how B1's
 *   "preserve deterministic ordering where business semantics actually require it" is spelled.
 * - An options argument that is not an object literal (`Effect.all(effects, baseOptions)`) and, by
 *   default, an object literal containing a spread (`{ ...baseOptions }`): the concurrency may come
 *   from the spread and this rule has no type information. Set `strictSpread: true` to report those.
 * - `Effect.all([only])` / `Effect.forEach([only], f)` and other *literal* collections shorter than
 *   `minItems` (default 2): a one-element literal is not a fan-out.
 * - Tests (`includeTests: false`) and scripts (`includeScripts: false`). The audit's B1 scale is about
 *   production workers, reads and route loaders; tests deliberately use `concurrency: "unbounded"` as
 *   a race proof (`packages/core-runtime/tests/integration/action-runtime.test.ts:1268`), and script
 *   fan-out is covered by B3, not B1.
 * - Everything the audit's "Existing patterns to preserve" / D tier blesses is untouched: this rule
 *   looks only at fan-out combinator options. Native array operations "where Effect collection APIs
 *   add no semantic value" (`.map`, `.filter`, `Promise.all`, …) are never matched — the rule requires
 *   an `effect` import binding on the callee object.
 *
 * Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree } from '@oxlint/plugins';

import { collectEffectBindings, type EffectBindings } from '../shared/effect-imports.ts';
import { isScriptFile, isTestFile, matchesGlobs, scopePath } from '../shared/paths.ts';
import {
  skipWrappers,
  staticString,
  unwrapNode,
  memberName as staticMemberName,
} from '../shared/ast.ts';
import { bindingPath } from '../shared/effect-identity.ts';
import { stringArray, positiveInteger } from '../shared/options.ts';
import {
  collectRootNamespaces,
  collectDirectMemberImports,
  collectNamedImports,
  importDeclarations,
} from '../shared/imports.ts';

const EFFECT_ROOT_MODULE = 'effect';
/** `effect/Effect`, `effect/Stream`, and any nested re-export path ending in those names. */
const EFFECT_SUBMODULE = /^effect\/(?:.*\/)?(Effect|Stream)$/u;

/** B1 is about production workers, reads and route loaders. */
const DEFAULT_INCLUDE: readonly string[] = ['apps/**', 'verticals/**', 'packages/**'];
const DEFAULT_IGNORE: readonly string[] = [];

/**
 * Barrels that re-export Effect namespaces verbatim, so `Effect` imported from them *is* Effect's
 * `Effect` (`dist/esm/runtime/effect/handler.mjs` re-exports `Config`, `Effect`, `Layer`, `Option`
 * and `Schema` straight from `effect`). The whole Shell/vertical BFF surface imports through
 * `effect-edge`, including the audit's `apps/shell-super-app/api/index.ts:1243,1315` fan-outs.
 */
const DEFAULT_REEXPORT_MODULES: readonly string[] = [
  '@modern-js/plugin-bff/effect-client',
  '@modern-js/plugin-bff/effect-edge',
];
const DEFAULT_STREAM_MEMBERS: readonly string[] = ['mapEffect', 'flatMap', 'forEach'];
const DEFAULT_MIN_ITEMS = 2;

const CONCURRENCY_KEY = 'concurrency';
/** `"inherit"` resolves to the ambient fiber concurrency, which is unbounded unless something set it. */
const UNBOUNDED_VALUES: ReadonlySet<string> = new Set(['unbounded', 'inherit']);

interface MemberShape {
  /** Index of the options argument in the data-first form. */
  readonly dataFirstOptions: number;
  /** Index of the options argument in the data-last (curried / piped) form. */
  readonly dataLastOptions: number;
  /** Index of the collection argument in the data-first form, or -1 when there is none. */
  readonly collection: number;
  /** True when the data-first form takes the callback in slot 1 (so a leading function ⇒ data-last). */
  readonly callbackSecond: boolean;
}

/** `(collection, f, options)` — `Effect.forEach` and friends. */
const COLLECTION_AND_CALLBACK: MemberShape = {
  dataFirstOptions: 2,
  dataLastOptions: 1,
  collection: 0,
  callbackSecond: true,
};
/** `(effects, options)` — `Effect.all` / `Effect.allSuccesses`. */
const COLLECTION_ONLY: MemberShape = {
  dataFirstOptions: 1,
  dataLastOptions: 0,
  collection: 0,
  callbackSecond: false,
};
/** `(options)` — `Effect.allWith` is data-last by construction. */
const OPTIONS_ONLY: MemberShape = {
  dataFirstOptions: 0,
  dataLastOptions: 0,
  collection: -1,
  callbackSecond: false,
};
/** `(effects, zero, f, options)` — `Effect.reduceEffect`. */
const REDUCE: MemberShape = {
  dataFirstOptions: 3,
  dataLastOptions: 2,
  collection: 0,
  callbackSecond: false,
};
/** `(stream, f, options)` — `Stream.mapEffect` and friends; the stream is never a literal. */
const STREAM: MemberShape = {
  dataFirstOptions: 2,
  dataLastOptions: 1,
  collection: -1,
  callbackSecond: true,
};

const EFFECT_MEMBERS: ReadonlyMap<string, MemberShape> = new Map([
  ['forEach', COLLECTION_AND_CALLBACK],
  ['partition', COLLECTION_AND_CALLBACK],
  ['validateAll', COLLECTION_AND_CALLBACK],
  // filter/filterMap also accept pure predicates with no options overload. AST cannot disambiguate.
  ['all', COLLECTION_ONLY],
  ['allSuccesses', COLLECTION_ONLY],
  ['allWith', OPTIONS_ONLY],
  ['reduceEffect', REDUCE],
]);

interface RuleOptions {
  readonly allowUnbounded: boolean;
  readonly minItems: number;
  readonly strictSpread: boolean;
  readonly includeTests: boolean;
  readonly includeScripts: boolean;
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly reexportModules: readonly string[];
  readonly streamMembers: ReadonlySet<string>;
}

function readOptions(context: Context): RuleOptions {
  const record = optionRecord(context.options?.[0]);
  return {
    allowUnbounded: record.allowUnbounded === true,
    minItems: positiveInteger(record.minItems, DEFAULT_MIN_ITEMS, 0),
    strictSpread: record.strictSpread === true,
    includeTests: record.includeTests === true,
    includeScripts: record.includeScripts === true,
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
    streamMembers: new Set(stringArray(record.streamMembers, DEFAULT_STREAM_MEMBERS)),
  };
}

const CALL_WRAPPERS: ReadonlySet<string> = new Set([
  'ChainExpression',
  'TSNonNullExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSInstantiationExpression',
  'ParenthesizedExpression',
]);

function unwrap(node: ESTree.Node): ESTree.Node {
  return unwrapNode(node, { wrappers: CALL_WRAPPERS });
}

function memberName(node: ESTree.MemberExpression): string | null {
  return staticMemberName(node, { templates: true });
}

/**
 * The shared `effect`/`effect/*` bindings, widened with the named imports of the Effect re-export
 * barrels. `import { Effect } from "@modern-js/plugin-bff/effect-edge"` binds Effect's own `Effect`.
 */
function collectBindings(
  program: ESTree.Program,
  reexportModules: readonly string[],
): EffectBindings {
  const shared = collectEffectBindings(program);
  const accepts = (source: string) => matchesGlobs(source, reexportModules);
  const namespaces = new Map([...shared.namespaces, ...collectNamedImports(program, accepts)]);
  return {
    namespaces,
    importsEffect: shared.importsEffect || importDeclarations(program, accepts).length > 0,
  };
}

/** A curried application `f(...)(...)`, or an operator slot in `pipe(subject, …)` / `subject.pipe(…)`. */
function isDataLastPosition(call: ESTree.CallExpression, context: Context): boolean {
  const { node: current, parent } = skipWrappers(call, CALL_WRAPPERS);
  if (parent?.type !== 'CallExpression') return false;
  if (unwrap(parent.callee) === current) return true; // `Effect.forEach(f)(xs)`
  const index = parent.arguments.indexOf(current as ESTree.Argument);
  if (index === -1) return false;
  const outerCallee = unwrap(parent.callee);
  // `subject.pipe(op, op)` — every argument is an operator.
  if (outerCallee.type === 'MemberExpression' && memberName(outerCallee) === 'pipe') return true;
  // `pipe(subject, op, op)` — argument 0 is the subject, the rest are operators.
  const identity = bindingPath(context, outerCallee);
  return index >= 1 && (identity?.join('.') === 'pipe' || identity?.join('.') === 'Function.pipe');
}

function isFunctionLike(node: ESTree.Node): boolean {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';
}

/** Literal collection size, or `null` when the length is not statically known. */
function literalLength(node: ESTree.Node | undefined): number | null {
  if (node === undefined) return null;
  const value = unwrap(node);
  if (value.type === 'ArrayExpression') {
    return value.elements.some((element) => element !== null && element.type === 'SpreadElement')
      ? null
      : value.elements.length;
  }
  if (value.type === 'ObjectExpression') {
    return value.properties.some((property) => property.type === 'SpreadElement')
      ? null
      : value.properties.length;
  }
  return null;
}

function propertyName(property: ESTree.ObjectProperty): string | null {
  const key = property.key;
  if (!property.computed && key.type === 'Identifier') return key.name;
  return staticString(key);
}

type Verdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unbounded'; readonly value: string };

const OK: Verdict = { kind: 'ok' };
const UNKNOWN: Verdict = { kind: 'unknown' };
const MISSING: Verdict = { kind: 'missing' };

function inspectOptions(argument: ESTree.Node | undefined, options: RuleOptions): Verdict {
  if (argument === undefined) return MISSING;
  const value = unwrap(argument);
  // A non-literal options bag (`Effect.all(effects, baseOptions)`) cannot be inspected syntactically.
  if (value.type !== 'ObjectExpression') return UNKNOWN;
  let sawSpread = false;
  for (const property of value.properties) {
    if (property.type === 'SpreadElement') {
      sawSpread = true;
      continue;
    }
    if (propertyName(property) !== CONCURRENCY_KEY) continue;
    return inspectConcurrency(property.value, options.allowUnbounded);
  }
  if (sawSpread && !options.strictSpread) return UNKNOWN;
  return MISSING;
}

function inspectConcurrency(value: ESTree.Node, allowUnbounded: boolean): Verdict {
  const literal = staticString(unwrap(value));
  if (literal !== null && UNBOUNDED_VALUES.has(literal) && !allowUnbounded)
    return { kind: 'unbounded', value: literal };
  return OK;
}

function memberShape(
  namespace: string,
  member: string,
  options: RuleOptions,
): MemberShape | undefined {
  if (namespace === 'Effect') return EFFECT_MEMBERS.get(member);
  if (namespace === 'Stream' && options.streamMembers.has(member)) return STREAM;
  return undefined;
}

function hasDataLastArguments(args: readonly ESTree.Argument[], shape: MemberShape): boolean {
  if (!shape.callbackSecond) return false;
  if (args.length === 1) return true;
  if (args[0] !== undefined && isFunctionLike(unwrap(args[0]))) return true;
  return args.length === 2 && unwrap(args[1]!).type === 'ObjectExpression';
}

function isSmallCollection(
  args: readonly ESTree.Argument[],
  shape: MemberShape,
  dataLast: boolean,
  minItems: number,
): boolean {
  if (dataLast || shape.collection === -1) return false;
  const length = literalLength(args[shape.collection]);
  return length !== null && length < minItems;
}

function reportVerdict(
  context: Context,
  node: ESTree.Node,
  callee: { readonly namespace: string; readonly member: string },
  verdict: Verdict,
): void {
  if (verdict.kind === 'ok' || verdict.kind === 'unknown') return;
  if (verdict.kind === 'missing') {
    context.report({
      node,
      messageId: 'missingConcurrency',
      data: { namespace: callee.namespace, member: callee.member },
    });
    return;
  }
  context.report({
    node,
    messageId: 'unboundedConcurrency',
    data: { namespace: callee.namespace, member: callee.member, value: verdict.value },
  });
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B1: require an explicit bounded `{ concurrency: N }` on `Effect.forEach`/`Effect.all`/' +
        '`Effect.partition` and `Stream` ' +
        'fan-out. These combinators default to sequential execution, so an omitted options argument ' +
        'leaves the scheduling choice implicit. Pure filter/filterMap overloads and opaque options are not inferred.',
    },
    messages: {
      missingConcurrency:
        '`{{namespace}}.{{member}}` runs sequentially by default (audit B1: independent remote ' +
        'providers, module-state loads, impersonation recoveries and entrypoint loads are all fanned ' +
        'out one-at-a-time). Pass an explicit bounded `{ concurrency: N }` sized for the downstream ' +
        'resource — or `{ concurrency: 1 }` when business ordering is genuinely required, so the ' +
        'sequential choice is visible instead of accidental.',
      unboundedConcurrency:
        '`{{namespace}}.{{member}}` declares `concurrency: "{{value}}"`, without a ' +
        'visible local ceiling (`inherit` depends on the ambient policy). Audit B1 asks for *bounded* ' +
        '`Effect.forEach`/`Effect.all`: pass `{ concurrency: N }` with a real limit (pair it with ' +
        '`Effect.timeout` and a typed `Schedule` retry), or add a `Semaphore` if the bound is shared.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowUnbounded: { type: 'boolean' },
          minItems: { type: 'integer', minimum: 0 },
          strictSpread: { type: 'boolean' },
          includeTests: { type: 'boolean' },
          includeScripts: { type: 'boolean' },
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          reexportModules: { type: 'array', items: { type: 'string' } },
          streamMembers: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        allowUnbounded: false,
        minItems: DEFAULT_MIN_ITEMS,
        strictSpread: false,
        includeTests: false,
        includeScripts: false,
        include: [...DEFAULT_INCLUDE],
        ignore: [...DEFAULT_IGNORE],
        reexportModules: [...DEFAULT_REEXPORT_MODULES],
        streamMembers: [...DEFAULT_STREAM_MEMBERS],
      },
    ],
  },
  createOnce(context) {
    let options: RuleOptions | null = null;
    let bindings: EffectBindings | null = null;
    let rootNamespaces: ReadonlySet<string> = new Set();
    let directMembers: ReadonlyMap<string, { namespace: string; member: string }> = new Map();

    return {
      before() {
        const resolved = readOptions(context);
        options = resolved;
        const path = scopePath(context.filename);
        if (matchesGlobs(path, resolved.ignore)) return false;
        if (!resolved.includeTests && isTestFile(path)) return false;
        const script = isScriptFile(path);
        if (script && !resolved.includeScripts) return false;
        if (!script && !matchesGlobs(path, resolved.include)) return false;

        const program = context.sourceCode.ast;
        bindings = collectBindings(program, resolved.reexportModules);
        rootNamespaces = collectRootNamespaces(
          program,
          (source) =>
            source === EFFECT_ROOT_MODULE || matchesGlobs(source, resolved.reexportModules),
        );
        directMembers = collectDirectMemberImports(
          program,
          undefined,
          {},
          (source) => EFFECT_SUBMODULE.exec(source)?.[1] ?? null,
        );
        return bindings.importsEffect || rootNamespaces.size > 0 || directMembers.size > 0;
      },
      after() {
        bindings = null;
        rootNamespaces = new Set();
        directMembers = new Map();
      },
      CallExpression(node) {
        const resolved = options;
        const imports = bindings;
        if (resolved === null || imports === null) return;

        const identity = bindingPath(context, node.callee, resolved.reexportModules);
        if (identity?.length !== 2) return;
        const callee = { namespace: identity[0], member: identity[1] };

        const shape = memberShape(callee.namespace, callee.member, resolved);
        if (shape === undefined) return;

        const args = node.arguments;
        const dataLast = isDataLastPosition(node, context) || hasDataLastArguments(args, shape);
        const optionsIndex = dataLast ? shape.dataLastOptions : shape.dataFirstOptions;
        // A literal collection shorter than minItems is not a fan-out.
        if (isSmallCollection(args, shape, dataLast, resolved.minItems)) return;

        const verdict = inspectOptions(args[optionsIndex], resolved);
        reportVerdict(context, node.callee, callee, verdict);
      },
    };
  },
});
