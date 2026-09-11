/**
 * Audit findings: **A3** — "Replace ambient configuration with Config, ConfigProvider, and Redacted"
 * and **A7** — "Give topology, composition, and authorization evidence shared Schemas"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`).
 *
 * A3 records that configuration "combines `process.env`, per-module dotenv loading, `trim`,
 * `new URL`, number/range checks, `JSON.parse`, synchronous Schema decoding, and throws", with
 * `apps/shell-super-app/api/auth/gateway-issuer-config.ts:57` and
 * `verticals/contacts/api/auth/action-principal.ts:117` among the evidence sites. A7 records that
 * "authoritative topology and authorization documents are decoded using combinations of
 * `JSON.parse`, `Schema.Json`, optional interfaces, structural walking, exact-key comparisons, and
 * casts", with `apps/shell-super-app/api/modules/deployment-allowlist.ts:25`,
 * `apps/shell-super-app/api/verticals/installed-verticals.ts:37` and the
 * `scripts/authorization/*` readers among the evidence sites.
 *
 * The shared defect is the *synchronous* codec entry point. `Schema.decodeUnknownSync` throws a
 * `SchemaError` (v4) / `ParseError` (v3) out of band, so the caller either lets it escape as a
 * defect or wraps it in `try/catch` / `Effect.try` and collapses the `ParseIssue` into a generic
 * error — exactly the "blanket collapse" the audit's error-model targets remove. The Effect-native
 * entry points keep the failure in a typed channel: `Schema.decodeUnknownEffect` /
 * `Schema.decodeUnknownResult` (and their `encode*` / `validate*` siblings) for program code, and
 * `Config.schema` + a root `ConfigProvider` for configuration, so one typed startup failure
 * vocabulary survives to the caller.
 *
 * What is detected
 * - Any reference to a synchronous Schema codec entry point — by default `decodeSync`,
 *   `decodeUnknownSync`, `encodeSync`, `encodeUnknownSync`, `validateSync` (configurable via
 *   `members`) — on Effect's `Schema` namespace, whether called (`Schema.decodeUnknownSync(S)(x)`)
 *   or referenced point-free (`pipe(raw, Schema.decodeUnknownSync(S))`,
 *   `const decode = Schema.decodeUnknownSync(S)`, `map(Schema.decodeUnknownSync(S))`).
 * - Aliased imports (`import { Schema as S } from "effect"`), submodule namespace imports
 *   (`import * as Schema from "effect/Schema"`), the Effect barrel (`import * as Effect from "effect"`
 *   then `Effect.Schema.decodeUnknownSync`), direct member imports
 *   (`import { decodeUnknownSync } from "effect/Schema"`), Effect re-export barrels
 *   (`@modern-js/bff-effect/effect-client`, configurable via `reexportModules`), computed access
 *   (`Schema["decodeUnknownSync"]`) and optional chaining (`Schema?.decodeUnknownSync`).
 * - `.ts`, `.mts`, `.cts` and `.tsx`/`.jsx` alike, across `apps/`, `verticals/`, `packages/` and
 *   `scripts/`. Library code that is not currently inside any Effect is still an A7 target: the
 *   remedy is to return a `Result`/`Effect` from the decoder, not to keep throwing.
 *
 * What is deliberately allowed
 * - **Known framework configuration basenames** (DEFAULT_ALLOW_PATHS). An arbitrary
 *   `*.config.ts` document reader is not a forced framework seam: A7 explicitly names the
 *   module-deployment-allowlist config and requires build readers to share document Schemas.
 * - **Test files** (`ignoreTestFiles`, default `true`): the audit blesses "several tests already
 *   decode responses through Schema", and `assert.throws(() => Schema.decodeUnknownSync(S)(bad))`
 *   is the deliberate rejection-proving shape from the D tier.
 * - Everything that is not Effect's `Schema` namespace: a local `const Schema = { decodeUnknownSync }`
 *   shadow, a hand-rolled `codec.decodeUnknownSync(...)`, an object literal *declaring* a
 *   `decodeUnknownSync` property, or a `Schema` imported from a non-Effect module.
 * - Every other D-tier / "existing patterns to preserve" shape — correct Drizzle JSONB and HttpApi
 *   serialization, `Layer.orDie` at a deliberate startup root, `JSON.stringify` in external test
 *   fixture APIs, native array operations: this rule looks at exactly one small member set on
 *   exactly one namespace.
 *
 * Static limits: follows immutable lexical namespace aliases, not dynamic imports, mutable aliases
 * or cross-file reexports. Named exports from effect/Schema report at the export boundary.
 *
 * Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree } from '@oxlint/plugins';

import { keyName } from '../shared/ast.ts';
import { lookupVariable } from '../shared/bindings.ts';
import { booleanOption, optionRecord, stringArray } from '../shared/options.ts';
import { isTestFile, matchesGlobs, scopePath } from '../shared/paths.ts';
import { isNonReferencePosition, isInErasedTypePosition } from '../shared/reference-positions.ts';
import { schemaIdentity } from '../shared/schema-identity.ts';

const EFFECT_SCHEMA_MODULE = /^effect\/(?:.*\/)?Schema$/u;

/** Synchronous, throwing codec entry points. Everything here has an `Effect`/`Result` sibling. */
const DEFAULT_MEMBERS = ['decodeSync', 'decodeUnknownSync', 'encodeSync', 'encodeUnknownSync', 'validateSync'];

/**
 * Bundler / test-runner configuration roots. These modules are evaluated by the framework before any
 * Effect runtime exists, so a throw is the only failure channel available to them.
 */
const DEFAULT_ALLOW_PATHS = [
  '{apps,verticals,packages}/*/{module-federation,backend-federation,modern,rstest,drizzle,drizzle.auth,tailwind,playwright}.config.{ts,mts,js,mjs,cts,cjs}',
];

/**
 * Barrels that re-export Effect namespaces verbatim (`export * as Schema from "effect/Schema"`), so
 * `Schema` imported from them *is* Effect's `Schema`.
 */
const DEFAULT_REEXPORT_MODULES = [
  '@modern-js/bff-effect/effect-client',
  '@modern-js/bff-effect/effect-edge',
  '@modern-js/bff-effect/effect-*',
];

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly ignoreTestFiles: boolean;
  readonly members: readonly string[];
  readonly reexportModules: readonly string[];
}

function readOptions(context: Context): RuleOptions {
  const record = optionRecord(context.options?.[0]);
  return {
    allowPaths: stringArray(record.allowPaths, DEFAULT_ALLOW_PATHS),
    ignoreTestFiles: booleanOption(record.ignoreTestFiles, true),
    members: stringArray(record.members, DEFAULT_MEMBERS),
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
  };
}

/** Runtime references exclude both name positions and erased TS ancestry. */
function isDeclarationPosition(node: ESTree.Node): boolean {
  return isNonReferencePosition(node, { variableBindings: true }) || isInErasedTypePosition(node);
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A3/A7: disallow synchronous Schema codec entry points (`Schema.decodeUnknownSync`, ' +
        '`encodeSync`, `validateSync`, …) outside tests and framework configuration roots. They throw the ' +
        '`SchemaError` out of band, so callers wrap them in `try/catch` and collapse the `ParseIssue`; use ' +
        '`Schema.decodeUnknownEffect` / `Schema.decodeUnknownResult`, or `Config.schema` for configuration, ' +
        'so the failure stays in a typed channel.',
    },
    messages: {
      syncCodecBare:
        '`{{member}}` (imported from `effect/Schema`) throws instead of failing typed: the `SchemaError` ' +
        'escapes as a defect or gets caught and collapsed, discarding the `ParseIssue` (audit A3/A7). ' +
        'Import `{{effectful}}` (or `{{result}}` where no Effect context exists) so the decode failure ' +
        'stays in the error channel, and decode configuration through `Config.schema` with a root ' +
        '`ConfigProvider` instead of parsing it inline.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowPaths: { type: 'array', items: { type: 'string' } },
          ignoreTestFiles: { type: 'boolean' },
          members: { type: 'array', items: { type: 'string' } },
          reexportModules: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        allowPaths: DEFAULT_ALLOW_PATHS,
        ignoreTestFiles: true,
        members: DEFAULT_MEMBERS,
        reexportModules: DEFAULT_REEXPORT_MODULES,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.allowPaths)) return {};
    if (options.ignoreTestFiles && isTestFile(path)) return {};

    const members = new Set(options.members);
    if (members.size === 0) return {};

    /** `decodeUnknownSync` → `decodeUnknownEffect` / `decodeUnknownResult`. */
    const replacements = (member: string): { effectful: string; result: string } => {
      const base = member.replace(/Sync$/u, '');
      return { effectful: `${base}Effect`, result: `${base}Result` };
    };

    const report = (node: ESTree.Node, member: string): void => {
      context.report({
        node,
        messageId: 'syncCodecBare',
        data: { member, ...replacements(member) },
      });
    };
    return {
      MemberExpression(node) {
        const member = schemaIdentity(context, node, options.reexportModules, 0, {
          templates: true,
          unwrap: {},
        });
        if (member !== null && members.has(member)) report(node, member);
      },
      Identifier(node) {
        if (isDeclarationPosition(node)) return;
        // Destructured aliases report at capture, not at every subsequent use.
        const variable = lookupVariable(context, node);
        if (!variable?.defs.some((def) => def.type === 'ImportBinding')) return;
        const member = schemaIdentity(context, node, options.reexportModules, 0, {
          templates: true,
          unwrap: {},
        });
        if (member !== null && members.has(member)) report(node, member);
      },
      VariableDeclarator(node) {
        if (node.id.type !== 'ObjectPattern' || node.init === null) return;
        if (
          schemaIdentity(context, node.init, options.reexportModules, 0, {
            templates: true,
            unwrap: {},
          }) !== '@schema'
        )
          return;
        for (const property of node.id.properties) {
          if (property.type !== 'Property') continue;
          const member = keyName(property.key, property.computed);
          if (member && members.has(member)) report(property, member);
        }
      },
      ExportNamedDeclaration(node) {
        if (!node.source || !EFFECT_SCHEMA_MODULE.test(node.source.value) || node.exportKind === 'type') return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ExportSpecifier' || specifier.exportKind === 'type') continue;
          const member = specifier.local.type === 'Identifier' ? specifier.local.name : specifier.local.value;
          if (members.has(member)) report(specifier, member);
        }
      },
    };
  },
});
