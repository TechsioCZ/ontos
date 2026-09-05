/**
 * effect-native/no-manual-tag-comparison
 *
 * Audit findings: **A4** — "Rebuild the error system around typed channels and contract-owned Problem
 * Details" ("Roughly 113 manual `_tag` comparisons", "`_tag ===` inside `Effect.catch` and
 * `mapError`", "Use `Effect.catchTag`, `Effect.catchTags`, and exhaustive `Match`"), **C2** —
 * "Replace raw Option, Exit, and `_tag` inspection", and **B5** — "Adopt Effect's ADTs and temporal
 * model consistently" (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`).
 *
 * The repository discriminates failures and outcomes by hand: if-ladders and nested ternaries in
 * every Contacts and Shell route (`apps/shell-super-app/api/index.ts`,
 * `verticals/contacts/api/read-server-support.ts`), `result._tag === 'found'` outcome unions
 * (`customer-contact-persistence.service.ts`), ARES retry predicates built from `||` chains of tag
 * equality, prefix probes such as `error._tag.startsWith('Contacts') && error._tag.endsWith('Problem')`
 * (`verticals/contacts/api/index.ts:176`), and `'_tag' in error` shape tests. Every one of them is a
 * second, non-exhaustive authority over a vocabulary that a `Schema.TaggedError` union already owns,
 * and each drifts silently when a tag is added or renamed.
 *
 * ## What this detects
 *
 * 1. **Equality against a tag** — a `BinaryExpression` with `===`, `!==`, `==` or `!=` where one
 *    operand is a tag expression and the other is anything else, plus the equality-without-an-operator
 *    spelling `Object.is(x._tag, 'X')`. The compared value may be a string literal, an
 *    expressionless template literal, a variable, an enum member or any other expression — a
 *    comparison against a variable is exactly as non-exhaustive as one against a literal. Both
 *    operand orders are handled, and every comparison in an `||` / `&&` chain reports separately,
 *    because each is its own missing `Match` case.
 * 2. **String probes on a tag** — `x._tag.startsWith(…)`, `.endsWith(…)`, `.includes(…)`,
 *    `.match(…)`, `.test(…)`, and the mirrored regex spelling `/^Contacts/u.test(x._tag)` /
 *    `RE.exec(x._tag)`. Treating the tag as a string re-implements union membership by naming
 *    convention.
 * 3. **Shape tests for the discriminant** — `'_tag' in value`, `` `_tag` in value ``,
 *    `Object.hasOwn(value, '_tag')` and `Reflect.has(value, '_tag')`.
 * 4. **Membership probes** — `KNOWN_TAGS.includes(x._tag)`, `TAG_SET.has(x._tag)` and
 *    `x._tag in HANDLERS`: a second, unchecked copy of the union's membership list
 *    (`includeMembershipProbes: false` opts out).
 *
 * A **tag expression** is resolved through every spelling that does not change what is being read:
 *
 * - the wrappers that never change what an expression denotes — optional chaining (`error?._tag`),
 *   non-null assertions (`error!._tag`), `as` / `satisfies` / angle-bracket assertions, parentheses,
 *   and arbitrarily deep receivers (`error.a.b.reason._tag`);
 * - computed access — `error['_tag']`, `` error[`_tag`] ``, and an indirect key
 *   (`const KEY = '_tag'; error[KEY]`, `error['_' + 'tag']`);
 * - **indirection through a local binding**, resolved with `context.sourceCode.getScope` so
 *   shadowing is respected: `const { _tag } = error`, `const { _tag: classification } = error`,
 *   `const tag = error._tag`, a nested pattern (`const { reason: { _tag } } = error`), a destructured
 *   parameter (`({ _tag }) => …`), a `for (const { _tag } of …)` head and `catch ({ _tag })`. The
 *   binding itself is fine — only a *comparison* on it reports, so `readTag = ({ _tag }) => _tag`
 *   stays silent while `({ _tag }) => _tag === 'X'` does not (`includeIndirectTags: false` opts out);
 * - **string laundering** — `String(error._tag)` and derivations such as `error._tag.slice(0, 8)`,
 *   `.toLowerCase()`, `.replace(…)`, `.trim()`: the result is still the tag, so comparing it is still
 *   hand-written narrowing.
 *
 * Scope is encoded in the rule: `apps/**`, `verticals/**`, `packages/**`, `scripts/**` (`include`),
 * `.ts`/`.mts`/`.tsx` alike. Tests are in scope by default — the audit's B2 harness work wants test
 * predicates to go through `Schema.is(TaggedError)` rather than hand-written tag equality
 * (`ignoreTests: true` opts out).
 *
 * ## What is deliberately allowed
 *
 * - **Effect's built-in ADT tags** (`Some`, `None`, `Success`, `Failure`, `Left`, `Right` —
 *   `adtTags`). `exit._tag === 'Failure'` is the sibling rule `no-raw-effect-adt-tag-check`'s
 *   concern; reporting it here too would double-report the same span.
 * - **`switch (error._tag)`** — switch exhaustiveness belongs to `prefer-match-over-tag-switch`;
 *   this rule never looks at a `SwitchStatement` discriminant or its `case` tests.
 * - **Type-level `_tag`** — `Extract<P, { readonly _tag: 'X' }>`, `P['_tag']`,
 *   `Failure extends { readonly _tag: infer Tag }`. Type positions contain no `BinaryExpression` or
 *   `CallExpression`, so they are structurally unreachable from these visitors.
 * - **Tag-to-tag equality** (`a._tag === b._tag`, and the same through aliases) — comparing two
 *   discriminants is an identity test, not a hand-written case analysis over a closed vocabulary.
 * - **Reading, building and annotating a tag** — `{ _tag: tag }`, `{ failureTag: error._tag }`,
 *   `const { _tag } = error` on its own. Only narrowing reports.
 * - **The Effect-native forms themselves**: `Effect.catchTag(s)`, `Match.tag`/`Match.tags`/
 *   `Match.typeTags`, `Match.when({ _tag: 'X' }, …)` object patterns, `Schema.is(TaggedError)(x)`,
 *   `Predicate.isTagged`, `Option.isSome`/`Exit.isFailure` and friends — none compare a tag by hand.
 * - **`allowTags`** — an explicit, narrow escape hatch (empty by default) for a tag vocabulary that
 *   genuinely may not move to `Match`/`Schema.is`.
 * - **`includeErrorCombinators: false`** (opt-in) suppresses comparisons written inside a function
 *   passed directly to `Effect.catch`/`catchIf`/`catchFilter`/`catchCause`/`catchEager`/`mapError`/
 *   `mapErrorEager`/`tapError`/`retry`, `Schedule.recurWhile`, or a `Match.when`/`Match.whenOr`
 *   predicate. The default is `true`: A4 names `_tag ===` inside `Effect.catch` and `mapError` as the
 *   load-bearing instance of the anti-pattern, so those are reported unless a consumer opts out.
 * - Anything matched by `ignore`, and anything outside `include` (`tools/**`, `dist/**`, generated
 *   bundles).
 *
 * Known limitation: with no type information, a `_tag` property is judged lexically. Non-Effect
 * objects that carry a `_tag` (the Contacts `LookupResult` / `LifecycleResult` outcome unions) are
 * reported — deliberately, since B5 asks for `Option`/`Result` there. Report-only: no fixers, no
 * suggestions. Reassigned aliases are not traced; no control-flow value inference is attempted.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production `include` defaults instead of
 * forcing the fixture config to pass loosened options (which `run-on-repo.mts` reuses verbatim).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];

const DEFAULT_IGNORE: readonly string[] = [];

/** Tag literals owned by Effect's built-in ADTs — `no-raw-effect-adt-tag-check` reports those. */
const DEFAULT_ADT_TAGS = ['Some', 'None', 'Success', 'Failure', 'Left', 'Right'];

/** Barrels that re-export Effect namespaces verbatim (the Modern.js BFF edge barrel). */
const DEFAULT_REEXPORT_MODULES = ['@modern-js/plugin-bff/effect-edge'];

const EQUALITY_OPERATORS = new Set(['===', '!==', '==', '!=']);

const TAG_PROPERTY = '_tag';

/** String methods that turn a closed tag vocabulary into a naming convention. */
const STRING_PROBES = new Set(['startsWith', 'endsWith', 'includes', 'match', 'test']);

/** Regex methods whose *argument* is the probed string (`/^Contacts/u.test(error._tag)`). */
const REGEX_PROBES = new Set(['test', 'exec']);

/**
 * String methods that return a value still derived from the tag. `error._tag.slice(0, 8) === 'Contacts'`
 * is prefix matching with extra steps, so the result stays a tag expression.
 */
const STRING_TRANSFORMS = new Set([
  'slice',
  'substring',
  'substr',
  'at',
  'charAt',
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
  'normalize',
  'replace',
  'replaceAll',
  'padStart',
  'padEnd',
  'toString',
  'valueOf',
]);

/** Membership containers: `KNOWN.includes(tag)`, `SET.has(tag)`. */
const MEMBERSHIP_METHODS = new Set(['includes', 'has', 'indexOf', 'lastIndexOf']);

/** `Effect.*` combinators whose callback is the error channel (`includeErrorCombinators: false`). */
const ERROR_COMBINATORS = new Set([
  'catch',
  'catchIf',
  'catchFilter',
  'catchCause',
  'catchEager',
  'mapError',
  'mapErrorEager',
  'tapError',
  'retry',
]);

/** `Schedule.*` combinators taking a failure predicate. */
const SCHEDULE_COMBINATORS = new Set(['recurWhile', 'recurUntil', 'whileInput', 'untilInput']);

/** `Match.*` combinators whose first argument may be a hand-written predicate. */
const MATCH_COMBINATORS = new Set(['when', 'whenOr', 'whenAnd', 'not']);

const MAX_TEXT_LENGTH = 60;

/** Bounds every structural walk so a pathological expression can never spin. */
const MAX_DEPTH = 64;

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly ignoreTests: boolean;
  readonly includeErrorCombinators: boolean;
  readonly includeIndirectTags: boolean;
  readonly includeMembershipProbes: boolean;
  readonly adtTags: readonly string[];
  readonly allowTags: readonly string[];
  readonly requireEffectImport: boolean;
  readonly reexportModules: readonly string[];
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
    ignoreTests: record.ignoreTests === true,
    includeErrorCombinators: record.includeErrorCombinators !== false,
    includeIndirectTags: record.includeIndirectTags !== false,
    includeMembershipProbes: record.includeMembershipProbes !== false,
    adtTags: stringArray(record.adtTags, DEFAULT_ADT_TAGS),
    allowTags: stringArray(record.allowTags, []),
    requireEffectImport: record.requireEffectImport === true,
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Strip the wrappers that never change what an expression denotes. */
function unwrap(node: ESTree.Node): ESTree.Node {
  let current: ESTree.Node = node;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (current.type === 'ChainExpression') {
      current = current.expression;
      continue;
    }
    if (current.type === 'TSNonNullExpression' || current.type === 'ParenthesizedExpression') {
      current = current.expression;
      continue;
    }
    if (
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSInstantiationExpression' ||
      current.type === 'TSTypeAssertion'
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
  return current;
}

function templateText(node: ESTree.TemplateLiteral): string | null {
  const quasi = node.quasis[0];
  if (node.quasis.length !== 1 || quasi === undefined) return null;
  return quasi.value.cooked ?? quasi.value.raw;
}

/** A statically known string operand (`'X'`, `"X"`, `` `X` ``), or null. */
function asStringLiteral(node: ESTree.Node): string | null {
  const expression = unwrap(node);
  if (expression.type === 'Literal')
    return typeof expression.value === 'string' ? expression.value : null;
  if (expression.type === 'TemplateLiteral' && expression.expressions.length === 0)
    return templateText(expression);
  return null;
}

function resolveVariable(context: Context, name: string, from: ESTree.Node): Variable | null {
  let scope: Scope | null = null;
  try {
    scope = context.sourceCode.getScope(from);
  } catch {
    return null;
  }
  for (let depth = 0; scope !== null && depth < MAX_DEPTH; depth += 1) {
    const variable = scope.set.get(name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/** Single-assignment `const NAME = <expr>` initialiser for an identifier reference, or null. */
function constInitialiser(context: Context, node: ESTree.Node): ESTree.Node | null {
  const expression = unwrap(node);
  if (expression.type !== 'Identifier') return null;
  const variable = resolveVariable(context, expression.name, expression);
  if (variable === null || variable.defs.length !== 1) return null;
  if (variable.references.some((reference) => reference.isWrite() && !reference.init)) return null;
  const def = variable.defs[0];
  if (def === undefined || def.type !== 'Variable') return null;
  const declarator = def.node as ESTree.Node;
  if (declarator.type !== 'VariableDeclarator') return null;
  if (declarator.id.type !== 'Identifier' || declarator.id.name !== expression.name) return null;
  return declarator.init ?? null;
}

/**
 * A statically known string, following one level of `const KEY = '_tag'` indirection and folding
 * literal `'_' + 'tag'` concatenation — the two spellings that hide a computed `_tag` key.
 */
function staticString(context: Context, node: ESTree.Node): string | null {
  const direct = asStringLiteral(node);
  if (direct !== null) return direct;
  const expression = unwrap(node);
  if (expression.type === 'BinaryExpression' && expression.operator === '+') {
    const left = asStringLiteral(expression.left);
    const right = asStringLiteral(expression.right);
    return left !== null && right !== null ? left + right : null;
  }
  const initialiser = constInitialiser(context, expression);
  return initialiser === null ? null : asStringLiteral(initialiser);
}

/** The `_tag` member access itself (`x._tag`, `x?._tag`, `x!._tag`, `x["_tag"]`, `x[KEY]`), or null. */
function asTagMember(context: Context, node: ESTree.Node): ESTree.MemberExpression | null {
  const expression = unwrap(node);
  if (expression.type !== 'MemberExpression') return null;
  const property = expression.property;
  if (!expression.computed) {
    return property.type === 'Identifier' && property.name === TAG_PROPERTY ? expression : null;
  }
  if (property.type === 'PrivateIdentifier') return null;
  return staticString(context, property) === TAG_PROPERTY ? expression : null;
}

/** Non-computed `.x` or computed `["x"]` property name of a member expression. */
function memberPropertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  return asStringLiteral(node.property);
}

/** Source text of an expression, whitespace-collapsed and truncated for the message. */
function describe(context: Context, node: ESTree.Node): string {
  const text = context.sourceCode.getText(node).replace(/\s+/gu, ' ').trim();
  if (text.length === 0) return '…';
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
}

function importsEffectOrBarrel(
  program: ESTree.Program,
  reexportModules: readonly string[],
): boolean {
  if (collectEffectBindings(program).importsEffect) return true;
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (reexportModules.includes(statement.source.value)) return true;
  }
  return false;
}

/**
 * `Effect.mapError(…)` / `E.catch(…)` / `Schedule.recurWhile(…)` / `Match.when(…)` — recognised
 * through the file's real Effect import bindings. A conventional name or a shadow is not evidence.
 * Direct-member imports and unknown re-export barrels are not resolved for this optional exclusion.
 */
function combinatorName(
  context: Context,
  node: ESTree.CallExpression,
  bindings: EffectBindings,
): string | null {
  const callee = unwrap(node.callee);
  if (callee.type !== 'MemberExpression') return null;
  const object = unwrap(callee.object);
  if (object.type !== 'Identifier') return null;
  const member = memberPropertyName(callee);
  if (member === null) return null;
  const variable = resolveVariable(context, object.name, object);
  if (variable === null || !variable.defs.some((definition) => definition.type === 'ImportBinding'))
    return null;
  const namespace = bindings.namespaces.get(object.name);
  if (namespace === undefined) return null;
  if (namespace === 'Effect' && ERROR_COMBINATORS.has(member)) return `${namespace}.${member}`;
  if (namespace === 'Schedule' && SCHEDULE_COMBINATORS.has(member)) return `${namespace}.${member}`;
  if (namespace === 'Match' && MATCH_COMBINATORS.has(member)) return `${namespace}.${member}`;
  return null;
}

const FUNCTION_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'FunctionDeclaration',
]);

/**
 * True when `node` sits inside a function passed *directly* as an argument to one of the error /
 * predicate combinators above. Walks parent links, so `pipe(x, Effect.catch((e) => e._tag === 'A'))`
 * and `x.pipe(Effect.mapError(fn))` are both recognised.
 */
function insideErrorCombinator(
  context: Context,
  node: ESTree.Node,
  bindings: EffectBindings,
): boolean {
  let current: ESTree.Node | null = node;
  for (let depth = 0; current !== null && depth < 512; depth += 1) {
    const candidate: ESTree.Node = current;
    const parent: ESTree.Node | null = candidate.parent ?? null;
    if (FUNCTION_TYPES.has(candidate.type) && parent !== null && parent.type === 'CallExpression') {
      const isArgument = parent.arguments.some(
        (argument) => (argument as ESTree.Node) === candidate,
      );
      if (isArgument && combinatorName(context, parent, bindings) !== null) return true;
    }
    if (parent === candidate) return false;
    current = parent;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Indirect tag bindings — `const { _tag } = error`, `const tag = error._tag`, `({ _tag }) => …`
// ---------------------------------------------------------------------------------------------

/** `true` when a binding pattern property key is the `_tag` discriminant. */
function isTagKey(property: ESTree.Node & { key?: ESTree.Node; computed?: boolean }): boolean {
  const key = property.key;
  if (key === undefined) return false;
  if (property.computed !== true) {
    if (key.type === 'Identifier') return key.name === TAG_PROPERTY;
    return asStringLiteral(key) === TAG_PROPERTY;
  }
  return asStringLiteral(key) === TAG_PROPERTY;
}

/**
 * `true` when `pattern` binds `name` to the `_tag` property of whatever it destructures — directly
 * (`{ _tag }`), renamed (`{ _tag: classification }`), defaulted (`{ _tag = 'none' }`) or nested
 * (`{ reason: { _tag } }`, `[{ _tag }]`).
 */
function patternBindsTag(
  pattern: ESTree.Node | null | undefined,
  name: string,
  depth = 0,
): boolean {
  if (pattern === null || pattern === undefined || depth > MAX_DEPTH) return false;
  switch (pattern.type) {
    case 'ObjectPattern': {
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') continue;
        const value = property.value as ESTree.Node;
        if (isTagKey(property as ESTree.Node & { key?: ESTree.Node; computed?: boolean })) {
          if (bindsName(value, name, depth + 1)) return true;
          continue;
        }
        // A nested pattern may still reach `_tag` one level down: `{ reason: { _tag } }`.
        if (patternBindsTag(value, name, depth + 1)) return true;
      }
      return false;
    }
    case 'ArrayPattern': {
      for (const element of pattern.elements) {
        if (patternBindsTag(element as ESTree.Node | null, name, depth + 1)) return true;
      }
      return false;
    }
    case 'AssignmentPattern':
      return patternBindsTag(pattern.left as ESTree.Node, name, depth + 1);
    case 'RestElement':
      return patternBindsTag(pattern.argument as ESTree.Node, name, depth + 1);
    default:
      return false;
  }
}

/** `true` when a (possibly defaulted) binding target is exactly the identifier `name`. */
function bindsName(target: ESTree.Node | null | undefined, name: string, depth = 0): boolean {
  if (target === null || target === undefined || depth > MAX_DEPTH) return false;
  if (target.type === 'Identifier') return target.name === name;
  if (target.type === 'AssignmentPattern')
    return bindsName(target.left as ESTree.Node, name, depth + 1);
  return false;
}

/** Binding patterns introduced by a scope definition node (declarator, function params, catch clause). */
function definitionPatterns(node: ESTree.Node): readonly (ESTree.Node | null)[] {
  if (node.type === 'VariableDeclarator') return [node.id as ESTree.Node];
  if (node.type === 'CatchClause') return [(node.param ?? null) as ESTree.Node | null];
  const params = (node as { params?: readonly unknown[] }).params;
  if (Array.isArray(params)) return params as readonly ESTree.Node[];
  return [];
}

/**
 * The object a tag alias was read from, when `name` is a local binding that holds a `_tag`:
 * `const tag = error._tag` → `error`; `const { _tag: classification } = error` → `error`;
 * `({ _tag }) => …` → `null` (a parameter has no initialiser, but is still a tag alias).
 *
 * Returns `undefined` when the binding is not a tag alias at all.
 */
function tagAliasOrigin(context: Context, node: ESTree.Node): ESTree.Node | null | undefined {
  const expression = unwrap(node);
  if (expression.type !== 'Identifier') return undefined;
  const variable = resolveVariable(context, expression.name, expression);
  if (variable === null) return undefined;
  if (variable.references.some((reference) => reference.isWrite() && !reference.init))
    return undefined;
  for (const def of variable.defs) {
    const declaration = def.node as ESTree.Node | undefined;
    if (declaration === undefined) continue;
    if (declaration.type === 'VariableDeclarator') {
      const id = declaration.id as ESTree.Node;
      const init = (declaration.init ?? null) as ESTree.Node | null;
      // `const tag = error._tag`
      if (id.type === 'Identifier' && id.name === expression.name && init !== null) {
        const member = asTagMember(context, init);
        if (member !== null) return member.object as ESTree.Node;
        continue;
      }
      // `const { _tag } = error`, `const { _tag: classification } = error`, `for (const { _tag } of …)`
      if (patternBindsTag(id, expression.name)) return init;
      continue;
    }
    for (const pattern of definitionPatterns(declaration)) {
      if (patternBindsTag(pattern, expression.name)) return null;
    }
  }
  return undefined;
}

/** A resolved tag read: the node whose source text names it, for the diagnostic message. */
interface TagReference {
  readonly origin: ESTree.Node | null;
  readonly fallback: string;
}

/**
 * Resolve every spelling of "this expression is the `_tag` discriminant": a direct member access, a
 * local binding that holds one, `String(tag)` laundering and tag-derived string surgery.
 */
function tagReference(
  context: Context,
  node: ESTree.Node,
  options: RuleOptions,
  depth = 0,
): TagReference | null {
  if (depth > MAX_DEPTH) return null;
  const expression = unwrap(node);

  const member = asTagMember(context, expression);
  if (member !== null)
    return { origin: member.object as ESTree.Node, fallback: describe(context, expression) };

  if (expression.type === 'Identifier') {
    if (!options.includeIndirectTags) return null;
    const origin = tagAliasOrigin(context, expression);
    if (origin === undefined) return null;
    return { origin, fallback: expression.name };
  }

  if (expression.type === 'CallExpression') {
    const callee = unwrap(expression.callee);
    // `String(error._tag)` — laundering the tag through a wrapper leaves it a tag.
    if (callee.type === 'Identifier' && callee.name === 'String') {
      const variable = resolveVariable(context, callee.name, callee);
      if (variable !== null && variable.defs.length > 0) return null;
      const argument = expression.arguments[0] as ESTree.Node | undefined;
      if (argument !== undefined && argument.type !== 'SpreadElement') {
        return tagReference(context, argument, options, depth + 1);
      }
      return null;
    }
    // `error._tag.slice(0, 8)` — string surgery on the tag is still the tag.
    if (callee.type === 'MemberExpression') {
      const method = memberPropertyName(callee);
      if (method !== null && STRING_TRANSFORMS.has(method)) {
        return tagReference(context, callee.object as ESTree.Node, options, depth + 1);
      }
    }
    return null;
  }

  return null;
}

/** The text used to name the compared value in the diagnostic. */
function referenceText(context: Context, reference: TagReference): string {
  return reference.origin === null ? reference.fallback : describe(context, reference.origin);
}

/** `Object.hasOwn` / `Reflect.has` / `Object.is` — a global namespace call, not a shadowed local. */
function globalNamespaceCall(
  context: Context,
  node: ESTree.CallExpression,
  namespace: string,
  method: string,
): boolean {
  const callee = unwrap(node.callee);
  if (callee.type !== 'MemberExpression') return false;
  const object = unwrap(callee.object as ESTree.Node);
  if (object.type !== 'Identifier' || object.name !== namespace) return false;
  if (memberPropertyName(callee) !== method) return false;
  const variable = resolveVariable(context, namespace, object);
  return variable === null || variable.defs.length === 0;
}

/** `/^Contacts/u`, `new RegExp('^Contacts')`, or a const bound to either. */
function isRegexReceiver(context: Context, node: ESTree.Node, depth = 0): boolean {
  if (depth > 2) return false;
  const expression = unwrap(node);
  if (expression.type === 'Literal' && (expression as { regex?: unknown }).regex !== undefined)
    return true;
  if (expression.type === 'NewExpression') {
    const callee = unwrap(expression.callee as ESTree.Node);
    if (callee.type !== 'Identifier' || callee.name !== 'RegExp') return false;
    const variable = resolveVariable(context, callee.name, callee);
    return variable === null || variable.defs.length === 0;
  }
  const initialiser = constInitialiser(context, expression);
  return initialiser === null ? false : isRegexReceiver(context, initialiser, depth + 1);
}

const REPLACEMENTS =
  "`Match.value(x).pipe(Match.tag('Tag', onTag), Match.exhaustive)`, `Schema.is(TaggedError)(x)`, or " +
  '`Effect.catchTag`/`Effect.catchTags` on the error channel';

/** Audit A4/C2/B5: never discriminate a tagged value by hand-written `_tag` equality. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A4 (and C2, B5): disallow hand-written `_tag` equality, prefix/suffix probes, membership ' +
        "lists and `'_tag' in x` shape tests — including when the tag is first destructured, aliased or " +
        'laundered through `String()`. The audit counts roughly 113 manual `_tag` comparisons — if-ladders ' +
        "in the Contacts and Shell routes, `result._tag === 'found'` outcome unions, ARES retry predicates " +
        'and comparisons inside `Effect.catch`/`mapError` — each a non-exhaustive second authority over a ' +
        'Schema-owned vocabulary. Use `Match.tag`/`Match.tags` with `Match.exhaustive`, ' +
        '`Schema.is(TaggedError)`, or `Effect.catchTag(s)`.',
    },
    messages: {
      tagEquality:
        "Manual `_tag` comparison on `{{text}}` (`{{operator}} '{{tag}}'`) re-implements pattern matching by " +
        'hand and silently stops matching when the tag vocabulary moves (audit A4 / C2). Use ' +
        `${REPLACEMENTS}.`,
      tagEqualityDynamic:
        'Manual `_tag` comparison on `{{text}}` (`{{operator}} {{other}}`) re-implements pattern matching by ' +
        'hand: a tag compared against a variable is as non-exhaustive as one compared against a literal ' +
        `(audit A4 / C2). Use ${REPLACEMENTS}.`,
      tagEqualityCall:
        '`{{callee}}` compares the `_tag` of `{{text}}` by hand — an equality test without an equality ' +
        'operator is still a hand-written case analysis over a Schema-owned vocabulary (audit A4 / C2). Use ' +
        `${REPLACEMENTS}.`,
      tagStringProbe:
        "`{{text}}`'s `_tag` is probed as a string (`{{method}}`), turning a closed tag vocabulary " +
        'into a naming convention that no compiler checks (audit A4 / C2). Declare the membership once — a ' +
        `\`Schema.Union\` of \`Schema.TaggedError\`s with \`Schema.is\`, or ${REPLACEMENTS}.`,
      tagPresenceCheck:
        "`'_tag' in {{text}}` hand-rolls a shape test for the discriminant (audit A4 / C2). Narrow with " +
        `\`Schema.is(TaggedError)(x)\` or \`Predicate.isTagged\`, then branch with ${REPLACEMENTS}.`,
      tagMembershipProbe:
        'Membership test against the `_tag` of `{{text}}` ({{probe}}) keeps a second, unchecked copy of the ' +
        "union's membership list, which drifts the moment a tag is added or renamed (audit A4 / C2 / B5). " +
        `Own the vocabulary once with a \`Schema.Union\` of \`Schema.TaggedError\`s and ${REPLACEMENTS}.`,
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          ignoreTests: { type: 'boolean' },
          includeErrorCombinators: { type: 'boolean' },
          includeIndirectTags: { type: 'boolean' },
          includeMembershipProbes: { type: 'boolean' },
          adtTags: { type: 'array', items: { type: 'string' } },
          allowTags: { type: 'array', items: { type: 'string' } },
          requireEffectImport: { type: 'boolean' },
          reexportModules: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: DEFAULT_INCLUDE,
        ignore: [...DEFAULT_IGNORE],
        ignoreTests: false,
        includeErrorCombinators: true,
        includeIndirectTags: true,
        includeMembershipProbes: true,
        adtTags: DEFAULT_ADT_TAGS,
        allowTags: [],
        requireEffectImport: false,
        reexportModules: DEFAULT_REEXPORT_MODULES,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore)) return {};
    if (!matchesGlobs(path, options.include)) return {};
    if (options.ignoreTests && isTestFile(path)) return {};
    const bindings = collectEffectBindings(context.sourceCode.ast);
    if (
      options.requireEffectImport &&
      !importsEffectOrBarrel(context.sourceCode.ast, options.reexportModules)
    ) {
      return {};
    }

    const exempt = new Set([...options.adtTags, ...options.allowTags]);
    const suppressed = (node: ESTree.Node): boolean =>
      !options.includeErrorCombinators && insideErrorCombinator(context, node, bindings);
    const tagOf = (node: ESTree.Node): TagReference | null => tagReference(context, node, options);

    /** `[…]`/`new Set([…])` of nothing but Effect's own ADT tags — the sibling rule's territory. */
    const containerIsAdtOnly = (node: ESTree.Node): boolean => {
      const expression = unwrap(node);
      const elements =
        expression.type === 'ArrayExpression'
          ? expression.elements
          : expression.type === 'NewExpression' && expression.arguments.length === 1
            ? (() => {
                const first = unwrap(expression.arguments[0] as ESTree.Node);
                return first.type === 'ArrayExpression' ? first.elements : null;
              })()
            : null;
      if (elements === null || elements.length === 0) return false;
      let sawTag = false;
      for (const element of elements) {
        if (element === null || (element as ESTree.Node).type === 'SpreadElement') return false;
        const literal = asStringLiteral(element as ESTree.Node);
        if (literal === null || !exempt.has(literal)) return false;
        sawTag = true;
      }
      return sawTag;
    };

    return {
      BinaryExpression(node) {
        if ((node.left as ESTree.Node).type === 'PrivateIdentifier') return;

        if (node.operator === 'in') {
          // `'_tag' in value` — a hand-rolled shape test for the discriminant.
          if (staticString(context, node.left) === TAG_PROPERTY) {
            if (suppressed(node)) return;
            context.report({
              node,
              messageId: 'tagPresenceCheck',
              data: { text: describe(context, node.right) },
            });
            return;
          }
          // `error._tag in HANDLERS` — membership against a hand-maintained dispatch map.
          if (!options.includeMembershipProbes) return;
          const reference = tagOf(node.left);
          if (reference === null) return;
          if (suppressed(node)) return;
          context.report({
            node,
            messageId: 'tagMembershipProbe',
            data: {
              text: referenceText(context, reference),
              probe: `\`in ${describe(context, node.right)}\``,
            },
          });
          return;
        }

        if (!EQUALITY_OPERATORS.has(node.operator)) return;

        let reference = tagOf(node.left);
        let other: ESTree.Node = node.right;
        if (reference === null) {
          reference = tagOf(node.right);
          other = node.left;
        }
        if (reference === null) return;
        // `a._tag === b._tag` is an identity test, not a case analysis over a closed vocabulary.
        if (tagOf(other) !== null) return;

        const tag = asStringLiteral(other);
        // Effect's own ADT tags belong to `no-raw-effect-adt-tag-check`; `allowTags` is the escape hatch.
        if (tag !== null && exempt.has(tag)) return;
        if (suppressed(node)) return;

        const text = referenceText(context, reference);
        if (tag === null) {
          context.report({
            node,
            messageId: 'tagEqualityDynamic',
            data: { text, operator: node.operator, other: describe(context, other) },
          });
          return;
        }
        context.report({
          node,
          messageId: 'tagEquality',
          data: { text, operator: node.operator, tag },
        });
      },

      CallExpression(node) {
        // `Object.hasOwn(error, '_tag')` / `Reflect.has(error, '_tag')` — `'_tag' in error` by another name.
        const shapeProbe =
          globalNamespaceCall(context, node, 'Object', 'hasOwn') ||
          globalNamespaceCall(context, node, 'Reflect', 'has');
        if (shapeProbe && node.arguments.length >= 2) {
          const target = node.arguments[0] as ESTree.Node;
          const key = node.arguments[1] as ESTree.Node;
          if (target.type !== 'SpreadElement' && staticString(context, key) === TAG_PROPERTY) {
            if (suppressed(node)) return;
            context.report({
              node,
              messageId: 'tagPresenceCheck',
              data: { text: describe(context, target) },
            });
          }
          return;
        }

        // `Object.is(error._tag, 'X')` — equality without an equality operator.
        if (globalNamespaceCall(context, node, 'Object', 'is') && node.arguments.length === 2) {
          const first = node.arguments[0] as ESTree.Node;
          const second = node.arguments[1] as ESTree.Node;
          if (first.type === 'SpreadElement' || second.type === 'SpreadElement') return;
          let reference = tagOf(first);
          let other: ESTree.Node = second;
          if (reference === null) {
            reference = tagOf(second);
            other = first;
          }
          if (reference === null) return;
          if (tagOf(other) !== null) return;
          const literal = asStringLiteral(other);
          if (literal !== null && exempt.has(literal)) return;
          if (suppressed(node)) return;
          context.report({
            node,
            messageId: 'tagEqualityCall',
            data: {
              callee: describe(context, node.callee as ESTree.Node),
              text: referenceText(context, reference),
            },
          });
          return;
        }

        const callee = unwrap(node.callee);
        if (callee.type !== 'MemberExpression') return;
        const method = memberPropertyName(callee);
        if (method === null) return;
        const receiver = callee.object as ESTree.Node;

        // `error._tag.startsWith('Contacts')`, `String(error._tag).endsWith('Problem')`.
        if (STRING_PROBES.has(method)) {
          const reference = tagOf(receiver);
          if (reference !== null) {
            if (suppressed(node)) return;
            context.report({
              node,
              messageId: 'tagStringProbe',
              data: { text: referenceText(context, reference), method: `.${method}(…)` },
            });
            return;
          }
        }

        // `/^Contacts/u.test(error._tag)` — the mirrored spelling of the same naming-convention probe.
        if (REGEX_PROBES.has(method) && isRegexReceiver(context, receiver)) {
          const argument = node.arguments[0] as ESTree.Node | undefined;
          if (argument !== undefined && argument.type !== 'SpreadElement') {
            const reference = tagOf(argument);
            if (reference !== null) {
              if (suppressed(node)) return;
              context.report({
                node,
                messageId: 'tagStringProbe',
                data: {
                  text: referenceText(context, reference),
                  method: `${describe(context, receiver)}.${method}(…)`,
                },
              });
              return;
            }
          }
        }

        // `KNOWN_TAGS.includes(error._tag)`, `TAG_SET.has(error._tag)`.
        if (options.includeMembershipProbes && MEMBERSHIP_METHODS.has(method)) {
          const argument = node.arguments[0] as ESTree.Node | undefined;
          if (argument === undefined || argument.type === 'SpreadElement') return;
          const reference = tagOf(argument);
          if (reference === null) return;
          // A receiver that is itself the tag is the string probe above, already handled.
          if (tagOf(receiver) !== null) return;
          if (containerIsAdtOnly(receiver)) return;
          const initialiser = constInitialiser(context, receiver);
          if (initialiser !== null && containerIsAdtOnly(initialiser)) return;
          if (suppressed(node)) return;
          context.report({
            node,
            messageId: 'tagMembershipProbe',
            data: {
              text: referenceText(context, reference),
              probe: `\`${describe(context, receiver)}.${method}(…)\``,
            },
          });
        }
      },
    };
  },
});
