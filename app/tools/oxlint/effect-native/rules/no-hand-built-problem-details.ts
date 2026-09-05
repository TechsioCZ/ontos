/**
 * effect-native/no-hand-built-problem-details
 *
 * Audit findings: **A4** ("Rebuild the error system around typed channels and contract-owned Problem
 * Details" — "Problem Details literals duplicated from endpoint schemas", "raw statuses duplicated in
 * object constructors", "Declare public errors once on the HttpApi endpoint. Derive RFC 9457 payloads
 * and HTTP status from that contract") and **A5** ("Introduce an Effect-shaped persistence seam and
 * typed database failures" — "Never expose raw driver messages in public Problem Details") of
 * `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`.
 *
 * `apps/shell-super-app/api/index.ts`, `verticals/contacts/api/index.ts` and the five generated
 * `verticals/contacts/api/*-read-server.ts` BFFs each re-declare the RFC 9457 payload by hand:
 *
 * ```ts
 * unavailable: (): ContactsProblem => ({
 *   _tag: 'ContactsUnavailableProblem',
 *   detail: 'The Contacts operation is temporarily unavailable.',
 *   retryable: true,
 *   status: 503,                                   // ← duplicated from HttpApiSchema.status(503)
 *   title: 'Contacts unavailable',
 *   type: 'https://ontos.dev/problems/contacts-unavailable',
 * });
 * ```
 *
 * The very same `_tag`, `status`, `title` and `type` already exist on the endpoint contract
 * (`Schema.TaggedStruct(...).pipe(asProblemDetails, HttpApiSchema.status(503))` in
 * `apps/shell-super-app/shared/api.ts`). Every literal is a second authority that can drift from the
 * declared status, and each `problem.*` factory is exactly the "per-endpoint error factory" A4 asks
 * to remove.
 *
 * ## What this detects
 *
 * 1. `handBuiltProblem` — an `ObjectExpression` with a non-computed `status` property whose value is
 *    a numeric literal inside `statusRange` (`401`, `503 as const`, `(500)`), when the same object
 *    also carries at least one RFC 9457 corroborator: a `type` string/template literal, a `_tag`
 *    string literal ending in `Problem`, a `title` property, or a `retryable` property. The `status`
 *    property is reported.
 * 2. `handBuiltProblemTag` — a problem-shaped literal whose `_tag` ends in `Problem` and that carries
 *    `title` / `type` / `detail`, but whose status is absent or non-literal. The `_tag` property is
 *    reported. (`reportTagOnlyLiterals`, default on.)
 * 3. `rawDriverMessage` — inside any problem-shaped literal, a `detail` / `title` / `reason` /
 *    `message` value that leaks a raw driver message: `error.message`, `cause?.stack`,
 *    `String(defect)`, `` `Query failed: ${dbError.message}` ``, `error.message ?? 'unknown'`, or the
 *    same through `+` / ternaries. The offending property is reported. Identifier roots are matched
 *    with `errorIdentifierPattern`, so `error`, `cause`, `dbError`, `rootCause`, `parseFailure` all
 *    count. This is A5's "Never expose raw driver messages in public Problem Details".
 *
 * Aliases and namespace imports are honoured through `shared/effect-imports.ts`, so
 * `import { Schema as S } from 'effect'` / `import * as Schema from 'effect/Schema'` behave like the
 * plain names.
 *
 * ## What is deliberately allowed
 *
 * - Anything the audit's "Existing patterns to preserve" section blesses. Schema-owned declarations
 *   never report: the object is exempt whenever it is an argument of a `Schema.*` / `HttpApiSchema.*`
 *   call (or a `…Schema(...)` call) — `Schema.Struct({ status: Schema.Finite })`,
 *   `Schema.TaggedError<E>()('E', { … }, HttpApiSchema.annotations({ status: 503 }))`,
 *   `HttpApiSchema.status(503)`. The walk stops at function boundaries, so a hand-built literal
 *   returned from a callback passed to a Schema combinator still reports.
 * - Transport status codes with no Problem Details shape: `HttpServerResponse.empty({ status: 204 })`,
 *   `new Response(body, { status: 200, headers })`, `{ status: 302 }`, `{ status: 200, contentType }`.
 *   A bare status is not a duplicated contract; only status **plus** an RFC 9457 field is.
 * - Tests (D tier: "Deliberately malformed casts in tests proving rejection behavior" and
 *   `JSON.stringify` inside external test fixture APIs) unless `includeTests` is set, and `scripts/**`,
 *   `dist/`, `tools/` and `*.d.ts` which are outside `include`.
 * - JSX attribute values (`<StatusCard problem={{ status: 503, title: … }} />`): UI props are not the
 *   wire contract.
 * - Type-level declarations (`interface Problem { status: 503 }`) — those are `TSPropertySignature`
 *   nodes owned by `effect-native/no-hand-rolled-tagged-union`, not this rule.
 *
 * Report-only: no fixer, no suggestion. The existing violations are the intended output.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree } from '@oxlint/plugins';

import { collectEffectBindings } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isScriptFile, isTestFile, normalisePath } from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production `include` defaults instead of
 * forcing the fixture config to pass loosened options (which `run-on-repo.mts` reuses).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE: readonly string[] = ['apps/**', 'verticals/**', 'packages/**'];

const DEFAULT_IGNORE: readonly string[] = [
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  '**/*.d.ts',
  '**/*.gen.ts',
];

const DEFAULT_ALLOW_PATHS: readonly string[] = [];

const DEFAULT_STATUS_RANGE: readonly [number, number] = [100, 599];

/**
 * Namespaces whose calls own a Schema declaration rather than a value. An object literal handed to
 * one of these is the contract itself (`HttpApiSchema.annotations({ status: 503 })`), never a
 * hand-built payload.
 */
const DEFAULT_SCHEMA_NAMESPACES: readonly string[] = [
  'Schema',
  'HttpApiSchema',
  'HttpApiEndpoint',
  'HttpApiGroup',
  'OpenApi',
  'S',
];

/** `_tag: 'ContactsUnavailableProblem'` — the suffix that marks an RFC 9457 payload tag. */
const DEFAULT_TAG_SUFFIXES: readonly string[] = ['Problem'];

/** Identifier roots that carry a driver failure: `error`, `dbError`, `cause`, `rootCause`, … */
const DEFAULT_ERROR_IDENTIFIER_PATTERN = '^[A-Za-z_$]*(?:error|cause|defect|failure|exception)$';

/** Property values that end up in the public Problem Details body as prose. */
const DEFAULT_MESSAGE_KEYS: readonly string[] = ['detail', 'title', 'reason', 'message'];

/** Depth guard for the ancestor walk; real nesting never approaches this. */
const MAX_ANCESTOR_DEPTH = 64;

/** Depth guard for the raw-message expression walk. */
const MAX_EXPRESSION_DEPTH = 12;

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly includeTests: boolean;
  readonly allowPaths: readonly string[];
  readonly statusRange: readonly [number, number];
  readonly schemaNamespaces: readonly string[];
  readonly tagSuffixes: readonly string[];
  readonly messageKeys: readonly string[];
  readonly errorIdentifier: RegExp;
  readonly reportTagOnlyLiterals: boolean;
  readonly reportRawDriverMessages: boolean;
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function statusRange(
  value: unknown,
  fallback: readonly [number, number],
): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return fallback;
  const [low, high] = value;
  if (typeof low !== 'number' || typeof high !== 'number') return fallback;
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) return fallback;
  return [low, high];
}

function errorPattern(value: unknown): RegExp {
  if (typeof value !== 'string' || value.length === 0)
    return new RegExp(DEFAULT_ERROR_IDENTIFIER_PATTERN, 'iu');
  try {
    return new RegExp(value, 'iu');
  } catch {
    return new RegExp(DEFAULT_ERROR_IDENTIFIER_PATTERN, 'iu');
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
    allowPaths: stringArray(record.allowPaths, DEFAULT_ALLOW_PATHS),
    statusRange: statusRange(record.statusRange, DEFAULT_STATUS_RANGE),
    schemaNamespaces: stringArray(record.schemaNamespaces, DEFAULT_SCHEMA_NAMESPACES),
    tagSuffixes: stringArray(record.tagSuffixes, DEFAULT_TAG_SUFFIXES),
    messageKeys: stringArray(record.messageKeys, DEFAULT_MESSAGE_KEYS),
    errorIdentifier: errorPattern(record.errorIdentifierPattern),
    reportTagOnlyLiterals: record.reportTagOnlyLiterals !== false,
    reportRawDriverMessages: record.reportRawDriverMessages !== false,
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Strip `as const`, `satisfies`, `!`, `<T>x` and parentheses so the underlying literal is visible. */
function unwrap(node: ESTree.Node): ESTree.Node {
  let current: ESTree.Node = node;
  for (let depth = 0; depth < MAX_EXPRESSION_DEPTH; depth += 1) {
    if (
      current.type === 'ParenthesizedExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSInstantiationExpression' ||
      current.type === 'ChainExpression'
    ) {
      const inner: ESTree.Node | undefined = (current as { expression?: ESTree.Node }).expression;
      if (inner === undefined) return current;
      current = inner;
      continue;
    }
    return current;
  }
  return current;
}

/** Static name of a non-computed object-literal property key (`status`, `'status'`). */
function propertyName(node: ESTree.Node): string | null {
  if (node.type !== 'Property') return null;
  const key = node.key;
  if (!node.computed && key.type === 'Identifier') return key.name;
  return stringLiteralValue(unwrap(key));
}

/** Index the non-computed properties of an object literal by key name (first occurrence wins). */
function indexProperties(node: ESTree.ObjectExpression): Map<string, ESTree.Node> {
  const properties = new Map<string, ESTree.Node>();
  for (const property of node.properties) {
    const name = propertyName(property);
    if (name === null || properties.has(name)) continue;
    properties.set(name, property);
  }
  return properties;
}

function propertyValue(node: ESTree.Node): ESTree.Node | null {
  if (node.type !== 'Property') return null;
  return unwrap(node.value);
}

function stringLiteralValue(node: ESTree.Node | null): string | null {
  if (node === null) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('');
  }
  return null;
}

/** `type: 'https://…'` or `` type: `${base}/problems/x` `` — either shape is a URI reference. */
function isUriLike(node: ESTree.Node | null): boolean {
  if (node === null) return false;
  const text = stringLiteralValue(node);
  if (text !== null) return /^(?:https?:\/\/|urn:|about:blank$|\/|#)/u.test(text);
  return (
    node.type === 'TemplateLiteral' &&
    node.quasis.some((quasi) => /(?:problems?\/|https?:\/\/)/u.test(quasi.value.raw))
  );
}

function integerLiteral(node: ESTree.Node | null): number | null {
  if (node === null) return null;
  if (node.type === 'Literal' && typeof node.value === 'number' && Number.isInteger(node.value))
    return node.value;
  return null;
}

function endsWithAny(value: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => suffix.length > 0 && value.endsWith(suffix));
}

/** `Schema.Struct`, `HttpApiSchema.annotations`, `S.TaggedStruct`, `ContactsResponseSchema` … */
function isSchemaCallee(context: Context, callee: ESTree.Node, options: RuleOptions): boolean {
  let target = unwrap(callee);
  for (let depth = 0; depth < MAX_EXPRESSION_DEPTH && target.type === 'CallExpression'; depth += 1)
    target = unwrap(target.callee);
  const origin = effectOrigin(context, target, ['@modern-js/plugin-bff/effect-edge']);
  return origin !== null && origin.length >= 2 && options.schemaNamespaces.includes(origin[0]!);
}

/**
 * `true` when the literal belongs to a Schema declaration or a JSX attribute rather than to a
 * hand-built wire payload. The walk stops at function/class/program boundaries so that a literal
 * *returned from a callback* passed to a Schema combinator is still reported.
 */
function isExemptContext(
  context: Context,
  node: ESTree.ObjectExpression,
  options: RuleOptions,
  bindings: EffectBindings,
): boolean {
  let previous: ESTree.Node = node;
  let current: ESTree.Node | null | undefined = node.parent;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    if (current === null || current === undefined) return false;
    switch (current.type) {
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
      case 'FunctionDeclaration':
      case 'ClassBody':
      case 'Program':
      case 'BlockStatement':
        return false;
      case 'JSXAttribute':
      case 'JSXSpreadAttribute':
        return true;
      case 'CallExpression':
      case 'NewExpression': {
        const isArgument = current.arguments.some((argument) => Object.is(argument, previous));
        if (isArgument && isSchemaCallee(context, current.callee, options)) return true;
        break;
      }
      default:
        break;
    }
    previous = current;
    current = current.parent;
  }
  return false;
}

/** Leftmost identifier of a member chain: `error.cause.message` → `error`. */
function rootIdentifier(node: ESTree.Node): string | null {
  let current: ESTree.Node = unwrap(node);
  for (let depth = 0; depth < MAX_EXPRESSION_DEPTH; depth += 1) {
    if (current.type === 'Identifier') return current.name;
    if (current.type === 'MemberExpression') {
      current = unwrap(current.object);
      continue;
    }
    if (current.type === 'CallExpression') {
      current = unwrap(current.callee);
      continue;
    }
    return null;
  }
  return null;
}

function memberPropertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const key = unwrap(node.property);
  return stringLiteralValue(key);
}

/** `error`, `dbError`, `cause` … — an identifier that names a failure value. */
function isErrorIdentifier(node: ESTree.Node, options: RuleOptions): boolean {
  const target = unwrap(node);
  return target.type === 'Identifier' && options.errorIdentifier.test(target.name);
}

/**
 * `true` when the expression surfaces a raw driver message: `error.message`, `cause?.stack`,
 * `String(defect)`, template interpolation, `+` concatenation, ternaries and `??` fallbacks.
 */
function leaksDriverMessage(node: ESTree.Node, options: RuleOptions, depth: number): boolean {
  if (depth > MAX_EXPRESSION_DEPTH) return false;
  const target = unwrap(node);
  switch (target.type) {
    case 'Identifier':
      return options.errorIdentifier.test(target.name);
    case 'MemberExpression': {
      const property = memberPropertyName(target);
      if (property !== 'message' && property !== 'stack' && property !== 'cause') return false;
      const root = rootIdentifier(target.object);
      return root !== null && options.errorIdentifier.test(root);
    }
    case 'CallExpression': {
      const callee = unwrap(target.callee);
      const isJsonStringify =
        callee.type === 'MemberExpression' &&
        memberPropertyName(callee) === 'stringify' &&
        unwrap(callee.object).type === 'Identifier' &&
        (unwrap(callee.object) as ESTree.IdentifierReference).name === 'JSON';
      const isStringify =
        isJsonStringify ||
        (callee.type === 'Identifier' && (callee.name === 'String' || callee.name === 'inspect')) ||
        (callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          (callee.property.name === 'toString' || callee.property.name === 'inspect'));
      if (!isStringify) return false;
      if (callee.type === 'MemberExpression' && !isJsonStringify)
        return leaksDriverMessage(callee.object, options, depth + 1);
      return target.arguments.some(
        (argument) =>
          argument.type !== 'SpreadElement' &&
          (isErrorIdentifier(argument, options) ||
            leaksDriverMessage(argument, options, depth + 1)),
      );
    }
    case 'TemplateLiteral':
      return target.expressions.some((expression) =>
        leaksDriverMessage(expression, options, depth + 1),
      );
    case 'BinaryExpression':
      if (target.operator !== '+') return false;
      return (
        leaksDriverMessage(target.left, options, depth + 1) ||
        leaksDriverMessage(target.right, options, depth + 1)
      );
    case 'LogicalExpression':
      return (
        leaksDriverMessage(target.left, options, depth + 1) ||
        leaksDriverMessage(target.right, options, depth + 1)
      );
    case 'ConditionalExpression':
      return (
        leaksDriverMessage(target.consequent, options, depth + 1) ||
        leaksDriverMessage(target.alternate, options, depth + 1)
      );
    default:
      return false;
  }
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

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A4 + A5: RFC 9457 Problem Details must be declared once on the HttpApi endpoint contract. ' +
        "A hand-authored `{ _tag: 'XProblem', status: 503, title, type, retryable }` literal duplicates " +
        'the Schema.TaggedError/TaggedStruct + HttpApiSchema.status declaration and can drift from it, and ' +
        'raw driver messages must never reach `detail`. This syntactic rule uses problem tags/URI-shaped type fields and error-identifier naming; it cannot prove driver provenance or sanitization through arbitrary functions.',
    },
    messages: {
      handBuiltProblem:
        'Hand-built Problem Details literal with raw status {{status}}{{tagged}}. Declare the problem once ' +
        'as Schema.TaggedError (or Schema.TaggedStruct) with HttpApiSchema.status({{status}}) on the endpoint ' +
        'contract and construct it via that class instead of re-typing `status`, `title` and `type` here; ' +
        'never interpolate raw driver messages into `detail`.',
      handBuiltProblemTag:
        'Hand-built Problem Details literal for `{{tag}}`. The RFC 9457 payload is already declared by the ' +
        'endpoint contract — build it with the Schema.TaggedError / Schema.TaggedStruct that carries ' +
        'HttpApiSchema.status, and let Effect derive the wire body, instead of re-declaring the shape here.',
      rawDriverMessage:
        '`{{key}}` interpolates a raw driver message into a Problem Details payload. Keep the original ' +
        'failure in `Cause` (or a typed Schema.TaggedError field) and let the single outer HTTP seam emit a ' +
        'sanitized, contract-owned problem; audit A5 requires that raw driver messages never reach the wire.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          includeTests: { type: 'boolean' },
          allowPaths: { type: 'array', items: { type: 'string' } },
          statusRange: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
          schemaNamespaces: { type: 'array', items: { type: 'string' } },
          tagSuffixes: { type: 'array', items: { type: 'string' } },
          messageKeys: { type: 'array', items: { type: 'string' } },
          errorIdentifierPattern: { type: 'string' },
          reportTagOnlyLiterals: { type: 'boolean' },
          reportRawDriverMessages: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: [...DEFAULT_INCLUDE],
        ignore: [...DEFAULT_IGNORE],
        includeTests: false,
        allowPaths: [...DEFAULT_ALLOW_PATHS],
        statusRange: [...DEFAULT_STATUS_RANGE],
        schemaNamespaces: [...DEFAULT_SCHEMA_NAMESPACES],
        tagSuffixes: [...DEFAULT_TAG_SUFFIXES],
        messageKeys: [...DEFAULT_MESSAGE_KEYS],
        errorIdentifierPattern: DEFAULT_ERROR_IDENTIFIER_PATTERN,
        reportTagOnlyLiterals: true,
        reportRawDriverMessages: true,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore)) return {};
    if (matchesGlobs(path, options.allowPaths)) return {};
    if (!matchesGlobs(path, options.include)) return {};
    if (!options.includeTests && isTestFile(path)) return {};
    if (isScriptFile(path)) return {};

    let bindings: EffectBindings = { namespaces: new Map<string, string>(), importsEffect: false };

    return {
      Program(node) {
        bindings = collectEffectBindings(node);
      },

      ObjectExpression(node) {
        if (node.properties.length === 0) return;
        const properties = indexProperties(node);
        const statusProperty = properties.get('status') ?? null;
        const status =
          statusProperty === null ? null : integerLiteral(propertyValue(statusProperty));
        const inRange =
          status !== null && status >= options.statusRange[0] && status <= options.statusRange[1];

        const tagProperty = properties.get('_tag') ?? null;
        const tag = tagProperty === null ? null : stringLiteralValue(propertyValue(tagProperty));
        const taggedProblem = tag !== null && endsWithAny(tag, options.tagSuffixes);

        const typeProperty = properties.get('type') ?? null;
        const hasProblemType = typeProperty !== null && isUriLike(propertyValue(typeProperty));
        const hasTitle = properties.has('title');
        const hasRetryable = properties.has('retryable');
        const hasDetail = properties.has('detail');

        const corroborated = taggedProblem || (hasProblemType && (hasTitle || hasDetail));
        const reportStatus = inRange && corroborated;
        const reportTag =
          !reportStatus &&
          options.reportTagOnlyLiterals &&
          taggedProblem &&
          (hasTitle || hasProblemType || hasDetail);
        // A problem payload for the raw-message check: either of the two report shapes, or the
        // RFC 9457 `title` + `type` pair without a tag.
        const problemShaped = reportStatus || reportTag || (hasTitle && hasProblemType);

        if (isExemptContext(context, node, options, bindings)) return;

        if (reportStatus && statusProperty !== null) {
          context.report({
            node: statusProperty,
            messageId: 'handBuiltProblem',
            data: { status: String(status), tagged: tag === null ? '' : ` for \`${tag}\`` },
          });
        } else if (reportTag && tagProperty !== null) {
          context.report({
            node: tagProperty,
            messageId: 'handBuiltProblemTag',
            data: { tag: tag ?? '' },
          });
        }

        if (!problemShaped || !options.reportRawDriverMessages) return;
        for (const key of options.messageKeys) {
          const property = properties.get(key);
          if (property === undefined) continue;
          const value = propertyValue(property);
          if (value === null || !leaksDriverMessage(value, options, 0)) continue;
          context.report({ node: property, messageId: 'rawDriverMessage', data: { key } });
        }
      },
    };
  },
});
