/**
 * effect-native/no-refinement-outside-schema
 *
 * Audit finding: **A2** — "Make Schema the sole authority for contracts and domain models"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`). A2's Effect v4 target says in as many words:
 * *"Move refinements and cross-field rules into the owning Schema."* Its headline evidence is
 * `packages/shared-contracts/src/index.ts:178-209`, a block of hand-written
 * `<Value>(value: Value): value is Value & string` guards (`isRecord`, `isNonEmptyString`,
 * `isNonNegativeNumber`, `isUltramodernWorkspaceLocale`, `isPerformanceReadinessSignalId`,
 * `isPerformanceReadinessSignalStatus`) that re-implement, in TypeScript control flow, exactly the
 * validation the workspace-event Schemas already own. A2 also lists the downstream cost this rule
 * exists to remove: "removal of manual guards, safer forms and routes, ... shared validation across
 * client/server/persistence".
 *
 * A user-defined type predicate is a *second validation authority*: the compiler trusts the boolean
 * unconditionally, so the guard's rule and the Schema's rule drift apart silently, the guard cannot
 * produce a decode error, an `Issue`, an annotation, an arbitrary for property tests, or a JSON
 * Schema, and it cannot be shared with the client or the database row codec. The Effect-native form
 * is to put the refinement on the Schema (`Schema.filter` / `Schema.check` / `Schema.brand` /
 * `Schema.Literal` / `Schema.TaggedStruct`) and to narrow with `Schema.is(Schema)` /
 * `Schema.asserts(Schema)`, which reuses the one authority.
 *
 * ## What this detects
 *
 * Every `TSTypePredicate` return type — `x is T` and `asserts x is T`, plus bare `asserts x` — on any
 * declaration form:
 *
 * - arrow functions and function expressions (`const isTagged = <V>(v: V): v is V & { _tag: string } => …`),
 * - function declarations, overload signatures (`TSDeclareFunction`) and class methods,
 * - object/class members, and type-level positions: `TSMethodSignature`, `TSFunctionType`
 *   (`readonly isFoo: (v: unknown) => v is Foo`), `TSCallSignatureDeclaration`, `TSConstructorType`,
 * - `.ts`, `.mts`, `.cts` and `.tsx`/JSX alike, in source *and* tests (the audit's duplicated guards
 *   live in `tests/support/*` too); `ignoreTests: true` opts tests out.
 *
 * The report is anchored on the predicate itself (`value is Value & string`), so the diagnostic names
 * the type whose Schema should own the rule.
 *
 * ## What is deliberately allowed
 *
 * - **Predicates whose whole body delegates the narrowing decision to an existing authority, applied
 *   to the guarded value itself.** `Schema.is(S)(x)` / `Schema.asserts(S)(x)` (including
 *   `import { is, asserts } from "effect/Schema"`, the root barrel `Effect.Schema.is(S)(x)`, and
 *   computed access `Schema["is"](S)(x)`), any `Predicate.*` call, an `effect/Predicate` named import
 *   (`import { isString } from "effect/Predicate"` — the shape used by
 *   `verticals/contacts/src/modern.runtime.ts`), `Array.isArray(x)`, and a single call to a guard
 *   imported from an external (third-party/framework) package — e.g. Drizzle's own
 *   `import { isTable } from "drizzle-orm"` in the schema-inventory tests, where no `Schema` can own
 *   "is this a `PgTable` instance". Such a predicate is a *typing seam over* the one authority, not a
 *   competing one.
 *
 *   Three things this allowance deliberately refuses:
 *   1. **The delegate must test the guarded parameter.** `(scope): scope is … =>
 *      Predicate.isString(scope.legalEntityId)` refines a *projection*, so the hand-written rule is
 *      still outside the Schema — it reports. So do zero-argument and unrelated-argument delegates.
 *   2. **Locally declared delegates are not authorities.** `isRecord(x)` where `isRecord` is declared
 *      in this repo (or imported from a first-party workspace package, see `internalModules`) is the
 *      hand-written refinement, merely renamed.
 *   3. **Compound bodies.** `Predicate.isString(v) && v.trim().length > 0` reports: the extra clause is
 *      precisely the refinement A2 wants inside the Schema.
 *
 *   Point-free forms — `const f: (v: unknown) => v is T = Schema.is(S)`, `= isString`, and the same
 *   through an `as` clause — are allowed the same way (there the delegate *is* the function).
 * - **Inline array-operation callbacks** (`allowInlineCallbacks`, default `true`): a predicate passed
 *   directly to `filter` / `find` / `findLast` / `findIndex` / `every` / `some` / `flatMap` — including
 *   the Effect data-module forms (`pipe(xs, Array.filter((x): x is T => …))`, and bare
 *   `import { filter } from "effect/Array"`). A bare identifier callee is only honoured when it really
 *   is an `effect` collection import, so a local helper named `every`/`find` cannot launder an
 *   exported domain predicate. The D tier blesses "native array/object operations where Effect
 *   collection APIs add no semantic value", and `entries.filter((e): e is [string, string] =>
 *   e[1] !== undefined)` is a local narrowing of a collection, not a domain contract.
 * - **`Array.isArray` in recursive JSON normalisation**, blessed verbatim under "Existing patterns to
 *   preserve" — covered by the single-call allowance above.
 * - **Callable service-capability probes**, exactly `'method' in service &&
 *   Predicate.isFunction(service.method)`. These inspect behavior, not a data contract; A2's Schema
 *   prescription is not actionable here. Added data checks or other projected delegates still report.
 * - **`instanceof`/`in` guards** when `allowInstanceofGuards` is enabled (default `false`, because the
 *   audit's real instances carry extra hand-written clauses): structural-only bodies over an
 *   `unknown`/`never`/`any` parameter, plus bodies anchored on `param instanceof Class && …` (runtime
 *   object-identity matching such as `value instanceof ActionRollbackSignal && value.matches(token)`,
 *   which no Schema can own).
 * - Anything outside `include` (default `apps/**`, `verticals/**`, `packages/**`, `scripts/**`, so
 *   `tools/**` and generated `dist/**` never report) or matching `ignore`.
 *
 * Report-only: no fixer, no suggestion. Existing violations are the intended output.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree } from '@oxlint/plugins';

import { collectEffectBindings } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production `include` defaults instead of
 * forcing the fixture config to pass loosened options (which `run-on-repo.mts` reuses verbatim).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE: readonly string[] = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];

const DEFAULT_IGNORE: readonly string[] = [];

/** Workspace-internal module specifiers: first-party code can never be the "existing authority". */
const DEFAULT_INTERNAL_MODULES: readonly string[] = [
  '@app/**',
  '@ontos/**',
  '@akros/**',
  '~/**',
  '#*',
  '#*/**',
];

const DEFAULT_ALLOW_DELEGATED_GUARDS: readonly string[] = [];

/** Array/collection operations whose callback narrowing is a local concern, not a domain contract. */
const ARRAY_CALLBACK_METHODS = new Set([
  'every',
  'filter',
  'filterMap',
  'find',
  'findFirst',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'partition',
  'some',
]);

/** `Schema` members that already return a Schema-owned refinement/narrowing function. */
const SCHEMA_NARROWING_MEMBERS = new Set(['asserts', 'is', 'validate', 'validateSync']);

/** Module whose named exports are Effect's own predicate combinators. */
const PREDICATE_MODULES = new Set(['effect/Predicate']);

/** Module whose named exports include the Schema narrowing factories themselves. */
const SCHEMA_MODULES = new Set(['effect/Schema']);

const EFFECT_MODULE = /^effect(?:\/.*)?$/u;

/** Type keywords that mark a "widest possible input" guard rather than a domain refinement. */
const OPAQUE_INPUT_TYPES = new Set(['TSUnknownKeyword', 'TSNeverKeyword', 'TSAnyKeyword']);

/** Expression forms allowed inside an `instanceof`/`in`-only guard body. */
const STRUCTURAL_OPERATORS = new Set(['instanceof', 'in']);

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly allowInlineCallbacks: boolean;
  readonly allowInstanceofGuards: boolean;
  readonly allowExternalGuardDelegation: boolean;
  readonly allowDelegatedGuards: readonly string[];
  readonly internalModules: readonly string[];
  readonly ignoreTests: boolean;
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
    allowInlineCallbacks: record.allowInlineCallbacks !== false,
    allowInstanceofGuards: record.allowInstanceofGuards === true,
    allowExternalGuardDelegation: record.allowExternalGuardDelegation !== false,
    allowDelegatedGuards: stringArray(record.allowDelegatedGuards, DEFAULT_ALLOW_DELEGATED_GUARDS),
    internalModules: stringArray(record.internalModules, DEFAULT_INTERNAL_MODULES),
    ignoreTests: record.ignoreTests === true,
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
  for (;;) {
    if (
      current.type === 'ChainExpression' ||
      current.type === 'ParenthesizedExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSInstantiationExpression'
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function parentOf(node: ESTree.Node): ESTree.Node | null {
  return (node as { parent?: ESTree.Node | null }).parent ?? null;
}

interface ImportBinding {
  /** The module specifier the local name came from, e.g. `effect/Schema`, `drizzle-orm`, `./guards.ts`. */
  readonly module: string;
  /** The exported name (`default` for a default import, `*` for a namespace import). */
  readonly imported: string;
  readonly namespace: boolean;
}

/**
 * Every *value* import binding in the program, keyed by local name. Type-only imports are skipped —
 * they can never be the runtime delegate of a guard body.
 */
function collectValueImports(program: ESTree.Program): ReadonlyMap<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if ((statement as { importKind?: string }).importKind === 'type') continue;
    const module = statement.source.value;
    if (typeof module !== 'string') continue;
    for (const specifier of statement.specifiers) {
      if ((specifier as { importKind?: string }).importKind === 'type') continue;
      if (specifier.type === 'ImportSpecifier') {
        const imported =
          specifier.imported.type === 'Identifier'
            ? specifier.imported.name
            : String(specifier.imported.value);
        bindings.set(specifier.local.name, { module, imported, namespace: false });
      } else if (specifier.type === 'ImportDefaultSpecifier') {
        bindings.set(specifier.local.name, { module, imported: 'default', namespace: false });
      } else if (specifier.type === 'ImportNamespaceSpecifier') {
        bindings.set(specifier.local.name, { module, imported: '*', namespace: true });
      }
    }
  }
  return bindings;
}

function localsFrom(
  imports: ReadonlyMap<string, ImportBinding>,
  accept: (binding: ImportBinding) => boolean,
): ReadonlySet<string> {
  const locals = new Set<string>();
  for (const [local, binding] of imports) {
    if (accept(binding)) locals.add(local);
  }
  return locals;
}

function staticPropertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const key = unwrap(node.property);
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : null;
}

/**
 * Resolve `Schema.is`, `Schema["is"]`, `S.is` and the root-barrel `Effect.Schema.is` to
 * `{ namespace: "Schema", member: "is" }`. Unlike the shared `effectMember` helper this also honours
 * computed access and namespace imports of the `effect` barrel itself.
 */
function resolveNamespaceMember(
  node: ESTree.Node,
  bindings: EffectBindings,
  barrelLocals: ReadonlySet<string>,
): { namespace: string; member: string } | null {
  if (node.type !== 'MemberExpression') return null;
  const member = staticPropertyName(node);
  if (member === null) return null;
  const object = unwrap(node.object);
  if (object.type === 'Identifier') {
    const namespace = bindings.namespaces.get(object.name);
    return namespace === undefined ? null : { namespace, member };
  }
  if (object.type === 'MemberExpression') {
    const root = unwrap(object.object);
    if (root.type !== 'Identifier' || !barrelLocals.has(root.name)) return null;
    const namespace = staticPropertyName(object);
    return namespace === null ? null : { namespace, member };
  }
  return null;
}

/** `Array.isArray(x)` — the D-tier-blessed JSON normalisation guard. */
function isArrayIsArrayCall(callee: ESTree.Node): boolean {
  if (callee.type !== 'MemberExpression') return false;
  const object = unwrap(callee.object);
  return (
    object.type === 'Identifier' &&
    object.name === 'Array' &&
    staticPropertyName(callee) === 'isArray'
  );
}

/** Everything the file has learned about which local names really are existing authorities. */
interface Authorities {
  readonly context: Context;
  readonly bindings: EffectBindings;
  readonly barrelLocals: ReadonlySet<string>;
  /** `import { isString } from "effect/Predicate"`. */
  readonly predicateLocals: ReadonlySet<string>;
  /** `import { is, asserts } from "effect/Schema"`. */
  readonly schemaNarrowingLocals: ReadonlySet<string>;
  /** `import { filter } from "effect/Array"` — collection operations, for the callback allowance. */
  readonly collectionLocals: ReadonlySet<string>;
  readonly imports: ReadonlyMap<string, ImportBinding>;
}

function collectAuthorities(program: ESTree.Program, context: Context): Authorities {
  const imports = collectValueImports(program);
  return {
    context,
    bindings: collectEffectBindings(program),
    barrelLocals: localsFrom(
      imports,
      (binding) => binding.namespace && binding.module === 'effect',
    ),
    predicateLocals: localsFrom(
      imports,
      (binding) => !binding.namespace && PREDICATE_MODULES.has(binding.module),
    ),
    schemaNarrowingLocals: localsFrom(
      imports,
      (binding) =>
        !binding.namespace &&
        SCHEMA_MODULES.has(binding.module) &&
        SCHEMA_NARROWING_MEMBERS.has(binding.imported),
    ),
    collectionLocals: localsFrom(
      imports,
      (binding) =>
        !binding.namespace &&
        EFFECT_MODULE.test(binding.module) &&
        ARRAY_CALLBACK_METHODS.has(binding.imported),
    ),
    imports,
  };
}

/** Import spelling is insufficient: a parameter or local may shadow any recorded authority. */
function hasImportedRoot(node: ESTree.Node, authorities: Authorities): boolean {
  let root = unwrap(node);
  while (root.type === 'MemberExpression') root = unwrap(root.object);
  if (root.type !== 'Identifier' || !authorities.imports.has(root.name)) return false;
  let scope: ReturnType<Context['sourceCode']['getScope']> | null =
    authorities.context.sourceCode.getScope(root);
  while (scope !== null) {
    const variable = scope.set.get(root.name);
    if (variable !== undefined)
      return variable.defs.some((definition) => definition.type === 'ImportBinding');
    scope = scope.upper;
  }
  return false;
}

/** Array must be the native global, not an imported or locally declared lookalike. */
function isNativeArray(callee: ESTree.Node, authorities: Authorities): boolean {
  if (!isArrayIsArrayCall(callee) || callee.type !== 'MemberExpression') return false;
  const root = unwrap(callee.object);
  let scope: ReturnType<Context['sourceCode']['getScope']> | null =
    authorities.context.sourceCode.getScope(root);
  while (scope !== null) {
    const variable = scope.set.get('Array');
    if (variable !== undefined) return variable.defs.length === 0;
    scope = scope.upper;
  }
  return true;
}

/** `Predicate.isString` / `P.isRecord` / `Effect.Predicate.isString`, or an `effect/Predicate` import. */
function isPredicateAuthority(node: ESTree.Node, authorities: Authorities): boolean {
  if (!hasImportedRoot(node, authorities)) return false;
  if (node.type === 'Identifier') return authorities.predicateLocals.has(node.name);
  const member = resolveNamespaceMember(node, authorities.bindings, authorities.barrelLocals);
  return member !== null && member.namespace === 'Predicate';
}

/** `Schema.is` / `Schema["is"]` / `Effect.Schema.asserts` / the bare `is` from `effect/Schema`. */
function isSchemaNarrowingFactory(node: ESTree.Node, authorities: Authorities): boolean {
  if (!hasImportedRoot(node, authorities)) return false;
  if (node.type === 'Identifier') return authorities.schemaNarrowingLocals.has(node.name);
  const member = resolveNamespaceMember(node, authorities.bindings, authorities.barrelLocals);
  if (member === null) return false;
  return member.namespace === 'Schema' && SCHEMA_NARROWING_MEMBERS.has(member.member);
}

/** `Schema.is(S)` / `is(S)` — a call that *produces* the Schema-owned narrowing function. */
function isSchemaNarrowingApplication(node: ESTree.Node, authorities: Authorities): boolean {
  const inner = unwrap(node);
  if (inner.type !== 'CallExpression') return false;
  return isSchemaNarrowingFactory(unwrap(inner.callee), authorities);
}

function moduleIsExternal(module: string, internalModules: readonly string[]): boolean {
  if (module.startsWith('.') || module.startsWith('/')) return false;
  return !matchesGlobs(module, internalModules);
}

/** `"drizzle-orm#isTable"` (module-qualified) or `"isTable"` (bare) entries of `allowDelegatedGuards`. */
function matchesDelegateAllowlist(
  name: string,
  binding: ImportBinding,
  allowlist: readonly string[],
): boolean {
  return allowlist.some((entry) => {
    const hash = entry.indexOf('#');
    if (hash === -1) return entry === name;
    return entry.slice(0, hash) === binding.module && entry.slice(hash + 1) === binding.imported;
  });
}

/**
 * A bare identifier that names a guard owned by somebody else: a third-party/framework runtime guard
 * such as Drizzle's `isTable`. Locally declared names — and first-party workspace packages — are never
 * authorities: those are the hand-written refinements A2 is about, merely renamed.
 */
function isExternalGuardDelegate(
  name: string,
  authorities: Authorities,
  options: RuleOptions,
): boolean {
  const binding = authorities.imports.get(name);
  if (binding === undefined || binding.namespace) return false;
  if (matchesDelegateAllowlist(name, binding, options.allowDelegatedGuards)) return true;
  if (!options.allowExternalGuardDelegation) return false;
  return moduleIsExternal(binding.module, options.internalModules);
}

/** The name of the value the predicate narrows — `value` in `(value: unknown): value is T`. */
function guardedParameterName(predicate: ESTree.TSTypePredicate): string | null {
  const parameter = predicate.parameterName as ESTree.Node;
  if (parameter.type === 'Identifier') return parameter.name;
  if (parameter.type === 'TSThisType') return 'this';
  return null;
}

/** Is `argument` literally the value the predicate claims to narrow? */
function isGuardedValue(argument: ESTree.Node, parameterName: string): boolean {
  const node = unwrap(argument);
  if (parameterName === 'this') return node.type === 'ThisExpression';
  return node.type === 'Identifier' && node.name === parameterName;
}

/**
 * Whether the body *applies* an existing authority to the guarded value: `Schema.is(S)(x)`,
 * `Predicate.isString(x)`, `Array.isArray(x)`, `isTable(x)`. The argument check is what stops a
 * hand-written refinement from hiding behind a delegate call on a projection
 * (`Predicate.isString(scope.legalEntityId)`) or on an unrelated value.
 */
function delegatesToAuthority(
  expression: ESTree.Node,
  parameterName: string | null,
  authorities: Authorities,
  options: RuleOptions,
): boolean {
  if (parameterName === null) return false;
  const node = unwrap(expression);
  if (node.type !== 'CallExpression' || node.arguments.length !== 1) return false;
  const first = node.arguments[0];
  if (first === undefined || first.type === 'SpreadElement') return false;
  if (!isGuardedValue(first, parameterName)) return false;
  const callee = unwrap(node.callee);
  if (isNativeArray(callee, authorities)) return true;
  if (isPredicateAuthority(callee, authorities)) return true;
  if (isSchemaNarrowingApplication(callee, authorities)) return true;
  if (
    callee.type === 'Identifier' &&
    hasImportedRoot(callee, authorities) &&
    isExternalGuardDelegate(callee.name, authorities, options)
  )
    return true;
  return false;
}

/**
 * Point-free: the annotated value *is* the narrowing function — `= Schema.is(S)`, `= is(S)`,
 * `= isString`, `= Predicate.isString`. There is no argument to check; the delegate is the guard.
 */
function isAuthorityFunction(
  expression: ESTree.Node,
  authorities: Authorities,
  options: RuleOptions,
): boolean {
  const node = unwrap(expression);
  if (isSchemaNarrowingApplication(node, authorities)) return true;
  if (node.type === 'Identifier') {
    if (!hasImportedRoot(node, authorities)) return false;
    if (authorities.predicateLocals.has(node.name)) return true;
    return isExternalGuardDelegate(node.name, authorities, options);
  }
  return isPredicateAuthority(node, authorities);
}

/** The single expression a function body evaluates to, or null when the body does more than that. */
function soleReturnedExpression(owner: ESTree.Node): ESTree.Node | null {
  const body = (owner as { body?: ESTree.Node | null }).body ?? null;
  if (body === null) return null;
  if (body.type !== 'BlockStatement') return body;
  const statements = body.body.filter((statement) => statement.type !== 'EmptyStatement');
  const only = statements[0];
  if (statements.length !== 1 || only === undefined) return null;
  // `asserts` guards evaluate their delegate for effect rather than returning it.
  if (only.type === 'ExpressionStatement') return only.expression;
  if (only.type !== 'ReturnStatement' || only.argument === null) return null;
  return only.argument;
}

/**
 * The value a `TSFunctionType` predicate annotation is attached to: `const f: (v) => v is T = <init>`,
 * `class { readonly f: (v) => v is T = <init> }`, and `<init> as (v) => v is T`.
 */
function annotatedInitialiser(owner: ESTree.Node): ESTree.Node | null {
  if (owner.type !== 'TSFunctionType') return null;
  let current: ESTree.Node | null = parentOf(owner);
  for (let depth = 0; current !== null && depth < 6; depth += 1) {
    if (current.type === 'TSAsExpression' || current.type === 'TSSatisfiesExpression')
      return current.expression;
    if (current.type === 'VariableDeclarator') return current.init ?? null;
    if (current.type === 'PropertyDefinition') return current.value ?? null;
    if (
      current.type === 'Identifier' ||
      current.type === 'TSTypeAnnotation' ||
      current.type === 'TSParenthesizedType'
    ) {
      current = parentOf(current);
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Is this function the direct callback argument of a collection operation? Member callees
 * (`rows.filter(...)`, `Arr.findFirst(...)`) are honoured by name; a *bare* identifier callee must
 * really be an `effect` collection import, so a local helper named `every`/`find` cannot launder an
 * exported domain predicate through the allowance.
 */
function isInlineArrayCallback(owner: ESTree.Node, authorities: Authorities): boolean {
  if (owner.type !== 'ArrowFunctionExpression' && owner.type !== 'FunctionExpression') return false;
  const call = parentOf(owner);
  if (call === null || call.type !== 'CallExpression') return false;
  if (!call.arguments.some((argument) => argument === owner)) return false;
  const callee = unwrap(call.callee);
  if (callee.type === 'MemberExpression') {
    const name = staticPropertyName(callee);
    return name !== null && ARRAY_CALLBACK_METHODS.has(name);
  }
  if (callee.type === 'Identifier')
    return authorities.collectionLocals.has(callee.name) && hasImportedRoot(callee, authorities);
  return false;
}

/** A service capability probe checks callable behavior, not a serialisable domain refinement.
 * A2 does not justify prescribing a data Schema for `'method' in service && isFunction(service.method)`.
 * Require that exact pair; data-property probes and additional business clauses still report. */
function isCallableCapabilityProbe(
  expression: ESTree.Node,
  parameterName: string | null,
  authorities: Authorities,
): boolean {
  if (parameterName === null) return false;
  const pair = unwrap(expression);
  if (pair.type !== 'LogicalExpression' || pair.operator !== '&&') return false;
  const presence = unwrap(pair.left);
  const check = unwrap(pair.right);
  if (presence.type !== 'BinaryExpression' || presence.operator !== 'in') return false;
  if (!isGuardedValue(presence.right, parameterName)) return false;
  const key = unwrap(presence.left);
  if (key.type !== 'Literal' || typeof key.value !== 'string') return false;
  if (check.type !== 'CallExpression' || check.arguments.length !== 1) return false;
  const callee = unwrap(check.callee);
  if (!isPredicateAuthority(callee, authorities)) return false;
  const member =
    callee.type === 'Identifier'
      ? authorities.imports.get(callee.name)?.imported
      : resolveNamespaceMember(callee, authorities.bindings, authorities.barrelLocals)?.member;
  if (member !== 'isFunction') return false;
  const argument = check.arguments[0];
  if (argument === undefined) return false;
  const projected = unwrap(argument);
  return (
    projected.type === 'MemberExpression' &&
    staticPropertyName(projected) === key.value &&
    isGuardedValue(projected.object, parameterName)
  );
}

/** Body made only of `instanceof` / `in` tests joined by `&&`, `||`, `!` and parentheses. */
function isStructuralNarrowingOnly(expression: ESTree.Node): boolean {
  const node = unwrap(expression);
  if (node.type === 'BinaryExpression') return STRUCTURAL_OPERATORS.has(node.operator);
  if (node.type === 'LogicalExpression') {
    return isStructuralNarrowingOnly(node.left) && isStructuralNarrowingOnly(node.right);
  }
  if (node.type === 'UnaryExpression' && node.operator === '!')
    return isStructuralNarrowingOnly(node.argument);
  return false;
}

/**
 * `value instanceof ActionRollbackSignal && value.matches(token)` — runtime object-identity matching
 * anchored on the guarded value. Opt-in through `allowInstanceofGuards`.
 */
function isInstanceofAnchored(expression: ESTree.Node, parameterName: string | null): boolean {
  if (parameterName === null) return false;
  const node = unwrap(expression);
  if (node.type === 'LogicalExpression' && node.operator === '&&') {
    return isInstanceofAnchored(node.left, parameterName);
  }
  if (node.type !== 'BinaryExpression' || node.operator !== 'instanceof') return false;
  return isGuardedValue(node.left as ESTree.Node, parameterName);
}

/** The declared type of the parameter the predicate narrows, e.g. `unknown` in `(v: unknown): v is T`. */
function guardedParameterType(owner: ESTree.Node, parameterName: string | null): string | null {
  if (parameterName === null) return null;
  const params = (owner as { params?: readonly ESTree.Node[] }).params ?? [];
  for (const param of params) {
    let target: ESTree.Node = param;
    if (target.type === 'RestElement') target = target.argument;
    if (target.type === 'AssignmentPattern') target = target.left;
    const identifier = target.type === 'Identifier' ? target : null;
    if (identifier === null || identifier.name !== parameterName) continue;
    const annotation =
      (identifier as { typeAnnotation?: ESTree.TSTypeAnnotation | null }).typeAnnotation ?? null;
    return annotation?.typeAnnotation.type ?? null;
  }
  return null;
}

const OWNER_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
  'TSDeclareFunction',
  'TSEmptyBodyFunctionExpression',
  'TSMethodSignature',
  'TSFunctionType',
  'TSConstructorType',
  'TSCallSignatureDeclaration',
  'TSConstructSignatureDeclaration',
]);

/** Walk out of the return-type annotation to the function/signature that declares the predicate. */
function ownerOf(predicate: ESTree.TSTypePredicate): ESTree.Node | null {
  let current: ESTree.Node | null = parentOf(predicate);
  for (let depth = 0; current !== null && depth < 6; depth += 1) {
    if (OWNER_TYPES.has(current.type)) return current;
    if (current.type !== 'TSTypeAnnotation' && current.type !== 'TSParenthesizedType') return null;
    current = parentOf(current);
  }
  return null;
}

function keyName(node: ESTree.Node | null): string | null {
  if (node === null) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null;
  if (node.type === 'PrivateIdentifier') return `#${node.name}`;
  return null;
}

/** Parents that carry no name of their own but sit between a predicate and the declaration that does. */
const NAME_TRANSPARENT_PARENTS = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'Identifier',
  'TSAsExpression',
  'TSParenthesizedType',
  'TSSatisfiesExpression',
  'TSTypeAnnotation',
]);

/** Best-effort declaration name for the diagnostic (`isNonEmptyString`, `#isReady`, `(anonymous)`). */
function predicateName(owner: ESTree.Node | null): string {
  if (owner === null) return '(anonymous)';
  const own = (owner as { id?: ESTree.Node | null }).id ?? null;
  const ownName = keyName(own);
  if (ownName !== null) return ownName;
  if (owner.type === 'TSMethodSignature' || owner.type === 'TSCallSignatureDeclaration') {
    const key = keyName((owner as { key?: ESTree.Node | null }).key ?? null);
    if (key !== null) return key;
    return '(call signature)';
  }
  let current: ESTree.Node | null = parentOf(owner);
  for (let depth = 0; current !== null && depth < 8; depth += 1) {
    if (current.type === 'VariableDeclarator') return keyName(current.id) ?? '(anonymous)';
    if (
      current.type === 'Property' ||
      current.type === 'PropertyDefinition' ||
      current.type === 'MethodDefinition'
    ) {
      return keyName((current as { key?: ESTree.Node | null }).key ?? null) ?? '(anonymous)';
    }
    if (current.type === 'TSPropertySignature') {
      return keyName((current as { key?: ESTree.Node | null }).key ?? null) ?? '(anonymous)';
    }
    if (current.type === 'TSTypeAliasDeclaration') return keyName(current.id) ?? '(anonymous)';
    if (current.type === 'AssignmentExpression') {
      const left = unwrap(current.left);
      if (left.type === 'Identifier') return left.name;
      if (left.type === 'MemberExpression') return staticPropertyName(left) ?? '(anonymous)';
      return '(anonymous)';
    }
    if (!NAME_TRANSPARENT_PARENTS.has(current.type)) return '(anonymous)';
    current = parentOf(current);
  }
  return '(anonymous)';
}

function condense(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

/** Audit A2: refinements belong to the owning Schema, not to hand-written `x is T` predicates. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A2 (“Make Schema the sole authority for contracts and domain models”, target: ' +
        '“Move refinements and cross-field rules into the owning Schema”): disallow hand-written ' +
        '`x is T` / `asserts x is T` type predicates. A user-defined guard is a second validation ' +
        'authority the compiler trusts blindly — it cannot produce an Issue, an annotation, an ' +
        'arbitrary, or a JSON Schema, and it silently drifts from the Schema it duplicates. Express the ' +
        'rule with `Schema.filter`/`Schema.check`/`Schema.brand`/`Schema.Literal` and narrow with ' +
        '`Schema.is(Schema)` or `Schema.asserts(Schema)`. Inline array-callback narrowing stays allowed, ' +
        'as does a whole body that delegates the decision about the guarded value itself to an existing ' +
        'authority (`Schema.is(S)(x)`, `Predicate.*`, `Array.isArray`, a third-party runtime guard).',
    },
    messages: {
      handWrittenRefinement:
        'Type predicate `{{name}}` is a hand-written refinement outside the Schema that owns `{{type}}` ' +
        '(audit A2). Move the rule into that Schema with `Schema.filter`/`Schema.check` (or ' +
        '`Schema.brand`/`Schema.Literal` when it is an identifier or a closed vocabulary) and narrow with ' +
        '`Schema.is(Schema)`, so validation, decoding, error Issues and the client share one authority.',
      handWrittenAssertion:
        'Assertion signature `{{name}}` asserts `{{type}}` from hand-written control flow outside the ' +
        'Schema that owns it (audit A2). Encode the rule as `Schema.filter`/`Schema.check` on that Schema ' +
        'and assert with `Schema.asserts(Schema)` — or better, decode once with ' +
        '`Schema.decodeUnknown(Schema)` and carry the typed failure in the Effect error channel.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          allowInlineCallbacks: { type: 'boolean' },
          allowInstanceofGuards: { type: 'boolean' },
          allowExternalGuardDelegation: { type: 'boolean' },
          allowDelegatedGuards: { type: 'array', items: { type: 'string' } },
          internalModules: { type: 'array', items: { type: 'string' } },
          ignoreTests: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: [...DEFAULT_INCLUDE],
        ignore: [...DEFAULT_IGNORE],
        allowInlineCallbacks: true,
        allowInstanceofGuards: false,
        allowExternalGuardDelegation: true,
        allowDelegatedGuards: [...DEFAULT_ALLOW_DELEGATED_GUARDS],
        internalModules: [...DEFAULT_INTERNAL_MODULES],
        ignoreTests: false,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore)) return {};
    if (!matchesGlobs(path, options.include)) return {};
    if (options.ignoreTests && isTestFile(path)) return {};

    const authorities = collectAuthorities(context.sourceCode.ast, context);

    return {
      TSTypePredicate(node) {
        const owner = ownerOf(node);

        if (
          options.allowInlineCallbacks &&
          owner !== null &&
          isInlineArrayCallback(owner, authorities)
        )
          return;

        if (owner !== null) {
          const parameterName = guardedParameterName(node);
          const body = soleReturnedExpression(owner);
          if (body !== null && delegatesToAuthority(body, parameterName, authorities, options))
            return;
          if (body !== null && isCallableCapabilityProbe(body, parameterName, authorities)) return;

          const initialiser = body === null ? annotatedInitialiser(owner) : null;
          if (initialiser !== null && isAuthorityFunction(initialiser, authorities, options))
            return;

          if (options.allowInstanceofGuards && body !== null) {
            const parameterType = guardedParameterType(owner, parameterName);
            if (
              parameterType !== null &&
              OPAQUE_INPUT_TYPES.has(parameterType) &&
              isStructuralNarrowingOnly(body)
            ) {
              return;
            }
            if (isInstanceofAnchored(body, parameterName)) return;
          }
        }

        const asserted = node.typeAnnotation;
        const type =
          asserted === null
            ? condense(context.sourceCode.getText(node.parameterName), 60)
            : condense(context.sourceCode.getText(asserted.typeAnnotation), 60);

        context.report({
          node,
          messageId: node.asserts ? 'handWrittenAssertion' : 'handWrittenRefinement',
          data: { name: predicateName(owner), type },
        });
      },
    };
  },
});
