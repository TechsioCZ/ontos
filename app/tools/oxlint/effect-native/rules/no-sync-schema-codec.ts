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
 *   (`@modern-js/plugin-bff/effect-client`, configurable via `reexportModules`), computed access
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

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

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

/** Synchronous, throwing codec entry points. Everything here has an `Effect`/`Result` sibling. */
const DEFAULT_MEMBERS = [
  'decodeSync',
  'decodeUnknownSync',
  'encodeSync',
  'encodeUnknownSync',
  'validateSync',
];

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
  '@modern-js/plugin-bff/effect-client',
  '@modern-js/plugin-bff/effect-edge',
  '@modern-js/plugin-bff/effect-*',
];

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly ignoreTestFiles: boolean;
  readonly members: readonly string[];
  readonly reexportModules: readonly string[];
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
    ignoreTestFiles: boolean(record.ignoreTestFiles, true),
    members: stringArray(record.members, DEFAULT_MEMBERS),
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
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

/** Non-computed `.decodeUnknownSync`, or computed `["decodeUnknownSync"]`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const property = unwrapExpression(node.property);
  if (property.type === 'TemplateLiteral' && property.expressions.length === 0)
    return property.quasis[0]?.value.cooked ?? null;
  if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
  return null;
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

/** Declaration / key positions where an identifier is not a *reference* to the import. */
function isDeclarationPosition(node: Extract<ESTree.Node, { type: 'Identifier' }>): boolean {
  const parent = node.parent;
  if (parent === null || parent === undefined) return true;
  if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier') return true;
  if (parent.type === 'ImportNamespaceSpecifier' || parent.type === 'ExportSpecifier') return true;
  // Erased type syntax is never a runtime codec reference. Expression wrappers retain values.
  let ancestor: ESTree.Node | null = parent;
  let child: ESTree.Node = node;
  while (ancestor) {
    if (
      ancestor.type.startsWith('TS') &&
      !('expression' in ancestor && ancestor.expression === child)
    )
      return true;
    child = ancestor;
    ancestor = ancestor.parent ?? null;
  }
  if (parent.type === 'VariableDeclarator' && parent.id === node) return true;
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
    return true;
  if (parent.type === 'Property' && parent.key === node && !parent.computed) return true;
  if (parent.type === 'PropertyDefinition' && parent.key === node && !parent.computed) return true;
  if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) return true;
  return false;
}

function unwrapExpression(node: ESTree.Node): ESTree.Node {
  let current = node;
  while (
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'ChainExpression',
      'ParenthesizedExpression',
      'TSInstantiationExpression',
      'TSTypeAssertion',
    ].includes(current.type)
  ) {
    if (!('expression' in current)) break;
    current = current.expression as ESTree.Node;
  }
  return current;
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
        'Audit A3/A7: disallow synchronous Schema codec entry points (`Schema.decodeUnknownSync`, ' +
        '`encodeSync`, `validateSync`, …) outside tests and framework configuration roots. They throw the ' +
        '`SchemaError` out of band, so callers wrap them in `try/catch` and collapse the `ParseIssue`; use ' +
        '`Schema.decodeUnknownEffect` / `Schema.decodeUnknownResult`, or `Config.schema` for configuration, ' +
        'so the failure stays in a typed channel.',
    },
    messages: {
      syncCodec:
        '`{{namespace}}.{{member}}` throws instead of failing typed: the `SchemaError` escapes as a defect ' +
        'or gets caught and collapsed, discarding the `ParseIssue` (audit A3 — ambient configuration parsed ' +
        'with synchronous Schema decoding and throws; audit A7 — topology/authorization evidence decoded ' +
        'with `JSON.parse` + sync Schema + casts). Use `{{namespace}}.{{effectful}}` (or ' +
        '`{{namespace}}.{{result}}` where no Effect context exists) so the decode failure stays in the ' +
        'error channel, and decode configuration through `Config.schema` with a root `ConfigProvider` ' +
        'instead of parsing it inline. Framework config roots and tests are already allowed by this rule.',
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
        const member = schemaIdentity(context, node, options.reexportModules);
        if (member !== null && members.has(member)) report(node, member);
      },
      Identifier(node) {
        if (isDeclarationPosition(node)) return;
        // Destructured aliases report at capture, not at every subsequent use.
        const variable = lookupVariable(context, node);
        if (!variable?.defs.some((def) => def.type === 'ImportBinding')) return;
        const member = schemaIdentity(context, node, options.reexportModules);
        if (member !== null && members.has(member)) report(node, member);
      },
      VariableDeclarator(node) {
        if (node.id.type !== 'ObjectPattern' || node.init === null) return;
        if (schemaIdentity(context, node.init, options.reexportModules) !== '@schema') return;
        for (const property of node.id.properties) {
          if (property.type !== 'Property') continue;
          const key = property.key;
          const member =
            !property.computed && key.type === 'Identifier'
              ? key.name
              : key.type === 'Literal' && typeof key.value === 'string'
                ? key.value
                : key.type === 'TemplateLiteral' && key.expressions.length === 0
                  ? key.quasis[0]?.value.cooked
                  : null;
          if (member && members.has(member)) report(property, member);
        }
      },
      ExportNamedDeclaration(node) {
        if (
          !node.source ||
          !EFFECT_SCHEMA_MODULE.test(node.source.value) ||
          node.exportKind === 'type'
        )
          return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ExportSpecifier' || specifier.exportKind === 'type') continue;
          const member =
            specifier.local.type === 'Identifier' ? specifier.local.name : specifier.local.value;
          if (members.has(member)) report(specifier, member);
        }
      },
    };
  },
});
