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

import type { ESTree } from '@oxlint/plugins';

import {
  EXPRESSION_WRAPPERS,
  keyName,
  memberName,
  parentOf,
  skipWrappers,
  unwrapNode,
} from '../shared/ast.ts';
import { isJsonHost, jsonExpressionSnippet } from '../shared/json-globals.ts';
import { booleanOption, stringList } from '../shared/options.ts';
import { isTestFile, matchesAny, workspacePath } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

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

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Partial<Record<keyof RuleOptions, unknown>>;
  const includePaths = stringList(given.includePaths, DEFAULTS.includePaths);
  return {
    allowPaths: stringList(given.allowPaths, DEFAULTS.allowPaths),
    ignoreTestFiles: booleanOption(given.ignoreTestFiles, DEFAULTS.ignoreTestFiles),
    includePaths: includePaths.length > 0 ? includePaths : DEFAULTS.includePaths,
  };
}

const UNWRAP_OPTIONS = { wrappers: EXPRESSION_WRAPPERS, maxDepth: 8, sequence: true };
const STRING_OPTIONS = {
  templates: true,
  rawTemplates: false,
  singleQuasi: false,
  unwrap: UNWRAP_OPTIONS,
};

function unwrap(node: AnyNode): AnyNode {
  return unwrapNode(node, UNWRAP_OPTIONS);
}

function staticPropertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed && unwrap(node.property).type !== 'Identifier') return null;
  return memberName(node, STRING_OPTIONS);
}

/** A single-input call whose callee is the supplied expression, through transparent wrappers. */
function singleInputCall(node: AnyNode): ESTree.CallExpression | null {
  const { node: callee, parent } = skipWrappers(node, EXPRESSION_WRAPPERS);
  if (parent?.type !== 'CallExpression' || parent.callee !== callee) return null;
  return parent.arguments.length === 1 ? parent : null;
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

    const report = (node: AnyNode, messageId: string): void => {
      context.report({
        node,
        messageId,
        data: { expression: jsonExpressionSnippet(context.sourceCode.getText(node)) },
      });
    };

    const isJsonGlobal = (node: AnyNode): boolean =>
      isJsonHost(context, node, {
        containers: CONTAINER_GLOBALS,
        unwrap,
        memberName: staticPropertyName,
      });

    const isRoundTrip = (node: ESTree.MemberExpression): boolean => {
      const call = singleInputCall(node);
      if (call === null) return false;
      const input = unwrap(call.arguments[0] as AnyNode);
      if (input.type !== 'CallExpression' || input.arguments.length !== 1) return false;
      const encoder = unwrap(input.callee as AnyNode);
      return (
        encoder.type === 'MemberExpression' &&
        staticPropertyName(encoder) === 'stringify' &&
        isJsonGlobal(encoder.object as AnyNode)
      );
    };

    return {
      // `JSON.parse(text)`, `lines.map(JSON.parse)`, `globalThis.JSON["parse"]`, `JSON?.parse?.(text)`.
      MemberExpression(node) {
        if (staticPropertyName(node) !== 'parse') return;
        if (!isJsonGlobal(node.object as AnyNode)) return;
        // A direct JSON round-trip is an in-memory copy, not an external document decode
        // (audit D native-object boundary). This does NOT prove it safe or equivalent to structuredClone.
        if (isRoundTrip(node)) return;
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
          if (keyName(property.key, false, STRING_OPTIONS) !== 'parse') continue;
          report(property as unknown as AnyNode, 'nativeJsonParseBinding');
        }
      },
    };
  },
});
