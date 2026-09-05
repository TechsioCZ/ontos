/**
 * Audit finding: **A5** — "Introduce an Effect-shaped persistence seam and typed database failures"
 * in `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`: *"PostgreSQL failures are either walked
 * manually through unknown `.cause` chains or collapsed into generic retryable 503 errors"*, with the
 * target *"Introduce a Core-owned database failure taxonomy and one decoder for SQLSTATE,
 * constraints, connectivity, deadlock, serialization, scope/RLS, and unexpected defects."*
 *
 * Four independent PostgreSQL cause-chain / SQLSTATE walkers exist today:
 * `apps/shell-super-app/api/auth/service.ts` (`isDatabaseUnavailable`),
 * `packages/core-runtime/src/auth/principal-management.ts` (`hasDatabaseErrorCode`),
 * `verticals/contacts/src/services/customer-contact-persistence.service.ts`
 * (`isCustomerIcoUniquenessFailure`) and `packages/core-runtime/src/actions/runtime.ts`
 * (`isCommitAcknowledgementFailure`). Each re-invents `'code' in error`, `'cause' in error`, a
 * SQLSTATE prefix regex and a private set of `E*` socket codes, so the taxonomy is owned by whichever
 * module happened to hit the failure first.
 *
 * What is detected (in `include` paths, outside `decoderPaths`, never in tests/scripts):
 * 1. `in` narrowing of a driver failure shape: `'cause' in error`, `'code' in current`,
 *    `'constraint' in current`, … — any `BinaryExpression` with operator `in` whose left operand is a
 *    string literal listed in `narrowedKeys`. Keys that also name ordinary DOM/ORM fields
 *    (`ambiguousKeys`: `detail`, `routine`, `schema`, `table`, `column`) additionally require the
 *    narrowed subject to read like a failure (`failureOperandPattern`), so `'detail' in event` on a
 *    DOM `CustomEvent` stays silent while `'detail' in error` reports.
 * 2. Walking an unknown `.cause` chain: `error.cause`, `current.cause`, `value?.["cause"]`.
 * 3. SQLSTATE-shaped string literals (`sqlStatePattern`, default `^[0-9]{2}[0-9A-Z]{3}$`):
 *    `'23505'`, `'57P01'`, `'40001'` in any expression position (`sqlStateAnywhere`, default true) or
 *    — with `sqlStateAnywhere: false` — only as a comparison operand, a
 *    `startsWith`/`endsWith`/`includes`/`has` argument, or an element of an array / `new Set([...])`.
 * 4. Driver socket codes (`networkCodes`): `'ECONNREFUSED'`, `'EPIPE'`, `'ETIMEDOUT'`, …
 * 5. SQLSTATE class regexes: `/^(?:08|40|53|55|57|58)/u`, `/^08$/u`.
 * 6. SQLSTATE class prefix tests: `code.startsWith('08')` (a two-digit literal).
 *
 * What is deliberately allowed
 * - **Effect's own failure model.** `exit.cause`, `handlerExit.cause`, `policyExit.cause` — any object
 *   whose identifier ends in `exit`/`Exit` (`exitNamePattern`) — plus every `.cause` handed straight
 *   to a `Cause.*` / `Exit.*` / `Effect.failCause` sink (`causeSinks`), which is exactly the
 *   audit-blessed "preserve original failures or causes" pattern:
 *   `Cause.findErrorOption(exit.cause)`, `Cause.hasDies(exit.cause)`,
 *   `Effect.logError('defect', handlerExit.cause)`, `Effect.failCause(signal.cause)`.
 * - **Explicit safe cause fields** on your own class (`this.cause`, `super.cause`) and assignments to
 *   them — A4 asks for "an explicit safe cause field", not for zero cause fields.
 * - **Constructing** a typed error that carries a cause: `new IcoConflict({ cause: e })` is an object
 *   property, never a member read, and `Effect.catchTag('DatabaseUniqueViolation', …)` is the target
 *   pattern itself.
 * - Tests (`includeTests`, default false) — `database-boundary.test.ts` asserts real SQLSTATEs on
 *   purpose — `scripts/`, `tools/`, `dist/` and generated `**​/drizzle/**` migration metadata.
 * - DOM/ORM homonyms of driver keys — `'detail' in event` (`CustomEvent`), Drizzle `schema`/`table`/
 *   `column` — see `ambiguousKeys` above.
 * - `decoderPaths` (empty by default): once the Core-owned decoder exists, list its file(s) here and
 *   the taxonomy it owns stops reporting, while every other module stays covered.
 *
 * Known limitation: with no type information this is a lexical judgement. A five-character domain code
 * shaped like a SQLSTATE would report; the audit found none in production source. This rule only
 * reports; it never fixes or suggests.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree } from '@oxlint/plugins';

import { collectEffectBindings, effectMember } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isScriptFile, isTestFile, normalisePath } from '../shared/paths.ts';

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
  '**/.next/**',
  '**/drizzle/**',
  'tools/**',
  'scripts/**',
  '**/*.d.ts',
];

const DEFAULT_NARROWED_KEYS = [
  'cause',
  'code',
  'constraint',
  'detail',
  'sqlState',
  'errno',
  'syscall',
  'routine',
  'schema',
  'table',
  'column',
];

/**
 * Driver keys that also name ordinary DOM/ORM/domain fields (`event.detail`, Drizzle `schema`/`table`/
 * `column`). They only report when the narrowed subject itself looks like a failure.
 */
const DEFAULT_AMBIGUOUS_KEYS = ['detail', 'routine', 'schema', 'table', 'column'];

const DEFAULT_FAILURE_OPERAND_PATTERN =
  'error|failure|cause|defect|problem|exception|reason|rejection|current|value|row|record|result|body';

const DEFAULT_NETWORK_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ECONNABORTED',
  'EHOSTDOWN',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
];

/** `Namespace.member` sinks that legitimately consume an Effect `Cause`; `*` matches any member. */
const DEFAULT_CAUSE_SINKS = [
  'Cause.*',
  'Exit.*',
  'Effect.failCause',
  'Effect.logError',
  'Effect.logWarning',
  'Effect.logDebug',
  'Effect.annotateLogs',
];

const DEFAULT_SQLSTATE_PATTERN = '^(?:[0-9]{2}|0[A-Z]|2[BDF]|3[BDFZ]|F0|HV|P0|XX)[0-9A-Z]{3}$';

const DEFAULT_EXIT_NAME_PATTERN = 'exit$';

/** `startsWith('08')` style class-prefix probes. */
const DEFAULT_PREFIX_METHODS = ['startsWith', 'endsWith'];

/** Membership probes that make a bare literal a driver-code comparison. */
const MEMBERSHIP_METHODS = new Set([
  'startsWith',
  'endsWith',
  'includes',
  'has',
  'indexOf',
  'match',
  'test',
]);

const EQUALITY_OPERATORS = new Set(['===', '!==', '==', '!=']);

const CAUSE_KEY = 'cause';

/** `/^(?:08|40|53)/u` and `/^08$/u` — SQLSTATE class prefix matchers. */
const SQLSTATE_REGEX_PATTERNS = [
  /^\^\((?:\?:)?[0-9]{2}(?:\|[0-9]{2})*\)/u,
  /^\^[0-9]{2}\$?$/u,
  /^\^[0-9]\[[0-9-]+\]/u,
];

const TWO_DIGIT = /^[0-9]{2}$/u;

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly includeTests: boolean;
  readonly decoderPaths: readonly string[];
  readonly narrowedKeys: ReadonlySet<string>;
  readonly ambiguousKeys: ReadonlySet<string>;
  readonly failureOperandPattern: RegExp;
  readonly networkCodes: ReadonlySet<string>;
  readonly causeSinks: readonly string[];
  readonly sqlStatePattern: RegExp;
  readonly sqlStateAnywhere: boolean;
  readonly exitNamePattern: RegExp;
  readonly prefixMethods: ReadonlySet<string>;
  readonly detectCauseWalk: boolean;
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

function compile(value: unknown, fallback: string, flags: string): RegExp {
  const source = typeof value === 'string' && value.length > 0 ? value : fallback;
  try {
    return new RegExp(source, flags);
  } catch {
    return new RegExp(fallback, flags);
  }
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
    decoderPaths: stringArray(record.decoderPaths, []),
    narrowedKeys: new Set(stringArray(record.narrowedKeys, DEFAULT_NARROWED_KEYS)),
    ambiguousKeys: new Set(stringArray(record.ambiguousKeys, DEFAULT_AMBIGUOUS_KEYS)),
    failureOperandPattern: compile(
      record.failureOperandPattern,
      DEFAULT_FAILURE_OPERAND_PATTERN,
      'iu',
    ),
    networkCodes: new Set(stringArray(record.networkCodes, DEFAULT_NETWORK_CODES)),
    causeSinks: stringArray(record.causeSinks, DEFAULT_CAUSE_SINKS),
    sqlStatePattern: compile(record.sqlStatePattern, DEFAULT_SQLSTATE_PATTERN, 'u'),
    sqlStateAnywhere: record.sqlStateAnywhere !== false,
    exitNamePattern: compile(record.exitNamePattern, DEFAULT_EXIT_NAME_PATTERN, 'iu'),
    prefixMethods: new Set(stringArray(record.prefixMethods, DEFAULT_PREFIX_METHODS)),
    detectCauseWalk: record.detectCauseWalk !== false,
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Non-computed `.x`, or computed `["x"]`. */
function memberPropertyName(node: AnyNode): string | null {
  const property = node.property;
  if (!isNode(property)) return null;
  if (node.computed === true) {
    return staticString(property);
  }
  return property.type === 'Identifier' && typeof property.name === 'string' ? property.name : null;
}

/** Unwrap parentheses, chains, `!`, `as T` so callee/operand inspection sees the real node. */
function unwrap(node: unknown): AnyNode | null {
  let current: unknown = node;
  while (isNode(current)) {
    if (
      current.type === 'ChainExpression' ||
      current.type === 'ParenthesizedExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSInstantiationExpression' ||
      current.type === 'TSTypeAssertion'
    ) {
      current = current.expression ?? current.argument;
      continue;
    }
    return current;
  }
  return null;
}

/** `error.cause`, `error?.cause`, `error["cause"]` → the `cause` key it reads, else `null`. */
function causeMemberKey(node: AnyNode, key: string): boolean {
  return memberPropertyName(node) === key;
}

/**
 * `exit.cause` / `handlerExit.cause` / `result.scopeExit.cause` — the object this `.cause` is read from
 * is an Effect `Exit` by naming convention.
 */
function objectLooksLikeExit(object: unknown, pattern: RegExp): boolean {
  const target = unwrap(object);
  if (target === null) return false;
  if (target.type === 'Identifier')
    return typeof target.name === 'string' && pattern.test(target.name);
  if (target.type === 'MemberExpression') {
    const name = memberPropertyName(target);
    return name !== null && pattern.test(name);
  }
  return false;
}

/** `Cause.*`, `Exit.*`, `Effect.failCause` — a sink that legitimately consumes an Effect `Cause`. */
function isCauseSink(
  context: Context,
  callee: unknown,
  bindings: EffectBindings,
  sinks: readonly string[],
): boolean {
  const target = unwrap(callee);
  if (target === null) return false;
  const origin = effectOrigin(context, target as unknown as ESTree.Node, [
    '@modern-js/plugin-bff/effect-edge',
  ]);
  if (origin?.length !== 2) return false;
  const resolved = { namespace: origin[0], member: origin[1] };
  return sinks.some((sink) => {
    const [namespace, member] = sink.split('.');
    if (namespace !== resolved.namespace) return false;
    return member === '*' || member === resolved.member;
  });
}

/** Walk parents: is `node` (transitively) an argument of a `Cause.*`/`Exit.*`/`Effect.failCause` call? */
function insideCauseSink(
  context: Context,
  node: AnyNode,
  bindings: EffectBindings,
  sinks: readonly string[],
): boolean {
  let current: AnyNode = node;
  let parent = isNode(current.parent) ? current.parent : null;
  let depth = 0;
  while (parent !== null && depth < 12) {
    if (parent.type === 'CallExpression' || parent.type === 'NewExpression') {
      const args = Array.isArray(parent.arguments) ? parent.arguments : [];
      if (args.includes(current) && isCauseSink(context, parent.callee, bindings, sinks))
        return true;
      const origin = isNode(parent.callee)
        ? effectOrigin(context, parent.callee as unknown as ESTree.Node, [])
        : null;
      // Only the first transformation receives the unchanged value; a later sink is not proof.
      if (
        args[0] === current &&
        (origin?.join('.') === 'pipe' || origin?.join('.') === 'Function.pipe') &&
        isCauseSink(context, args[1], bindings, sinks)
      )
        return true;
      return false;
    }
    // Only transparent wrappers keep the "argument of" relation alive.
    if (
      parent.type !== 'ChainExpression' &&
      parent.type !== 'ParenthesizedExpression' &&
      parent.type !== 'TSNonNullExpression' &&
      parent.type !== 'TSAsExpression' &&
      parent.type !== 'TSSatisfiesExpression' &&
      parent.type !== 'TSTypeAssertion' &&
      parent.type !== 'TSInstantiationExpression'
    ) {
      return false;
    }
    current = parent;
    parent = isNode(current.parent) ? current.parent : null;
    depth += 1;
  }
  return false;
}

/** `this.cause = …` / `error.cause = …` — a write to an explicit cause field, not a chain walk. */
function isAssignmentTarget(node: AnyNode): boolean {
  const parent = isNode(node.parent) ? node.parent : null;
  if (parent === null) return false;
  return (
    (parent.type === 'AssignmentExpression' && parent.left === node) ||
    (parent.type === 'UpdateExpression' && parent.argument === node)
  );
}

/** Positions where a string literal is real runtime data rather than a key, type or module specifier. */
function isExpressionContext(node: AnyNode): boolean {
  const parent = isNode(node.parent) ? node.parent : null;
  if (parent === null) return false;
  switch (parent.type) {
    case 'ImportDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
    case 'ImportExpression':
    case 'ImportAttribute':
    case 'TSLiteralType':
    case 'TSModuleDeclaration':
    case 'TSImportType':
    case 'TSEnumMember':
    case 'TSPropertySignature':
    case 'TSAbstractMethodDefinition':
    case 'JSXAttribute':
    case 'Directive':
      return false;
    case 'Property':
    case 'PropertyDefinition':
    case 'MethodDefinition':
    case 'AccessorProperty':
      return (
        (parent.type === 'Property' &&
          isNode(parent.parent) &&
          parent.parent.type === 'ObjectExpression') ||
        parent.key !== node
      );
    case 'ExpressionStatement':
      // A bare string statement is a directive prologue, not an inspection.
      return false;
    case 'MemberExpression':
      // `x["23505"]` reads a field named after the code; still an inspection of driver data.
      return parent.computed === true;
    default:
      return true;
  }
}

/**
 * Spec positions for a SQLSTATE literal when `sqlStateAnywhere` is disabled: a comparison operand, a
 * membership-probe argument, or an element of an array / `new Set([...])`.
 */
function isCodeComparisonPosition(node: AnyNode): boolean {
  const parent = isNode(node.parent) ? node.parent : null;
  if (parent === null) return false;
  if (parent.type === 'BinaryExpression') {
    return typeof parent.operator === 'string' && EQUALITY_OPERATORS.has(parent.operator);
  }
  if (parent.type === 'SwitchCase' && parent.test === node) return true;
  if (parent.type === 'ArrayExpression') return true;
  if (parent.type === 'CallExpression') {
    const args = Array.isArray(parent.arguments) ? parent.arguments : [];
    if (!args.includes(node)) return false;
    const callee = unwrap(parent.callee);
    if (callee === null || callee.type !== 'MemberExpression') return false;
    const method = memberPropertyName(callee);
    return method !== null && MEMBERSHIP_METHODS.has(method);
  }
  return false;
}

/**
 * `'detail' in error`, `'table' in row.cause` → the narrowed subject reads like a failure value;
 * `'detail' in event` (a DOM `CustomEvent`) does not. Only consulted for `ambiguousKeys`.
 */
function operandLooksLikeFailure(node: unknown, pattern: RegExp): boolean {
  const target = unwrap(node);
  if (target === null) return false;
  if (target.type === 'Identifier')
    return typeof target.name === 'string' && pattern.test(target.name);
  if (target.type === 'MemberExpression') {
    const property = memberPropertyName(target);
    if (property !== null && pattern.test(property)) return true;
    return operandLooksLikeFailure(target.object, pattern);
  }
  return false;
}

function excerpt(context: Context, node: ESTree.Node): string {
  const text = context.sourceCode.getText(node).replace(/\s+/gu, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
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

function staticString(input: unknown): string | null {
  const node = unwrap(input);
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (
    node?.type === 'TemplateLiteral' &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0
  )
    return (node.quasis as { value: { cooked: string } }[])[0]?.value.cooked ?? null;
  return null;
}

function unshadowedGlobal(context: Context, input: unknown, name: string): boolean {
  const node = unwrap(input);
  if (node?.type !== 'Identifier' || node.name !== name) return false;
  let scope: ReturnType<Context['sourceCode']['getScope']> | null = context.sourceCode.getScope(
    node as unknown as ESTree.Node,
  );
  while (scope) {
    if (
      scope.set
        .get(name)
        ?.defs.some(
          (def) => !['TSInterfaceDeclaration', 'TSTypeAliasDeclaration'].includes(def.node.type),
        )
    )
      return false;
    scope = scope.upper;
  }
  return true;
}

function constValue(context: Context, input: unknown, depth = 0): AnyNode | null {
  const node = unwrap(input);
  if (!node || node.type !== 'Identifier' || depth > 24) return node;
  let scope: ReturnType<Context['sourceCode']['getScope']> | null = context.sourceCode.getScope(
    node as unknown as ESTree.Node,
  );
  while (scope) {
    const variable = scope.set.get(String(node.name));
    if (!variable) {
      scope = scope.upper;
      continue;
    }
    if (variable.defs.length !== 1 || variable.references.some((r) => r.isWrite() && !r.init))
      return node;
    const declaration = variable.defs[0]?.node;
    if (
      declaration?.type !== 'VariableDeclarator' ||
      declaration.parent?.type !== 'VariableDeclaration' ||
      declaration.parent.kind !== 'const'
    )
      return node;
    return constValue(context, declaration.init, depth + 1);
  }
  return node;
}

// Two-digit strings are also months/hours. Require a code-shaped receiver (including
// immutable local aliases), rather than treating native string/array operations as driver proof.
function codePrefixSubject(context: Context, input: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  const node = constValue(context, input);
  if (!node) return false;
  if (node.type === 'Identifier') return /(?:code|sqlstate)$/iu.test(String(node.name));
  if (node.type === 'MemberExpression')
    return /(?:code|sqlstate)$/iu.test(memberPropertyName(node) ?? '');
  if (node.type === 'CallExpression' && unshadowedGlobal(context, node.callee, 'String')) {
    return codePrefixSubject(context, (node.arguments as unknown[])[0], depth + 1);
  }
  if (node.type === 'ConditionalExpression')
    return (
      codePrefixSubject(context, node.consequent, depth + 1) ||
      codePrefixSubject(context, node.alternate, depth + 1)
    );
  if (node.type === 'LogicalExpression')
    return (
      codePrefixSubject(context, node.left, depth + 1) ||
      codePrefixSubject(context, node.right, depth + 1)
    );
  return false;
}

// `code` is also a first-party domain/transport field. Require independent driver evidence
// in the enclosing function (not an unrelated sibling function or an identifier spelling).
function hasDriverEvidence(input: AnyNode, options: RuleOptions): boolean {
  let region = input;
  while (
    isNode(region.parent) &&
    !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'Program'].includes(
      region.type,
    )
  )
    region = region.parent;
  const walk = (node: AnyNode): boolean => {
    if (
      node !== region &&
      ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
    )
      return false;
    const text = staticString(node);
    if (
      text !== null &&
      (options.sqlStatePattern.test(text) ||
        options.networkCodes.has(text) ||
        ['cause', 'constraint', 'sqlState', 'errno', 'syscall'].includes(text))
    )
      return true;
    if (
      node.type === 'MemberExpression' &&
      ['cause', 'constraint', 'sqlState', 'errno', 'syscall'].includes(
        memberPropertyName(node) ?? '',
      )
    )
      return true;
    const regex = node.regex as { pattern?: string } | undefined;
    if (regex?.pattern && SQLSTATE_REGEX_PATTERNS.some((probe) => probe.test(regex.pattern!)))
      return true;
    for (const [key, value] of Object.entries(node)) {
      if (['parent', 'loc', 'range', 'tokens', 'comments'].includes(key)) continue;
      if (isNode(value) && walk(value)) return true;
      if (Array.isArray(value) && value.some((entry) => isNode(entry) && walk(entry))) return true;
    }
    return false;
  };
  return walk(region);
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A5 (with A4): no ad hoc driver failure inspection. Four independent PostgreSQL ' +
        'cause-chain/SQLSTATE walkers (`apps/shell-super-app/api/auth/service.ts`, ' +
        '`packages/core-runtime/src/auth/principal-management.ts`, ' +
        '`verticals/contacts/src/services/customer-contact-persistence.service.ts`, ' +
        "`packages/core-runtime/src/actions/runtime.ts`) each re-invent `'code' in error`, unknown " +
        '`.cause` chain walking, SQLSTATE class regexes and private socket-code sets. Decode driver ' +
        'failures once through the Core-owned database failure decoder into a typed taxonomy. This lexical heuristic uses code shapes, code/Exit naming conventions and local driver evidence, not type provenance; domain values with identical names/shapes may still report, while dynamic keys and arbitrary dataflow remain unknown.',
    },
    messages: {
      inNarrowing:
        'Ad hoc driver failure inspection (`{{text}}`): `in` narrowing of an unknown failure on the ' +
        'driver key `{{key}}`. Decode PostgreSQL/driver failures once through the Core-owned database ' +
        'failure decoder (`Schema.TaggedError` taxonomy for SQLSTATE, constraints, connectivity, ' +
        'deadlock, serialization and scope/RLS) and match on `_tag` with `Effect.catchTag(s)`/`Match`.',
      causeWalk:
        'Ad hoc driver failure inspection (`{{text}}`): walking an unknown `.cause` chain. Convert the ' +
        'driver failure once at the persistence edge (`Effect.tryPromise` inside the Core database ' +
        'service) into the typed database failure taxonomy, and keep unexpected defects in `Cause` ' +
        "until the outer HTTP seam. `Cause.*`/`Exit.*` reads of an `Exit`'s own cause are fine.",
      sqlStateLiteral:
        'Ad hoc driver failure inspection (`{{text}}`): a raw PostgreSQL SQLSTATE literal. Map SQLSTATE ' +
        'to a tag once in the Core-owned database failure decoder (e.g. `23505` → ' +
        "`DatabaseUniqueViolation`) and match the tag — `Effect.catchTag('DatabaseUniqueViolation', …)` " +
        '— instead of comparing driver codes at the call site.',
      networkCode:
        'Ad hoc driver failure inspection (`{{text}}`): a raw driver/socket error code. Classify ' +
        'connectivity failures once in the Core-owned database failure decoder (e.g. ' +
        '`DatabaseUnavailable`) and drive retries from the typed reason with `Effect.retry`/`Schedule`.',
      sqlStateRegex:
        'Ad hoc driver failure inspection (`{{text}}`): a SQLSTATE class regex. The SQLSTATE class table ' +
        'belongs in the Core-owned database failure decoder, which returns a `Schema.TaggedError` from ' +
        'the shared taxonomy; call sites should match tags, not re-derive classes.',
      codePrefix:
        'Ad hoc driver failure inspection (`{{text}}`): a SQLSTATE class prefix test. Fold the class ' +
        'prefix into the Core-owned database failure decoder and expose a typed reason ' +
        '(connectivity/deadlock/serialization/…) that callers match with `Effect.catchTag(s)`/`Match`.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          includeTests: { type: 'boolean' },
          decoderPaths: { type: 'array', items: { type: 'string' } },
          narrowedKeys: { type: 'array', items: { type: 'string' } },
          ambiguousKeys: { type: 'array', items: { type: 'string' } },
          failureOperandPattern: { type: 'string' },
          networkCodes: { type: 'array', items: { type: 'string' } },
          causeSinks: { type: 'array', items: { type: 'string' } },
          sqlStatePattern: { type: 'string' },
          sqlStateAnywhere: { type: 'boolean' },
          exitNamePattern: { type: 'string' },
          prefixMethods: { type: 'array', items: { type: 'string' } },
          detectCauseWalk: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: DEFAULT_INCLUDE,
        ignore: DEFAULT_IGNORE,
        includeTests: false,
        decoderPaths: [],
        narrowedKeys: DEFAULT_NARROWED_KEYS,
        ambiguousKeys: DEFAULT_AMBIGUOUS_KEYS,
        failureOperandPattern: DEFAULT_FAILURE_OPERAND_PATTERN,
        networkCodes: DEFAULT_NETWORK_CODES,
        causeSinks: DEFAULT_CAUSE_SINKS,
        sqlStatePattern: DEFAULT_SQLSTATE_PATTERN,
        sqlStateAnywhere: true,
        exitNamePattern: DEFAULT_EXIT_NAME_PATTERN,
        prefixMethods: DEFAULT_PREFIX_METHODS,
        detectCauseWalk: true,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.include)) return {};
    if (matchesGlobs(path, options.ignore)) return {};
    if (matchesGlobs(path, options.decoderPaths)) return {};
    if (!options.includeTests && isTestFile(path)) return {};
    if (isScriptFile(path)) return {};

    let bindings: EffectBindings = { importsEffect: false, namespaces: new Map() };

    const reportNode = (
      node: ESTree.Node,
      messageId: string,
      data: Record<string, string>,
    ): void => {
      context.report({ node, messageId, data: { text: excerpt(context, node), ...data } });
    };

    const narrowing = (node: ESTree.Node, subject: unknown, key: string | null): void => {
      if (key === null || !options.narrowedKeys.has(key)) return;
      if (key === 'code' && !hasDriverEvidence(node as unknown as AnyNode, options)) return;
      if (
        options.ambiguousKeys.has(key) &&
        !operandLooksLikeFailure(subject, options.failureOperandPattern)
      )
        return;
      reportNode(node, 'inNarrowing', { key });
    };
    const literal = (node: ESTree.Node): void => {
      const raw = node as unknown as AnyNode;
      const regex = raw.regex as { pattern?: string } | undefined;
      if (regex?.pattern) {
        if (SQLSTATE_REGEX_PATTERNS.some((probe) => probe.test(regex.pattern!)))
          reportNode(node, 'sqlStateRegex', {});
        return;
      }
      const text = staticString(raw);
      if (text === null || !isExpressionContext(raw)) return;
      if (options.networkCodes.has(text)) {
        reportNode(node, 'networkCode', {});
        return;
      }
      if (
        options.sqlStatePattern.test(text) &&
        (options.sqlStateAnywhere || isCodeComparisonPosition(raw))
      )
        reportNode(node, 'sqlStateLiteral', {});
    };
    const runtimeRegex = (node: ESTree.CallExpression | ESTree.NewExpression): void => {
      if (!unshadowedGlobal(context, node.callee, 'RegExp')) return;
      const text = staticString(node.arguments[0]);
      if (text !== null && SQLSTATE_REGEX_PATTERNS.some((probe) => probe.test(text)))
        reportNode(node, 'sqlStateRegex', {});
    };
    return {
      Program(program) {
        bindings = collectEffectBindings(program);
      },
      BinaryExpression(node) {
        if (node.operator === 'in') {
          narrowing(node, node.right, staticString(node.left));
          return;
        }
        if (!EQUALITY_OPERATORS.has(node.operator)) return;
        for (const [value, other] of [
          [node.left, node.right],
          [node.right, node.left],
        ]) {
          const text = staticString(value);
          const call = unwrap(other);
          if (text === null || !TWO_DIGIT.test(text) || call?.type !== 'CallExpression') continue;
          const callee = unwrap(call.callee);
          const args = call.arguments as unknown[];
          if (
            callee?.type === 'MemberExpression' &&
            codePrefixSubject(context, callee.object) &&
            ['slice', 'substring', 'substr'].includes(memberPropertyName(callee) ?? '') &&
            unwrap(args[0])?.value === 0 &&
            unwrap(args[1])?.value === 2
          ) {
            reportNode(node, 'codePrefix', {});
            return;
          }
        }
      },
      MemberExpression(node) {
        if (!options.detectCauseWalk) return;
        const raw = node as unknown as AnyNode;
        if (!causeMemberKey(raw, CAUSE_KEY)) return;
        const object = unwrap(raw.object);
        if (
          !object ||
          object.type === 'ThisExpression' ||
          object.type === 'Super' ||
          isAssignmentTarget(raw)
        )
          return;
        if (
          objectLooksLikeExit(raw.object, options.exitNamePattern) ||
          insideCauseSink(context, raw, bindings, options.causeSinks)
        )
          return;
        reportNode(node, 'causeWalk', {});
      },
      VariableDeclarator(node) {
        if (
          !options.detectCauseWalk ||
          node.id.type !== 'ObjectPattern' ||
          !node.init ||
          objectLooksLikeExit(node.init, options.exitNamePattern)
        )
          return;
        const value = unwrap(node.init);
        if (value?.type === 'ThisExpression' || value?.type === 'Super') return;
        for (const property of node.id.properties) {
          if (property.type !== 'Property') continue;
          const key =
            !property.computed && property.key.type === 'Identifier'
              ? property.key.name
              : staticString(property.key);
          if (key === 'cause') reportNode(property, 'causeWalk', {});
        }
      },
      Literal: literal,
      TemplateLiteral: literal,
      NewExpression: runtimeRegex,
      CallExpression(node) {
        runtimeRegex(node);
        const raw = node as unknown as AnyNode;
        const callee = unwrap(raw.callee);
        if (callee?.type !== 'MemberExpression') return;
        const method = memberPropertyName(callee);
        const args = node.arguments;
        if (
          (method === 'hasOwn' && unshadowedGlobal(context, callee.object, 'Object')) ||
          (method === 'has' && unshadowedGlobal(context, callee.object, 'Reflect'))
        )
          narrowing(node, args[0], staticString(args[1]));
        if (method === 'call') {
          const own = unwrap(callee.object);
          const prototype = own?.type === 'MemberExpression' ? unwrap(own.object) : null;
          if (
            own?.type === 'MemberExpression' &&
            memberPropertyName(own) === 'hasOwnProperty' &&
            prototype?.type === 'MemberExpression' &&
            memberPropertyName(prototype) === 'prototype' &&
            unshadowedGlobal(context, prototype.object, 'Object')
          )
            narrowing(node, args[0], staticString(args[1]));
        }
        if (
          !method ||
          !options.prefixMethods.has(method) ||
          !codePrefixSubject(context, callee.object)
        )
          return;
        const text = staticString(args[0]);
        if (text !== null && TWO_DIGIT.test(text)) {
          reportNode(node, 'codePrefix', {});
          return;
        }
        // Hoisted class arrays only when the callback's actual parameter supplies the prefix.
        const first = unwrap(args[0]);
        if (first?.type !== 'Identifier') return;
        let scope: ReturnType<Context['sourceCode']['getScope']> | null =
          context.sourceCode.getScope(first as unknown as ESTree.Node);
        while (scope) {
          const variable = scope.set.get(String(first.name));
          if (!variable) {
            scope = scope.upper;
            continue;
          }
          const def = variable.defs[0];
          const fn = def?.node;
          if (
            def?.type !== 'Parameter' ||
            !fn ||
            (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') ||
            fn.params[0]?.type !== 'Identifier' ||
            fn.params[0].name !== first.name ||
            variable.references.some((r) => r.isWrite() && !r.init)
          )
            return;
          const parent = fn.parent;
          if (parent?.type !== 'CallExpression' || parent.arguments[0] !== fn) return;
          const owner = unwrap(parent.callee);
          if (
            owner?.type !== 'MemberExpression' ||
            !['some', 'every', 'find', 'filter'].includes(memberPropertyName(owner) ?? '')
          )
            return;
          const list = constValue(context, owner.object);
          if (
            list?.type === 'ArrayExpression' &&
            Array.isArray(list.elements) &&
            list.elements.length > 0 &&
            list.elements.every((entry) => {
              const value = staticString(entry);
              return value !== null && TWO_DIGIT.test(value);
            })
          )
            reportNode(node, 'codePrefix', {});
          return;
        }
      },
    };
  },
});
