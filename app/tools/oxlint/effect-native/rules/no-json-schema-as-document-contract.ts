/**
 * Audit finding: **A7** — "Give topology, composition, and authorization evidence shared Schemas"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`).
 *
 * A7 records that "authoritative topology and authorization documents are decoded using
 * combinations of `JSON.parse`, `Schema.Json`, optional interfaces, structural walking, exact-key
 * comparisons, and casts", listing `apps/shell-super-app/modern.config.ts:101`,
 * `apps/shell-super-app/module-deployment-allowlist.config.ts:62`,
 * `apps/shell-super-app/api/modules/deployment-allowlist.ts:25`,
 * `apps/shell-super-app/api/verticals/installed-verticals.ts:37` and the
 * `scripts/authorization/*` readers as evidence. The Effect v4 target is a shared
 * composition-contract package holding real Schemas for reference topology, ownership, local
 * overlays, deployment allowlists, Module Federation manifests, authorization rollout contracts and
 * readiness/would-deny evidence, decoded through the *same* Schemas by every runtime, build and
 * script consumer.
 *
 * `Schema.Json` (and `Schema.Record(Schema.String, Schema.Json)`, `Schema.Array(Schema.Json)`) is a
 * *shape-free* codec: it proves the value is JSON and nothing else. Decoding an authoritative
 * document through it does not validate the document — it merely licences the hand-written walk
 * that follows (`Predicate.isObjectKeyword`, `Array.isArray`, `entry['kind'] !== 'vertical'`,
 * `throw new TypeError(...)`), which is precisely the structural walking / exact-key comparison /
 * cast pile A7 targets. The same applies to `Schema.Schema.Type<typeof Schema.Json>` used as the
 * declared *type* of a topology document or build-time global: the alias is the seed from which
 * every hand-rolled `object(value)` helper in these files grows.
 *
 * What is detected
 * - A `Schema` codec entry point (`decode*`, `encode*`, `validate*`, `is`, `asserts`, `standardSchemaV1`;
 *   configurable via `codecMembers`) whose schema argument is `Schema.Json` / `Schema.JsonValue`,
 *   `Schema.Record(<key>, Schema.Json)` or `Schema.Array(Schema.Json)` — either written inline, or
 *   named by a lexically resolved `const` in the same file whose initialiser is one of those. Wrappers
 *   (`Schema.optional`, `Schema.optionalKey`, `Schema.NullOr`, `Schema.UndefinedOr`,
 *   `Schema.NullishOr`, `Schema.mutable`) are unwrapped first.
 * - A module-scope initialiser or static readonly class property value that *is*
 *   one of those shapes and is not a field of a `Schema.Struct` / `Schema.Class` /
 *   `Schema.TaggedError` / `Schema.TaggedRequest` / `Schema.Union` argument.
 * - `typeof Schema.Json` (a `TSTypeQuery`) inside a `type X = …` alias or a `declare const/let/var`
 *   annotation — the `type JsonValue = Schema.Schema.Type<typeof Schema.Json>` /
 *   `declare const ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY: JsonValue` pair that opens every A7 reader.
 * - Aliased imports (`import { Schema as S } from "effect"`), submodule namespace imports
 *   (`import * as Schema from "effect/Schema"`), direct member imports
 *   (`import { Json } from "effect/Schema"`), computed access (`Schema["Json"]`), optional chaining,
 *   point-free/`pipe` usage (`pipe(raw, Schema.decodeUnknownEffect(Schema.Json))`), and `.ts`/`.mts`/
 *   `.cts`/`.tsx` alike across `apps/`, `verticals/`, `packages/` and `scripts/`.
 *
 * What is deliberately allowed
 * - **`Schema.Json` as a Struct/Class/TaggedError/TaggedRequest/Union field** (including under
 *   `Schema.optional*` / `Schema.NullOr` wrappers). The audit's "Existing patterns to preserve"
 *   section explicitly blesses "Outbox payloads already use `Schema.Json`, registered payload
 *   Schemas, and Drizzle JSONB correctly": `Schema.Struct({ payloadJson: Schema.Json })` is an
 *   *opaque payload carried inside* a typed envelope, not a document contract. Never reported.
 * - **Opaque-payload owners** (`allowPaths`, default `packages/core-runtime/src/outbox/**` and the
 *   action collector/events/context modules): the audit evidence envelope and outbox payload are
 *   genuinely shape-free by design, and their `Schema.decodeUnknownEffect(Schema.Json)` calls are
 *   already the correct Effect-native form.
 * - **Test files** (`ignoreTestFiles`, default `true`): fixtures build deliberately malformed JSON
 *   documents to prove rejection (D tier), and the audit blesses "several tests already decode
 *   responses through Schema".
 * - Anything that is not Effect's `Schema` namespace — a local `Schema` shadow, a `Json` from a
 *   non-Effect module, an interface member or function parameter typed `JsonValue` (only the
 *   declaring alias/`declare const` is reported, once, rather than every use), and every other
 *   D-tier shape (`Layer.orDie` at a startup root, `JSON.stringify` in external test fixture APIs,
 *   native array operations, correct Drizzle JSONB / HttpApi serialization).
 *
 * Static limits: opaque ownership is path-scoped; aliases are immutable and depth-bounded.
 * Object fields may be hoisted Struct fields or registered outbox descriptors, so they are not
 * classified as document declarations. Dynamic imports and arbitrary pipe transformations are not followed.
 *
 * Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings, type EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

const SCHEMA_NAMESPACE = 'Schema';
const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_SCHEMA_MODULE = /^effect\/(?:.*\/)?Schema$/u;

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production defaults instead of forcing the
 * fixture config to pass loosened options (which `run-on-repo.mts` reuses verbatim against the repo).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

/** Shape-free JSON codecs on Effect's `Schema` namespace. */
const DEFAULT_JSON_MEMBERS = ['Json', 'JsonValue'];

/** Codec entry points whose first argument is the schema being used as the document contract. */
const DEFAULT_CODEC_MEMBERS = [
  'asserts',
  'decode',
  'decodeEffect',
  'decodeResult',
  'decodeSync',
  'decodeUnknown',
  'decodeUnknownEffect',
  'decodeUnknownResult',
  'decodeUnknownSync',
  'encode',
  'encodeEffect',
  'encodeResult',
  'encodeSync',
  'encodeUnknown',
  'encodeUnknownEffect',
  'encodeUnknownResult',
  'encodeUnknownSync',
  'is',
  'standardSchemaV1',
  'validate',
  'validateEffect',
  'validateResult',
  'validateSync',
];

/**
 * Modules that legitimately own an opaque JSON payload: the outbox message body and the action
 * audit-evidence envelope. The audit's "Existing patterns to preserve" section blesses both.
 */
const DEFAULT_ALLOW_PATHS = [
  'packages/core-runtime/src/outbox/**',
  'packages/core-runtime/src/actions/collector.ts',
  'packages/core-runtime/src/actions/events.ts',
  'packages/core-runtime/src/actions/context.ts',
];

/** Combinators that wrap a field schema without changing what it validates. */
const TRANSPARENT_WRAPPERS = new Set([
  'mutable',
  'NullishOr',
  'NullOr',
  'optional',
  'optionalKey',
  'OptionFromNullishOr',
  'OptionFromNullOr',
  'readonly',
  'Readonly',
  'UndefinedOr',
]);

/** `Schema.Array(Schema.Json)` and friends: the element schema is the contract. */
const ARRAY_COMBINATORS = new Set(['Array', 'ArrayEnsure', 'NonEmptyArray', 'ReadonlyArray']);

/** Node types that end module scope. */
const SCOPE_BREAKERS = new Set([
  'ArrowFunctionExpression',
  'ClassBody',
  'FunctionDeclaration',
  'FunctionExpression',
  'StaticBlock',
  'TSDeclareFunction',
  'TSEmptyBodyFunctionExpression',
]);

/** Expression wrappers that are transparent for the purpose of recognising a schema expression. */
const EXPRESSION_WRAPPERS = new Set([
  'ChainExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSInstantiationExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
]);

/** Guard against pathological `const a = b; const b = a;` chains while resolving aliases. */
const MAX_RESOLUTION_DEPTH = 8;

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly codecMembers: readonly string[];
  readonly ignoreTestFiles: boolean;
  readonly jsonMembers: readonly string[];
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readOptions(context: Context): RuleOptions {
  const raw = context.options?.[0];
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    allowPaths: stringArray(record.allowPaths, DEFAULT_ALLOW_PATHS),
    codecMembers: stringArray(record.codecMembers, DEFAULT_CODEC_MEMBERS),
    ignoreTestFiles: boolean(record.ignoreTestFiles, true),
    jsonMembers: stringArray(record.jsonMembers, DEFAULT_JSON_MEMBERS),
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

/** Non-computed `.Json`, or computed `["Json"]`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const property = unwrapExpression(node.property);
  if (property.type === 'TemplateLiteral' && property.expressions.length === 0)
    return property.quasis[0]?.value.cooked ?? null;
  if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
  return null;
}

function unwrapExpression(node: ESTree.Node): ESTree.Node {
  let current = node;
  for (let step = 0; step < MAX_RESOLUTION_DEPTH; step += 1) {
    if (!EXPRESSION_WRAPPERS.has(current.type)) return current;
    const next =
      'expression' in current && current.expression !== null && current.expression !== undefined
        ? (current.expression as ESTree.Node)
        : null;
    if (next === null) return current;
    current = next;
  }
  return current;
}

function lookupVariable(
  context: Context,
  identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
): Variable | null {
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
function resolvesToImport(
  context: Context,
  identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
): boolean {
  const variable = lookupVariable(context, identifier);
  if (variable === null) return true;
  if (variable.defs.length === 0) return true;
  return variable.defs.some((definition) => definition.type === 'ImportBinding');
}

interface SchemaLocals {
  /** Locals standing for Effect's `Schema` namespace (`Schema`, `S`, `import * as S from "effect/Schema"`). */
  readonly namespaces: ReadonlySet<string>;
  /** Locals bound directly from `effect/Schema` (`import { Json as AnyJson } from "effect/Schema"`). */
  readonly direct: ReadonlyMap<string, string>;
}

function collectSchemaLocals(program: ESTree.Program, bindings: EffectBindings): SchemaLocals {
  const namespaces = new Set<string>();
  const direct = new Map<string, string>();
  for (const [local, namespace] of bindings.namespaces) {
    if (namespace === SCHEMA_NAMESPACE) namespaces.add(local);
  }
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    const source = statement.source.value;
    if (EFFECT_SCHEMA_MODULE.test(source)) {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportSpecifier')
          direct.set(specifier.local.name, importedName(specifier));
        else if (specifier.type === 'ImportNamespaceSpecifier')
          namespaces.add(specifier.local.name);
      }
      continue;
    }
    if (source !== EFFECT_ROOT_MODULE) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && importedName(specifier) === SCHEMA_NAMESPACE) {
        namespaces.add(specifier.local.name);
      }
    }
  }
  return { namespaces, direct };
}

/** Resolve only lexical imports and immutable same-file aliases; no cross-file or mutation inference. */
function schemaIdentity(
  context: Context,
  input: ESTree.Node,
  reexports: readonly string[] = [],
  depth = 0,
): string | null {
  if (depth > 16) return null;
  const node = unwrapExpression(input);
  if (node.type === 'MemberExpression') {
    const host = schemaIdentity(context, node.object, reexports, depth + 1);
    const member = memberName(node);
    return host === '@schema'
      ? member
      : host === '@effect' && member === 'Schema'
        ? '@schema'
        : null;
  }
  if (node.type !== 'Identifier') return null;
  const variable = lookupVariable(context, node);
  if (!variable) return null;
  for (const def of variable.defs) {
    if (def.type === 'ImportBinding') {
      const specifier = def.node;
      const declaration = def.parent;
      if (declaration?.type !== 'ImportDeclaration' || declaration.importKind === 'type') continue;
      if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue;
      const source = declaration.source.value;
      if (EFFECT_SCHEMA_MODULE.test(source)) {
        if (specifier.type === 'ImportNamespaceSpecifier') return '@schema';
        if (specifier.type === 'ImportSpecifier') return importedName(specifier);
      }
      if (source === 'effect' || matchesGlobs(source, reexports)) {
        if (specifier.type === 'ImportNamespaceSpecifier') return '@effect';
        if (specifier.type === 'ImportSpecifier' && importedName(specifier) === 'Schema')
          return '@schema';
      }
    }
    if (def.type !== 'Variable' || def.node.type !== 'VariableDeclarator' || def.node.init === null)
      continue;
    const declarator = def.node;
    if (declarator.init === null) continue;
    if (declarator.parent?.type !== 'VariableDeclaration' || declarator.parent.kind !== 'const')
      continue;
    if (declarator.id.type === 'Identifier')
      return schemaIdentity(context, declarator.init, reexports, depth + 1);
    if (declarator.id.type !== 'ObjectPattern') continue;
    const host = schemaIdentity(context, declarator.init, reexports, depth + 1);
    for (const property of declarator.id.properties) {
      if (
        property.type !== 'Property' ||
        property.value.type !== 'Identifier' ||
        property.value.name !== node.name
      )
        continue;
      const key =
        !property.computed && property.key.type === 'Identifier'
          ? property.key.name
          : property.key.type === 'Literal' && typeof property.key.value === 'string'
            ? property.key.value
            : property.key.type === 'TemplateLiteral' && property.key.expressions.length === 0
              ? property.key.quasis[0]?.value.cooked
              : null;
      if (host === '@schema') return key ?? null;
      if (host === '@effect' && key === 'Schema') return '@schema';
    }
  }
  return null;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A7: disallow `Schema.Json` (and `Schema.Record(Schema.String, Schema.Json)` / ' +
        '`Schema.Array(Schema.Json)` / `Schema.Schema.Type<typeof Schema.Json>`) as the contract for an ' +
        'authoritative document. Topology, ownership, local overlays, deployment allowlists, Module ' +
        'Federation manifests, authorization rollout contracts and readiness evidence must be decoded ' +
        'through the shared composition-contract Schemas, not through a shape-free JSON codec followed by ' +
        'a hand-written structural walk. `Schema.Json` as a `Schema.Struct` field (outbox payloads, audit ' +
        'evidence) stays allowed.',
    },
    messages: {
      jsonCodecArgument:
        '`{{shape}}` is the schema handed to `{{namespace}}.{{codec}}`, so this decodes the document as ' +
        'shape-free JSON and leaves every field to a hand-written walk (`Predicate.isObjectKeyword`, ' +
        '`Array.isArray`, exact-key comparisons, `throw new TypeError`) — audit A7: "authoritative topology ' +
        'and authorization documents are decoded using combinations of `JSON.parse`, `Schema.Json`, optional ' +
        'interfaces, structural walking, exact-key comparisons, and casts". Decode topology, ownership, ' +
        'overlays, deployment allowlists, Module Federation manifests and authorization rollout contracts ' +
        'through the shared composition-contract `Schema.Struct`/`Schema.Class` definitions so the same ' +
        'Schema serves runtime, build and script consumers. `Schema.Json` remains correct as a ' +
        '`Schema.Struct` field for genuinely opaque payloads (outbox, audit evidence).',
      jsonDocumentSchema:
        '`{{shape}}` is declared here as a document schema, which validates "this is JSON" and nothing ' +
        'else — audit A7: topology/composition/authorization evidence needs shared Schemas, not a shape-free ' +
        'codec plus structural walking and casts. Replace it with the shared composition-contract ' +
        '`Schema.Struct`/`Schema.Class` for this document (reference topology, ownership, local overlay, ' +
        'deployment allowlist, Module Federation manifest, rollout contract, readiness evidence). ' +
        '`Schema.Json` inside a `Schema.Struct` field stays allowed for opaque payloads.',
      jsonDocumentType:
        '`typeof {{reference}}` types this declaration as shape-free JSON, which is the seed of the ' +
        'hand-rolled `object(value)` / exact-key walk A7 targets ("optional interfaces, structural walking, ' +
        'exact-key comparisons, and casts"). Derive the type from the shared composition-contract Schema ' +
        'for this document (`Schema.Schema.Type<typeof ReferenceTopology>`) and decode the value through ' +
        'that Schema instead of walking it by hand.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowPaths: { type: 'array', items: { type: 'string' } },
          codecMembers: { type: 'array', items: { type: 'string' } },
          ignoreTestFiles: { type: 'boolean' },
          jsonMembers: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        allowPaths: DEFAULT_ALLOW_PATHS,
        codecMembers: DEFAULT_CODEC_MEMBERS,
        ignoreTestFiles: true,
        jsonMembers: DEFAULT_JSON_MEMBERS,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.allowPaths)) return {};
    if (options.ignoreTestFiles && isTestFile(path)) return {};

    const jsonMembers = new Set(options.jsonMembers);
    const codecMembers = new Set(options.codecMembers);
    if (jsonMembers.size === 0) return {};

    const program = context.sourceCode.ast;
    const bindings = collectEffectBindings(program);
    const locals = collectSchemaLocals(program, bindings);

    /**
     * The `Schema` export a node names: `Schema.Record` / `S["Record"]` / `Schema?.Record` on a
     * namespace binding, or a bare identifier bound by `import { Record as SchemaRecord } from
     * "effect/Schema"`. `null` for anything that is not Effect's `Schema`.
     */
    const schemaReference = (node: ESTree.Node): string | null => schemaIdentity(context, node);

    /** `Schema.Json` / `S.Json` / `Schema["Json"]` / a bare `Json` imported from `effect/Schema`. */
    const isBareJson = (node: ESTree.Node): boolean => {
      const member = schemaReference(node);
      return member !== null && jsonMembers.has(member);
    };

    /**
     * Describe `node` when it is a shape-free JSON *document* schema, resolving module-scope
     * aliases and unwrapping transparent combinators. Returns the shape to quote in the message.
     */
    const jsonDocumentShape = (
      node: ESTree.Node,
      depth: number,
      seen: Set<string>,
    ): string | null => {
      if (depth > MAX_RESOLUTION_DEPTH) return null;
      const current = unwrapExpression(node);

      if (isBareJson(current)) return `${SCHEMA_NAMESPACE}.Json`;

      if (current.type === 'Identifier') {
        if (seen.has(current.name)) return null;
        const variable = lookupVariable(context, current);
        const definition = variable?.defs.find(
          (def) => def.type === 'Variable' && def.node.type === 'VariableDeclarator',
        );
        if (!definition || definition.node.type !== 'VariableDeclarator') return null;
        const declaration = definition.node.parent;
        if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const')
          return null;
        const init = definition.node.init;
        if (!init) return null;
        seen.add(current.name);
        return jsonDocumentShape(init, depth + 1, seen);
      }

      if (current.type !== 'CallExpression') return null;
      const combinator = schemaReference(unwrapExpression(current.callee));
      if (combinator === null) return null;
      const args = current.arguments;

      if (TRANSPARENT_WRAPPERS.has(combinator)) {
        const first = args[0];
        return first === undefined || first.type === 'SpreadElement'
          ? null
          : jsonDocumentShape(first, depth + 1, seen);
      }

      if (ARRAY_COMBINATORS.has(combinator)) {
        const first = args[0];
        if (first === undefined || first.type === 'SpreadElement') return null;
        return jsonDocumentShape(first, depth + 1, seen) === null
          ? null
          : `${SCHEMA_NAMESPACE}.${combinator}(${SCHEMA_NAMESPACE}.Json)`;
      }

      if (combinator === 'Record') {
        // `Schema.Record(key, value)` and the object form `Schema.Record({ key, value })`.
        let value: ESTree.Node | null = null;
        const first = args[0];
        if (args.length >= 2) {
          const second = args[1];
          if (second !== undefined && second.type !== 'SpreadElement') value = second;
        } else if (first !== undefined && first.type === 'ObjectExpression') {
          for (const property of first.properties) {
            if (property.type !== 'Property' || property.computed) continue;
            const key = property.key;
            const name = key.type === 'Identifier' ? key.name : null;
            if (name === 'value') value = property.value;
          }
        }
        if (value === null) return null;
        return jsonDocumentShape(value, depth + 1, seen) === null
          ? null
          : `${SCHEMA_NAMESPACE}.Record(…, ${SCHEMA_NAMESPACE}.Json)`;
      }

      return null;
    };

    const describe = (node: ESTree.Node): string | null =>
      jsonDocumentShape(node, 0, new Set<string>());

    /**
     * The `Schema` member a call ultimately targets, unwrapping the curried forms
     * `Schema.TaggedError<Self>()("Tag", {...})` and `Schema.Class<Self>("X")({...})`.
     */
    const calledSchemaMember = (call: ESTree.CallExpression): string | null => {
      let callee: ESTree.Node = unwrapExpression(call.callee);
      for (let step = 0; step < MAX_RESOLUTION_DEPTH; step += 1) {
        const member = schemaReference(callee);
        if (member !== null) return member;
        if (callee.type !== 'CallExpression') return null;
        callee = unwrapExpression(callee.callee);
      }
      return null;
    };

    /**
     * `true` when the node sits inside a `Schema` combinator call — a `Schema.Struct` /
     * `Schema.Class` / `Schema.TaggedError` fields object above all, which is the blessed
     * opaque-payload shape the audit preserves, but also any other combinator whose own
     * declarator or codec-argument report already covers the site (so it is never double-reported).
     */
    const insideSchemaCall = (node: ESTree.Node): boolean => {
      let current: ESTree.Node | null = node.parent ?? null;
      for (let step = 0; step < 64 && current !== null; step += 1) {
        if (current.type === 'Program') return false;
        if (current.type === 'CallExpression' && calledSchemaMember(current) !== null) return true;
        current = current.parent ?? null;
      }
      return false;
    };

    const atModuleScope = (node: ESTree.Node): boolean => {
      let current: ESTree.Node | null = node.parent ?? null;
      for (let step = 0; step < 64 && current !== null; step += 1) {
        if (SCOPE_BREAKERS.has(current.type)) return false;
        if (current.type === 'Program') return true;
        current = current.parent ?? null;
      }
      return false;
    };

    /** `type X = …` alias or `declare const x: …` — where an opaque JSON *type* becomes a contract. */
    const inTypeContract = (node: ESTree.Node): boolean => {
      let current: ESTree.Node | null = node.parent ?? null;
      for (let step = 0; step < 64 && current !== null; step += 1) {
        if (current.type === 'TSTypeAliasDeclaration') return true;
        if (current.type === 'VariableDeclaration') return current.declare === true;
        if (current.type === 'Program') return false;
        current = current.parent ?? null;
      }
      return false;
    };

    const isEffectPipe = (input: ESTree.Node): boolean => {
      const node = unwrapExpression(input);
      if (node.type !== 'Identifier') return false;
      return (
        lookupVariable(context, node)?.defs.some(
          (def) =>
            def.type === 'ImportBinding' &&
            def.node.type === 'ImportSpecifier' &&
            importedName(def.node) === 'pipe' &&
            def.node.importKind !== 'type' &&
            def.parent?.type === 'ImportDeclaration' &&
            def.parent.importKind !== 'type' &&
            ['effect', 'effect/Function'].includes(def.parent.source.value),
        ) ?? false
      );
    };

    return {
      CallExpression(node) {
        const codec = schemaReference(unwrapExpression(node.callee));
        // Only actual Effect pipe, with the codec immediately following the schema. An
        // arbitrary intermediate transformation can change the contract and is not inferred.
        if (codec === null && node.arguments.length >= 2 && isEffectPipe(node.callee)) {
          const [subject, next] = node.arguments;
          if (subject.type !== 'SpreadElement' && next.type !== 'SpreadElement') {
            const pipedCodec = schemaReference(next);
            const shape = describe(subject);
            if (pipedCodec && codecMembers.has(pipedCodec) && shape)
              context.report({
                node: subject,
                messageId: 'jsonCodecArgument',
                data: { codec: pipedCodec, namespace: 'Schema', shape },
              });
          }
        }
        if (codec === null || !codecMembers.has(codec)) return;
        const first = node.arguments[0];
        if (first === undefined || first.type === 'SpreadElement') return;
        const shape = describe(first);
        if (shape === null) return;
        const callee = unwrapExpression(node.callee);
        const namespace =
          callee.type === 'MemberExpression' && callee.object.type === 'Identifier'
            ? callee.object.name
            : SCHEMA_NAMESPACE;
        context.report({
          node: first,
          messageId: 'jsonCodecArgument',
          data: { codec, namespace, shape },
        });
      },

      VariableDeclarator(node) {
        if (node.init === null) return;
        if (!atModuleScope(node)) return;
        if (insideSchemaCall(node)) return;
        const shape = describe(node.init);
        if (shape === null) return;
        context.report({ node: node.init, messageId: 'jsonDocumentSchema', data: { shape } });
      },

      PropertyDefinition(node) {
        if (!node.static || !node.readonly || node.value === null || insideSchemaCall(node)) return;
        const shape = describe(node.value);
        if (shape !== null)
          context.report({ node: node.value, messageId: 'jsonDocumentSchema', data: { shape } });
      },

      TSTypeQuery(node) {
        const expression = node.exprName;
        let reference: string | null = null;
        if (expression.type === 'TSQualifiedName') {
          const left = expression.left;
          if (left.type !== 'Identifier') return;
          if (!locals.namespaces.has(left.name) || !resolvesToImport(context, left)) return;
          if (!jsonMembers.has(expression.right.name)) return;
          reference = `${left.name}.${expression.right.name}`;
        } else if (expression.type === 'Identifier') {
          const imported = locals.direct.get(expression.name);
          if (
            imported === undefined ||
            !jsonMembers.has(imported) ||
            !resolvesToImport(context, expression)
          )
            return;
          reference = expression.name;
        }
        if (reference === null) return;
        if (!inTypeContract(node)) return;
        context.report({ node, messageId: 'jsonDocumentType', data: { reference } });
      },
    };
  },
});
