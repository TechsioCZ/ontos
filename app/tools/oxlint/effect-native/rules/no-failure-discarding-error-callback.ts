/**
 * Audit findings: **A4** — "Rebuild the error system around typed channels and contract-owned Problem
 * Details" ("`Effect.mapError(() => oneGenericError)` discarding original failures", "Preserve original
 * failures or causes when translating between layers") — and **A5** — "Introduce an Effect-shaped
 * persistence seam and typed database failures" ("PostgreSQL failures are either walked manually
 * through unknown `.cause` chains or collapsed into generic retryable 503 errors", "Introduce a
 * Core-owned database failure taxonomy and one decoder"), both in
 * `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`.
 *
 * A `catch`/`mapError` callback that takes no argument — or takes one and never reads it — throws the
 * only evidence away at the exact seam where SQLSTATE, connectivity, decode and timeout failures still
 * differ. Everything downstream sees one generic "unavailable" error, so retry policy, 409/428/503
 * distinctions and the cause chain are all lost.
 *
 * What is detected — in `include` paths only, for calls on an Effect namespace binding proven by the
 * file's own import declarations (`import { Effect } from "effect"`, `import * as Effect from
 * "effect/Effect"`, aliases, `effectModules` barrels, `Effect["mapError"]`, `Effect?.mapError`, and
 * bare `mapError` imported directly from `effect/Effect`). Data-first (`Effect.mapError(self, f)`),
 * data-last (`self.pipe(Effect.mapError(f))`) and point-free pipe usage are treated identically.
 *
 * The error callback is located per member:
 * - `mapError` / `catch` / `catchAll` / `catchCause` / `catchAllCause` / `catchDefect` / `orElseFail`
 *   → the handler argument.
 * - `mapBoth` / `match` / `matchEffect` / `matchCause` / `matchCauseEffect` → `onFailure`.
 * - `tryPromise` / `try` / `tryMap` / `tryMapPromise` → the `catch` property of the options object.
 *
 * It is then classified:
 * - Arrow/function expression with **zero parameters** → reported.
 * - First parameter is an `Identifier` whose scope variable has **zero reads** (this includes
 *   `_`- prefixed throwaways) → reported.
 * - First parameter is an `ObjectPattern`/`ArrayPattern`/`RestElement` → treated as used.
 * - An `Identifier` callback that resolves, through scope, to a **same-file** function definition →
 *   the same test is applied to that definition (`const unavailable = () => new UnavailableError()`).
 * - Anything else (imported factories, parameters, member expressions, reassigned bindings) → skipped.
 *
 * What is deliberately allowed
 * - `Effect.catchTag`, `Effect.catchTags` and `Effect.catchIf`: those are the A4 *target*. The rule
 *   never inspects them, so `Effect.catchTag('ActionAlreadyCommitted', () => Effect.void)` is fine —
 *   the tag already carries the failure identity.
 * - Any callback that reads its failure parameter, however it uses it — including
 *   `(error) => new X({ cause: error })` and `catch: decodeDatabaseFailure` (the shared decoder A5
 *   asks for), whether the decoder is imported or defined in the same file.
 * - Tests (`includeTests: false`) and scripts: the audit's D tier blesses throwaway error mapping in
 *   test fixtures and operational scripts, and B3 migrates scripts separately.
 * - Imported and member-expression callbacks (`catch: failures.unavailable`), unless
 *   `flagMemberReferences` is enabled — with no type information their arity is unknowable, so the
 *   rule under-reports rather than guesses.
 *
 * Known limitation: a source that genuinely has a single failure mode is still reported (the audit
 * asks for the cause to be preserved regardless), and imported zero-arity factories are missed. This
 * rule only reports; it never fixes or suggests, and no source file is edited to satisfy it.
 */
import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree, Variable } from '@oxlint/plugins';

import { isNode, keyName, memberName, EXPRESSION_WRAPPERS, skipWrappers } from '../shared/ast.ts';
import { lookupVariable } from '../shared/bindings.ts';
import { effectOrigin } from '../shared/effect-identity.ts';
import { collectEffectBindings, type EffectBindings } from '../shared/effect-imports.ts';
import { collectNamedImports, collectRootNamespaces } from '../shared/imports.ts';
import { optionRecord } from '../shared/options.ts';
import { stringArray } from '../shared/options.ts';
import { isScriptFile, isTestFile, scopePath, matchesGlobs } from '../shared/paths.ts';

const EFFECT_NAMESPACE = 'Effect';
const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_SUBMODULE = /^effect\/(?:.*\/)?Effect$/u;

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**'];

const DEFAULT_IGNORE = ['**/dist/**', '**/build/**', '**/node_modules/**', 'tools/**', 'scripts/**'];

/** Members whose error callback replaces or absorbs the failure channel wholesale. */
const DEFAULT_MEMBERS = [
  'mapError',
  'catch',
  'catchAll',
  'catchCause',
  'catchAllCause',
  'catchDefect',
  'orElseFail',
  'mapBoth',
  'match',
  'matchEffect',
  'matchCause',
  'matchCauseEffect',
  'tryPromise',
  'try',
  'tryMap',
  'tryMapPromise',
];

/** Members whose error callback lives in an options object rather than in the argument list. */
const OPTION_PROPERTY: ReadonlyMap<string, string> = new Map([
  ['mapBoth', 'onFailure'],
  ['match', 'onFailure'],
  ['matchEffect', 'onFailure'],
  ['matchCause', 'onFailure'],
  ['matchCauseEffect', 'onFailure'],
  ['tryPromise', 'catch'],
  ['try', 'catch'],
  ['tryMap', 'catch'],
  ['tryMapPromise', 'catch'],
]);

/** Barrels that re-export the Effect namespace verbatim. */
const DEFAULT_EFFECT_MODULES = ['@modern-js/plugin-bff/effect-edge'];

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly includeTests: boolean;
  readonly members: readonly string[];
  readonly flagMemberReferences: boolean;
  readonly effectModules: readonly string[];
}

type AnyNode = Record<string, unknown> & { readonly type: string };

function readOptions(context: Context): RuleOptions {
  const record = optionRecord(context.options?.[0]);
  return {
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    includeTests: record.includeTests === true,
    members: stringArray(record.members, DEFAULT_MEMBERS),
    flagMemberReferences: record.flagMemberReferences === true,
    effectModules: stringArray(record.effectModules, DEFAULT_EFFECT_MODULES),
  };
}

interface EffectLocals {
  /** Locals standing for the `Effect` namespace itself. */
  readonly namespace: ReadonlySet<string>;
  /** Locals standing for a whole Effect barrel (`import * as X from "effect"` → `X.Effect.mapError`). */
  readonly barrel: ReadonlySet<string>;
  /** Locals bound by `import { mapError } from "effect/Effect"` — bare calls must be caught. */
  readonly direct: ReadonlyMap<string, string>;
}

function collectEffectLocals(program: ESTree.Program, bindings: EffectBindings, options: RuleOptions): EffectLocals {
  const submodule = (source: string) => EFFECT_SUBMODULE.test(source);
  const root = (source: string) =>
    !submodule(source) && (source === EFFECT_ROOT_MODULE || matchesGlobs(source, options.effectModules));
  const namespace = collectRootNamespaces(program, submodule);
  for (const [local, exported] of bindings.namespaces) {
    if (exported === EFFECT_NAMESPACE) namespace.add(local);
  }
  for (const local of collectNamedImports(program, root, new Set([EFFECT_NAMESPACE])).keys()) namespace.add(local);
  return {
    namespace,
    barrel: collectRootNamespaces(program, root),
    direct: collectNamedImports(program, submodule, new Set(options.members)),
  };
}

function unwrap(node: unknown): AnyNode | null {
  let current: unknown = node;
  while (isNode(current)) {
    if (EXPRESSION_WRAPPERS.has(current.type)) {
      current = current.expression;
      continue;
    }
    return current;
  }
  return null;
}

/** A later spread or unknown computed key prevents proving the selected value. */
function selectedProperty(property: unknown, key: string): { value: unknown } | null {
  if (!isNode(property)) return null;
  if (property.type === 'SpreadElement') return { value: null };
  if (property.type !== 'Property' || !isNode(property.key)) return null;
  const name = keyName(property.key, property.computed === true, {
    templates: true,
  });
  if (name === null && property.computed === true) return { value: null };
  return name === key ? { value: property.kind === 'init' ? property.value : null } : null;
}

/** Resolve the last statically selected object property, including method shorthand. */
function objectProperty(object: AnyNode, key: string): unknown {
  const properties = Array.isArray(object.properties) ? object.properties : [];
  for (const property of [...properties].reverse()) {
    const selected = selectedProperty(property, key);
    if (selected !== null) return selected.value;
  }
  return null;
}

/**
 * Locate the error callback for a call to `Effect.<member>`. Data-last (`pipe(x, Effect.mapError(f))`)
 * puts it at argument 0; data-first (`Effect.mapError(self, f)`) at argument 1. Members listed in
 * `OPTION_PROPERTY` carry it on an options object in either position.
 */
function errorCallback(context: Context, member: string, argumentsList: readonly unknown[]): AnyNode | null {
  const property = OPTION_PROPERTY.get(member);
  if (property !== undefined) {
    for (const argument of argumentsList) {
      const candidate = resolveValue(context, argument);
      if (candidate === null || candidate.type !== 'ObjectExpression') continue;
      const value = objectProperty(candidate, property);
      if (value !== null) return unwrap(value);
    }
    return null;
  }
  if (argumentsList.length === 0) return null;
  const positional = argumentsList.length >= 2 ? argumentsList[1] : argumentsList[0];
  const candidate = unwrap(positional);
  if (candidate === null) return null;
  if (candidate.type === 'SpreadElement') return null;
  return candidate;
}

type Classification = 'zeroArity' | 'unusedParameter' | 'uses' | 'unknown';

/** The binding name of the first parameter, or `null` when it is a pattern (destructuring = used). */
function firstParameterName(parameters: readonly unknown[]): {
  name: string | null;
  pattern: boolean;
} {
  const first = unwrap(parameters[0]);
  if (first === null) return { name: null, pattern: false };
  let target: AnyNode | null = first;
  if (target.type === 'AssignmentPattern') target = unwrap(target.left);
  if (target === null) return { name: null, pattern: true };
  if (target.type === 'TSParameterProperty') target = unwrap(target.parameter);
  if (target === null) return { name: null, pattern: true };
  if (target.type === 'Identifier') return { name: String(target.name), pattern: false };
  // ObjectPattern / ArrayPattern / RestElement all read the failure.
  return { name: null, pattern: true };
}

function classifyFunction(context: Context, fn: AnyNode): Classification {
  const parameters = Array.isArray(fn.params) ? fn.params : [];
  if (parameters.length === 0) return 'zeroArity';
  const { name, pattern } = firstParameterName(parameters);
  if (pattern || name === null) return 'uses';
  const declared = context.sourceCode.getDeclaredVariables(fn as unknown as ESTree.Node);
  const variable = declared.find(
    (entry) => entry.name === name && entry.defs.some((definition) => definition.type === 'Parameter'),
  );
  if (variable === undefined) return 'unknown';
  return variable.references.some((reference) => reference.isRead()) ? 'uses' : 'unusedParameter';
}

function isFunctionNode(node: AnyNode): boolean {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';
}

/** Resolve an identifier callback to a same-file function definition, or `null`. */
function resolveLocalFunction(context: Context, identifier: AnyNode, depth = 0): AnyNode | null {
  if (depth > 24) return null;
  const variable = stableVariable(context, identifier);
  if (variable === null) return null;
  const definition = variable.defs[0];
  if (definition === undefined) return null;
  if (definition.type === 'ImportBinding' || definition.type === 'Parameter') return null;
  return functionDefinition(context, definition.node, depth);
}

function functionDefinition(context: Context, node: unknown, depth: number): AnyNode | null {
  if (!isNode(node)) return null;
  if (node.type === 'FunctionDeclaration') return node;
  if (node.type !== 'VariableDeclarator') return null;
  const init = unwrap(node.init);
  if (init !== null && isFunctionNode(init)) return init;
  return init?.type === 'Identifier' ? resolveLocalFunction(context, init, depth + 1) : null;
}

const OPTION_REFERENCE_WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'ParenthesizedExpression',
]);

function mutatesMember(member: ESTree.MemberExpression): boolean {
  const use = member.parent;
  if (use?.type === 'AssignmentExpression') return use.left === member;
  if (use?.type === 'UpdateExpression') return use.argument === member;
  if (use?.type === 'UnaryExpression') return use.operator === 'delete';
  return use?.type === 'CallExpression' && use.callee === member;
}

function mutatesOptionObject(identifier: ESTree.Node): boolean {
  const { node, parent } = skipWrappers(identifier, OPTION_REFERENCE_WRAPPERS);
  return parent?.type === 'MemberExpression' && parent.object === node && mutatesMember(parent);
}

function stableVariable(context: Context, identifier: AnyNode): Variable | null {
  const variable = lookupVariable(context, identifier as unknown as ESTree.Node);
  if (!variable || variable.defs.length !== 1) return null;
  return variable.references.some((reference) => reference.isWrite() && !reference.init) ? null : variable;
}

function constDeclaration(variable: Variable): ESTree.VariableDeclarator | null {
  const declaration = variable.defs[0]?.node;
  if (declaration?.type !== 'VariableDeclarator') return null;
  return declaration.parent?.type === 'VariableDeclaration' && declaration.parent.kind === 'const' ? declaration : null;
}

function resolveValue(context: Context, input: unknown, depth = 0): AnyNode | null {
  const node = unwrap(input);
  if (!node || node.type !== 'Identifier' || depth > 24) return node;
  const variable = stableVariable(context, node);
  if (!variable) return node;
  const declaration = constDeclaration(variable);
  if (declaration === null) return node;
  // A const binding does not freeze its option properties. Visible writes/method calls
  // invalidate this local snapshot; arbitrary escaped-object mutation is not modeled.
  if (variable.references.some((reference) => mutatesOptionObject(reference.identifier))) return node;
  return resolveValue(context, declaration.init, depth + 1);
}

function reportFunction(
  context: Context,
  callback: AnyNode,
  definition: AnyNode,
  member: string,
  indirect: boolean,
): void {
  const classification = classifyFunction(context, definition);
  const node = callback as unknown as ESTree.Node;
  const name = String(callback.name);
  if (classification === 'zeroArity') {
    context.report({
      node,
      messageId: member === 'orElseFail' ? 'discardingLazyFailure' : indirect ? 'indirectZeroArity' : 'zeroArity',
      data: { member, name },
    });
    return;
  }
  if (classification !== 'unusedParameter') return;
  const parameter = firstParameterName(Array.isArray(definition.params) ? definition.params : []).name;
  context.report({
    node,
    messageId: indirect ? 'indirectUnusedParameter' : 'unusedParameter',
    data: { member, name, parameter: parameter ?? 'error' },
  });
}

function reportCallback(context: Context, callback: AnyNode, member: string, flagMemberReferences: boolean): void {
  if (isFunctionNode(callback)) {
    reportFunction(context, callback, callback, member, false);
    return;
  }
  if (callback.type === 'Identifier') {
    const definition = resolveLocalFunction(context, callback);
    if (definition !== null) reportFunction(context, callback, definition, member, true);
    return;
  }
  if (flagMemberReferences && callback.type === 'MemberExpression') {
    context.report({
      node: callback as unknown as ESTree.Node,
      messageId: 'memberReference',
      data: { member, name: memberName(callback) ?? 'callback' },
    });
  }
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A4/A5: `Effect.mapError`/`catch`/`tryPromise({ catch })` callbacks must not discard the ' +
        'original failure. `Effect.mapError(() => new UnavailableError())` and `catch: () => genericFailure()` ' +
        'collapse SQLSTATE, connectivity, decode and timeout failures into one generic 503 and throw the ' +
        'cause away. Preserve the failure, decode it through the shared database/transport failure decoder, ' +
        'or narrow with `Effect.catchTag`/`Effect.catchTags`. Static parameter reads do not prove semantic cause preservation; imported callbacks and dynamic option bags remain unknown.',
    },
    messages: {
      discardingLazyFailure:
        'Effect.orElseFail cannot receive the original failure. Use Effect.mapError or Effect.catchTag(s) to preserve or narrow it (audit A4/A5).',
      zeroArity:
        '`Effect.{{member}}` is given a zero-argument callback, so the original failure is discarded here. ' +
        'Accept it and preserve it (`(error) => new XError({ cause: error })`), decode it through the shared ' +
        'Core database/transport failure decoder (A5), or narrow the failure with `Effect.catchTag`/' +
        '`Effect.catchTags` so the tag itself carries the identity (A4).',
      unusedParameter:
        '`Effect.{{member}}` callback declares `{{parameter}}` but never reads it, so the original failure is ' +
        'discarded here. Carry it into the replacement error (`new XError({ cause: {{parameter}} })`), decode ' +
        'it through the shared Core database/transport failure decoder (A5), or narrow with ' +
        '`Effect.catchTag`/`Effect.catchTags` instead of collapsing every reason into one (A4).',
      indirectZeroArity:
        '`Effect.{{member}}` is given `{{name}}`, a same-file factory that takes no failure argument, so the ' +
        'original failure is discarded here. Give `{{name}}` the failure and preserve it as a `cause`, replace ' +
        'it with the shared Core database/transport failure decoder (A5), or narrow with ' +
        '`Effect.catchTag`/`Effect.catchTags` (A4).',
      indirectUnusedParameter:
        '`Effect.{{member}}` is given `{{name}}`, a same-file factory that ignores its `{{parameter}}` ' +
        'argument, so the original failure is discarded here. Preserve it as a `cause`, replace `{{name}}` ' +
        'with the shared Core database/transport failure decoder (A5), or narrow with ' +
        '`Effect.catchTag`/`Effect.catchTags` (A4).',
      memberReference:
        '`Effect.{{member}}` is given the opaque callback `{{name}}`; this rule cannot prove it preserves the ' +
        'original failure. Pass a local handler that carries the failure into the replacement error, or use ' +
        'the shared Core database/transport failure decoder (A5).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          includeTests: { type: 'boolean' },
          members: { type: 'array', items: { type: 'string' } },
          flagMemberReferences: { type: 'boolean' },
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
        members: DEFAULT_MEMBERS,
        flagMemberReferences: false,
        effectModules: DEFAULT_EFFECT_MODULES,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore)) return {};
    if (!matchesGlobs(path, options.include)) return {};
    if (isScriptFile(path)) return {};
    if (!options.includeTests && isTestFile(path)) return {};

    const program = context.sourceCode.ast;
    const bindings = collectEffectBindings(program);
    const locals = collectEffectLocals(program, bindings, options);
    if (locals.namespace.size === 0 && locals.barrel.size === 0 && locals.direct.size === 0) return {};

    return {
      CallExpression(node: ESTree.CallExpression): void {
        const raw = node as unknown as AnyNode;
        const origin = effectOrigin(context, node.callee, options.effectModules);
        const member = origin?.length === 2 && origin[0] === 'Effect' ? origin[1]! : null;
        if (member === null || !options.members.includes(member)) return;
        const argumentsList = Array.isArray(raw.arguments) ? raw.arguments : [];
        const callback = errorCallback(context, member, argumentsList);
        if (callback === null) return;

        reportCallback(context, callback, member, options.flagMemberReferences);
      },
    };
  },
});
