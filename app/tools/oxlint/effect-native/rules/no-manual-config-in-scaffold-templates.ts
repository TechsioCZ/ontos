import { optionRecord } from '../shared/options.ts';
/**
 * Audit findings: **A8** — "Fix the generators before generating more code" — and **A3** — "Replace
 * ambient configuration with Config, ConfigProvider, and Redacted"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`).
 *
 * A8 records that generators "emit Promise-first browser code, repeated route argument types,
 * per-call clients, manual error switches, and—in one stale template—manual JWK parsing that
 * production Contacts had already replaced", naming
 * `scripts/scaffolding/microvertical-action-boundary/scaffold.mts` (the action-boundary template),
 * `scripts/scaffolding/microvertical-page/scaffold.mts:236/243/374` and
 * `scripts/scaffolding/governed-contribution/scaffold.mts:281` as evidence. A3 supplies the target
 * shape the templates must emit instead: one configuration Schema decoded through `Config` /
 * `Config.schema` and a root `ConfigProvider`, `Schema.fromJsonString` for JSON-valued
 * configuration, `Redacted` / `Schema.Redacted` for key material and credentials, JWK material
 * loaded and imported **once in a Layer**, and one typed startup failure vocabulary instead of
 * `throw`.
 *
 * The concrete stale template this rule exists for is
 * `scripts/scaffolding/microvertical-action-boundary/scaffold.mts`'s `parseConfiguration`, which
 * emits `environment['ONTOS_GATEWAY_PUBLIC_JWKS']`, `JSON.parse(rawJwks)`,
 * `typeof parsed !== 'object'`, `Array.isArray(...)` guards, `parsed as Record<string, unknown>`,
 * hand-walked `key['kty'] / key['crv'] / key['alg'] / key['kid'] / key['x']` JWK members, a
 * `new URL(issuer)` protocol check, and roughly a dozen `throw configurationError()` sites.
 * Every generated boundary inherits all of it, so one stale template multiplies the debt the rest of
 * the plugin reports on hand-written code.
 *
 * What is detected
 * - Inside **generator template text only** — the static quasis of template literals in files that
 *   match `templatePaths` (scaffolds, generators, codegen, `*.template.*`). The generator's *own*
 *   driver code is untouched: a `throw new Error('--permission is required')` in the CLI argument
 *   parser is the script's business and is covered by `no-throw-in-scripts`, not by this rule.
 * - The default `patterns` are the A3/A8 configuration-plumbing shapes: `JSON.parse(`,
 *   `process.env`, `environment['SCREAMING_CASE']`-style ambient lookups, `new URL(`,
 *   `throw <callable>(` (throw-based configuration failure), `as Record<string, unknown>`,
 *   `typeof x !== 'object'`, `Array.isArray(`, JWK member indexing (`key['kty']`, `['crv']`,
 *   `['alg']`, `['use']`, `['kid']`, `['x']`, `['d']`, `['key_ops']`) and `dotenv`.
 * - Matches are reported once per occurrence, highlighting the containing quasi/string literal
 *   (the whole template for cross-interpolation shapes). Cooked offsets are not raw source offsets.
 *
 * What is deliberately allowed
 * - Every non-template line of a generator: imports, argument parsing, file-system plumbing,
 *   `JSON.parse` of a `package.json` the generator reads, its own `throw new Error(...)`.
 * - Templates that already emit the Effect-native shape: `Config.schema(Schema.Struct({...}))`,
 *   `Schema.fromJsonString(JsonWebKeySet)`, `Schema.Redacted`, `Layer.effect`, `Schema.TaggedError`
 *   failures — none of those match any default pattern.
 * - Test files (`ignoreTestFiles: true`), so `scripts/scaffolding/tests/*` snapshot expectations of
 *   the *current* generator output do not double-report, and the audit's D tier (deliberately
 *   malformed casts and hand-written fixtures in tests) stays untouched.
 * - Anything outside `templatePaths`, or matching `exclude` (generated output, `node_modules`).
 * - The audit's blessed `Array.isArray` normaliser, or any other pattern that turns out to be
 *   noise, can be dropped by passing a narrowed `patterns` array — the option replaces the default
 *   list wholesale.
 *
 * Known limitation: static template/string fragments are scanned lexically. Comments, emitted
 * quoted data, module-specifier literals and direct log/shell/error arguments are skipped. Named
 * environment bags and config context are heuristics, not binding/type or data-flow proof. Arbitrary
 * helper-returned source and dynamic interpolation values are not reconstructed. Report-only.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context } from '@oxlint/plugins';

import { booleanOption, compilePatterns, stringArray } from '../shared/options.ts';
import { isTestFile, matchesGlobs, scopePath } from '../shared/paths.ts';
import { snippet } from '../shared/reporting.ts';
import { driverText, emittedText, maskText, reportNode } from '../shared/scaffold-text.ts';
import type { StringNode } from '../shared/scaffold-text.ts';

/** Files whose template literals are emitted as source code for someone else's repository. */
const DEFAULT_TEMPLATE_PATHS: readonly string[] = [
  'scripts/scaffolding/**',
  'scripts/generate-*.{ts,mts,cts,tsx}',
  'scripts/**/generate-*.{ts,mts,cts,tsx}',
  'scripts/**/*scaffold*.{ts,mts,cts,tsx}',
  '**/scaffolding/**',
  '**/scaffolds/**',
  '**/generators/**',
  '**/codegen/**',
  '**/templates/**',
  '**/*.template.{ts,mts,cts,tsx,js,mjs}',
];

/** Generated or vendored output that is never hand-edited. */
const DEFAULT_EXCLUDE: readonly string[] = [
  '**/dist/**',
  '**/.output/**',
  '**/node_modules/**',
  '**/*.d.ts',
];

/**
 * Configuration-plumbing shapes no generator may emit. Sources (not `RegExp`s) so the whole list is
 * expressible in `oxlint.config.ts` / a fixture config; each is compiled with the `g` and `u` flags.
 */
const DEFAULT_PATTERNS: readonly string[] = [
  String.raw`\bJSON\s*(?:\.\s*parse|\[\s*['"]parse['"]\s*\])\s*\(`,
  String.raw`\b(?:process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env|Bun\s*\.\s*env|Deno\s*\.\s*env)\b`,
  String.raw`\b(?:environment|env|environmentVariables|processEnv|rawEnvironment|settings|secrets)\s*(?:\[\s*['"][A-Z][A-Z0-9_]{2,}['"]\s*\]|\.\s*[A-Z][A-Z0-9_]{2,}\b)`,
  String.raw`\bnew\s+URL\s*\(`,
  String.raw`\bthrow\s+(?:new\s+)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(`,
  String.raw`as\s+Record<\s*string\s*,\s*unknown\s*>`,
  String.raw`typeof\s+[\w$]+\s*[!=]==\s*['"]object['"]`,
  String.raw`Array\s*\.\s*isArray\s*\(`,
  String.raw`\b[A-Za-z_$][\w$]*\s*(?:\[\s*['"](?:kty|crv|alg|use|kid|key_ops)['"]\s*\]|\.\s*(?:kty|crv|alg|use|kid|key_ops)\b)`,
  String.raw`\b[\w$]*[Kk]ey\s*(?:\[\s*['"][xdney]['"]\s*\]|\.\s*[xdney]\b)`,
  String.raw`\bimport\s*['"]dotenv(?:/config)?['"]|\bdotenv\s*\.\s*config\s*\(`,
];

/** Longest snippet echoed back in the diagnostic message. */
const SNIPPET_LIMIT = 60;

interface RuleOptions {
  readonly templatePaths: readonly string[];
  readonly patterns: readonly string[];
  readonly exclude: readonly string[];
  readonly ignoreTestFiles: boolean;
}

function readOptions(context: Context): RuleOptions {
  const record = optionRecord(context.options?.[0]);
  return {
    templatePaths: stringArray(record.templatePaths, DEFAULT_TEMPLATE_PATHS),
    patterns: stringArray(record.patterns, DEFAULT_PATTERNS),
    exclude: stringArray(record.exclude, DEFAULT_EXCLUDE),
    ignoreTestFiles: booleanOption(record.ignoreTestFiles, true),
  };
}

interface Match {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface TemplateSource {
  readonly code: string;
  readonly syntax: string;
  readonly config: boolean;
}

function templateSource(text: string): TemplateSource {
  const syntax = maskText(text, true);
  // Audit D preserves ordinary URL construction and recursive JSON normalization.
  const config =
    /\b(?:ONTOS_[A-Z_]+|process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env|\w*[Jj][Ww][Kk]\w*|\w*[Cc]onfig\w*|issuer|environment)\b/u.test(
      syntax,
    );
  return { code: maskText(text), syntax, config };
}

function isConfigurationMatch(match: RegExpExecArray, source: TemplateSource): boolean {
  const text = match[0];
  // Matches starting inside emitted strings are data, not executable syntax.
  if (source.syntax[match.index] === ' ') return false;
  if (!source.config && /^(?:new\s+URL|Array\s*\.|typeof|as\s+Record)/u.test(text)) return false;
  if (!/^new\s+URL/u.test(text)) return true;
  return /^(?:issuer|endpoint|process\s*\.|environment\s*[.[])/iu.test(
    source.code.slice(match.index + text.length).trimStart(),
  );
}

function collectMatches(patterns: readonly RegExp[], source: TemplateSource): Match[] {
  const found: Match[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source.code)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex++;
        continue;
      }
      if (isConfigurationMatch(match, source))
        found.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    }
  }
  return found.sort((a, b) => a.start - b.start || b.end - a.end);
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A8 + A3: scaffold and generator templates must not emit hand-written configuration or JWK ' +
        "parsing — `JSON.parse`, ambient `process.env` / `environment['X']` lookups, `typeof`/`Array.isArray` " +
        'guards, `as Record<string, unknown>` casts, hand-walked JWK members or `throw`-based configuration ' +
        'errors. Emit `Config.schema` + `Schema.fromJsonString` decoding with `Redacted` key material loaded ' +
        'once in a Layer and typed `Schema.TaggedError` failures instead. Lexical emitted-text matching only; dynamic fragments and binding identity are not inferred.',
    },
    messages: {
      manualConfigInTemplate:
        'Generated code must not parse configuration or JWK material by hand (matched `{{snippet}}` in a ' +
        'generator template). Audit A8 names this stale template — the action-boundary generator still emits ' +
        'the JSON.parse/typeof/Array.isArray/`throw configurationError()` JWK walk that production Contacts ' +
        'already replaced — and A3 gives the shape to emit instead: decode one configuration Schema through ' +
        '`Config.schema(Schema.Struct({ ... }))`, use `Schema.fromJsonString(JsonWebKeySet)` for JSON-valued ' +
        'configuration, wrap key material and credentials in `Schema.Redacted`, load and import the JWK set ' +
        'once in a `Layer`, and fail with a typed `Schema.TaggedError` instead of `throw`.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          templatePaths: { type: 'array', items: { type: 'string' } },
          patterns: { type: 'array', items: { type: 'string' } },
          exclude: { type: 'array', items: { type: 'string' } },
          ignoreTestFiles: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        templatePaths: [...DEFAULT_TEMPLATE_PATHS],
        patterns: [...DEFAULT_PATTERNS],
        exclude: [...DEFAULT_EXCLUDE],
        ignoreTestFiles: true,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.templatePaths)) return {};
    if (matchesGlobs(path, options.exclude)) return {};
    if (options.ignoreTestFiles && isTestFile(path)) return {};

    const patterns = compilePatterns(options.patterns);
    if (patterns.length === 0) return {};

    function inspect(node: StringNode): void {
      if (driverText(node)) return;
      const text = emittedText(node);
      if (text.length === 0) return;
      const found = collectMatches(patterns, templateSource(text));
      let end = -1;
      for (const match of found) {
        if (match.start < end) continue;
        end = match.end;
        context.report({
          node: reportNode(node, match.start, match.end),
          messageId: 'manualConfigInTemplate',
          data: { snippet: snippet(match.text, SNIPPET_LIMIT) },
        });
      }
    }
    return {
      TemplateLiteral: inspect,
      Literal(node) {
        if (typeof node.value === 'string') inspect(node);
      },
    };
  },
});
