/**
 * effect-native/no-native-json-parse
 *
 * Audit findings enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *   - A3 "Replace ambient configuration with Config, ConfigProvider, and Redacted" —
 *     "Configuration currently combines `process.env`, per-module dotenv loading, `trim`, `new URL`,
 *     number/range checks, `JSON.parse`, synchronous Schema decoding, and throws"; the stated target
 *     is "Use `Schema.fromJsonString` for JSON-valued configuration."
 *   - A7 "Give topology, composition, and authorization evidence shared Schemas" —
 *     "Authoritative topology and authorization documents are decoded using combinations of
 *     `JSON.parse`, `Schema.Json`, optional interfaces, structural walking, exact-key comparisons,
 *     and casts." The target is a shared composition-contract package of Schemas *and JSON-string
 *     codecs*.
 *   - C1 "Remove remaining hand-owned serialization" — API-key metadata, impersonation payloads and
 *     build injection still round-trip through hand JSON; "Use `Schema.fromJsonString`, Schema
 *     encoders, Effect HTTP Cookies, and explicit stable-key codecs."
 *
 * For external document text, `JSON.parse` has two independent limitations: the result is `any`/`unknown` (so every downstream field
 * access is unvalidated, and the "validate separately, later, maybe" step is what the audit keeps
 * finding missing), and the failure is a bare `SyntaxError` thrown out of band — untyped, uncaught
 * by the Effect error channel, indistinguishable from a decode failure.
 * `Schema.decodeUnknownEffect(Schema.fromJsonString(S))` composes parse + decode into one typed
 * failure inside the Effect channel.
 *
 * ## What is detected
 *
 *   1. `nativeJsonParse` — a `JSON.parse` member expression, reported once per occurrence whether it
 *      is called, referenced point-free, or aliased:
 *        - `JSON.parse(text)`, `JSON.parse(text) as Topology`
 *        - `lines.map(JSON.parse)` / `pipe(text, JSON.parse)` (bare function reference)
 *        - `const parseJson = JSON.parse`
 *        - `JSON?.parse?.(text)` (optional chaining) and `JSON["parse"](text)` (computed string key)
 *      Recognised hosts: the unshadowed global `JSON`, and `globalThis|global|window|self|frames`
 *      `.JSON` (static or computed) when that container is itself the unshadowed global.
 *   2. `nativeJsonParseBinding` — the same capability lifted out of the global by destructuring or
 *      re-export: `const { parse } = JSON`, `const { parse: parseJson } = globalThis.JSON`. Reported
 *      once on the pattern property, because every later call through that binding is the same
 *      anti-pattern with the evidence erased.
 *
 * ## What is deliberately allowed
 *
 *   - Any shadowed / injected `JSON`: `const JSON = { parse: myParser }`, a `json: JsonPort`
 *     parameter, `import { JSON } from "./fake-json.ts"`. The scope chain is walked and a binding
 *     with any definition wins — only the real ambient global reports.
 *   - `JSON.stringify` and every other `JSON` member. Encoding is a different finding (C1 keeps
 *     "`JSON.stringify` inside external test fixture APIs that require a body string" in D tier) and
 *     is not this rule's business.
 *   - Correct Drizzle JSONB columns and HttpApi request/response serialization — C1 says explicitly
 *     "Do not replace correct Drizzle JSONB or HttpApi serialization". Those never call `JSON.parse`
 *     in application code (the driver and the platform own it), so they are untouched by
 *     construction.
 *   - Type positions: `typeof JSON.parse` parses as `TSTypeQuery` + `TSQualifiedName`, never a
 *     `MemberExpression`.
 *   - Test files, by default (`ignoreTestFiles: true`). D tier blesses hand JSON in external test
 *     fixture APIs and deliberately malformed payloads proving rejection behaviour; the audit's
 *     `JSON.parse` evidence is entirely production and script code. Set `ignoreTestFiles: false` to
 *     hold tests to the same bar once B2's harness lands.
 *   - Anything under `allowPaths` (empty by default — no carve-out is ratified yet).
 *
 * Scope lives in the rule (`includePaths` defaults to `apps/**`, `verticals/**`, `packages/**`,
 * `scripts/**`, which covers the app-root framework configs the A7 evidence cites, e.g.
 * `apps/shell-super-app/modern.config.ts`), so `oxlint.config.ts` only needs
 * `'effect-native/no-native-json-parse': 'error'`.
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
 * The *last* workspace marker wins so real sources (`<root>/apps/x/api/index.ts`) and the plugin's
 * own fixtures (`tools/.../fixtures/<rule>/invalid/apps/...`) classify identically; `normalisePath`
 * alone would stop at the enclosing `tools/` segment.
 */
function workspacePath(filename: string): string {
  const unified = filename.replaceAll('\\', '/');
  let best = -1;
  for (const marker of WORKSPACE_MARKERS) best = Math.max(best, unified.lastIndexOf(marker));
  return best === -1 ? normalisePath(unified) : unified.slice(best + 1);
}

/** Globals that expose the ambient `JSON` object as a property (`globalThis.JSON.parse`). */
const CONTAINER_GLOBALS = new Set(['globalThis', 'global', 'window', 'self', 'frames']);

const DEFAULT_INCLUDE_PATHS: readonly string[] = [
  'apps/**',
  'verticals/**',
  'packages/**',
  'scripts/**',
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

/** Wrappers that do not change which value an expression evaluates to. */
const TRANSPARENT_WRAPPERS = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

/** Strip parentheses, `as`/`!` casts and optional-chain wrappers from an expression. */
function unwrap(node: AnyNode): AnyNode {
  let current = node;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current.type === 'SequenceExpression') {
      current = current.expressions.at(-1)!;
      continue;
    }
    if (!TRANSPARENT_WRAPPERS.has(current.type)) return current;
    const inner = (current as { expression?: AnyNode }).expression;
    if (inner === undefined) return current;
    current = inner;
  }
  return current;
}

function parentOf(node: AnyNode): AnyNode | null {
  return (node as { parent?: AnyNode | null }).parent ?? null;
}

/** `JSON.parse` / `JSON["parse"]` → `"parse"`; a dynamic key → `null`. */
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

/** Effect-native rule: JSON text is decoded by `Schema.fromJsonString`, never by `JSON.parse`. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A3/A7/C1: `JSON.parse` yields untyped data plus an out-of-band SyntaxError, so configuration, topology documents and API-key metadata are parsed here and validated (if ever) somewhere else. Decode JSON text through `Schema.fromJsonString`, which composes parse and decode into one typed failure. Static global references only; direct in-memory JSON round-trip copies are excluded, without claiming they are safe.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#a7-give-topology-composition-and-authorization-evidence-shared-schemas',
    },
    messages: {
      nativeJsonParse:
        'Audit A3/A7/C1: `{{expression}}` yields untyped data and throws a generic `SyntaxError` outside the Effect error channel, so parsing and validation are two disconnected steps. Decode the text in one typed step with `Schema.decodeUnknownEffect(Schema.fromJsonString(TheSchema))(text)` — or `Config.schema(Schema.fromJsonString(TheSchema), "KEY")` for JSON-valued configuration — so a malformed document and an invalid document arrive as the same typed failure.',
      nativeJsonParseBinding:
        'Audit A3/A7/C1: `{{expression}}` lifts `JSON.parse` out of the global, so every later call parses untyped data and throws an untyped `SyntaxError` with the evidence hidden. Bind the decoder instead: `const decodeTopology = Schema.decodeUnknownEffect(Schema.fromJsonString(TopologySchema))`, and let the failure stay in the Effect error channel.',
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
              'Globs of files allowed to call `JSON.parse` — a ratified carve-out only (default: none).',
          },
          ignoreTestFiles: {
            type: 'boolean',
            description:
              'Skip test files (default: true — D tier keeps hand JSON in external test fixture APIs and deliberately malformed payloads).',
          },
          includePaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs the rule applies to (default: apps/**, verticals/**, packages/**, scripts/**).',
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
    const isJsonGlobal = (node: AnyNode): boolean => {
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

    return {
      // `JSON.parse(text)`, `lines.map(JSON.parse)`, `globalThis.JSON["parse"]`, `JSON?.parse?.(text)`.
      MemberExpression(node) {
        if (staticPropertyName(node) !== 'parse') return;
        if (!isJsonGlobal(node.object as AnyNode)) return;
        // A direct JSON round-trip is an in-memory copy, not an external document decode
        // (audit D native-object boundary). This does NOT prove it safe or equivalent to structuredClone.
        let callee: AnyNode = node;
        while (parentOf(callee) && TRANSPARENT_WRAPPERS.has(parentOf(callee)!.type))
          callee = parentOf(callee)!;
        const call = parentOf(callee);
        if (
          call?.type === 'CallExpression' &&
          call.callee === callee &&
          call.arguments.length === 1
        ) {
          const input = unwrap(call.arguments[0] as AnyNode);
          if (input.type === 'CallExpression' && input.arguments.length === 1) {
            const encoder = unwrap(input.callee as AnyNode);
            if (
              encoder.type === 'MemberExpression' &&
              staticPropertyName(encoder) === 'stringify' &&
              isJsonGlobal(encoder.object as AnyNode)
            )
              return;
          }
        }
        report(node as unknown as AnyNode, 'nativeJsonParse');
      },

      // `const { parse } = JSON` / `const { parse: parseJson } = globalThis.JSON`.
      ObjectPattern(node) {
        const parent = parentOf(node as unknown as AnyNode);
        if (parent === null) return;
        const source =
          parent.type === 'VariableDeclarator'
            ? ((parent as ESTree.VariableDeclarator).init as AnyNode | null)
            : parent.type === 'AssignmentExpression'
              ? ((parent as ESTree.AssignmentExpression).right as AnyNode)
              : null;
        if (source === null || !isJsonGlobal(source)) return;
        for (const property of node.properties) {
          if (property.type !== 'Property') continue;
          if (keyName((property as { key: AnyNode }).key) !== 'parse') continue;
          report(property as unknown as AnyNode, 'nativeJsonParseBinding');
        }
      },
    };
  },
});
