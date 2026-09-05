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

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import {
  collectEffectBindings,
  effectMember,
  type EffectBindings,
} from '../shared/effect-imports.ts';
import { globToRegExp, isScriptFile, isTestFile, normalisePath } from '../shared/paths.ts';

const EFFECT_NAMESPACE = 'Effect';
const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_SUBMODULE = /^effect\/(?:.*\/)?Effect$/u;

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production `include`/`ignore` defaults instead
 * of forcing the fixture config to pass loosened options (which `run-on-repo.mts` reuses).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**'];

const DEFAULT_IGNORE = [
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  'tools/**',
  'scripts/**',
];

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

function isNode(value: unknown): value is AnyNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
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
    includeTests: record.includeTests === true,
    members: stringArray(record.members, DEFAULT_MEMBERS),
    flagMemberReferences: record.flagMemberReferences === true,
    effectModules: stringArray(record.effectModules, DEFAULT_EFFECT_MODULES),
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function importedName(specifier: ESTree.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : specifier.imported.value;
}

interface EffectLocals {
  /** Locals standing for the `Effect` namespace itself. */
  readonly namespace: ReadonlySet<string>;
  /** Locals standing for a whole Effect barrel (`import * as X from "effect"` → `X.Effect.mapError`). */
  readonly barrel: ReadonlySet<string>;
  /** Locals bound by `import { mapError } from "effect/Effect"` — bare calls must be caught. */
  readonly direct: ReadonlyMap<string, string>;
}

function collectEffectLocals(
  program: ESTree.Program,
  bindings: EffectBindings,
  options: RuleOptions,
): EffectLocals {
  const namespace = new Set<string>();
  const barrel = new Set<string>();
  const direct = new Map<string, string>();
  for (const [local, exported] of bindings.namespaces) {
    if (exported === EFFECT_NAMESPACE) namespace.add(local);
  }
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    const source = statement.source.value;
    if (EFFECT_SUBMODULE.test(source)) {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier') namespace.add(specifier.local.name);
        else if (specifier.type === 'ImportSpecifier') {
          const imported = importedName(specifier);
          if (options.members.includes(imported)) direct.set(specifier.local.name, imported);
        }
      }
      continue;
    }
    if (source !== EFFECT_ROOT_MODULE && !matchesGlobs(source, options.effectModules)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') barrel.add(specifier.local.name);
      else if (
        specifier.type === 'ImportSpecifier' &&
        importedName(specifier) === EFFECT_NAMESPACE
      ) {
        namespace.add(specifier.local.name);
      }
    }
  }
  return { namespace, barrel, direct };
}

/** Non-computed `.mapError`, or computed `["mapError"]`. */
function memberName(node: AnyNode): string | null {
  const property = node.property;
  if (!isNode(property)) return null;
  if (node.computed === true) {
    return property.type === 'Literal' && typeof property.value === 'string'
      ? property.value
      : null;
  }
  return property.type === 'Identifier' && typeof property.name === 'string' ? property.name : null;
}

function lookupVariable(context: Context, identifier: ESTree.IdentifierReference): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/**
 * `true` when the identifier still resolves to an `import` binding. Unresolved names fall back to
 * `true` because the module-level import declaration already proved the binding exists; only a local
 * shadow (parameter, `const`, catch clause, …) rejects the match.
 */
function resolvesToImport(context: Context, identifier: unknown): boolean {
  if (!isNode(identifier) || identifier.type !== 'Identifier') return false;
  const variable = lookupVariable(context, identifier as unknown as ESTree.IdentifierReference);
  if (variable === null) return true;
  if (variable.defs.length === 0) return true;
  return variable.defs.some((definition) => definition.type === 'ImportBinding');
}

/** `Effect.mapError`, `Effect["mapError"]`, `Barrel.Effect.mapError` → the member name. */
function calleeMember(
  context: Context,
  callee: unknown,
  bindings: EffectBindings,
  locals: EffectLocals,
): string | null {
  if (!isNode(callee)) return null;
  if (callee.type === 'Identifier') {
    const member = locals.direct.get(String(callee.name));
    if (member === undefined) return null;
    return resolvesToImport(context, callee) ? member : null;
  }
  if (callee.type !== 'MemberExpression') return null;
  const member = memberName(callee);
  if (member === null) return null;
  const object = callee.object;
  if (!isNode(object)) return null;
  // `Effect.mapError` — fast path through the shared helper, then the computed/alias fallback.
  if (object.type === 'Identifier') {
    const fast = effectMember(callee as unknown as ESTree.Node, bindings);
    const isEffect =
      fast?.namespace === EFFECT_NAMESPACE || locals.namespace.has(String(object.name));
    if (!isEffect) return null;
    return resolvesToImport(context, object) ? member : null;
  }
  // `Barrel.Effect.mapError` where `Barrel` is `import * as Barrel from "effect"`.
  if (object.type !== 'MemberExpression') return null;
  if (memberName(object) !== EFFECT_NAMESPACE) return null;
  const root = object.object;
  if (!isNode(root) || root.type !== 'Identifier') return null;
  if (!locals.barrel.has(String(root.name))) return null;
  return resolvesToImport(context, root) ? member : null;
}

function unwrap(node: unknown): AnyNode | null {
  let current: unknown = node;
  while (isNode(current)) {
    if (
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'TSInstantiationExpression' ||
      current.type === 'ParenthesizedExpression'
    ) {
      current = current.expression;
      continue;
    }
    if (current.type === 'ChainExpression') {
      current = current.expression;
      continue;
    }
    return current;
  }
  return null;
}

/** The value of a non-computed `key` property on an object expression (method shorthand included). */
function objectProperty(object: AnyNode, key: string): unknown {
  const properties = Array.isArray(object.properties) ? object.properties : [];
  for (const property of [...properties].reverse()) {
    if (isNode(property) && property.type === 'SpreadElement') return null;
    if (!isNode(property) || property.type !== 'Property') continue;

    const propertyKey = property.key;
    if (!isNode(propertyKey)) continue;
    const name =
      property.computed !== true && propertyKey.type === 'Identifier'
        ? propertyKey.name
        : propertyKey.type === 'Literal' && typeof propertyKey.value === 'string'
          ? propertyKey.value
          : propertyKey.type === 'TemplateLiteral' &&
              (propertyKey.expressions as unknown[]).length === 0
            ? ((propertyKey.quasis as { value: { cooked: string } }[])[0]?.value.cooked ?? null)
            : null;
    // An unknown later computed key could overwrite the selected callback.
    if (name === null && property.computed === true) return null;
    if (name === key) return property.kind === 'init' ? property.value : null;
  }
  return null;
}

/**
 * Locate the error callback for a call to `Effect.<member>`. Data-last (`pipe(x, Effect.mapError(f))`)
 * puts it at argument 0; data-first (`Effect.mapError(self, f)`) at argument 1. Members listed in
 * `OPTION_PROPERTY` carry it on an options object in either position.
 */
function errorCallback(
  context: Context,
  member: string,
  argumentsList: readonly unknown[],
): AnyNode | null {
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
    (entry) =>
      entry.name === name && entry.defs.some((definition) => definition.type === 'Parameter'),
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
  const variable = lookupVariable(context, identifier as unknown as ESTree.IdentifierReference);
  if (variable === null || variable.defs.length !== 1) return null;
  const definition = variable.defs[0];
  if (definition === undefined) return null;
  if (definition.type === 'ImportBinding' || definition.type === 'Parameter') return null;
  // Reassigned bindings are not statically knowable.
  if (variable.references.some((reference) => reference.isWrite() && !reference.init)) return null;
  const node = definition.node as unknown;
  if (!isNode(node)) return null;
  if (node.type === 'FunctionDeclaration') return node;
  if (node.type === 'VariableDeclarator') {
    const init = unwrap(node.init);
    if (init !== null && isFunctionNode(init)) return init;
    if (init?.type === 'Identifier') return resolveLocalFunction(context, init, depth + 1);
  }
  return null;
}

// Resolve runtime identity, not spelling. Only immutable same-file aliases are followed;
// dynamic imports, mutable rebinding and arbitrary cross-module re-exports remain unknown.
function effectOrigin(
  context: Context,
  input: ESTree.Node,
  barrels: readonly string[],
  depth = 0,
): readonly string[] | null {
  if (depth > 24) return null;
  let node = input;
  while (
    [
      'ParenthesizedExpression',
      'ChainExpression',
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'TSInstantiationExpression',
      'TSTypeAssertion',
    ].includes(node.type)
  ) {
    node = (node as { expression: ESTree.Node }).expression;
  }
  const keyOf = (key: ESTree.Node, computed: boolean): string | null => {
    if (!computed && key.type === 'Identifier') return key.name;
    if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
    if (key.type === 'TemplateLiteral' && key.expressions.length === 0)
      return key.quasis[0]?.value.cooked ?? null;
    return null;
  };
  if (node.type === 'MemberExpression') {
    const key = keyOf(node.property, node.computed);
    const base = effectOrigin(context, node.object, barrels, depth + 1);
    return base && key !== null ? [...base, key] : null;
  }
  if (node.type !== 'Identifier') return null;
  let scope: ReturnType<Context['sourceCode']['getScope']> | null =
    context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    const defs = variable?.defs.filter(
      (def) =>
        !['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSTypeParameter'].includes(
          def.node.type,
        ),
    );
    if (!variable || !defs?.length) {
      scope = scope.upper;
      continue;
    }
    if (defs.length !== 1) return null;
    const def = defs[0]!;
    if (def.type === 'ImportBinding') {
      const spec = def.node;
      const declaration = def.parent?.type === 'ImportDeclaration' ? def.parent : spec.parent;
      if (
        declaration?.type !== 'ImportDeclaration' ||
        declaration.importKind === 'type' ||
        (spec as { importKind?: string }).importKind === 'type'
      )
        return null;
      const source = declaration.source.value;
      const root = source === 'effect' || barrels.some((glob) => globToRegExp(glob).test(source));
      if (!root && !source.startsWith('effect/')) return null;
      const base = root ? [] : [source.split('/').at(-1)!];
      if (spec.type === 'ImportNamespaceSpecifier' || spec.type === 'ImportDefaultSpecifier')
        return base;
      if (spec.type !== 'ImportSpecifier') return null;
      return [
        ...base,
        spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value,
      ];
    }
    const declaration = def.node;
    if (
      declaration.type !== 'VariableDeclarator' ||
      !declaration.init ||
      declaration.parent?.type !== 'VariableDeclaration' ||
      declaration.parent.kind !== 'const'
    )
      return null;
    if (variable.references.some((reference) => reference.isWrite() && !reference.init))
      return null;
    const base = effectOrigin(context, declaration.init, barrels, depth + 1);
    if (!base) return null;
    if (declaration.id.type === 'Identifier') return base;
    if (declaration.id.type !== 'ObjectPattern') return null;
    for (const property of declaration.id.properties) {
      if (
        property.type !== 'Property' ||
        property.value.type !== 'Identifier' ||
        property.value.name !== node.name
      )
        continue;
      const key = keyOf(property.key, property.computed);
      return key === null ? null : [...base, key];
    }
    return null;
  }
  return null;
}

function resolveValue(context: Context, input: unknown, depth = 0): AnyNode | null {
  const node = unwrap(input);
  if (!node || node.type !== 'Identifier' || depth > 24) return node;
  const variable = lookupVariable(context, node as unknown as ESTree.IdentifierReference);
  if (
    !variable ||
    variable.defs.length !== 1 ||
    variable.references.some((r) => r.isWrite() && !r.init)
  )
    return node;
  const declaration = variable.defs[0]?.node;
  if (
    declaration?.type !== 'VariableDeclarator' ||
    declaration.parent?.type !== 'VariableDeclaration' ||
    declaration.parent.kind !== 'const'
  )
    return node;
  // A const binding does not freeze its option properties. Visible writes/method calls
  // invalidate this local snapshot; arbitrary escaped-object mutation is not modeled.
  if (
    variable.references.some((reference) => {
      let current: ESTree.Node = reference.identifier;
      while (
        current.parent &&
        [
          'TSAsExpression',
          'TSSatisfiesExpression',
          'TSNonNullExpression',
          'TSTypeAssertion',
          'ParenthesizedExpression',
        ].includes(current.parent.type)
      )
        current = current.parent;
      const member = current.parent;
      if (member?.type !== 'MemberExpression' || member.object !== current) return false;
      const use = member.parent;
      return (
        (use?.type === 'AssignmentExpression' && use.left === member) ||
        (use?.type === 'UpdateExpression' && use.argument === member) ||
        (use?.type === 'UnaryExpression' && use.operator === 'delete') ||
        (use?.type === 'CallExpression' && use.callee === member)
      );
    })
  )
    return node;
  return resolveValue(context, declaration.init, depth + 1);
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
    if (locals.namespace.size === 0 && locals.barrel.size === 0 && locals.direct.size === 0)
      return {};

    return {
      CallExpression(node: ESTree.CallExpression): void {
        const raw = node as unknown as AnyNode;
        const origin = effectOrigin(context, node.callee, options.effectModules);
        const member = origin?.length === 2 && origin[0] === 'Effect' ? origin[1]! : null;
        if (member === null || !options.members.includes(member)) return;
        const argumentsList = Array.isArray(raw.arguments) ? raw.arguments : [];
        const callback = errorCallback(context, member, argumentsList);
        if (callback === null) return;
        const target = callback as unknown as ESTree.Node;

        if (isFunctionNode(callback)) {
          const classification = classifyFunction(context, callback);
          if (classification === 'zeroArity') {
            context.report({
              node: target,
              messageId: member === 'orElseFail' ? 'discardingLazyFailure' : 'zeroArity',
              data: { member },
            });
            return;
          }
          if (classification === 'unusedParameter') {
            const { name } = firstParameterName(
              Array.isArray(callback.params) ? callback.params : [],
            );
            context.report({
              node: target,
              messageId: 'unusedParameter',
              data: { member, parameter: name ?? 'error' },
            });
          }
          return;
        }

        if (callback.type === 'Identifier') {
          const name = String(callback.name);
          const definition = resolveLocalFunction(context, callback);
          if (definition === null) return;
          const classification = classifyFunction(context, definition);
          if (classification === 'zeroArity') {
            context.report({
              node: target,
              messageId: member === 'orElseFail' ? 'discardingLazyFailure' : 'indirectZeroArity',
              data: { member, name },
            });
            return;
          }
          if (classification === 'unusedParameter') {
            const parameter = firstParameterName(
              Array.isArray(definition.params) ? definition.params : [],
            ).name;
            context.report({
              node: target,
              messageId: 'indirectUnusedParameter',
              data: { member, name, parameter: parameter ?? 'error' },
            });
          }
          return;
        }

        if (options.flagMemberReferences && callback.type === 'MemberExpression') {
          const property = memberName(callback);
          context.report({
            node: target,
            messageId: 'memberReference',
            data: { member, name: property ?? 'callback' },
          });
        }
      },
    };
  },
});
