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

import type { Context, ESTree, Scope } from '@oxlint/plugins';

import { isTestFile, matchesAny, normalisePath } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

const WORKSPACE_MARKERS: readonly string[] = ['/apps/', '/verticals/', '/packages/', '/scripts/'];

/**
 * Absolute filename → the workspace-relative path the scope globs are written against.
 *
 * The *last* workspace marker wins so that real sources (`<root>/apps/x/api/index.ts`) and the
 * plugin's own fixtures (`tools/.../tests/fixtures/<rule>/invalid/apps/...`) classify identically;
 * `normalisePath` alone would stop at the enclosing `tools/` segment.
 */
function workspacePath(filename: string): string {
  const unified = filename.replaceAll('\\', '/');
  let best = -1;
  for (const marker of WORKSPACE_MARKERS) best = Math.max(best, unified.lastIndexOf(marker));
  return best === -1 ? normalisePath(unified) : unified.slice(best + 1);
}

/** Globals that can be used to reach the `JSON` bag indirectly (`globalThis.JSON.stringify`). */
const CONTAINER_GLOBALS = new Set(['globalThis', 'global', 'window', 'self']);

/** Wrappers that do not change "is this expression the callee / argument of its parent". */
const TRANSPARENT_PARENTS = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

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

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly ignoreTestFiles: boolean;
  readonly includePaths: readonly string[];
}

const DEFAULTS: RuleOptions = {
  allowPaths: [],
  ignoreTestFiles: true,
  includePaths: DEFAULT_INCLUDE_PATHS,
};

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : fallback;
}

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Partial<Record<keyof RuleOptions, unknown>>;
  const includePaths = stringList(given.includePaths, DEFAULTS.includePaths);
  return {
    allowPaths: stringList(given.allowPaths, DEFAULTS.allowPaths),
    ignoreTestFiles:
      typeof given.ignoreTestFiles === 'boolean' ? given.ignoreTestFiles : DEFAULTS.ignoreTestFiles,
    includePaths: includePaths.length > 0 ? includePaths : DEFAULTS.includePaths,
  };
}

/** Value-preserving wrappers, including the final value of a sequence expression. */
function unwrap(node: AnyNode): AnyNode {
  let current = node;
  for (;;) {
    if (current.type === 'SequenceExpression') {
      current = current.expressions.at(-1)!;
      continue;
    }
    if (!TRANSPARENT_PARENTS.has(current.type)) return current;
    const inner = (current as { expression?: AnyNode }).expression;
    if (inner === undefined) return current;
    current = inner;
  }
}

function parentOf(node: AnyNode): AnyNode | null {
  return (node as { parent?: AnyNode | null }).parent ?? null;
}

/** Climb through parentheses/type wrappers; returns the outermost equivalent node and its parent. */
function skipWrappers(node: AnyNode): { readonly node: AnyNode; readonly parent: AnyNode | null } {
  let current = node;
  let parent = parentOf(current);
  while (parent !== null && TRANSPARENT_PARENTS.has(parent.type)) {
    current = parent;
    parent = parentOf(current);
  }
  return { node: current, parent };
}

/** `JSON.stringify` / `JSON["stringify"]` → `"stringify"`; a dynamic key → `null`. */
function staticPropertyName(node: ESTree.MemberExpression): string | null {
  const property = unwrap(node.property as AnyNode);
  if (!node.computed)
    return property.type === 'Identifier' ? (property as ESTree.IdentifierName).name : null;
  if (property.type === 'TemplateLiteral' && property.expressions.length === 0)
    return property.quasis[0]?.value.cooked ?? null;
  if (property.type !== 'Literal') return null;
  const value = (property as { value?: unknown }).value;
  return typeof value === 'string' ? value : null;
}

/** `true` when `node` is the global `name` — not a local, parameter, class or imported binding. */
function isUnshadowedGlobal(context: Context, node: AnyNode, name: string): boolean {
  if (node.type !== 'Identifier') return false;
  if ((node as ESTree.IdentifierReference).name !== name) return false;
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(name);
    const valueBinding = variable?.defs.some((definition) => {
      const def = definition as unknown as {
        type: string;
        node?: { importKind?: string };
        parent?: { importKind?: string };
      };
      return (
        def.type !== 'Type' &&
        !(
          def.type === 'ImportBinding' &&
          (def.node?.importKind === 'type' || def.parent?.importKind === 'type')
        )
      );
    });
    if (valueBinding) return false;
    // A type-only binding does not hide an outer value binding with this name.
    scope = scope.upper;
  }
  return true;
}

function keyName(key: AnyNode): string | null {
  key = unwrap(key);
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0)
    return key.quasis[0]?.value.cooked ?? null;
  if (key.type === 'Identifier') return (key as ESTree.IdentifierName).name;
  if (key.type === 'Literal') {
    const value = (key as { value?: unknown }).value;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/** Name of the binding / property / assignment target this expression flows into. */
function ownerName(node: AnyNode): string | null {
  let current: AnyNode | null = parentOf(node);
  for (let depth = 0; current !== null && depth < 10; depth += 1) {
    switch (current.type) {
      case 'VariableDeclarator': {
        const id = (current as ESTree.VariableDeclarator).id as AnyNode;
        return id.type === 'Identifier' ? (id as ESTree.BindingIdentifier).name : null;
      }
      case 'Property':
      case 'PropertyDefinition':
        return keyName((current as { key: AnyNode }).key);
      case 'AssignmentExpression': {
        const left = (current as ESTree.AssignmentExpression).left as AnyNode;
        if (left.type === 'Identifier') return (left as ESTree.IdentifierReference).name;
        if (left.type === 'MemberExpression')
          return staticPropertyName(left as ESTree.MemberExpression);
        return null;
      }
      case 'ParenthesizedExpression':
      case 'ChainExpression':
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
        current = parentOf(current);
        continue;
      default:
        return null;
    }
  }
  return null;
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
    const options = readOptions(context.options[0]);
    const path = workspacePath(context.filename);
    if (!matchesAny(path, options.includePaths)) return {};
    if (matchesAny(path, options.allowPaths)) return {};
    if (options.ignoreTestFiles && isTestFile(path)) return {};

    const printed = (node: AnyNode): string => {
      const text = context.sourceCode.getText(node).replace(/\s+/gu, ' ').trim();
      return text.length > 72 ? `${text.slice(0, 69)}...` : text;
    };

    const report = (node: AnyNode, messageId: string): void => {
      context.report({ node, messageId, data: { expression: printed(node) } });
    };

    /** `true` when this expression evaluates to the ambient `JSON` global. */
    const isJsonHost = (node: AnyNode): boolean => {
      const inner = unwrap(node);
      if (inner.type === 'Identifier') return isUnshadowedGlobal(context, inner, 'JSON');
      if (inner.type === 'MemberExpression') {
        // `globalThis.JSON`, `window["JSON"]`.
        const member = inner as ESTree.MemberExpression;
        if (staticPropertyName(member) !== 'JSON') return false;
        const container = unwrap(member.object as AnyNode);
        if (container.type !== 'Identifier') return false;
        const containerName = (container as ESTree.IdentifierReference).name;
        return (
          CONTAINER_GLOBALS.has(containerName) &&
          isUnshadowedGlobal(context, container, containerName)
        );
      }
      return false;
    };

    /**
     * Decide which diagnostic a `JSON.stringify` reference earns, and which node to anchor it to:
     * the enclosing call when it is called here, the reference itself when it is passed around.
     */
    const classify = (
      reference: AnyNode,
    ): { readonly node: AnyNode; readonly messageId: string } => {
      const { node: callee, parent } = skipWrappers(reference);
      if (
        parent === null ||
        parent.type !== 'CallExpression' ||
        (parent as ESTree.CallExpression).callee !== callee
      ) {
        return { node: reference, messageId: 'jsonStringifyReference' };
      }
      const call = parent as unknown as AnyNode;
      const { node: result, parent: consumer } = skipWrappers(call);
      if (consumer !== null) {
        if (
          consumer.type === 'BinaryExpression' &&
          COMPARISON_OPERATORS.has((consumer as ESTree.BinaryExpression).operator)
        ) {
          return { node: call, messageId: 'jsonStringifyEquality' };
        }
        // `map.set(JSON.stringify(key), value)` / `cache.get(JSON.stringify(key))`.
        if (consumer.type === 'CallExpression') {
          const consumerCall = consumer as ESTree.CallExpression;
          if ((consumerCall.arguments[0] as AnyNode | undefined) === result) {
            const consumerCallee = consumerCall.callee as AnyNode;
            if (consumerCallee.type === 'MemberExpression') {
              const method = staticPropertyName(consumerCallee as ESTree.MemberExpression);
              if (method !== null && KEYED_METHODS.has(method)) {
                return { node: call, messageId: 'jsonStringifyIdentityKey' };
              }
            }
          }
        }
        // `bucket[JSON.stringify(key)] = value`.
        if (
          consumer.type === 'MemberExpression' &&
          (consumer as ESTree.MemberExpression).computed &&
          ((consumer as ESTree.MemberExpression).property as AnyNode) === result
        ) {
          return { node: call, messageId: 'jsonStringifyIdentityKey' };
        }
      }
      const owner = ownerName(call);
      if (owner !== null && IDENTITY_NAME.test(owner)) {
        return { node: call, messageId: 'jsonStringifyIdentityKey' };
      }
      return { node: call, messageId: 'nativeJsonStringify' };
    };

    return {
      // `JSON.stringify(...)`, `JSON["stringify"]`, `globalThis.JSON?.stringify?.(...)`.
      MemberExpression(node) {
        if (staticPropertyName(node) !== 'stringify') return;
        if (!isJsonHost(node.object as AnyNode)) return;
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
        if (source === null || !isJsonHost(source)) return;
        for (const property of node.properties) {
          if (property.type !== 'Property') continue;
          if (keyName((property as { key: AnyNode }).key) !== 'stringify') continue;
          report(property as unknown as AnyNode, 'jsonStringifyReference');
        }
      },
    };
  },
});
