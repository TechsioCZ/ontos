/**
 * effect-native/no-native-json-stringify
 *
 * Audit findings enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *   - C1 "Remove remaining hand-owned serialization" — "Localized examples remain in API-key
 *     metadata, cookie construction, identity/equality keys, JSON-LD embedding, tests, and build
 *     injection. […] Use `Schema.fromJsonString`, Schema encoders, Effect HTTP Cookies, and
 *     explicit stable-key codecs. Do not replace correct Drizzle JSONB or HttpApi serialization."
 *     Evidence cited by the audit: `apps/shell-super-app/api/auth/api-key-service.ts:150,157,281`
 *     and `apps/shell-super-app/api/auth/impersonation-service.ts:265`.
 *   - A7 "Give topology, composition, and authorization evidence shared Schemas" — the same
 *     topology/allowlist/rollout documents that are read with `JSON.parse` are *written* with
 *     `JSON.stringify`, so key order, `undefined` handling and escaping are re-decided per site
 *     instead of being owned by one shared JSON-string codec.
 *
 * Every `JSON.stringify` call re-decides, at that call site: which keys exist, in what order they
 * are emitted, what happens to `undefined` / `NaN` / `bigint` / `Date` / class instances, and how
 * the result is escaped. When the output is a persisted token, a hash input, an equality key or an
 * embedded document, that per-site decision *is* the contract — an unowned one.
 *
 * ## What is detected
 *
 * Any reference to the global `JSON.stringify`, reported exactly once per reference:
 *
 *   1. `jsonStringifyEquality` — the call is an operand of `===` / `!==` / `==` / `!=` (or an
 *      ordering comparison). Structural equality via serialized text: key order decides the answer.
 *   2. `jsonStringifyIdentityKey` — the result is used as an identity/hash key: first argument of
 *      `.set()` / `.get()` / `.has()` / `.add()` / `.delete()` (Map/Set/cache), a computed member
 *      key (`bucket[JSON.stringify(k)]`), or a binding/property whose name ends in
 *      `Key`, `Hash`, `Id`, `Fingerprint`, `Digest`, `Signature`, `Etag`, `Checksum` or `Cache`.
 *   3. `jsonStringifyReference` — a point-free reference that is never called here:
 *      `pipe(value, JSON.stringify)`, `items.map(JSON.stringify)`, `const dump = JSON.stringify`.
 *   4. `nativeJsonStringify` — every other call: API-key metadata, cookie/header construction,
 *      JSON-LD embedding, hand-built `Response` bodies, build-time injection, report writers.
 *
 * Recognised spellings of the host: the unshadowed global `JSON`, `globalThis|global|window|self`
 * `.JSON`, computed access (`JSON["stringify"]`), optional chaining (`JSON?.stringify?.(x)`), and
 * the destructured bag (`const { stringify } = JSON`, `const { stringify: dump } = globalThis.JSON`).
 * JSX/TSX is covered — JSON-LD embedding is a `dangerouslySetInnerHTML` site.
 *
 * ## What is deliberately allowed
 *
 *   - **Correct Drizzle JSONB and HttpApi serialization** (audit C1 "do not replace", plus
 *     "Existing patterns to preserve": "Outbox payloads already use `Schema.Json`, registered
 *     payload Schemas, and Drizzle JSONB correctly"). Those sites hand a *value* to the driver and
 *     never call `JSON.stringify`, so they are invisible to this rule by construction.
 *   - **D tier: "`JSON.stringify` inside external test fixture APIs that require a body string."**
 *     `ignoreTestFiles` defaults to `true`, so test files are skipped entirely.
 *   - Any shadowed or imported binding: a local `JSON`, an injected `serializer.stringify`, or
 *     `import { stringify } from "yaml"` / `superjson.stringify`. Only the ambient global reports.
 *   - Type positions (`typeof JSON.stringify`) parse as `TSTypeQuery` + `TSQualifiedName`, never a
 *     `MemberExpression`, so declaring the shape of a serializer stays legal.
 *   - Anything under `allowPaths` — empty by default. The audit wants the remaining sites reported
 *     until a carve-out is ratified, not pre-emptively excused.
 *
 * Scope lives in the rule (`includePaths` defaults to `apps/**`, `verticals/**`, `packages/**`,
 * `scripts/**` and root/framework `*.config.*` files), so `oxlint.config.ts` only needs
 * `'effect-native/no-native-json-stringify': 'error'`.
 *
 * Static limits: global-container aliases, rest/default destructuring, dynamic keys, reflection and
 * generated source text are not resolved. Direct member aliases report at capture, not each call.
 * Type-only declarations are not value shadows.
 *
 * Report-only: no fixers, no suggestions.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree } from '@oxlint/plugins';

import { jsonExpressionSnippet } from '../shared/json-globals.ts';
import { inJsonRuleScope } from '../shared/json-rule-scope.ts';
import {
  EXPRESSION_WRAPPERS,
  identityUnwrap as unwrap,
  keyName as sharedKeyName,
  parentOf,
  skipWrappers,
  staticString,
} from '../shared/ast.ts';
import { isUnshadowedGlobal } from '../shared/bindings.ts';

type AnyNode = ESTree.Node;

/** Globals that can be used to reach the `JSON` bag indirectly (`globalThis.JSON.stringify`). */
const CONTAINER_GLOBALS = new Set(['globalThis', 'global', 'window', 'self']);

/** Comparison operators that turn serialized text into a structural-equality verdict. */
const COMPARISON_OPERATORS = new Set(['===', '!==', '==', '!=', '<', '>', '<=', '>=']);

/** Methods whose first argument is a lookup key (Map, Set, cache, keyed store). */
const KEYED_METHODS = new Set(['set', 'get', 'has', 'add', 'delete']);

/** A binding/property name that declares the value is an identity or hash key. */
const IDENTITY_NAME = /(?:Key|Hash|Id|Fingerprint|Digest|Signature|Etag|Checksum|Cache)$/u;

const DEFAULT_INCLUDE_PATHS: readonly string[] = [
  'apps/**',
  'verticals/**',
  'packages/**',
  'scripts/**',
  '**/*.config.{ts,mts,cts,js,mjs,cjs}',
];

/** JSON member keys accept static cooked templates, but never dynamic computed identifiers. */
function staticPropertyName(node: ESTree.MemberExpression): string | null {
  const property = unwrap(node.property);
  if (node.computed) return staticString(property);
  return property.type === 'Identifier' ? property.name : null;
}

function keyName(key: AnyNode): string | null {
  return sharedKeyName(key, false, { unwrap: { wrappers: EXPRESSION_WRAPPERS, sequence: true } });
}

const OWNER_WRAPPERS = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
]);

function assignmentName(left: AnyNode): string | null {
  if (left.type === 'Identifier') return left.name;
  return left.type === 'MemberExpression' ? staticPropertyName(left) : null;
}

function directOwnerName(node: AnyNode): string | null {
  switch (node.type) {
    case 'VariableDeclarator':
      return node.id.type === 'Identifier' ? node.id.name : null;
    case 'Property':
    case 'PropertyDefinition':
      return keyName(node.key);
    case 'AssignmentExpression':
      return assignmentName(node.left);
    default:
      return null;
  }
}

/** Name of the binding / property / assignment target this expression flows into. */
function ownerName(node: AnyNode): string | null {
  let current: AnyNode | null = parentOf(node);
  for (let depth = 0; current !== null && depth < 10; depth += 1) {
    if (!OWNER_WRAPPERS.has(current.type)) return directOwnerName(current);
    current = parentOf(current);
  }
  return null;
}

function isGlobalContainer(context: Context, node: AnyNode): boolean {
  const container = unwrap(node);
  return (
    container.type === 'Identifier' &&
    CONTAINER_GLOBALS.has(container.name) &&
    isUnshadowedGlobal(context, container, container.name, true)
  );
}

function isJsonHost(context: Context, node: AnyNode): boolean {
  const host = unwrap(node);
  if (host.type === 'Identifier') return isUnshadowedGlobal(context, host, 'JSON', true);
  return (
    host.type === 'MemberExpression' &&
    staticPropertyName(host) === 'JSON' &&
    isGlobalContainer(context, host.object)
  );
}

function isKeyedCall(consumer: ESTree.CallExpression, result: AnyNode): boolean {
  if (consumer.arguments[0] !== result || consumer.callee.type !== 'MemberExpression') return false;
  const method = staticPropertyName(consumer.callee);
  return method !== null && KEYED_METHODS.has(method);
}

function isKeyConsumer(consumer: AnyNode | null, result: AnyNode): boolean {
  if (consumer?.type === 'CallExpression') return isKeyedCall(consumer, result);
  return consumer?.type === 'MemberExpression' && consumer.computed && consumer.property === result;
}

function callMessage(call: AnyNode): string {
  const { node: result, parent: consumer } = skipWrappers(call);
  if (consumer?.type === 'BinaryExpression' && COMPARISON_OPERATORS.has(consumer.operator))
    return 'jsonStringifyEquality';
  if (isKeyConsumer(consumer, result)) return 'jsonStringifyIdentityKey';
  const owner = ownerName(call);
  return owner !== null && IDENTITY_NAME.test(owner)
    ? 'jsonStringifyIdentityKey'
    : 'nativeJsonStringify';
}

/** Called references anchor at their call; point-free references anchor at capture. */
function classify(reference: AnyNode): { readonly node: AnyNode; readonly messageId: string } {
  const { node: callee, parent } = skipWrappers(reference);
  if (parent?.type !== 'CallExpression' || parent.callee !== callee)
    return { node: reference, messageId: 'jsonStringifyReference' };
  return { node: parent, messageId: callMessage(parent) };
}

/** Effect-native rule: serialization is owned by a Schema codec, never re-decided per call site. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit C1/A7: `JSON.stringify` is hand-owned serialization — it re-decides key order, `undefined`/`bigint`/`Date` handling and escaping at every call site, including identity keys, equality comparisons, cookie/token metadata, JSON-LD embedding and build injection. Static global references only: dynamic keys and cross-file aliases are not resolved.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#c1-remove-remaining-hand-owned-serialization',
    },
    messages: {
      nativeJsonStringify:
        'Audit C1/A7: `{{expression}}` is hand-owned serialization — key order, `undefined`/`NaN`/`bigint`/`Date` handling and escaping are re-decided here instead of by the owning contract. Encode through the Schema that owns the value (`Schema.encodeSync(Schema.fromJsonString(MySchema))(value)`, or `Schema.encode`/`Schema.encodeEffect` inside Effect), an explicit stable-key codec for canonical output, `HttpApi`/`HttpBody` for response bodies and Effect HTTP Cookies for cookie values.',
      jsonStringifyEquality:
        'Audit C1: `{{expression}}` compares values by serialized text. Key order and omitted values can affect that verdict; this rule cannot prove canonicalization or the operand types. Compare with `Equal.equals` (Schema/Data values are structurally comparable), a Schema-derived `Equivalence`, or explicit field comparison — not with `JSON.stringify` output.',
      jsonStringifyIdentityKey:
        'Audit C1: `{{expression}}` uses native serialization in a key-like context. This rule cannot identify the receiver type or prove stable key ordering. Derive the key from an explicit stable-key codec (`Schema.encodeSync(Schema.fromJsonString(KeySchema))` over a canonically ordered Schema) or a branded key Schema, and use `Equal`/`Hash`-backed structures (`HashMap`, `Effect.Cache`) keyed by the decoded value.',
      jsonStringifyReference:
        'Audit C1/A7: `{{expression}}` hands the native serializer itself to another function, so every value flowing through it is serialized by an unowned contract. Pass the Schema encoder instead (`Schema.encodeSync(Schema.fromJsonString(MySchema))`) so the emitted shape stays owned by the Schema.',
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
              'Globs of files allowed to call the native `JSON.stringify`, e.g. a ratified serialization carve-out (default: none).',
          },
          ignoreTestFiles: {
            type: 'boolean',
            description:
              'Skip test files (default: true — audit D tier keeps `JSON.stringify` inside external test fixture APIs that require a body string).',
          },
          includePaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs the rule applies to (default: apps/**, verticals/**, packages/**, scripts/** and root `*.config.*` files).',
          },
        },
      },
    ],
    defaultOptions: [
      { allowPaths: [], ignoreTestFiles: true, includePaths: [...DEFAULT_INCLUDE_PATHS] },
    ],
  },
  create(context) {
    if (!inJsonRuleScope(context.filename, context.options[0], DEFAULT_INCLUDE_PATHS)) return {};

    const report = (node: AnyNode, messageId: string): void => {
      context.report({
        node,
        messageId,
        data: { expression: jsonExpressionSnippet(context.sourceCode.getText(node)) },
      });
    };

    return {
      // `JSON.stringify(...)`, `JSON["stringify"]`, `globalThis.JSON?.stringify?.(...)`.
      MemberExpression(node) {
        if (staticPropertyName(node) !== 'stringify') return;
        if (!isJsonHost(context, node.object as AnyNode)) return;
        const outcome = classify(node as unknown as AnyNode);
        report(outcome.node, outcome.messageId);
      },

      // `const { stringify } = JSON` / `const { stringify: dump } = globalThis.JSON`.
      ObjectPattern(node) {
        const parent = parentOf(node as unknown as AnyNode);
        if (parent === null) return;
        const source =
          parent.type === 'VariableDeclarator'
            ? ((parent as ESTree.VariableDeclarator).init as AnyNode | null)
            : parent.type === 'AssignmentExpression'
              ? ((parent as ESTree.AssignmentExpression).right as AnyNode)
              : null;
        if (source === null || !isJsonHost(context, source)) return;
        for (const property of node.properties) {
          if (property.type !== 'Property') continue;
          if (keyName((property as { key: AnyNode }).key) !== 'stringify') continue;
          report(property as unknown as AnyNode, 'jsonStringifyReference');
        }
      },
    };
  },
});
