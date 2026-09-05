/**
 * effect-native/no-unredacted-secret-field
 *
 * Audit finding enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *   - **A3** "Replace ambient configuration with Config, ConfigProvider, and Redacted" —
 *     "Credentials, private keys, Bearer tokens, and passwords often remain ordinary strings."
 *     The A3 target says verbatim: "Represent key material and credentials using
 *     `Redacted`/`Schema.Redacted`."
 *
 * Concrete evidence this rule exists for (A3 evidence list, verified in this repository):
 *   - `packages/core-runtime/src/db/config.ts` — `readonly connectionString: string`
 *   - `packages/core-runtime/src/permissions/config.ts` — `readonly preSharedKey: string`
 *   - `apps/shell-super-app/api/auth/config.ts` — `readonly secret: string`
 *   - `apps/shell-super-app/shared/api.ts` — `secret: Schema.String.check(...)`,
 *     `password: Schema.String.check(...)` (the credential crosses the HttpApi contract as a
 *     loggable, `JSON.stringify`-able plain string)
 * At the time of writing the repository contains **zero** uses of `Redacted` anywhere, so every
 * credential-shaped value is one `Effect.log`, one error annotation or one `JSON.stringify` away
 * from being written to a log sink.
 *
 * ## What is detected
 *
 * A **name test** (`secretNames`, a case-insensitive regex anchored at the end of the identifier so
 * `apiKeyId` / `secretName` / `passwordPolicy` do not match) combined with a **shape test**:
 *
 *   1. `secretFieldType` — a `TSPropertySignature` (interface member, inline object type, type alias
 *      member) or a class `PropertyDefinition` / `AccessorProperty` whose type is string-shaped.
 *   2. `secretParameter` — a function/method/constructor parameter `Identifier` with a string-shaped
 *      annotation. Defaults (`AssignmentPattern`), rest parameters and TypeScript parameter
 *      properties are unwrapped first. Inline object-type parameters
 *      (`(input: { readonly apiKey: string })`) report through case 1 on the inner signature.
 *   3. `secretSchemaField` — an object property in a Schema field bag (`Schema.Struct`,
 *      `Schema.Class`, `Schema.TaggedClass`, `Schema.TaggedError`, an HttpApi payload, a shared
 *      `fields` object) whose value is a **string schema**: `Schema.String`, `NonEmptyString`,
 *      `Trim`/`Trimmed`, `NonEmptyTrimmedString`, `Base64`/`Base64Url`/`Hex`/`Char`, plus any
 *      `.check(...)` / `.pipe(...)` / `.annotate(...)` chain over one, `pipe(Schema.String, ...)`,
 *      and the absence/collection wrappers `optional`, `optionalKey`, `NullOr`, `NullishOr`,
 *      `UndefinedOr`, `Array`, `NonEmptyArray`, `mutable`, `withDecodingDefault*` around one.
 *   4. `secretConfigKey` — `Config.string("...")` / `Config.nonEmptyString("...")` (and the other
 *      plain string readers) whose literal key matches `secretConfigKeys`
 *      (`SECRET`, `PASSWORD`, `PRIVATE`, `PRESHARED`, `_TOKEN`, `API_KEY`, `CREDENTIAL`,
 *      `DATABASE_*URL`, `_DSN`).
 *
 * String-shaped means: `string`, `readonly string`/parenthesised variants, a union of `string` with
 * only `null`/`undefined` (`string | null`), and the ordered string collections `string[]`,
 * `readonly string[]`, `Array<string>`, `ReadonlyArray<string>` (a list of raw tokens is the same
 * leak, once per element).
 *
 * The `Schema` / `Config` / `pipe` bindings are resolved through the real import graph, so all of
 * these work: `import { Schema } from "effect"`, `import { Schema as S } from "effect"`,
 * `import * as Schema from "effect/Schema"`, `import * as Effect from "effect"` →
 * `Effect.Schema.String` / `Effect.Config.string`, computed access (`Schema["String"]`), optional
 * chaining, and the Modern.js BFF barrels that re-export `effect/Schema` verbatim (`reexportModules`
 * — how every `shared/api.ts` contract in this repository reaches `Schema`). A local shadow of the
 * namespace identifier is never reported. `.ts` and `.tsx` alike.
 *
 * ## What is deliberately allowed
 *
 *   - Anything already redacted: a `Redacted.Redacted<string>` / `Redacted<string>` annotation is not
 *     string-shaped, and structurally resolved Schema.Redacted/RedactedFromSelf constructors are not plain-string
 *     schemas. Annotation text containing the word Redacted does not grant an exemption. So is
 *     `Config.redacted("AUTH_SECRET")` — only the plain string readers are listed.
 *   - **Non-string shapes**: `credential: 'api_key' | 'session'` (literal union),
 *     `readonly credential: Credential` (type reference), `privateJwk: Ed25519PrivateJwk` (an
 *     already-modelled key type), a `Schema.Literals([...])` vocabulary. The rule only fires when the
 *     value really is an unstructured string. `Set`/`ReadonlySet`/`Map` collections are excluded on
 *     purpose: in this repository a `ReadonlySet<string>` named `apiKeys` is a set of API
 *     *contribution keys* (`packages/core-runtime/src/modules/shell-contribution.ts`), not a bag of
 *     credentials, and every real credential collection is an array or a single value.
 *   - **Public material**: names are matched at the end of the identifier, so `apiKeyId`,
 *     `secretRef`, `keyId`, `searchKey`, `providerKeyId` are untouched; and
 *     `Config.string('ONTOS_GATEWAY_PUBLIC_JWKS')` / `Config.string('ONTOS_GATEWAY_ISSUER')` — public
 *     verification material, not credentials — do not match `secretConfigKeys`.
 *   - **Tests** (`ignoreTestFiles: true` by default). The audit's D tier blesses test fixtures that
 *     hand-build credentials and deliberately malformed values; a `readonly connectionString: string`
 *     inside a vertical's `tests/support` directory is fixture plumbing, not a production leak.
 *   - Anything outside `includePaths`, and anything matched by `allowPaths` (empty by default — the
 *     audit wants these reported until each one is either redacted or explicitly ratified).
 *   - Nothing in the audit's "Existing patterns to preserve" list is touched: Drizzle JSONB /
 *     `Schema.Json` outbox payloads, HttpApi-driven bodies, structured `Effect.log*` annotations and
 *     the single outer `Effect.runPromise` seam are all invisible to this rule.
 *
 * Known limitation (accepted, report-only): without type information the rule cannot tell a
 * credential from a same-named non-secret (a `password` field of a *hashing* helper, say). External type aliases and arbitrary schema transforms are not inferred; bounded local const aliases
 * are supported. The name regex options and `allowPaths` are the lexical escape hatches. This rule never fixes and never
 * suggests.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the production `includePaths` defaults instead of
 * forcing the fixture config to loosen them (`run-on-repo.mts` reuses that config verbatim).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE_PATHS: readonly string[] = [
  'apps/**',
  'verticals/**',
  'packages/**',
  'scripts/**',
];
const DEFAULT_ALLOW_PATHS: readonly string[] = [];

/**
 * Barrels that re-export Effect namespaces verbatim (`export * as Schema from "effect/Schema"`), so
 * `Schema` imported from them *is* Effect's `Schema`. The Modern.js BFF client/edge barrels are how
 * every shared BFF contract in this repository reaches Schema.
 */
const DEFAULT_REEXPORT_MODULES: readonly string[] = [
  '@modern-js/plugin-bff/effect',
  '@modern-js/plugin-bff/effect-client',
  '@modern-js/plugin-bff/effect-client-runtime',
  '@modern-js/plugin-bff/effect-edge',
  '@modern-js/plugin-bff/effect-edge/*',
  '@modern-js/plugin-bff/effect-server',
];

/** Credential-shaped identifier names, matched case-insensitively and anchored at the end. */
const DEFAULT_SECRET_NAMES =
  '(^|[_-]|[a-z])(secret|password|passphrase|privateKey|privateJwk|preSharedKey|presharedkey|apiKey|accessToken|refreshToken|bearerToken|authorization|bearer|sessionToken|idToken|authToken|credential|credentials|signingKey|clientSecret|connectionString|databaseUrl)s?$';

/** Environment keys that name credential material rather than public configuration. */
const DEFAULT_SECRET_CONFIG_KEYS =
  '(SECRET|PASSWORD|PASSPHRASE|PRIVATE|PRESHARED|_TOKEN|API_KEY|CREDENTIAL|DATABASE_[A-Z_]*URL|_DSN)';

const EFFECT_ROOT_MODULE = 'effect';
const SCHEMA_NAMESPACE = 'Schema';
const CONFIG_NAMESPACE = 'Config';
const PIPE_EXPORT = 'pipe';

/** Type-reference containers whose single string argument is still a bag of raw strings. */
const STRING_CONTAINERS = new Set(['Array', 'ReadonlyArray']);

/** Schema constructors that decode to an unstructured `string`. */
const STRING_SCHEMAS = new Set([
  'Base64',
  'Base64Url',
  'Char',
  'Hex',
  'Lowercase',
  'NonEmptyString',
  'NonEmptyTrimmedString',
  'String',
  'Trim',
  'Trimmed',
  'Uppercase',
]);

/** Schema combinators that wrap another schema without changing "is the payload a string". */
const SCHEMA_WRAPPERS = new Set([
  'Array',
  'NonEmptyArray',
  'NullOr',
  'NullishOr',
  'UndefinedOr',
  'UniqueArray',
  'mutable',
  'optional',
  'optionalKey',
  'withConstructorDefault',
  'withDecodingDefault',
  'withDecodingDefaultKey',
]);

/** Fluent methods that refine/annotate a schema in place. */
const SCHEMA_CHAIN_METHODS = new Set(['annotate', 'annotateKey', 'brand', 'check', 'pipe']);

/** `Config` readers that hand back a plain, loggable string. */
const PLAIN_CONFIG_READERS = new Set(['nonEmptyString', 'string', 'url']);

/** Nodes that own `params` and therefore make a nested `Identifier` a parameter. */
const PARAMETER_OWNERS = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
  'TSCallSignatureDeclaration',
  'TSConstructSignatureDeclaration',
  'TSConstructorType',
  'TSDeclareFunction',
  'TSEmptyBodyFunctionExpression',
  'TSFunctionType',
  'TSMethodSignature',
]);

/** Wrappers between a parameter `Identifier` and the function that owns it. */
const PARAMETER_WRAPPERS = new Set(['AssignmentPattern', 'RestElement', 'TSParameterProperty']);

/** Expression wrappers that never change what an expression *is*. */
const UNWRAPPABLE = new Set([
  'ChainExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
]);

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly ignoreTestFiles: boolean;
  readonly includePaths: readonly string[];
  readonly reexportModules: readonly string[];
  readonly secretConfigKeys: RegExp;
  readonly secretNames: RegExp;
}

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  return value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : fallback;
}

function compile(value: unknown, fallback: string, flags: string): RegExp {
  const source = typeof value === 'string' && value.length > 0 ? value : fallback;
  try {
    return new RegExp(source, flags);
  } catch {
    return new RegExp(fallback, flags);
  }
}

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Record<string, unknown>;
  const includePaths = stringList(given.includePaths, DEFAULT_INCLUDE_PATHS);
  return {
    allowPaths: stringList(given.allowPaths, DEFAULT_ALLOW_PATHS),
    ignoreTestFiles: typeof given.ignoreTestFiles === 'boolean' ? given.ignoreTestFiles : true,
    includePaths: includePaths.length > 0 ? includePaths : DEFAULT_INCLUDE_PATHS,
    reexportModules: stringList(given.reexportModules, DEFAULT_REEXPORT_MODULES),
    secretConfigKeys: compile(given.secretConfigKeys, DEFAULT_SECRET_CONFIG_KEYS, 'u'),
    secretNames: compile(given.secretNames, DEFAULT_SECRET_NAMES, 'iu'),
  };
}

function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function parentOf(node: AnyNode): AnyNode | null {
  return (node as { parent?: AnyNode | null }).parent ?? null;
}

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  for (let guard = 0; guard < 16; guard += 1) {
    if (!UNWRAPPABLE.has(current.type)) return current;
    const inner = (current as { expression?: AnyNode }).expression;
    if (inner === undefined) return current;
    current = inner;
  }
  return current;
}

/** `.String` or `["String"]` → `"String"`; a dynamic key → `null`. */
function staticString(node: AnyNode): string | null {
  const value = unwrap(node);
  if (value.type === 'Literal' && typeof value.value === 'string') return value.value;
  if (value.type === 'TemplateLiteral' && value.expressions.length === 0)
    return value.quasis[0]?.value.cooked ?? null;
  return null;
}
function memberName(node: ESTree.MemberExpression): string | null {
  return keyName(node.property as AnyNode, node.computed);
}
/** Literal computed keys and private identifiers have the same credential-name semantics. */
function keyName(key: AnyNode, computed: boolean): string | null {
  if (!computed && (key.type === 'Identifier' || key.type === 'PrivateIdentifier')) return key.name;
  return staticString(key);
}

/** Last segment of a type name: `Redacted.Redacted` → `"Redacted"`. */
function typeNameOf(node: AnyNode): string | null {
  if (node.type === 'Identifier') return (node as { name: string }).name;
  if (node.type === 'TSQualifiedName') {
    const right = (node as { right?: AnyNode }).right;
    return right !== undefined && right.type === 'Identifier'
      ? (right as { name: string }).name
      : null;
  }
  return null;
}

function unwrapType(node: AnyNode): AnyNode {
  let current = node;
  for (let guard = 0; guard < 8; guard += 1) {
    if (current.type === 'TSParenthesizedType') {
      current = (current as { typeAnnotation: AnyNode }).typeAnnotation;
      continue;
    }
    if (
      current.type === 'TSTypeOperator' &&
      (current as { operator?: string }).operator === 'readonly'
    ) {
      current = (current as { typeAnnotation: AnyNode }).typeAnnotation;
      continue;
    }
    return current;
  }
  return current;
}

/** `string`, `string | null`, `readonly string[]`, `ReadonlySet<string>` — but never `Redacted<string>`. */
function isStringShaped(node: AnyNode, depth: number): boolean {
  if (depth > 6) return false;
  const type = unwrapType(node);
  if (type.type === 'TSStringKeyword') return true;
  if (type.type === 'TSLiteralType' && type.literal.type === 'TemplateLiteral')
    return type.literal.expressions.length > 0;
  if (type.type === 'TSTemplateLiteralType')
    return type.types.some((member) => isStringShaped(member, depth + 1));
  if (type.type === 'TSIntersectionType')
    return type.types.some((member) => isStringShaped(member, depth + 1));
  if (type.type === 'TSArrayType')
    return isStringShaped((type as { elementType: AnyNode }).elementType, depth + 1);
  if (type.type === 'TSUnionType') {
    let sawString = false;
    for (const member of (type as { types: readonly AnyNode[] }).types) {
      const inner = unwrapType(member);
      if (inner.type === 'TSNullKeyword' || inner.type === 'TSUndefinedKeyword') continue;
      if (
        inner.type === 'TSLiteralType' &&
        inner.literal.type === 'Literal' &&
        typeof inner.literal.value === 'string'
      )
        continue;
      if (!isStringShaped(inner, depth + 1)) return false;
      sawString = true;
    }
    return sawString;
  }
  if (type.type === 'TSTypeReference') {
    const name = typeNameOf((type as { typeName: AnyNode }).typeName);
    if (name === null || !STRING_CONTAINERS.has(name)) return false;
    const args =
      (type as { typeArguments?: { params?: readonly AnyNode[] } | null }).typeArguments?.params ??
      [];
    return args.length === 1 && args[0] !== undefined && isStringShaped(args[0], depth + 1);
  }
  return false;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A3: credential-shaped fields, parameters, Schema fields and Config keys declared as plain strings can leak through logs and serialization. Use Redacted, Schema.Redacted and Config.redacted. Syntax-only: credential names are heuristics; bounded local aliases and structural redaction are recognized, not arbitrary external types or schema transforms.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#a3-replace-ambient-configuration-with-config-configprovider-and-redacted',
    },
    messages: {
      secretConfigKey:
        "Audit A3: `Config.{{member}}('{{name}}')` reads credential material as a plain string, so the value can be logged, annotated or serialized anywhere it flows. Use `Config.redacted('{{name}}')` — it yields `Redacted<string>`, prints as `<redacted>`, and only `Redacted.value` at the single use site can unwrap it.",
      secretField:
        'Audit A3: the credential-shaped field `{{name}}` stores a plain string that can leak when read into logs, error payloads or JSON. Store it as `Redacted.Redacted<string>` (construct with `Redacted.make`, unwrap only at the boundary that needs it with `Redacted.value`). Private field visibility alone does not redact the value.',
      secretParameter:
        'Audit A3: the credential-shaped parameter `{{name}}` is a plain string, so every span attribute, log annotation and error message built from it can leak the credential. Take `Redacted.Redacted<string>` instead and call `Redacted.value` only at the single boundary that must see the raw value.',
      secretSchemaField:
        'Audit A3: the credential-shaped Schema field `{{name}}` decodes to a plain string, so the decoded contract value is loggable and `JSON.stringify`-able. Use `Schema.Redacted(Schema.String)` — the wire encoding stays a string while the decoded value becomes `Redacted<string>` that cannot be printed by accident.',
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
              'Globs allowed to keep plain-string credentials (default: none — the audit wants every site reported until it is redacted or ratified).',
          },
          ignoreTestFiles: {
            type: 'boolean',
            description:
              "Skip test files (default: true — the audit's D tier blesses hand-built credentials in fixtures).",
          },
          includePaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs the rule applies to (default: apps/**, verticals/**, packages/**, scripts/**).',
          },
          reexportModules: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Modules that re-export Effect namespaces verbatim (Modern.js BFF barrels).',
          },
          secretConfigKeys: {
            type: 'string',
            description: "Regex (case-sensitive) matched against `Config.string('KEY')` literals.",
          },
          secretNames: {
            type: 'string',
            description:
              'Regex (case-insensitive) matched against field/parameter/Schema-field names.',
          },
        },
      },
    ],
    defaultOptions: [
      {
        allowPaths: [...DEFAULT_ALLOW_PATHS],
        ignoreTestFiles: true,
        includePaths: [...DEFAULT_INCLUDE_PATHS],
        reexportModules: [...DEFAULT_REEXPORT_MODULES],
        secretConfigKeys: DEFAULT_SECRET_CONFIG_KEYS,
        secretNames: DEFAULT_SECRET_NAMES,
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.includePaths)) return {};
    if (matchesGlobs(path, options.allowPaths)) return {};
    if (options.ignoreTestFiles && isTestFile(`/${path}`)) return {};

    /** local identifier → Effect namespace it stands for (`Schema`, `Config`, `pipe`, …). */
    let namespaces = new Map<string, string>();
    /** locals bound to the whole `effect` barrel (`import * as Effect from "effect"`). */
    let barrels = new Set<string>();

    const isSecretName = (name: string): boolean => options.secretNames.test(name);

    const lookupVariable = (identifier: AnyNode, name: string): Variable | null => {
      let scope: Scope | null = context.sourceCode.getScope(identifier);
      while (scope !== null) {
        const variable = scope.set.get(name);
        if (variable !== undefined) return variable;
        scope = scope.upper;
      }
      return null;
    };

    /** `true` when the namespace identifier still resolves to its import (no local shadow). */
    const resolvesToImport = (node: AnyNode, name: string): boolean => {
      const variable = lookupVariable(node, name);
      if (variable === null || variable.defs.length === 0) return true;
      return variable.defs.some((definition) => definition.type === 'ImportBinding');
    };

    /** Resolve exact import identity, including direct submodule members and const aliases. */
    const resolveMember = (
      input: AnyNode,
      depth = 0,
    ): { namespace: string; member: string } | null => {
      if (depth > 12) return null;
      const node = unwrap(input);
      if (node.type === 'Identifier') {
        const variable = lookupVariable(node, node.name);
        if (!variable || variable.defs.length !== 1) return null;
        const definition = variable.defs[0];
        if (definition.type === 'Variable') {
          const declaration = definition.node as ESTree.VariableDeclarator;
          if (
            declaration.id.type !== 'Identifier' ||
            !declaration.init ||
            (parentOf(declaration) as ESTree.VariableDeclaration)?.kind !== 'const'
          )
            return null;
          return resolveMember(declaration.init as AnyNode, depth + 1);
        }
        if (definition.type !== 'ImportBinding') return null;
        const specifier = definition.node as ESTree.ImportSpecifier;
        const declaration = parentOf(specifier as AnyNode) as ESTree.ImportDeclaration;
        if (
          declaration?.type !== 'ImportDeclaration' ||
          declaration.importKind === 'type' ||
          specifier.importKind === 'type'
        )
          return null;
        if (specifier.type !== 'ImportSpecifier') return null;
        const member =
          specifier.imported.type === 'Identifier'
            ? specifier.imported.name
            : specifier.imported.value;
        const namespace =
          declaration.source.value === 'effect/Schema'
            ? 'Schema'
            : declaration.source.value === 'effect/Config'
              ? 'Config'
              : null;
        return namespace ? { namespace, member } : null;
      }
      if (node.type !== 'MemberExpression') return null;
      const member = memberName(node);
      if (!member) return null;
      const object = unwrap(node.object as AnyNode);
      if (object.type === 'Identifier') {
        const variable = lookupVariable(object, object.name);
        const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
        if (definition?.type !== 'ImportBinding') return null;
        const specifier = definition.node as ESTree.ImportSpecifier;
        const declaration = parentOf(specifier as AnyNode) as ESTree.ImportDeclaration;
        if (
          declaration?.type !== 'ImportDeclaration' ||
          declaration.importKind === 'type' ||
          specifier.importKind === 'type'
        )
          return null;
        const namespace = namespaces.get(object.name);
        return namespace === 'Schema' || namespace === 'Config' ? { namespace, member } : null;
      }
      if (object.type !== 'MemberExpression') return null;
      const namespace = memberName(object);
      const root = unwrap(object.object as AnyNode);
      if (
        !namespace ||
        root.type !== 'Identifier' ||
        !barrels.has(root.name) ||
        !resolvesToImport(root, root.name)
      )
        return null;
      return { namespace, member };
    };
    const configKey = (node: AnyNode, depth = 0): string | null => {
      if (depth > 12) return null;
      const value = unwrap(node);
      const literal = staticString(value);
      if (literal !== null) return literal;
      if (value.type !== 'Identifier') return null;
      const variable = lookupVariable(value, value.name);
      const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
      if (definition?.type !== 'Variable') return null;
      const declaration = definition.node as ESTree.VariableDeclarator;
      return declaration.id.type === 'Identifier' &&
        declaration.init &&
        (parentOf(declaration) as ESTree.VariableDeclaration)?.kind === 'const'
        ? configKey(declaration.init as AnyNode, depth + 1)
        : null;
    };
    const isRedaction = (node: AnyNode): boolean => {
      const expression = unwrap(node);
      const member = resolveMember(
        expression.type === 'CallExpression' ? (expression.callee as AnyNode) : expression,
      );
      return (
        member?.namespace === 'Schema' &&
        (member.member === 'Redacted' || member.member === 'RedactedFromSelf')
      );
    };

    const isPipeIdentifier = (node: AnyNode): boolean => {
      if (node.type !== 'Identifier') return false;
      const name = (node as { name: string }).name;
      return namespaces.get(name) === PIPE_EXPORT && resolvesToImport(node, name);
    };

    /** `Schema.String`, `Schema.String.check(...)`, `Schema.optional(Schema.Trim)`, `pipe(Schema.String, …)`. */
    const isStringSchema = (node: AnyNode, depth: number): boolean => {
      if (depth > 8) return false;
      const expression = unwrap(node);
      const direct = resolveMember(expression);
      if (
        direct !== null &&
        direct.namespace === SCHEMA_NAMESPACE &&
        STRING_SCHEMAS.has(direct.member)
      )
        return true;
      if (expression.type !== 'CallExpression') return false;
      const call = expression as ESTree.CallExpression;
      const callee = unwrap(call.callee as AnyNode);
      const firstArgument = call.arguments[0] as AnyNode | undefined;
      const wrapped =
        firstArgument !== undefined && firstArgument.type !== 'SpreadElement'
          ? firstArgument
          : undefined;
      const called = resolveMember(callee);
      if (
        called !== null &&
        called.namespace === SCHEMA_NAMESPACE &&
        SCHEMA_WRAPPERS.has(called.member)
      ) {
        return wrapped !== undefined && isStringSchema(wrapped, depth + 1);
      }
      if (callee.type === 'MemberExpression') {
        const method = memberName(callee as ESTree.MemberExpression);
        if (method !== null && SCHEMA_CHAIN_METHODS.has(method)) {
          if (
            method === 'pipe' &&
            call.arguments.some((argument) => isRedaction(argument as AnyNode))
          )
            return false;
          return isStringSchema((callee as ESTree.MemberExpression).object as AnyNode, depth + 1);
        }
      }
      if (isPipeIdentifier(callee))
        return (
          !call.arguments.slice(1).some((argument) => isRedaction(argument as AnyNode)) &&
          wrapped !== undefined &&
          isStringSchema(wrapped, depth + 1)
        );
      return false;
    };

    const report = (node: AnyNode, messageId: string, data: Record<string, string>): void => {
      context.report({ data, messageId, node });
    };

    /** The function this identifier is a parameter of, or `null`. */
    const parameterOwner = (identifier: AnyNode): AnyNode | null => {
      let current: AnyNode = identifier;
      for (let guard = 0; guard < 4; guard += 1) {
        const parent = parentOf(current);
        if (parent === null) return null;
        if (PARAMETER_WRAPPERS.has(parent.type)) {
          current = parent;
          continue;
        }
        if (!PARAMETER_OWNERS.has(parent.type)) return null;
        const params = (parent as { params?: readonly AnyNode[] }).params ?? [];
        return params.includes(current) ? parent : null;
      }
      return null;
    };

    return {
      Program(node) {
        const bindings = collectEffectBindings(node);
        namespaces = new Map(bindings.namespaces);
        barrels = new Set<string>();
        for (const statement of node.body) {
          if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue;
          const source = statement.source.value;
          const isReexport = matchesGlobs(source, options.reexportModules);
          if (source === EFFECT_ROOT_MODULE || isReexport) {
            for (const specifier of statement.specifiers) {
              if (specifier.type === 'ImportNamespaceSpecifier') barrels.add(specifier.local.name);
            }
          }
          if (!isReexport) continue;
          for (const specifier of statement.specifiers) {
            if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') continue;
            const imported =
              specifier.imported.type === 'Identifier'
                ? specifier.imported.name
                : specifier.imported.value;
            namespaces.set(specifier.local.name, imported);
          }
        }
      },

      // Cases 1 + 2: a string-shaped type annotation on a credential-shaped name.
      TSTypeAnnotation(node) {
        const annotated = parentOf(node as unknown as AnyNode);
        if (annotated === null) return;
        const annotation = (node as { typeAnnotation: AnyNode }).typeAnnotation;
        if (!isStringShaped(annotation, 0)) return;

        if (annotated.type === 'TSPropertySignature') {
          const signature = annotated as ESTree.TSPropertySignature;
          const name = keyName(signature.key as AnyNode, signature.computed);
          if (name === null || !isSecretName(name)) return;
          report(signature.key as AnyNode, 'secretField', { name });
          return;
        }
        if (
          [
            'PropertyDefinition',
            'AccessorProperty',
            'TSAbstractPropertyDefinition',
            'TSAbstractAccessorProperty',
          ].includes(annotated.type)
        ) {
          const definition = annotated as unknown as { key: AnyNode; computed: boolean };
          const name = keyName(definition.key, definition.computed);
          if (name === null || !isSecretName(name)) return;
          report(definition.key, 'secretField', { name });
          return;
        }
        const method = annotated.type === 'TSMethodSignature' ? annotated : parentOf(annotated);
        if (
          method &&
          (method.type === 'TSMethodSignature' ||
            method.type === 'MethodDefinition' ||
            method.type === 'TSAbstractMethodDefinition') &&
          method.kind === 'get'
        ) {
          const name = keyName(method.key, method.computed);
          if (name && isSecretName(name)) report(method.key, 'secretField', { name });
          return;
        }
        if (annotated.type !== 'Identifier') return;
        const owner = parameterOwner(annotated);
        if (owner === null) return;
        const setter = owner.type === 'TSMethodSignature' ? owner : parentOf(owner);
        const setterName =
          setter &&
          (setter.type === 'TSMethodSignature' ||
            setter.type === 'MethodDefinition' ||
            setter.type === 'TSAbstractMethodDefinition') &&
          setter.kind === 'set'
            ? keyName(setter.key, setter.computed)
            : null;
        const name =
          setterName && isSecretName(setterName)
            ? setterName
            : (annotated as { name: string }).name;
        if (!isSecretName(name)) return;
        report(annotated, 'secretParameter', { name });
      },

      // Case 3: a credential-shaped field in a Schema field bag.
      Property(node) {
        const property = node as unknown as {
          computed: boolean;
          key: AnyNode;
          value: AnyNode;
          shorthand: boolean;
        };
        const name = keyName(property.key, property.computed);
        if (name === null || !isSecretName(name)) return;
        if (!isStringSchema(property.value, 0)) return;
        report(property.key, 'secretSchemaField', { name });
      },

      // Case 4: `Config.string("AUTH_SECRET")`.
      CallExpression(node) {
        const called = resolveMember(unwrap(node.callee as AnyNode));
        if (called === null || called.namespace !== CONFIG_NAMESPACE) return;
        if (!PLAIN_CONFIG_READERS.has(called.member)) return;
        const argument = node.arguments[0] as AnyNode | undefined;
        if (argument === undefined) return;
        const key = configKey(argument);
        if (typeof key !== 'string' || !options.secretConfigKeys.test(key)) return;
        report(node as unknown as AnyNode, 'secretConfigKey', { member: called.member, name: key });
      },
    };
  },
});
