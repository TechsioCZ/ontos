/**
 * Audit findings: **A1** — "Establish one process-level Layer and ManagedRuntime composition model"
 * ("Move Bearer/JWK verification and imported key material into long-lived services rather than
 * rebuilding them per request") and **A3** — "Replace ambient configuration with Config,
 * ConfigProvider, and Redacted" ("Load and import JWK material once in a Layer").
 * See `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`.
 *
 * Concrete evidence the rule exists for:
 * - `apps/shell-super-app/api/auth/gateway-issuer.ts:97` — `importJWK(configuration.privateJwk, …)`
 *   re-imported inside the `Effect.tryPromise` body of every assertion signing call.
 * - `verticals/contacts/api/auth/action-principal.ts:232` — `createLocalJWKSet(configuration.jwks)`
 *   rebuilt inside every `jwtVerify` for every inbound action request.
 * - `scripts/scaffolding/microvertical-action-boundary/scaffold.mts:262` — the generator template that
 *   *emits* the second pattern into every new MicroVertical (audit A8: fix the generators first).
 *
 * What is detected
 * - A call whose callee resolves to key-material construction:
 *   - a named import from `jose` — including deep subpaths (`jose/jwks/local`, `jose/key/import`, …)
 *     which the package genuinely publishes — for `importJWK`, `importSPKI`, `importPKCS8`,
 *     `importX509`, `createLocalJWKSet`, `createRemoteJWKSet`; aliases
 *     (`import { importJWK as load } from "jose"`) and namespace access (`jose.importJWK`) included;
 *   - a named/default/namespace import from `node:crypto` / `crypto` (default `createPublicKey`,
 *     `createPrivateKey`, `createSecretKey`);
 *   - a WebCrypto member chain ending in `subtle.importKey` / `subtle.generateKey`
 *     (`crypto.subtle.importKey`, `globalThis.crypto.subtle.generateKey`, `webcrypto.subtle.…`).
 *   Computed access (`jose["importJWK"]`) and optional chaining (`jose?.importJWK?.(…)`) are covered.
 * - One-hop lexical rebindings of those bindings, because renaming is the cheapest way around a
 *   report-only rule: `const load = importJWK`, `const load = jose.importJWK`,
 *   `const { createLocalJWKSet } = jose`, `const { subtle } = globalThis.crypto`,
 *   `const subtle = crypto.subtle`, `const { importKey } = crypto.subtle`.
 * - The CommonJS / dynamic spellings of the same import, which a static `ImportDeclaration` scan misses:
 *   `const jose = require("jose")`, `const { importJWK } = await import("jose")`,
 *   `const { createPrivateKey } = require("node:crypto")`.
 * - Point-free *references* to the same bindings inside a per-request function, e.g.
 *   `Effect.promise(importJWK)` or `pipe(jwk, importJWK)`.
 * - Occurrences inside generator/scaffold **template literals** (`scanGeneratorTemplates`), because a
 *   generator that emits per-request key material multiplies the anti-pattern across MicroVerticals.
 *   The template scan is lexical: a match is skipped when a `Layer.effect(`/`Layer.scoped(`/
 *   `Effect.cached…` marker appears earlier **in the same template literal** (no character window, so
 *   a realistically sized emitted Layer body still counts as fixed). `importKey`/`generateKey` are
 *   ordinary application identifiers, so inside templates they only match after `subtle.`.
 *
 * What is deliberately allowed
 * - Module-scope construction (`const jwks = createLocalJWKSet(staticJwks);`) — that is already
 *   "import it once".
 * - Anything lexically inside `Layer.effect|scoped|sync|unwrap|unwrapScoped|succeed(…)` or
 *   `Effect.cached|cachedWithTTL|cachedFunction|cachedInvalidateWithTTL|once(…)`, which is exactly the
 *   Effect-native target shape ("build the key material once in a Layer / a cached Effect").
 *   `Layer`/`Effect` may be aliased, submodule-imported (`import * as Layer from "effect/Layer"`),
 *   reached through a root namespace import (`import * as E from "effect"` → `E.Layer.effect`) or
 *   through an Effect re-export barrel (`reexportModules`).
 * - **The repo's established `Context.Service` idiom**: a `Context.Service` tag takes only a tag, so the
 *   build effect must live in a named module-level factory that is handed to the Layer by reference —
 *   `Layer.effect(AuthConfig, loadAuthConfig())`, `Layer.effect(PrincipalResolver,
 *   CoreDatabase.pipe(Effect.map(makePrincipalResolver)))`. A key site inside a module-level function
 *   whose name is referenced inside a `Layer.effect|scoped|sync|unwrap|unwrapScoped` / `Effect.cached*`
 *   argument **in the same module** is therefore cleared (a one-hop, module-local check — no call
 *   graph). `Layer.succeed` is excluded from that one-hop clearance: a function handed to
 *   `Layer.succeed` is a *method* of an already-built service and still runs per request.
 * - Verification/signing entry points themselves (`jwtVerify`, `SignJWT`, `decodeProtectedHeader`, …):
 *   those are per-request by nature; only the *key material* they consume must be hoisted.
 * - A locally bound `crypto` (including env.runtime.crypto and unrelated imports) — a DI port parameter `(crypto: CryptoPort) => crypto.subtle.importKey(…)`
 *   or a local object literal — is not WebCrypto; only an unresolved global or an imported binding
 *   (`import { webcrypto as wc } from "node:crypto"`) roots a reported `subtle` chain.
 *   A dotted suffix alone cannot establish WebCrypto provenance; the earlier spec overreached there.
 * - Test files (`includeTests: false` by default) — the audit's D tier blesses per-test key generation
 *   (`generateKeyPair` / `exportJWK` in fixtures) and deliberately hand-rolled test material.
 * - Anything outside `include` or matching `ignore`.
 *
 * Narrower than the earlier spec: generateKey/exportJWK do not prove repeated import of stable
 * verification material. Ephemeral per-operation generation/export can be required by a protocol;
 * hoisting it would change security semantics. Those members are opt-in, not default findings.
 * Known limitations (accepted, report-only — the rule never fixes and never suggests)
 * - No call graph: a helper only ever invoked from a Layer body is still reported unless the one-hop
 *   module-local check above clears it.
 * - Purely lexical wrapper detection: building the key inside a per-request closure that a Layer merely
 *   *returns* (`Layer.effect(Tag, Effect.sync(() => (t) => jwtVerify(t, createLocalJWKSet(cfg))))`)
 *   is not reported; distinguishing a generator/thunk body from a returned request handler needs types.
 * - A class field initializer has no function ancestor, so `class S { jwks = createLocalJWKSet(cfg) }`
 *   is treated as module-scope-equivalent and is not reported.
 * - A local re-export barrel (`export { importJWK } from "jose"` in one file, imported from another)
 *   is not followed: resolving it needs cross-file resolution, which an Oxlint JS plugin does not have.
 *   Add the barrel specifier to `joseModules` if a repo ever grows one.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings, type EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production defaults instead of forcing the
 * fixture config to pass loosened options (which `run-on-repo.mts` reuses verbatim).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];
const DEFAULT_IGNORE: readonly string[] = [];

/** `jose` publishes deep subpaths (`jose/jwks/local`, `jose/key/import`, `jose/key/generate/*`). */
const DEFAULT_JOSE_MODULES = ['jose', 'jose/**'];
const DEFAULT_JOSE_MEMBERS = [
  'importJWK',
  'importSPKI',
  'importPKCS8',
  'importX509',
  'createLocalJWKSet',
  'createRemoteJWKSet',
];

const DEFAULT_NODE_CRYPTO_MODULES = ['node:crypto', 'crypto', 'node:crypto/**'];
const DEFAULT_NODE_CRYPTO_MEMBERS = ['createPublicKey', 'createPrivateKey', 'createSecretKey'];

const DEFAULT_SUBTLE_MEMBERS = ['importKey'];

/** Layer constructors that make "once per layer build" the evaluation semantics. */
const DEFAULT_LAYER_WRAPPERS = ['effect', 'scoped', 'sync', 'unwrap', 'unwrapScoped', 'succeed'];
/**
 * Layer constructors whose second argument is an *effect/thunk that builds the service*, so a named
 * factory handed to them by reference is still evaluated once per Layer build. `succeed` is absent on
 * purpose: a function passed to `Layer.succeed` is a method of an already-built value.
 */
const DEFAULT_LAYER_BUILDER_WRAPPERS = ['effect', 'scoped', 'sync', 'unwrap', 'unwrapScoped'];
/** Effect combinators that memoise the produced value instead of recomputing it per call. */
const DEFAULT_EFFECT_WRAPPERS = [
  'cached',
  'cachedWithTTL',
  'cachedFunction',
  'cachedInvalidateWithTTL',
  'once',
];

/** Barrels that re-export Effect namespaces verbatim; `Layer` from them is Effect's `Layer`. */
const DEFAULT_REEXPORT_MODULES = ['@modern-js/plugin-bff/effect-edge'];

/** Files whose template literals carry generated source (audit A8). */
const DEFAULT_GENERATOR_FILES = [
  'scripts/**',
  '**/generators/**',
  '**/generator/**',
  '**/scaffolding/**',
  '**/scaffold/**',
  '**/templates/**',
];

const EFFECT_ROOT_MODULE = 'effect';
const LAYER_NAMESPACE = 'Layer';
const EFFECT_NAMESPACE = 'Effect';

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** Dotted object path of a `…subtle.importKey` chain: the part before `.importKey`. */
const SUBTLE_ROOT = /(?:^|\.)(?:crypto|webcrypto)\.subtle$/u;
/** Dotted path of a WebCrypto root object (`crypto`, `globalThis.crypto`, `webcrypto`). */
const CRYPTO_ROOT = /(?:^|\.)(?:crypto|webcrypto)$/u;

/** Lexical markers that prove an emitted snippet already builds the key once. */
const TEMPLATE_WRAPPER_MARKER =
  /\b(?:Layer\.(?:effect|scoped|sync|unwrap|unwrapScoped|succeed)|Effect\.(?:cached|cachedWithTTL|cachedFunction|cachedInvalidateWithTTL|once))\s*\(/u;

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly joseModules: readonly string[];
  readonly joseMembers: readonly string[];
  readonly nodeCryptoModules: readonly string[];
  readonly nodeCryptoMembers: readonly string[];
  readonly subtleMembers: readonly string[];
  readonly layerWrappers: readonly string[];
  readonly layerBuilderWrappers: readonly string[];
  readonly effectWrappers: readonly string[];
  readonly reexportModules: readonly string[];
  readonly includeTests: boolean;
  readonly scanGeneratorTemplates: boolean;
  readonly generatorFiles: readonly string[];
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
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
    joseModules: stringArray(record.joseModules, DEFAULT_JOSE_MODULES),
    joseMembers: stringArray(record.joseMembers, DEFAULT_JOSE_MEMBERS),
    nodeCryptoModules: stringArray(record.nodeCryptoModules, DEFAULT_NODE_CRYPTO_MODULES),
    nodeCryptoMembers: stringArray(record.nodeCryptoMembers, DEFAULT_NODE_CRYPTO_MEMBERS),
    subtleMembers: stringArray(record.subtleMembers, DEFAULT_SUBTLE_MEMBERS),
    layerWrappers: stringArray(record.layerWrappers, DEFAULT_LAYER_WRAPPERS),
    layerBuilderWrappers: stringArray(record.layerBuilderWrappers, DEFAULT_LAYER_BUILDER_WRAPPERS),
    effectWrappers: stringArray(record.effectWrappers, DEFAULT_EFFECT_WRAPPERS),
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
    includeTests: record.includeTests === true,
    scanGeneratorTemplates: record.scanGeneratorTemplates !== false,
    generatorFiles: stringArray(record.generatorFiles, DEFAULT_GENERATOR_FILES),
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

/** Non-computed `.member`, or computed `["member"]`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (node.type !== 'MemberExpression') return null;
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const property = node.property;
  if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
  return null;
}

/** Static key of an object-pattern / object-literal property (`{ subtle }`, `{ "importKey": k }`). */
function propertyKeyName(property: ESTree.Node): string | null {
  if (property.type !== 'Property') return null;
  if (property.computed) {
    return property.key.type === 'Literal' && typeof property.key.value === 'string'
      ? property.key.value
      : null;
  }
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal' && typeof property.key.value === 'string')
    return property.key.value;
  return null;
}

/** `globalThis.crypto.subtle` → `"globalThis.crypto.subtle"`; `null` for any dynamic segment. */
function dottedPath(node: ESTree.Node): string | null {
  if (node.type === 'Identifier') return node.name;
  if (node.type !== 'MemberExpression') return null;
  const property = memberName(node);
  if (property === null) return null;
  const object = dottedPath(node.object);
  return object === null ? null : `${object}.${property}`;
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
 * `true` when the identifier still resolves to an `import` binding, or to nothing at all (a global
 * such as `crypto`). Only a local shadow — parameter, `const`, catch clause, class name — rejects.
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

interface KeyBindings {
  /** `import { importJWK } from "jose"` / `import { createSecretKey } from "node:crypto"`. */
  readonly direct: Map<string, string>;
  /** `import * as jose from "jose"` (namespace or default) → allowed member list. */
  readonly namespaces: Map<string, readonly string[]>;
}

function collectKeyBindings(program: ESTree.Program, options: RuleOptions): KeyBindings {
  const direct = new Map<string, string>();
  const namespaces = new Map<string, readonly string[]>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (statement.importKind === 'type') continue;
    const source = statement.source.value;
    const isJose = matchesGlobs(source, options.joseModules);
    const isNodeCrypto = matchesGlobs(source, options.nodeCryptoModules);
    if (!isJose && !isNodeCrypto) continue;
    const members = isJose ? options.joseMembers : options.nodeCryptoMembers;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier') {
        if (specifier.importKind === 'type') continue;
        const imported = importedName(specifier);
        if (members.includes(imported)) direct.set(specifier.local.name, imported);
      } else if (
        specifier.type === 'ImportNamespaceSpecifier' ||
        specifier.type === 'ImportDefaultSpecifier'
      ) {
        const existing = namespaces.get(specifier.local.name) ?? [];
        namespaces.set(specifier.local.name, [...existing, ...members]);
      }
    }
  }
  return { direct, namespaces };
}

/** Names bound at module top level — the granularity of the one-hop "handed to a Layer" check. */
function collectModuleBindingNames(program: ESTree.Program): ReadonlySet<string> {
  const names = new Set<string>();
  const record = (declaration: ESTree.Node | null | undefined): void => {
    if (declaration === null || declaration === undefined) return;
    if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
      if (declaration.id !== null && declaration.id !== undefined) names.add(declaration.id.name);
      return;
    }
    if (declaration.type !== 'VariableDeclaration') return;
    for (const declarator of declaration.declarations) {
      if (declarator.id.type === 'Identifier') names.add(declarator.id.name);
    }
  };
  for (const statement of program.body) {
    if (
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration'
    ) {
      record(statement.declaration);
    } else record(statement);
  }
  return names;
}

/** Locals standing for Effect's `Layer`/`Effect` namespaces, plus whole-barrel namespace locals. */
function collectWrapperLocals(
  program: ESTree.Program,
  bindings: EffectBindings,
  options: RuleOptions,
): { layer: ReadonlySet<string>; effect: ReadonlySet<string>; barrel: ReadonlySet<string> } {
  const layer = new Set<string>();
  const effect = new Set<string>();
  const barrel = new Set<string>();
  for (const [local, namespace] of bindings.namespaces) {
    if (namespace === LAYER_NAMESPACE) layer.add(local);
    else if (namespace === EFFECT_NAMESPACE) effect.add(local);
  }
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    const source = statement.source.value;
    if (source !== EFFECT_ROOT_MODULE && !matchesGlobs(source, options.reexportModules)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') barrel.add(specifier.local.name);
      else if (specifier.type === 'ImportSpecifier') {
        const imported = importedName(specifier);
        if (imported === LAYER_NAMESPACE) layer.add(specifier.local.name);
        else if (imported === EFFECT_NAMESPACE) effect.add(specifier.local.name);
      }
    }
  }
  return { layer, effect, barrel };
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A1/A3: import JWK and other key material once inside a Layer (Config + Redacted), not on every ' +
        'signing or verification call. Rebuilding a JWKS or re-importing a private key per request re-parses ' +
        'secrets, defeats caching, and hides the key as an implicit dependency instead of a Context service.',
    },
    messages: {
      perRequest:
        '`{{callee}}` rebuilds key material on every call. Import it once inside a Layer (Config + Redacted) and ' +
        'inject the prepared key/JWKS resolver into the per-request verifier — e.g. ' +
        '`Layer.effect(KeySet, Effect.gen(function* () { const cfg = yield* AuthConfig; return createLocalJWKSet(cfg.jwks); }))`.',
      perRequestReference:
        '`{{callee}}` is referenced inside a per-request function, so key material is rebuilt on every call. ' +
        'Build it once in a `Layer.effect`/`Layer.scoped` (or memoise with `Effect.cached*`) and inject the ' +
        'prepared key/JWKS resolver through a `Context.Service` instead.',
      generatedPerRequest:
        'This generator template emits `{{callee}}` into per-request code, so every generated MicroVertical ' +
        'rebuilds key material on each request. Emit a `Layer.effect` that imports the key once (Config + ' +
        'Redacted) and have the generated verifier consume the injected key/JWKS resolver.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          joseModules: { type: 'array', items: { type: 'string' } },
          joseMembers: { type: 'array', items: { type: 'string' } },
          nodeCryptoModules: { type: 'array', items: { type: 'string' } },
          nodeCryptoMembers: { type: 'array', items: { type: 'string' } },
          subtleMembers: { type: 'array', items: { type: 'string' } },
          layerWrappers: { type: 'array', items: { type: 'string' } },
          layerBuilderWrappers: { type: 'array', items: { type: 'string' } },
          effectWrappers: { type: 'array', items: { type: 'string' } },
          reexportModules: { type: 'array', items: { type: 'string' } },
          includeTests: { type: 'boolean' },
          scanGeneratorTemplates: { type: 'boolean' },
          generatorFiles: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: [...DEFAULT_INCLUDE],
        ignore: [...DEFAULT_IGNORE],
        joseModules: [...DEFAULT_JOSE_MODULES],
        joseMembers: [...DEFAULT_JOSE_MEMBERS],
        nodeCryptoModules: [...DEFAULT_NODE_CRYPTO_MODULES],
        nodeCryptoMembers: [...DEFAULT_NODE_CRYPTO_MEMBERS],
        subtleMembers: [...DEFAULT_SUBTLE_MEMBERS],
        layerWrappers: [...DEFAULT_LAYER_WRAPPERS],
        layerBuilderWrappers: [...DEFAULT_LAYER_BUILDER_WRAPPERS],
        effectWrappers: [...DEFAULT_EFFECT_WRAPPERS],
        reexportModules: [...DEFAULT_REEXPORT_MODULES],
        includeTests: false,
        scanGeneratorTemplates: true,
        generatorFiles: [...DEFAULT_GENERATOR_FILES],
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore)) return {};
    if (!matchesGlobs(path, options.include)) return {};
    if (!options.includeTests && isTestFile(path)) return {};

    const program = context.sourceCode.ast;
    const keys = collectKeyBindings(program, options);
    const effectBindings = collectEffectBindings(program);
    const wrappers = collectWrapperLocals(program, effectBindings, options);
    const moduleNames = collectModuleBindingNames(program);
    const scanTemplates =
      options.scanGeneratorTemplates && matchesGlobs(path, options.generatorFiles);

    /**
     * Locals rebound one hop from a tracked import (`const load = importJWK`, `const { importJWK } = jose`)
     * and locals holding a WebCrypto `subtle` object (`const { subtle } = globalThis.crypto`). Keyed by the
     * source offset of the declaring identifier, which is stable regardless of `Variable` object identity.
     */
    const aliasVariables = new Set<number>();
    const subtleVariables = new Set<number>();
    /** `const jose = require("jose")` / `= await import("jose")` → allowed member list. */
    const dynamicNamespaces = new Map<number, readonly string[]>();
    /** Identifier nodes that merely *declare* an alias — never reported themselves. */
    const bindingNodes = new Set<ESTree.Node>();
    /** Names worth collecting as candidates (imports plus every alias discovered so far). */
    const watched = new Set<string>([
      ...keys.direct.keys(),
      ...keys.namespaces.keys(),
      ...options.subtleMembers,
    ]);
    /** Member names that can ever denote key material — the cheap pre-filter for candidates. */
    const interestingMembers = new Set<string>([
      ...options.joseMembers,
      ...options.nodeCryptoMembers,
      ...options.subtleMembers,
    ]);
    /** Module-level names referenced inside a Layer/cached builder argument in this same module. */
    const builderReferenced = new Set<string>();

    /** `Layer.effect(…)` / `Effect.cached(…)` / `E.Layer.scoped(…)` — the blessed "build once" shapes. */
    const isWrapperCall = (node: ESTree.Node, layerMembers: readonly string[]): boolean => {
      if (node.type !== 'CallExpression') return false;
      const callee = node.callee;
      if (callee.type !== 'MemberExpression') return false;
      const member = memberName(callee);
      if (member === null) return false;
      const object = callee.object;

      if (object.type === 'Identifier') {
        if (wrappers.layer.has(object.name) && layerMembers.includes(member)) return true;
        if (wrappers.effect.has(object.name) && options.effectWrappers.includes(member))
          return true;
        return false;
      }
      // `E.Layer.effect(…)` through `import * as E from "effect"`.
      if (object.type !== 'MemberExpression') return false;
      const namespace = memberName(object);
      if (namespace === null) return false;
      if (object.object.type !== 'Identifier' || !wrappers.barrel.has(object.object.name))
        return false;
      if (namespace === LAYER_NAMESPACE) return layerMembers.includes(member);
      if (namespace === EFFECT_NAMESPACE) return options.effectWrappers.includes(member);
      return false;
    };

    const isEnclosingWrapper = (node: ESTree.Node): boolean =>
      isWrapperCall(node, options.layerWrappers);
    const isBuilderWrapper = (node: ESTree.Node): boolean =>
      isWrapperCall(node, options.layerBuilderWrappers);

    /**
     * The `crypto` segment of a `<…>.subtle.<member>` chain must be a global or an import; a
     * parameter, local `const` or DI port named `crypto` is not WebCrypto.
     */
    const isCryptoObject = (node: ESTree.Node): boolean => {
      if (node.type === 'Identifier') {
        const variable = lookupVariable(context, node);
        if (variable === null || variable.defs.length === 0) return node.name === 'crypto';
        return variable.defs.some((definition) => {
          if (definition.type !== 'ImportBinding') return false;
          const specifier = definition.node;
          const declaration = definition.parent;
          return (
            declaration?.type === 'ImportDeclaration' &&
            matchesGlobs(declaration.source.value, options.nodeCryptoModules) &&
            specifier.type === 'ImportSpecifier' &&
            importedName(specifier) === 'webcrypto'
          );
        });
      }
      if (node.type !== 'MemberExpression') return false;
      const member = memberName(node);
      if (node.object.type !== 'Identifier') return false;
      const variable = lookupVariable(context, node.object);
      if (member === 'crypto' && ['globalThis', 'window', 'self'].includes(node.object.name)) {
        return variable === null || variable.defs.length === 0;
      }
      return (
        member === 'webcrypto' &&
        variable !== null &&
        variable.defs.some((definition) => {
          const declaration = definition.parent;
          return (
            definition.type === 'ImportBinding' &&
            declaration?.type === 'ImportDeclaration' &&
            matchesGlobs(declaration.source.value, options.nodeCryptoModules) &&
            ['ImportNamespaceSpecifier', 'ImportDefaultSpecifier'].includes(definition.node.type)
          );
        })
      );
    };
    const cryptoRootIsAmbient = (node: ESTree.Node): boolean =>
      node.type === 'MemberExpression' &&
      memberName(node) === 'subtle' &&
      isCryptoObject(node.object);

    /** Stable identity for a resolved variable: the offset of its declaring identifier. */
    const variableKey = (variable: Variable): number | null => {
      const declaration = variable.defs[0]?.name ?? variable.identifiers[0];
      return declaration === undefined || declaration === null ? null : declaration.start;
    };

    const bindsTo = (
      identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
      registry: ReadonlySet<number>,
    ): boolean => {
      if (registry.size === 0) return false;
      const variable = lookupVariable(context, identifier);
      if (variable === null) return false;
      const key = variableKey(variable);
      return key !== null && registry.has(key);
    };

    /** Members reachable through a dynamically required/imported key module bound to `identifier`. */
    const dynamicMembers = (
      identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
    ): readonly string[] | null => {
      if (dynamicNamespaces.size === 0) return null;
      const variable = lookupVariable(context, identifier);
      if (variable === null) return null;
      const key = variableKey(variable);
      return key === null ? null : (dynamicNamespaces.get(key) ?? null);
    };

    /**
     * `require("jose")`, `await import("jose")`, `import("node:crypto")` — the CommonJS/dynamic
     * spellings of the same import, which a static `ImportDeclaration` scan would miss entirely.
     */
    const dynamicKeyModuleMembers = (node: ESTree.Node): readonly string[] | null => {
      let current: ESTree.Node = node;
      if (current.type === 'AwaitExpression') current = current.argument;
      let source: string | null = null;
      if (current.type === 'ImportExpression') {
        const specifier = current.source;
        if (specifier.type === 'Literal' && typeof specifier.value === 'string')
          source = specifier.value;
      } else if (current.type === 'CallExpression' && current.callee.type === 'Identifier') {
        if (current.callee.name !== 'require') return null;
        const requireVariable = lookupVariable(context, current.callee);
        if (requireVariable !== null && requireVariable.defs.length > 0) return null;
        const first = current.arguments[0];
        if (first !== undefined && first.type === 'Literal' && typeof first.value === 'string')
          source = first.value;
      }
      if (source === null) return null;
      if (matchesGlobs(source, options.joseModules)) return options.joseMembers;
      if (matchesGlobs(source, options.nodeCryptoModules)) return options.nodeCryptoMembers;
      return null;
    };

    /** Display name when `node` denotes key-material construction, otherwise `null`. */
    const resolveKeyReference = (node: ESTree.Node): string | null => {
      if (node.type === 'Identifier') {
        if (keys.direct.has(node.name) && resolvesToImport(context, node)) return node.name;
        if (bindsTo(node, aliasVariables)) return node.name;
        return null;
      }
      if (node.type !== 'MemberExpression') return null;
      const member = memberName(node);
      if (member === null) return null;
      const objectPath = dottedPath(node.object);

      if (options.subtleMembers.includes(member)) {
        // `subtle.importKey` where `subtle` was destructured/aliased off WebCrypto.
        if (node.object.type === 'Identifier' && bindsTo(node.object, subtleVariables)) {
          return `${node.object.name}.${member}`;
        }
        // `crypto.subtle.importKey`, `globalThis.crypto.subtle.generateKey`, `webcrypto.subtle.importKey`.
        if (objectPath !== null && cryptoRootIsAmbient(node.object)) {
          return `${objectPath}.${member}`;
        }
      }

      if (objectPath === null) return null;
      if (node.object.type !== 'Identifier') return null;
      const dynamic = dynamicMembers(node.object);
      if (dynamic !== null) return dynamic.includes(member) ? `${objectPath}.${member}` : null;
      const allowed = keys.namespaces.get(node.object.name);
      if (allowed === undefined || !allowed.includes(member)) return null;
      return resolvesToImport(context, node.object) ? `${objectPath}.${member}` : null;
    };

    const register = (identifier: ESTree.Node, registry: Set<number>): void => {
      if (identifier.type !== 'Identifier') return;
      bindingNodes.add(identifier);
      watched.add(identifier.name);
      registry.add(identifier.start);
    };

    const registerAlias = (identifier: ESTree.Node): void => register(identifier, aliasVariables);
    const registerSubtle = (identifier: ESTree.Node): void => register(identifier, subtleVariables);

    /** `const { a, b } = <source>` → run `onMember(key, valueIdentifier)` for each static property. */
    const eachPatternProperty = (
      pattern: ESTree.Node,
      onMember: (key: string, value: ESTree.Node) => void,
    ): void => {
      if (pattern.type !== 'ObjectPattern') return;
      for (const property of pattern.properties) {
        const key = propertyKeyName(property);
        if (key === null) continue;
        const value = (property as { value: ESTree.Node }).value;
        if (value === undefined || value === null) continue;
        onMember(key, value);
      }
    };

    interface Candidate {
      readonly report: ESTree.Node;
      readonly target: ESTree.Node;
      readonly messageId: 'perRequest' | 'perRequestReference';
    }
    const candidates: Candidate[] = [];

    /** Report unless the site is module scope, lexically inside a wrapper, or one hop from one. */
    const evaluate = (candidate: Candidate): void => {
      const callee = resolveKeyReference(candidate.target);
      if (callee === null) return;
      let current: ESTree.Node | null | undefined = candidate.report.parent;
      let sawFunction = false;
      let outermostName: string | null = null;
      while (current !== null && current !== undefined) {
        if (isEnclosingWrapper(current)) return;
        if (FUNCTION_TYPES.has(current.type)) sawFunction = true;
        if (
          current.type === 'FunctionDeclaration' &&
          current.id !== null &&
          current.id !== undefined
        ) {
          outermostName = current.id.name;
        } else if (current.type === 'VariableDeclarator' && current.id.type === 'Identifier') {
          outermostName = current.id.name;
        }
        current = current.parent;
      }
      if (!sawFunction) return;
      // The repo's `Context.Service` idiom: the build effect lives in a named module-level factory
      // that is handed to `Layer.effect`/`Effect.cached*` by reference. Built once per Layer build.
      if (
        outermostName !== null &&
        moduleNames.has(outermostName) &&
        builderReferenced.has(outermostName)
      )
        return;
      context.report({ node: candidate.report, messageId: candidate.messageId, data: { callee } });
    };

    const isCalleePosition = (node: ESTree.Node): boolean => {
      const parent = node.parent;
      if (parent === null || parent === undefined) return false;
      if (parent.type === 'CallExpression' || parent.type === 'NewExpression')
        return parent.callee === node;
      return false;
    };

    /** Identifier positions that are declarations, keys or types rather than value references. */
    const isNonReferencePosition = (
      node: Extract<ESTree.Node, { type: 'Identifier' }>,
    ): boolean => {
      const parent = node.parent;
      if (parent === null || parent === undefined) return true;
      switch (parent.type) {
        case 'ImportSpecifier':
        case 'ImportDefaultSpecifier':
        case 'ImportNamespaceSpecifier':
        case 'ExportSpecifier':
        case 'TSTypeReference':
        case 'TSQualifiedName':
        case 'TSTypeQuery':
          return true;
        case 'MemberExpression':
          return parent.property === node && !parent.computed;
        case 'Property':
        case 'PropertyDefinition':
        case 'MethodDefinition':
          return parent.key === node && !parent.computed;
        default:
          return false;
      }
    };

    const templateElements: Array<{ start: number; end: number }> = [];
    const templateLiterals: Array<{ start: number; end: number }> = [];

    return {
      /**
       * One-hop rebindings. Visited before the references they enable (declaration precedes use),
       * and always before `Program:exit`, where every candidate is finally resolved.
       */
      VariableDeclarator(node) {
        const init = node.init;
        if (init === null || init === undefined) return;

        const required = dynamicKeyModuleMembers(init);
        if (required !== null) {
          if (node.id.type === 'Identifier') {
            bindingNodes.add(node.id);
            watched.add(node.id.name);
            dynamicNamespaces.set(node.id.start, required);
          } else {
            eachPatternProperty(node.id, (key, value) => {
              if (required.includes(key)) registerAlias(value);
            });
          }
          return;
        }

        if (init.type === 'Identifier') {
          const namespaceMembers = keys.namespaces.get(init.name);
          const isTrackedNamespace =
            namespaceMembers !== undefined && resolvesToImport(context, init);
          const isTrackedDirect =
            (keys.direct.has(init.name) && resolvesToImport(context, init)) ||
            bindsTo(init, aliasVariables);
          const isTrackedSubtle = bindsTo(init, subtleVariables) || isCryptoObject(init);

          if (isTrackedDirect && node.id.type === 'Identifier') {
            registerAlias(node.id);
            bindingNodes.add(init);
            return;
          }
          if (isTrackedNamespace) {
            eachPatternProperty(node.id, (key, value) => {
              if (namespaceMembers.includes(key)) registerAlias(value);
            });
            return;
          }
          if (isTrackedSubtle) {
            eachPatternProperty(node.id, (key, value) => {
              if (key === 'subtle' && isCryptoObject(init)) registerSubtle(value);
              else if (options.subtleMembers.includes(key)) registerAlias(value);
            });
          }
          return;
        }

        if (init.type !== 'MemberExpression') return;
        const member = memberName(init);
        const initPath = dottedPath(init);

        // `const subtle = crypto.subtle` / `const { importKey } = globalThis.crypto.subtle`.
        if (initPath !== null && cryptoRootIsAmbient(init)) {
          if (node.id.type === 'Identifier') registerSubtle(node.id);
          else {
            eachPatternProperty(node.id, (key, value) => {
              if (options.subtleMembers.includes(key)) registerAlias(value);
            });
          }
          return;
        }
        // `const { subtle } = globalThis.crypto`.
        if (isCryptoObject(init) && node.id.type === 'ObjectPattern') {
          const rootOk =
            init.object.type !== 'Identifier' || resolvesToImport(context, init.object);
          if (rootOk) {
            eachPatternProperty(node.id, (key, value) => {
              if (key === 'subtle') registerSubtle(value);
            });
          }
          return;
        }
        // `const load = jose.importJWK`.
        if (
          member !== null &&
          node.id.type === 'Identifier' &&
          resolveKeyReference(init) !== null
        ) {
          registerAlias(node.id);
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        const name =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression'
              ? memberName(callee)
              : null;
        if (name === null) return;
        if (!watched.has(name) && !interestingMembers.has(name)) return;
        candidates.push({ report: node, target: callee, messageId: 'perRequest' });
      },
      Identifier(node) {
        // One-hop Layer factory detection: a module-level name used inside a Layer/cached builder.
        if (moduleNames.has(node.name) && !builderReferenced.has(node.name)) {
          let child: ESTree.Node = node;
          let current: ESTree.Node | null | undefined = node.parent;
          while (current !== null && current !== undefined) {
            if (isBuilderWrapper(current) && (current as ESTree.CallExpression).callee !== child) {
              builderReferenced.add(node.name);
              break;
            }
            child = current;
            current = current.parent;
          }
        }
        if (isCalleePosition(node)) return;
        if (isNonReferencePosition(node)) return;
        if (!watched.has(node.name)) return;
        candidates.push({ report: node, target: node, messageId: 'perRequestReference' });
      },
      MemberExpression(node) {
        if (isCalleePosition(node)) return;
        const parent = node.parent;
        // Intermediate link of a longer chain (`crypto.subtle` inside `crypto.subtle.importKey`).
        if (
          parent !== null &&
          parent !== undefined &&
          parent.type === 'MemberExpression' &&
          parent.object === node
        ) {
          return;
        }
        const member = memberName(node);
        if (member === null) return;
        if (!watched.has(member) && !interestingMembers.has(member)) return;
        candidates.push({ report: node, target: node, messageId: 'perRequestReference' });
      },
      TemplateElement(node) {
        if (!scanTemplates) return;
        templateElements.push({ start: node.start, end: node.end });
      },
      TemplateLiteral(node) {
        if (!scanTemplates) return;
        templateLiterals.push({ start: node.start, end: node.end });
      },
      'Program:exit'() {
        for (const candidate of candidates) {
          if (bindingNodes.has(candidate.report)) continue;
          evaluate(candidate);
        }
        if (!scanTemplates || templateElements.length === 0) return;
        const text = context.sourceCode.text;
        const named = [...options.joseMembers, ...options.nodeCryptoMembers];
        const patterns: RegExp[] = [];
        // `createLocalJWKSet(`, `importJWK(` … — names distinctive enough to match bare.
        if (named.length > 0)
          patterns.push(new RegExp(`\\b(${named.map(escapeMember).join('|')})\\s*\\(`, 'gu'));
        // `importKey`/`generateKey` are ordinary app identifiers; only match real WebCrypto access.
        if (options.subtleMembers.length > 0) {
          patterns.push(
            new RegExp(
              `\\bsubtle\\s*\\??\\.\\s*(${options.subtleMembers.map(escapeMember).join('|')})\\s*\\(`,
              'gu',
            ),
          );
        }
        const seen = new Set<number>();
        for (const pattern of patterns) {
          let match = pattern.exec(text);
          while (match !== null) {
            const member = match[1] ?? '';
            const index = match.index + match[0].lastIndexOf(member);
            const inTemplate = templateElements.some(
              (entry) => index >= entry.start && index < entry.end,
            );
            if (inTemplate && !seen.has(index)) {
              // Scan back to the start of the *whole* template literal, not a character window, so a
              // realistically sized emitted `Layer.effect(…)` body still counts as already fixed.
              const literal = templateLiterals
                .filter((entry) => index >= entry.start && index < entry.end)
                .sort((a, b) => b.start - a.start)[0];
              const from = literal === undefined ? 0 : literal.start;
              if (!TEMPLATE_WRAPPER_MARKER.test(text.slice(from, index))) {
                seen.add(index);
                context.report({
                  node: { range: [index, index + member.length] },
                  messageId: 'generatedPerRequest',
                  data: { callee: member },
                });
              }
            }
            match = pattern.exec(text);
          }
        }
      },
    };
  },
});

function escapeMember(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
