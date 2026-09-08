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
 * - **Type-level `_tag`** — `Extract<P, { readonly _tag: 'X' }>`, `P['_tag']`,
 *   `Failure extends { readonly _tag: infer Tag }`. Type positions contain no `BinaryExpression` or
 *   `CallExpression`, so they are structurally unreachable from these visitors.
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

import { unwrapNode, templateText, asNamedMember } from '../shared/ast.ts';
import { collectEffectBindings } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { optionRecord, stringArray } from '../shared/options.ts';
import { isTestFile, scopePath, matchesGlobs } from '../shared/paths.ts';

const DEFAULT_INCLUDE = [
  'apps/**',
  'verticals/**',
  'packages/**',
  'scripts/**',
];

const DEFAULT_IGNORE: readonly string[] = [];

/** Tag literals owned by Effect's built-in ADTs — `no-raw-effect-adt-tag-check` reports those. */
const DEFAULT_ADT_TAGS = [
  'Some',
  'None',
  'Success',
  'Failure',
  'Left',
  'Right',
];

/** Barrels that re-export Effect namespaces verbatim (the Modern.js BFF edge barrel). */
const DEFAULT_REEXPORT_MODULES = ['@modern-js/plugin-bff/effect-edge'];

const EQUALITY_OPERATORS = new Set(['===', '!==', '==', '!=']);

const TAG_PROPERTY = '_tag';

/** String methods that turn a closed tag vocabulary into a naming convention. */
const STRING_PROBES = new Set([
  'startsWith',
  'endsWith',
  'includes',
  'match',
  'test',
]);

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
const MEMBERSHIP_METHODS = new Set([
  'includes',
  'has',
  'indexOf',
  'lastIndexOf',
]);

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
const SCHEDULE_COMBINATORS = new Set([
  'recurWhile',
  'recurUntil',
  'whileInput',
  'untilInput',
]);

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

function readOptions(context: Context): RuleOptions {
  const record = optionRecord(context.options?.[0]);
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
    reexportModules: stringArray(
      record.reexportModules,
      DEFAULT_REEXPORT_MODULES
    ),
  };
}

/** Preserve this rule's bounded transparent-wrapper traversal. */
function unwrap(node: ESTree.Node): ESTree.Node {
  return unwrapNode(node, { maxDepth: MAX_DEPTH });
}

/** A statically known string operand (`'X'`, `"X"`, `` `X` ``), or null. */
function asStringLiteral(node: ESTree.Node): string | null {
  const expression = unwrap(node);
  if (expression.type === 'Literal')
    return typeof expression.value === 'string' ? expression.value : null;
  if (
    expression.type === 'TemplateLiteral' &&
    expression.expressions.length === 0
  )
    return templateText(expression);
  return null;
}

function resolveVariable(
  context: Context,
  name: string,
  from: ESTree.Node
): Variable | null {
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

function isNamedIdentifier(node: ESTree.Node, name: string): boolean {
  return node.type === 'Identifier' && node.name === name;
}

/** A single-assignment variable declarator, resolved at the identifier's lexical scope. */
function immutableDeclarator(
  context: Context,
  node: Extract<ESTree.Node, { type: 'Identifier' }>
): ESTree.VariableDeclarator | null {
  const variable = resolveVariable(context, node.name, node);
  if (variable === null || variable.defs.length !== 1) return null;
  if (
    variable.references.some(
      (reference) => reference.isWrite() && !reference.init
    )
  )
    return null;
  const def = variable.defs[0];
  if (def === undefined || def.type !== 'Variable') return null;
  const declarator = def.node as ESTree.Node;
  return declarator.type === 'VariableDeclarator' ? declarator : null;
}

/** Single-assignment `const NAME = <expr>` initialiser for an identifier reference, or null. */
function constInitialiser(
  context: Context,
  node: ESTree.Node
): ESTree.Node | null {
  const expression = unwrap(node);
  if (expression.type !== 'Identifier') return null;
  const declarator = immutableDeclarator(context, expression);
  if (declarator === null || !isNamedIdentifier(declarator.id, expression.name))
    return null;
  return declarator.init ?? null;
}

function assertionPropertyName(
  context: Context,
  property: { readonly key: ESTree.Node; readonly computed: boolean }
): string | null {
  return !property.computed && property.key.type === 'Identifier'
    ? property.key.name
    : staticString(context, property.key);
}

/** Trace a simple immutable destructured method without losing the source binding's scope. */
function destructuredMethod(
  context: Context,
  node: ESTree.Node
): { source: ESTree.Node; method: string } | null {
  if (node.type !== 'Identifier') return null;
  const declarator = immutableDeclarator(context, node);
  if (
    declarator === null ||
    declarator.id.type !== 'ObjectPattern' ||
    declarator.init === null ||
    declarator.parent.type !== 'VariableDeclaration' ||
    declarator.parent.kind !== 'const'
  )
    return null;
  const property = declarator.id.properties.find(
    (entry) =>
      entry.type === 'Property' && isNamedIdentifier(entry.value, node.name)
  );
  if (property?.type !== 'Property') return null;
  const method = assertionPropertyName(context, property);
  return method === null ? null : { source: declarator.init, method };
}

interface AssertionCall {
  readonly method: string;
  readonly subject: ESTree.CallExpression | null;
  readonly expectedWrapper?: boolean;
}

/** Node assertions allow strict/default namespace prefixes but never an expect subject. */
function nodeAssertion(
  members: string[],
  subject: ESTree.CallExpression | null
): AssertionCall | null {
  if (subject !== null) return null;
  while (members[0] === 'strict' || members[0] === 'default') members.shift();
  const method = members[0];
  return members.length === 1 && method !== undefined
    ? { method, subject: null }
    : null;
}

/** Static expect helpers are expected values, never subject-bearing assertions. */
function staticAssertion(members: string[]): AssertionCall | null {
  const index = members[0] === 'expect' && members[1] === 'not' ? 2 : 1;
  const method = members[index];
  if (members.length !== index + 1 || method === undefined) return null;
  if (members[0] === 'assert') return { method, subject: null };
  return members[0] === 'expect' && EXPECTED_WRAPPERS.has(method)
    ? { method, subject: null, expectedWrapper: true }
    : null;
}

/** Match the supported assertion APIs only after proving the import's lexical identity. */
function importedAssertion(
  source: string,
  members: string[],
  subject: ESTree.CallExpression | null
): AssertionCall | null {
  if (/^(?:node:)?assert(?:\/strict)?$/u.test(source))
    return nodeAssertion(members, subject);
  if (
    ![
      '@rstest/core',
      'effect-rstest',
      'vitest',
      '@jest/globals',
      'expect',
    ].includes(source)
  )
    return null;
  if (subject === null) return staticAssertion(members);
  if (members.shift() !== 'expect') return null;
  const method = members.pop();
  if (
    method === undefined ||
    !members.every((member) => ['not', 'resolves', 'rejects'].includes(member))
  )
    return null;
  return { method, subject };
}

function assertionImport(
  context: Context,
  expression: ESTree.Node,
  members: string[],
  subject: ESTree.CallExpression | null
): AssertionCall | null {
  if (expression.type !== 'Identifier') return null;
  const variable = resolveVariable(context, expression.name, expression);
  const definition = variable?.defs.find(
    (entry) => entry.type === 'ImportBinding'
  );
  const specifier = definition?.node as ESTree.Node | undefined;
  if (specifier === undefined) return null;
  const declaration = context.sourceCode.ast.body.find(
    (statement) =>
      statement.type === 'ImportDeclaration' &&
      statement.specifiers.some((entry) => entry === specifier)
  );
  if (declaration?.type !== 'ImportDeclaration') return null;
  const path = [...members];
  if (specifier.type === 'ImportSpecifier')
    members.unshift(
      specifier.imported.type === 'Identifier'
        ? specifier.imported.name
        : specifier.imported.value
    );
  const source = declaration.source.value;
  if (specifier.type === 'ImportDefaultSpecifier' && source === 'expect')
    members.unshift('expect');
  return stableAssertion(
    context,
    expression,
    path,
    importedAssertion(source, members, subject)
  );
}

function assertionAlias(
  context: Context,
  expression: ESTree.Node,
  members: string[]
): ESTree.Node | null {
  const destructured = destructuredMethod(context, expression);
  if (destructured === null) return constInitialiser(context, expression);
  members.unshift(destructured.method);
  return destructured.source;
}

/** Writes through a receiver alias invalidate only the corresponding helper path. */
function assertionPathWrite(node: ESTree.Node): boolean {
  const parent = node.parent;
  switch (parent?.type) {
    case 'AssignmentExpression':
      return parent.left === node;
    case 'UpdateExpression':
      return parent.argument === node;
    case 'UnaryExpression':
      return parent.operator === 'delete' && parent.argument === node;
    default:
      return false;
  }
}

function assertionAliasTarget(
  context: Context,
  pattern: ESTree.Node,
  members: readonly string[]
): { node: ESTree.Node; members: readonly string[] } | null {
  if (pattern.type === 'Identifier')
    return immutableDeclarator(context, pattern) === null
      ? null
      : { node: pattern, members };
  if (pattern.type !== 'ObjectPattern') return null;
  const property = pattern.properties.find(
    (entry) =>
      entry.type === 'Property' &&
      assertionPropertyName(context, entry) === members[0]
  );
  return property?.type === 'Property'
    ? assertionAliasTarget(context, property.value, members.slice(1))
    : null;
}

function assertionMemberTail(
  node: ESTree.Node,
  members: readonly string[]
): readonly string[] | null {
  const parent = node.parent;
  if (
    members.length === 0 ||
    parent?.type !== 'MemberExpression' ||
    parent.object !== node
  )
    return null;
  const member = memberPropertyName(parent);
  return member === null || member === members[0] ? members.slice(1) : null;
}

function assertionReferenceWrite(
  context: Context,
  node: ESTree.Node,
  members: readonly string[],
  seen: Map<Variable, Set<string>>
): boolean {
  let current = node;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (assertionPathWrite(current)) return true;
    const parent = current.parent;
    if (parent === null) return false;
    if (unwrap(parent) === current) {
      current = parent;
      continue;
    }
    if (parent.type === 'VariableDeclarator' && parent.init === current) {
      const alias = assertionAliasTarget(context, parent.id, members);
      return (
        alias !== null &&
        assertionBindingWrite(context, alias.node, alias.members, seen)
      );
    }
    const tail = assertionMemberTail(current, members);
    if (tail === null) return false;
    members = tail;
    current = parent;
  }
  return true;
}

/** Follow local receiver aliases too, so `alias.objectContaining = fake` is not trusted. */
function assertionBindingWrite(
  context: Context,
  node: ESTree.Node,
  members: readonly string[],
  seen = new Map<Variable, Set<string>>()
): boolean {
  if (node.type !== 'Identifier') return false;
  const variable = resolveVariable(context, node.name, node);
  if (variable === null) return false;
  const path = members.join('.');
  const paths = seen.get(variable) ?? new Set<string>();
  if (paths.has(path)) return false;
  if (seen.size >= MAX_DEPTH) return true;
  seen.set(variable, paths.add(path));
  return variable.references.some(
    (reference) =>
      (reference.isWrite() && !reference.init) ||
      assertionReferenceWrite(context, reference.identifier, members, seen)
  );
}

/** Apply mutation checks only to the newly recognized expected-value helpers. */
function stableAssertion(
  context: Context,
  expression: ESTree.Node,
  members: readonly string[],
  assertion: AssertionCall | null
): AssertionCall | null {
  return assertion?.expectedWrapper === true &&
    assertionBindingWrite(context, expression, members)
    ? null
    : assertion;
}

/** Resolve assertion imports through lexical bindings, aliases, and matcher modifiers. */
function assertionCall(
  context: Context,
  call: ESTree.CallExpression
): AssertionCall | null {
  let expression = unwrap(call.callee);
  const members: string[] = [];
  const seen = new Set<ESTree.Node>();
  let subject: ESTree.CallExpression | null = null;
  for (let depth = 0; depth < MAX_DEPTH && !seen.has(expression); depth += 1) {
    seen.add(expression);
    const alias = assertionAlias(context, expression, members);
    if (alias !== null) {
      expression = unwrap(alias);
      continue;
    }
    if (expression.type === 'MemberExpression') {
      const member = memberPropertyName(expression);
      if (member === null) return null;
      members.unshift(member);
      expression = unwrap(expression.object as ESTree.Node);
      continue;
    }
    if (expression.type !== 'CallExpression')
      return assertionImport(context, expression, members, subject);
    if (subject !== null) return null;
    subject = expression;
    expression = unwrap(expression.callee);
  }
  return null;
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

/** Array paths permit static strings and numeric indexes, but never holes or spreads. */
function validTagPathSegment(
  context: Context,
  element: ESTree.Node | null
): boolean {
  if (element === null || element.type === 'SpreadElement') return false;
  if (staticString(context, element) !== null) return true;
  const value = unwrap(element);
  return value.type === 'Literal' && typeof value.value === 'number';
}

/** Resolve only the asserted property: dotted strings and literal array-path segments. */
function tagPropertyPath(context: Context, node: ESTree.Node): boolean {
  const path = staticString(context, node);
  if (path !== null) {
    const segments = path.split('.');
    return segments.length <= MAX_DEPTH && segments.at(-1) === TAG_PROPERTY;
  }
  const expression = unwrap(node);
  if (
    expression.type !== 'ArrayExpression' ||
    expression.elements.length > MAX_DEPTH
  )
    return false;
  if (
    !expression.elements.every((element) =>
      validTagPathSegment(context, element)
    )
  )
    return false;
  const last = expression.elements.at(-1);
  return (
    last !== undefined &&
    last !== null &&
    staticString(context, last) === TAG_PROPERTY
  );
}

/** The `_tag` member access itself (`x._tag`, `x?._tag`, `x!._tag`, `x["_tag"]`, `x[KEY]`), or null. */
function asTagMember(
  context: Context,
  node: ESTree.Node
): ESTree.MemberExpression | null {
  return asNamedMember(
    node,
    TAG_PROPERTY,
    (key) => staticString(context, key),
    {
      maxDepth: MAX_DEPTH,
    }
  );
}

/** Non-computed `.x` or computed `["x"]` property name of a member expression. */
function memberPropertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed)
    return node.property.type === 'Identifier' ? node.property.name : null;
  return asStringLiteral(node.property);
}

/** Source text of an expression, whitespace-collapsed and truncated for the message. */
function describe(context: Context, node: ESTree.Node): string {
  const text = context.sourceCode.getText(node).replace(/\s+/gu, ' ').trim();
  if (text.length === 0) return '…';
  return text.length > MAX_TEXT_LENGTH
    ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…`
    : text;
}

function importsEffectOrBarrel(
  program: ESTree.Program,
  reexportModules: readonly string[]
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
  bindings: EffectBindings
): string | null {
  const callee = unwrap(node.callee);
  if (callee.type !== 'MemberExpression') return null;
  const object = unwrap(callee.object);
  if (object.type !== 'Identifier') return null;
  const member = memberPropertyName(callee);
  if (member === null) return null;
  const variable = resolveVariable(context, object.name, object);
  if (
    variable === null ||
    !variable.defs.some((definition) => definition.type === 'ImportBinding')
  )
    return null;
  const namespace = bindings.namespaces.get(object.name);
  if (namespace === undefined) return null;
  const members = new Map([
    ['Effect', ERROR_COMBINATORS],
    ['Schedule', SCHEDULE_COMBINATORS],
    ['Match', MATCH_COMBINATORS],
  ]).get(namespace);
  return members?.has(member) ? `${namespace}.${member}` : null;
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
  bindings: EffectBindings
): boolean {
  let current: ESTree.Node | null = node;
  for (let depth = 0; current !== null && depth < 512; depth += 1) {
    const candidate: ESTree.Node = current;
    const parent: ESTree.Node | null = candidate.parent ?? null;
    if (
      FUNCTION_TYPES.has(candidate.type) &&
      parent !== null &&
      parent.type === 'CallExpression'
    ) {
      const isArgument = parent.arguments.some(
        (argument) => (argument as ESTree.Node) === candidate
      );
      if (isArgument && combinatorName(context, parent, bindings) !== null)
        return true;
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
function isTagKey(
  property: ESTree.Node & { key?: ESTree.Node; computed?: boolean }
): boolean {
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
  depth = 0
): boolean {
  if (pattern === null || pattern === undefined || depth > MAX_DEPTH)
    return false;
  switch (pattern.type) {
    case 'ObjectPattern':
      return pattern.properties.some((property) =>
        propertyBindsTag(property, name, depth)
      );
    case 'ArrayPattern':
      return pattern.elements.some((element) =>
        patternBindsTag(element, name, depth + 1)
      );
    case 'AssignmentPattern':
      return patternBindsTag(pattern.left as ESTree.Node, name, depth + 1);
    case 'RestElement':
      return patternBindsTag(pattern.argument as ESTree.Node, name, depth + 1);
    default:
      return false;
  }
}

function propertyBindsTag(
  property: ESTree.Node,
  name: string,
  depth: number
): boolean {
  if (property.type === 'RestElement') return false;
  const entry = property as ESTree.Node & {
    key?: ESTree.Node;
    computed?: boolean;
    value: ESTree.Node;
  };
  return isTagKey(entry)
    ? bindsName(entry.value, name, depth + 1)
    : patternBindsTag(entry.value, name, depth + 1);
}

/** `true` when a (possibly defaulted) binding target is exactly the identifier `name`. */
function bindsName(
  target: ESTree.Node | null | undefined,
  name: string,
  depth = 0
): boolean {
  if (target === null || target === undefined || depth > MAX_DEPTH)
    return false;
  if (target.type === 'Identifier') return target.name === name;
  if (target.type === 'AssignmentPattern')
    return bindsName(target.left as ESTree.Node, name, depth + 1);
  return false;
}

/** Binding patterns introduced by a scope definition node (declarator, function params, catch clause). */
function definitionPatterns(
  node: ESTree.Node
): readonly (ESTree.Node | null)[] {
  if (node.type === 'VariableDeclarator') return [node.id as ESTree.Node];
  if (node.type === 'CatchClause')
    return [(node.param ?? null) as ESTree.Node | null];
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
function tagAliasOrigin(
  context: Context,
  node: ESTree.Node
): ESTree.Node | null | undefined {
  const expression = unwrap(node);
  if (expression.type !== 'Identifier') return undefined;
  const variable = resolveVariable(context, expression.name, expression);
  if (variable === null) return undefined;
  if (
    variable.references.some(
      (reference) => reference.isWrite() && !reference.init
    )
  )
    return undefined;
  for (const def of variable.defs) {
    const declaration = def.node as ESTree.Node | undefined;
    if (declaration === undefined) continue;
    const origin = declarationTagOrigin(context, declaration, expression.name);
    if (origin !== undefined) return origin;
  }
  return undefined;
}

function declarationTagOrigin(
  context: Context,
  declaration: ESTree.Node,
  name: string
): ESTree.Node | null | undefined {
  if (declaration.type !== 'VariableDeclarator') {
    return definitionPatterns(declaration).some((pattern) =>
      patternBindsTag(pattern, name)
    )
      ? null
      : undefined;
  }
  const init = declaration.init ?? null;
  if (isNamedIdentifier(declaration.id, name) && init !== null) {
    return asTagMember(context, init)?.object ?? undefined;
  }
  return patternBindsTag(declaration.id, name) ? init : undefined;
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
  depth = 0
): TagReference | null {
  if (depth > MAX_DEPTH) return null;
  const expression = unwrap(node);

  const member = asTagMember(context, expression);
  if (member !== null)
    return {
      origin: member.object as ESTree.Node,
      fallback: describe(context, expression),
    };

  if (expression.type === 'Identifier') {
    if (!options.includeIndirectTags) return null;
    const origin = tagAliasOrigin(context, expression);
    if (origin === undefined) return null;
    return { origin, fallback: expression.name };
  }

  return expression.type === 'CallExpression'
    ? callTagReference(context, expression, options, depth)
    : null;
}

function callTagReference(
  context: Context,
  expression: ESTree.CallExpression,
  options: RuleOptions,
  depth: number
): TagReference | null {
  const callee = unwrap(expression.callee);
  if (isNamedIdentifier(callee, 'String')) {
    const variable = resolveVariable(context, 'String', callee);
    if (variable !== null && variable.defs.length > 0) return null;
    const argument = firstArgument(expression);
    return argument === null
      ? null
      : tagReference(context, argument, options, depth + 1);
  }
  if (callee.type !== 'MemberExpression') return null;
  const method = memberPropertyName(callee);
  return method !== null && STRING_TRANSFORMS.has(method)
    ? tagReference(context, callee.object, options, depth + 1)
    : null;
}

function firstArgument(node: ESTree.CallExpression): ESTree.Node | null {
  const argument = node.arguments[0];
  return argument === undefined || argument.type === 'SpreadElement'
    ? null
    : argument;
}

/** The text used to name the compared value in the diagnostic. */
function referenceText(context: Context, reference: TagReference): string {
  return reference.origin === null
    ? reference.fallback
    : describe(context, reference.origin);
}

/** `Object.hasOwn` / `Reflect.has` / `Object.is` — a global namespace call, not a shadowed local. */
function globalNamespaceCall(
  context: Context,
  node: ESTree.CallExpression,
  namespace: string,
  method: string
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
function isRegexReceiver(
  context: Context,
  node: ESTree.Node,
  depth = 0
): boolean {
  if (depth > 2) return false;
  const expression = unwrap(node);
  if (
    expression.type === 'Literal' &&
    (expression as { regex?: unknown }).regex !== undefined
  )
    return true;
  if (expression.type === 'NewExpression') {
    const callee = unwrap(expression.callee as ESTree.Node);
    if (callee.type !== 'Identifier' || callee.name !== 'RegExp') return false;
    const variable = resolveVariable(context, callee.name, callee);
    return variable === null || variable.defs.length === 0;
  }
  const initialiser = constInitialiser(context, expression);
  return initialiser === null
    ? false
    : isRegexReceiver(context, initialiser, depth + 1);
}

function containerElements(
  expression: ESTree.Node
): ESTree.ArrayExpression['elements'] | null {
  if (expression.type === 'ArrayExpression') return expression.elements;
  if (expression.type !== 'NewExpression' || expression.arguments.length !== 1)
    return null;
  const first = unwrap(expression.arguments[0] as ESTree.Node);
  return first.type === 'ArrayExpression' ? first.elements : null;
}

/** Only map callback results propagate tag values; arbitrary callback reads do not. */
function mappedTagValues(
  context: Context,
  expression: ESTree.CallExpression
): readonly ESTree.Node[] {
  const callee = unwrap(expression.callee);
  if (
    callee.type !== 'MemberExpression' ||
    memberPropertyName(callee) !== 'map'
  )
    return [];
  const first = firstArgument(expression);
  if (first === null) return [];
  const callback = unwrap(constInitialiser(context, first) ?? first);
  if (
    callback.type !== 'ArrowFunctionExpression' &&
    callback.type !== 'FunctionExpression'
  )
    return [];
  return callback.body === null ? [] : [callback.body];
}

/** Follow values reaching a comparison, without descending into unrelated predicates or fields. */
function comparedValues(
  context: Context,
  expression: ESTree.Node
): readonly ESTree.Node[] {
  switch (expression.type) {
    case 'ArrayExpression':
      return expression.elements.filter((element) => element !== null);
    case 'SpreadElement':
      return [expression.argument];
    case 'LogicalExpression':
      return [expression.left, expression.right];
    case 'ConditionalExpression':
      return [expression.consequent, expression.alternate];
    case 'SequenceExpression':
      return expression.expressions.slice(-1);
    case 'CallExpression':
      return mappedTagValues(context, expression);
    default:
      return returnedTagValues(expression);
  }
}

/** Statement bodies expose return values, not conditions or arbitrary expression statements. */
function returnedTagValues(expression: ESTree.Node): readonly ESTree.Node[] {
  switch (expression.type) {
    case 'BlockStatement':
      return expression.body;
    case 'ReturnStatement':
      return expression.argument === null ? [] : [expression.argument];
    case 'IfStatement':
      return expression.alternate === null
        ? [expression.consequent]
        : [expression.consequent, expression.alternate];
    default:
      return [];
  }
}

const ASSERTION_METHODS = new Set([
  'equal',
  'strictEqual',
  'notEqual',
  'notStrictEqual',
  'deepEqual',
  'deepStrictEqual',
  'notDeepEqual',
  'notDeepStrictEqual',
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toContain',
  'toContainEqual',
  'toMatch',
  'toMatchObject',
  'match',
  'doesNotMatch',
]);

const OBJECT_ASSERTION_METHODS = new Set([
  'toMatchObject',
  'toEqual',
  'toStrictEqual',
  'toContainEqual',
  'deepEqual',
  'deepStrictEqual',
  'notDeepEqual',
  'notDeepStrictEqual',
]);

const EXPECTED_WRAPPERS = new Set(['objectContaining', 'arrayContaining']);

type ExpectedShapeVisits = readonly [Set<ESTree.Node>, Set<ESTree.Node>];

/** An object's payload is not another discriminant: inspect only its own `_tag`. */
function expectedObjectTags(
  context: Context,
  shape: ESTree.Node
): readonly ESTree.Node[] {
  if (shape.type !== 'ObjectExpression') return [];
  const tag = shape.properties.find(
    (property) =>
      property.type === 'Property' &&
      assertionPropertyName(context, property) === TAG_PROPERTY
  );
  return tag?.type === 'Property' ? [tag.value] : [];
}

/** Only a proven arrayContaining opens an array's contained expected shapes. */
function expectedContainedTags(
  context: Context,
  shape: ESTree.Node,
  depth: number,
  seen: ExpectedShapeVisits
): readonly ESTree.Node[] {
  if (shape.type !== 'ArrayExpression') return [];
  return shape.elements.flatMap((element) =>
    element === null
      ? []
      : expectedShapeTags(context, element, false, depth + 1, seen)
  );
}

/** Bounded immutable aliases and framework wrappers; never walk arbitrary payload properties. */
function expectedShapeTags(
  context: Context,
  expected: ESTree.Node,
  contained = false,
  depth = 0,
  seen: ExpectedShapeVisits = [new Set(), new Set()]
): readonly ESTree.Node[] {
  const shape = unwrap(expected);
  const visited = seen[contained ? 1 : 0];
  if (depth > MAX_DEPTH || visited.has(shape)) return [];
  visited.add(shape);
  const initialiser = constInitialiser(context, shape);
  if (initialiser !== null)
    return expectedShapeTags(context, initialiser, contained, depth + 1, seen);
  if (contained) return expectedContainedTags(context, shape, depth, seen);
  if (shape.type !== 'CallExpression')
    return expectedObjectTags(context, shape);
  const wrapper = assertionCall(context, shape);
  const argument = firstArgument(shape);
  return wrapper?.expectedWrapper === true && argument !== null
    ? expectedShapeTags(
        context,
        argument,
        wrapper.method === 'arrayContaining',
        depth + 1,
        seen
      )
    : [];
}

/** Resolve callable aliases without applying object-shape depth limits to the original walk. */
function assertionCallee(context: Context, node: ESTree.Node): ESTree.Node {
  let callee = unwrap(node);
  const seen = new Set<ESTree.Node>();
  while (callee.type === 'Identifier' && !seen.has(callee)) {
    seen.add(callee);
    const initialiser = constInitialiser(context, callee);
    if (initialiser === null) break;
    callee = unwrap(initialiser);
  }
  return callee;
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
      tagSwitch:
        'Manual `_tag` switching must use Effect Match.tag/Match.tags or typed error handlers.',
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
      !options.includeErrorCombinators &&
      insideErrorCombinator(context, node, bindings);
    const tagOf = (node: ESTree.Node): TagReference | null =>
      tagReference(context, node, options);

    const comparedTag = (
      node: ESTree.Node,
      seen = new Set<ESTree.Node>()
    ): TagReference | null => {
      if (seen.has(node)) return null;
      seen.add(node);
      const direct = tagOf(node);
      if (direct !== null) return direct;
      const expression = unwrap(node);
      const initialiser = constInitialiser(context, expression);
      if (initialiser !== null) return comparedTag(initialiser, seen);
      const values = comparedValues(context, expression);
      for (const value of values) {
        const found = comparedTag(value, seen);
        if (found !== null) return found;
      }
      return null;
    };

    /** `[…]`/`new Set([…])` of nothing but Effect's own ADT tags — the sibling rule's territory. */
    const containerIsAdtOnly = (node: ESTree.Node): boolean => {
      const expression = unwrap(node);
      const elements = containerElements(expression);
      if (elements === null || elements.length === 0) return false;
      let sawTag = false;
      for (const element of elements) {
        if (
          element === null ||
          (element as ESTree.Node).type === 'SpreadElement'
        )
          return false;
        const literal = asStringLiteral(element as ESTree.Node);
        if (literal === null || !exempt.has(literal)) return false;
        sawTag = true;
      }
      return sawTag;
    };

    function checkIn(node: ESTree.BinaryExpression) {
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
    function equalityOperands(first: ESTree.Node, second: ESTree.Node) {
      const left = tagOf(first);
      const reference = left ?? tagOf(second);
      const other = left === null ? first : second;
      if (reference === null) return null;
      const tag = asStringLiteral(other);
      if (tag !== null && exempt.has(tag)) return null;
      return { reference, other, tag };
    }
    function checkBinary(node: ESTree.BinaryExpression) {
      if ((node.left as ESTree.Node).type === 'PrivateIdentifier') return;

      if (node.operator === 'in') return checkIn(node);

      if (!EQUALITY_OPERATORS.has(node.operator)) return;

      const operands = equalityOperands(node.left, node.right);
      if (operands === null) return;
      const { reference, other, tag } = operands;
      if (suppressed(node)) return;

      const text = referenceText(context, reference);
      if (tag === null) {
        context.report({
          node,
          messageId: 'tagEqualityDynamic',
          data: {
            text,
            operator: node.operator,
            other: describe(context, other),
          },
        });
        return;
      }
      context.report({
        node,
        messageId: 'tagEquality',
        data: { text, operator: node.operator, tag },
      });
    }
    function checkShape(node: ESTree.CallExpression): boolean {
      // `Object.hasOwn(error, '_tag')` / `Reflect.has(error, '_tag')` — `'_tag' in error` by another name.
      const shapeProbe =
        globalNamespaceCall(context, node, 'Object', 'hasOwn') ||
        globalNamespaceCall(context, node, 'Reflect', 'has');
      if (shapeProbe && node.arguments.length >= 2) {
        const target = node.arguments[0] as ESTree.Node;
        const key = node.arguments[1] as ESTree.Node;
        if (
          target.type !== 'SpreadElement' &&
          staticString(context, key) === TAG_PROPERTY
        ) {
          if (suppressed(node)) return true;
          context.report({
            node,
            messageId: 'tagPresenceCheck',
            data: { text: describe(context, target) },
          });
        }
        return true;
      }

      return false;
    }
    function checkEqualityCall(node: ESTree.CallExpression): boolean {
      // `Object.is(error._tag, 'X')` — equality without an equality operator.
      if (
        globalNamespaceCall(context, node, 'Object', 'is') &&
        node.arguments.length === 2
      ) {
        const first = node.arguments[0] as ESTree.Node;
        const second = node.arguments[1] as ESTree.Node;
        if (first.type === 'SpreadElement' || second.type === 'SpreadElement')
          return true;
        const operands = equalityOperands(first, second);
        if (operands === null) return true;
        const { reference } = operands;
        if (suppressed(node)) return true;
        context.report({
          node,
          messageId: 'tagEqualityCall',
          data: {
            callee: describe(context, node.callee as ESTree.Node),
            text: referenceText(context, reference),
          },
        });
        return true;
      }

      return false;
    }
    function checkStringProbe(
      node: ESTree.CallExpression,
      receiver: ESTree.Node,
      method: string
    ): boolean {
      // `error._tag.startsWith('Contacts')`, `String(error._tag).endsWith('Problem')`.
      if (STRING_PROBES.has(method)) {
        const reference = tagOf(receiver);
        if (reference !== null) {
          if (suppressed(node)) return true;
          context.report({
            node,
            messageId: 'tagStringProbe',
            data: {
              text: referenceText(context, reference),
              method: `.${method}(…)`,
            },
          });
          return true;
        }
      }

      return false;
    }
    function checkRegexProbe(
      node: ESTree.CallExpression,
      receiver: ESTree.Node,
      method: string
    ): boolean {
      // `/^Contacts/u.test(error._tag)` — the mirrored spelling of the same naming-convention probe.
      if (REGEX_PROBES.has(method) && isRegexReceiver(context, receiver)) {
        const argument = node.arguments[0] as ESTree.Node | undefined;
        if (argument !== undefined && argument.type !== 'SpreadElement') {
          const reference = tagOf(argument);
          if (reference !== null) {
            if (suppressed(node)) return true;
            context.report({
              node,
              messageId: 'tagStringProbe',
              data: {
                text: referenceText(context, reference),
                method: `${describe(context, receiver)}.${method}(…)`,
              },
            });
            return true;
          }
        }
      }

      return false;
    }
    function checkMembership(
      node: ESTree.CallExpression,
      receiver: ESTree.Node,
      method: string
    ) {
      // `KNOWN_TAGS.includes(error._tag)`, `TAG_SET.has(error._tag)`.
      if (options.includeMembershipProbes && MEMBERSHIP_METHODS.has(method)) {
        const argument = firstArgument(node);
        if (argument === null) return;
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
    }
    function reportAssertion(node: ESTree.CallExpression, text: string) {
      context.report({
        node,
        messageId: 'tagEqualityCall',
        data: { callee: describe(context, node.callee), text },
      });
    }

    function exemptStaticTag(node: ESTree.Node | undefined): boolean {
      if (node === undefined) return false;
      const literal = staticString(context, node);
      return literal !== null && exempt.has(literal);
    }

    function checkPropertyAssertion(
      node: ESTree.CallExpression,
      subject: ESTree.CallExpression
    ) {
      const assertedPath = firstArgument(node);
      const target = firstArgument(subject);
      if (
        assertedPath === null ||
        target === null ||
        !tagPropertyPath(context, assertedPath) ||
        suppressed(node)
      )
        return;
      const expected = node.arguments[1];
      if (expected?.type === 'SpreadElement') return;
      if (exemptStaticTag(expected)) return;
      context.report({
        node,
        messageId:
          expected === undefined ? 'tagPresenceCheck' : 'tagEqualityCall',
        data: {
          callee: describe(context, node.callee),
          text: describe(context, target),
        },
      });
    }

    /** Object matchers inspect only the expected top-level discriminant, never payload fields. */
    function checkObjectAssertion(
      node: ESTree.CallExpression,
      assertion: AssertionCall
    ): boolean {
      if (!OBJECT_ASSERTION_METHODS.has(assertion.method)) return false;
      const expected = node.arguments[assertion.subject === null ? 1 : 0];
      if (expected === undefined || expected.type === 'SpreadElement')
        return false;
      const tags = expectedShapeTags(context, expected);
      if (!tags.some((tag) => !exemptStaticTag(tag))) return false;
      if (suppressed(node)) return false;
      reportAssertion(
        node,
        describe(
          context,
          assertion.subject?.arguments[0] ?? node.arguments[0] ?? node
        )
      );
      return true;
    }

    function exemptAssertionValue(other: ESTree.Node | undefined): boolean {
      if (other === undefined || other.type === 'SpreadElement') return false;
      const literal = asStringLiteral(other);
      return (
        (literal !== null && exempt.has(literal)) || containerIsAdtOnly(other)
      );
    }

    function checkAssertionValues(
      node: ESTree.CallExpression,
      assertion: AssertionCall
    ): boolean {
      const compared =
        assertion.subject === null
          ? node.arguments.slice(0, 2)
          : [
              ...assertion.subject.arguments.slice(0, 1),
              ...node.arguments.slice(0, 1),
            ];
      for (const [index, argument] of compared.entries()) {
        if (argument.type === 'SpreadElement') continue;
        const reference = comparedTag(argument);
        if (
          reference === null ||
          exemptAssertionValue(compared[index === 0 ? 1 : 0])
        )
          continue;
        if (suppressed(node)) return true;
        reportAssertion(node, referenceText(context, reference));
        return true;
      }
      return false;
    }

    function checkAssertion(
      node: ESTree.CallExpression,
      assertion: AssertionCall | null
    ): boolean {
      if (assertion === null) return false;
      // Property assertions are shape/equality probes only on a proven `expect(subject)` chain.
      if (assertion.method === 'toHaveProperty' && assertion.subject !== null) {
        checkPropertyAssertion(node, assertion.subject);
        return true;
      }
      if (!ASSERTION_METHODS.has(assertion.method)) return false;
      return (
        checkObjectAssertion(node, assertion) ||
        checkAssertionValues(node, assertion)
      );
    }
    function checkReceiverProbes(
      node: ESTree.CallExpression,
      receiver: ESTree.Node,
      method: string
    ) {
      if (checkStringProbe(node, receiver, method)) return;
      if (checkRegexProbe(node, receiver, method)) return;
      checkMembership(node, receiver, method);
    }

    function checkCall(node: ESTree.CallExpression) {
      if (checkShape(node) || checkEqualityCall(node)) return;
      const callee = assertionCallee(context, node.callee);
      const assertion = assertionCall(context, node);
      const method =
        callee.type === 'MemberExpression'
          ? memberPropertyName(callee)
          : assertion?.method;
      const receiver =
        callee.type === 'MemberExpression' ? callee.object : null;
      if (method === null || method === undefined) return;
      if (checkAssertion(node, assertion) || receiver === null) return;

      checkReceiverProbes(node, receiver, method);
    }
    return {
      SwitchStatement(node) {
        if (tagOf(node.discriminant) === null || suppressed(node)) return;
        const labels = node.cases.flatMap((branch) =>
          branch.test === null ? [] : [branch.test]
        );
        if (
          labels.length > 0 &&
          labels.every((label) => {
            const literal = asStringLiteral(label);
            return literal !== null && exempt.has(literal);
          })
        )
          return;
        context.report({ node, messageId: 'tagSwitch' });
      },
      BinaryExpression: checkBinary,
      CallExpression: checkCall,
    };
  },
});
