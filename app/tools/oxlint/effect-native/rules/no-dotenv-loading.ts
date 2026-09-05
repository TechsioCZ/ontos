/**
 * effect-native/no-dotenv-loading
 *
 * Audit finding enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *   - A3 "Replace ambient configuration with Config, ConfigProvider, and Redacted" —
 *     "Configuration currently combines `process.env`, per-module dotenv loading, `trim`, `new URL`,
 *     number/range checks, `JSON.parse`, synchronous Schema decoding, and throws."
 *     Evidence sites: `packages/core-runtime/src/db/config.ts`, `packages/core-runtime/src/permissions/config.ts`,
 *     `apps/shell-super-app/api/auth/config.ts`, `apps/shell-super-app/api/auth/gateway-issuer-config.ts`,
 *     plus the drizzle / modern.js / playwright configs that each re-load the same `.env` by hand.
 *     A3 target: "Decode it through `Config`, `Config.schema`, and a root `ConfigProvider`. Compose
 *     environment and dotenv providers at startup."
 *
 * Distributed dotenv loading creates configuration outside the root ConfigProvider. Default config
 * calls may mutate process.env; parse and config({ processEnv: local }) need not. The violation is the
 * distributed configuration dependency, not an inference that every call reads files or mutates globals.
 * A3's target is one composed ConfigProvider at startup, with Config / Config.schema declarations
 * and Redacted credentials. Explicit composition-root exceptions remain controlled by allowPaths.
 *
 * What is detected (in `apps/**`, `verticals/**`, `packages/**`, `scripts/**`, tests included):
 *   1. `dotenvImport` — any *value* `import`/re-export whose specifier is a dotenv package:
 *      `dotenv`, `dotenv/config`, `dotenv/lib/main`, `dotenv-expand`, `dotenv-flow`, `dotenv-safe`,
 *      `dotenv-extended`, `dotenv-cli`, `@dotenvx/dotenvx`, … Side-effect imports
 *      (`import "dotenv/config"`, `import {} from "dotenv"`) are the worst case and report exactly
 *      like a named one. So does `import { type DotenvConfigOutput } from "dotenv"`: this repo sets
 *      `verbatimModuleSyntax: true` (tsconfig.base.json), under which an inline `type` specifier is
 *      *not* erased — TypeScript emits `import {} from "dotenv";`, which still executes dotenv.
 *      Only a whole-declaration `import type ... from "dotenv"` is genuinely erased.
 *   2. `dotenvDynamicImport` — `import("dotenv")` with a static string specifier (template literal
 *      without expressions included), including `await import(...)`.
 *   3. `dotenvRequire` — `require("dotenv")` where the callee really is a module loader:
 *      the ambient CommonJS `require`, *or* an ESM-built one — `const require = createRequire(import.meta.url)`
 *      (`createRequire` imported from `node:module` / `module`, under any local name, including a
 *      namespace member and an immediately invoked `createRequire(url)("dotenv")`). This repo's own
 *      config files build `require` exactly that way, so the shadow guard must not swallow it.
 *      `import dotenv = require("dotenv")` reports here too.
 *   4. `dotenvCall` — every call of a binding that came from such an import: named
 *      (`config`, `parse`, `populate`, `expand`, … including aliases such as
 *      `import { config as loadDotenv }`), default (`dotenv.config()`), namespace
 *      (`import * as dotenv from "dotenv"` → `dotenv.config()`), the `esModuleInterop` default
 *      unwrap (`dotenvNamespace.default.config()`), the CommonJS
 *      `const dotenv = require("dotenv"); dotenv.config()` / `const { config } = require("dotenv")`
 *      shapes, a destructure off a tracked namespace or dynamic import
 *      (`const { config } = await import("dotenv")`) and a plain local alias (`const boot = loadDotenv`).
 *      Optional calls (`loadDotenv?.()`), computed members (`dotenv["config"]()`) and
 *      parenthesised / `as` / `satisfies` / `!` wrapped callees are all matched.
 *   Both the import and its call sites report: the import is the coupling, each call is a separate
 *   configuration operation, not necessarily an ambient mutation, and the audit's ≈26-site baseline counts both.
 *
 * What is deliberately allowed
 *   - `allowPaths` (default `scripts/initialize-local-development.mts`): the local bootstrap
 *     composition root loads into a local record via `processEnv` and accepts an injectable
 *     environmentEffect. The D-tier line-preserving rewriter is ensure-local-environment.mts.
 *   - Whole-declaration type-only imports/exports: `import type { DotenvConfigOutput } from "dotenv"`,
 *     `import type * as Dotenv from "dotenv"`, `export type { … } from "dotenv"`. Those are erased
 *     even under `verbatimModuleSyntax`, so nothing is loaded. (An inline `type` specifier on a value
 *     declaration is *not* in this list — see detection #1.)
 *   - Anything shadowing a dotenv name without importing it: a local `const config = …`, a parameter
 *     named `config`, an unrelated `config()` helper, `require` rebound to a local helper function
 *     that is not `createRequire(...)` — the binding must resolve to a dotenv import (checked through
 *     `context.sourceCode.getScope`).
 *   - Dynamic specifiers that are not statically a dotenv package (`import(pluginName)`), and
 *     near-miss package names (`dotenvish`, `my-dotenv-helper`, `dotenv_flow`).
 *   - A bare *reference* to a dotenv binding that is not called (`paths.forEach(loadDotenv)`): the
 *     import on the same file already reports, so references add noise without adding coverage.
 *   - Everything outside `scopePaths`; and test files too when `ignoreTestFiles` is enabled
 *     (default `false` — Playwright/E2E fixtures loading dotenv are exactly the A3 evidence).
 *   - Reading `process.env` itself is a different finding and is not this rule's business.
 *
 * Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

/**
 * Any dotenv-family loader package, with or without a subpath (`dotenv/config` is the side-effect
 * entrypoint, `@dotenvx/dotenvx` the drop-in replacement, `dotenv-flow`/`dotenv-expand`/`dotenv-safe`/
 * `dotenv-extended` the layering add-ons, each with its own `/config` side-effect entrypoint).
 * Unrelated packages such as `dotenv-webpack` consumers or `dotenvish` are matched only when they
 * really are one of these package names.
 */
const DOTENV_MODULE =
  /^(?:dotenv|dotenv-expand|dotenv-flow|dotenv-safe|dotenv-extended|dotenv-cli|dotenv-vault|dotenv-defaults|@dotenvx\/[^/]+)(?:\/.*)?$/u;

/** `createRequire` lives here; an ESM module builds its `require` from one of these. */
const NODE_MODULE_SPECIFIER = /^(?:node:module|module)$/u;

/** Audit scope: application, vertical, package and script sources. Tests included by default. */
const DEFAULT_SCOPE_PATHS: readonly string[] = [
  'apps/**',
  'verticals/**',
  'packages/**',
  'scripts/**',
];

/**
 * The local bootstrap composition root loads dotenv into a local record (processEnv), not the
 * ambient bag, and exposes injectable environmentEffect. It is not the D-tier .env rewriter.
 */
const DEFAULT_ALLOW_PATHS: readonly string[] = ['scripts/initialize-local-development.mts'];

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets the fixtures exercise the real production defaults instead of forcing the
 * fixture config to pass loosened options (`run-on-repo.mts` reuses that same fixture config).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

/** Wrappers that do not change which expression is actually the callee. */
const TRANSPARENT = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
  'ChainExpression',
]);

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly ignoreTestFiles: boolean;
  readonly scopePaths: readonly string[];
}

const DEFAULTS: RuleOptions = {
  allowPaths: [...DEFAULT_ALLOW_PATHS],
  ignoreTestFiles: false,
  scopePaths: [...DEFAULT_SCOPE_PATHS],
};

type AnyNode = ESTree.Node;

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  return value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : fallback;
}

function readOptions(raw: unknown): RuleOptions {
  const given =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    allowPaths: stringArray(given.allowPaths, DEFAULTS.allowPaths),
    ignoreTestFiles:
      typeof given.ignoreTestFiles === 'boolean' ? given.ignoreTestFiles : DEFAULTS.ignoreTestFiles,
    scopePaths: stringArray(given.scopePaths, DEFAULTS.scopePaths),
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function isDotenvSpecifier(source: string): boolean {
  return DOTENV_MODULE.test(source);
}

function startOf(node: AnyNode | null | undefined): number | null {
  if (node === null || node === undefined) return null;
  const span = node as unknown as ESTree.Span;
  return typeof span.start === 'number' ? span.start : null;
}

/** The static string value of an `import(...)` / `require(...)` argument, when there is one. */
function staticStringValue(node: AnyNode | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  node = unwrap(node);
  if (node.type === 'Literal') {
    const value = (node as { value?: unknown }).value;
    return typeof value === 'string' ? value : null;
  }
  if (node.type === 'TemplateLiteral') {
    const template = node as ESTree.TemplateLiteral;
    if (template.expressions.length !== 0 || template.quasis.length !== 1) return null;
    return template.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (TRANSPARENT.has(current.type)) {
    const inner = (current as { expression?: AnyNode }).expression ?? null;
    if (inner === null) break;
    current = inner;
  }
  return current;
}

/** Like {@link unwrap}, but also sees through `await` — `const { config } = await import("dotenv")`. */
function unwrapValue(node: AnyNode): AnyNode {
  let current = unwrap(node);
  while (current.type === 'AwaitExpression') {
    const argument = (current as ESTree.AwaitExpression).argument as AnyNode | undefined;
    if (argument === undefined) break;
    current = unwrap(argument);
  }
  return current;
}

function parentOf(node: AnyNode): AnyNode | null {
  return (node as { parent?: AnyNode | null }).parent ?? null;
}

/** Climb through parentheses/type wrappers to the outermost equivalent node. */
function skipWrappers(node: AnyNode): { readonly node: AnyNode; readonly parent: AnyNode | null } {
  let current = node;
  let parent = parentOf(current);
  while (parent !== null && TRANSPARENT.has(parent.type)) {
    current = parent;
    parent = parentOf(current);
  }
  return { node: current, parent };
}

/** Non-computed `.config`, or computed `["config"]`. */
function staticMemberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) {
    const property = node.property as AnyNode;
    return property.type === 'Identifier' ? (property as ESTree.IdentifierName).name : null;
  }
  return staticStringValue(node.property as AnyNode);
}

function lookupVariable(context: Context, node: AnyNode, name: string): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/**
 * A set of local names known to hold a particular value (a dotenv module, or a module `require`),
 * anchored to the exact binding identifiers that introduced them. Resolving a reference re-runs scope
 * analysis so an inner shadow of the same name never inherits the tracked meaning.
 */
interface Tracker {
  /** Record a binding introduced by an `import` declaration (def type `ImportBinding`). */
  readonly addImport: (
    name: string,
    value: string,
    ...anchors: readonly (AnyNode | null | undefined)[]
  ) => void;
  /** Record a binding introduced by a declarator / declaration, anchored on the given nodes. */
  readonly addDeclared: (
    name: string,
    value: string,
    ...anchors: readonly (AnyNode | null | undefined)[]
  ) => void;
  readonly resolve: (node: AnyNode, name: string) => string | null;
}

function createTracker(context: Context): Tracker {
  const anchored = new Map<number, string>();
  const add = (
    _name: string,
    value: string,
    ...anchors: readonly (AnyNode | null | undefined)[]
  ): void => {
    for (const node of anchors) {
      const start = startOf(node);
      if (start !== null) anchored.set(start, value);
    }
  };
  return {
    addImport: add,
    addDeclared: add,
    resolve(node, name) {
      const variable = lookupVariable(context, node, name);
      if (!variable || variable.defs.length !== 1) return null;
      // Do not infer the current value after a reassignment.
      if (variable.references.some((reference) => reference.isWrite() && !reference.init))
        return null;
      const definition = variable.defs[0];
      return (
        anchored.get(startOf(definition.name as AnyNode) ?? -1) ??
        anchored.get(startOf(definition.node as AnyNode) ?? -1) ??
        null
      );
    },
  };
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A3: disallow per-module dotenv loading (importing, requiring or calling dotenv / dotenv-expand / ' +
        'dotenv-flow / dotenv-safe / @dotenvx). Compose one root ConfigProvider from the environment layered over ' +
        'a dotenv-backed provider at startup and read every value through Config / Config.schema. Static specifiers and scope-resolved local bindings only; no cross-module or reassignment value inference.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#a3-replace-ambient-configuration-with-config-configprovider-and-redacted',
    },
    messages: {
      dotenvImport:
        'Audit A3: importing "{{module}}" couples this module to a separate configuration loader. Avoid per-module ' +
        'dotenv loading: build one root ConfigProvider at startup ' +
        '(environment provider layered over a dotenv-backed provider), install it once on the root Layer, and ' +
        'read values here through Config / Config.schema (Redacted for credentials, Schema.fromJsonString for ' +
        'JSON-valued configuration).',
      dotenvDynamicImport:
        'Audit A3: dynamically importing "{{module}}" couples configuration to a per-module loader at ' +
        'an unpredictable point. Compose the environment and dotenv providers once into a root ConfigProvider at ' +
        'startup and read values through Config / Config.schema instead.',
      dotenvRequire:
        'Audit A3: require("{{module}}") couples configuration to a per-module loader. Compose one root ' +
        'ConfigProvider (environment layered over a dotenv-backed provider) at startup and read values through ' +
        'Config / Config.schema instead.',
      dotenvCall:
        'Audit A3: calling {{call}} from "{{module}}" uses a separate dotenv parsing/loading path, so ' +
        'configuration is not declared through the shared ConfigProvider (parse may be pure and processEnv may be local). ' +
        'Read this value with Config / Config.schema from the single root ConfigProvider composed at startup; use ' +
        'Redacted for credentials and key material.',
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
              'Globs of files allowed to load dotenv directly (default: the injectable local bootstrap composition root ' +
              'scripts/initialize-local-development.mts, which loads into a local record).',
          },
          ignoreTestFiles: {
            type: 'boolean',
            description:
              'Skip test files (default: false — Playwright and E2E fixtures loading dotenv are A3 evidence sites).',
          },
          scopePaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs the rule applies to (default: ["apps/**", "verticals/**", "packages/**", "scripts/**"]).',
          },
        },
      },
    ],
    defaultOptions: [
      {
        allowPaths: [...DEFAULT_ALLOW_PATHS],
        ignoreTestFiles: false,
        scopePaths: [...DEFAULT_SCOPE_PATHS],
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options?.[0]);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.scopePaths)) return {};
    if (matchesGlobs(path, options.allowPaths)) return {};
    if (options.ignoreTestFiles && isTestFile(`/${path}`)) return {};

    /** local name → the dotenv module it resolves to. */
    const dotenv = createTracker(context);
    /** local name → `"createRequire"`, for the `node:module` factory under any alias. */
    const requireFactory = createTracker(context);
    /** local name → `"node:module"`, for `import * as nodeModule from "node:module"`. */
    const moduleNamespace = createTracker(context);
    /** local name → `"require"`, for anything that really is a CommonJS module loader. */
    const requireLike = createTracker(context);

    /** `require` is a genuine ambient global here (not a local helper function or parameter). */
    const requireIsAmbient = (node: AnyNode): boolean => {
      const variable = lookupVariable(context, node, 'require');
      return variable === null || variable.defs.length === 0;
    };

    /** `createRequire(...)`, `nodeModule.createRequire(...)` — under any local alias. */
    const isCreateRequireCall = (node: AnyNode): boolean => {
      const call = unwrap(node);
      if (call.type !== 'CallExpression') return false;
      const callee = unwrap((call as ESTree.CallExpression).callee as AnyNode);
      if (callee.type === 'Identifier') {
        return requireFactory.resolve(callee, (callee as ESTree.IdentifierReference).name) !== null;
      }
      if (callee.type !== 'MemberExpression') return false;
      if (staticMemberName(callee as ESTree.MemberExpression) !== 'createRequire') return false;
      const object = unwrap((callee as ESTree.MemberExpression).object as AnyNode);
      if (object.type === 'Identifier') {
        return (
          moduleNamespace.resolve(object, (object as ESTree.IdentifierReference).name) !== null
        );
      }
      // `require("node:module").createRequire(...)`
      if (object.type !== 'CallExpression') return false;
      const inner = unwrap((object as ESTree.CallExpression).callee as AnyNode);
      if (inner.type !== 'Identifier' || (inner as ESTree.IdentifierReference).name !== 'require')
        return false;
      const specifier = staticStringValue(
        ((object as ESTree.CallExpression).arguments[0] as AnyNode) ?? null,
      );
      return requireIsAmbient(inner) && specifier !== null && NODE_MODULE_SPECIFIER.test(specifier);
    };

    /**
     * `true` when this callee really loads a module: the ambient CommonJS `require`, a local bound to
     * `createRequire(import.meta.url)` (this repo's ESM config files do exactly that), or an
     * immediately invoked `createRequire(url)("dotenv")`.
     */
    const isModuleLoaderCallee = (callee: AnyNode): boolean => {
      if (callee.type === 'Identifier') {
        const name = (callee as ESTree.IdentifierReference).name;
        if (requireLike.resolve(callee, name) !== null) return true;
        return name === 'require' && requireIsAmbient(callee);
      }
      return callee.type === 'CallExpression' && isCreateRequireCall(callee);
    };

    /**
     * The dotenv module an expression evaluates to, for binding propagation:
     * `require("dotenv")`, `import("dotenv")`, a tracked local, or the `esModuleInterop`
     * `namespace.default` unwrap.
     */
    const dotenvValueOf = (expression: AnyNode): string | null => {
      const value = unwrapValue(expression);
      if (value.type === 'CallExpression') {
        const call = value as ESTree.CallExpression;
        if (!isModuleLoaderCallee(unwrap(call.callee as AnyNode))) return null;
        const module = staticStringValue((call.arguments[0] as AnyNode) ?? null);
        return module !== null && isDotenvSpecifier(module) ? module : null;
      }
      if (value.type === 'ImportExpression') {
        const module = staticStringValue((value as ESTree.ImportExpression).source as AnyNode);
        return module !== null && isDotenvSpecifier(module) ? module : null;
      }
      if (value.type === 'Identifier') {
        return dotenv.resolve(value, (value as ESTree.IdentifierReference).name);
      }
      if (value.type === 'MemberExpression') {
        // `dotenvNamespace.default` under esModuleInterop is still the dotenv module object.
        if (staticMemberName(value as ESTree.MemberExpression) !== 'default') return null;
        return dotenvValueOf((value as ESTree.MemberExpression).object as AnyNode);
      }
      return null;
    };

    /** Bind every name introduced by a destructuring/identifier pattern to the dotenv module. */
    const bindPattern = (pattern: AnyNode, module: string, declarator: AnyNode): void => {
      if (pattern.type === 'Identifier') {
        dotenv.addDeclared((pattern as ESTree.BindingIdentifier).name, module, pattern, declarator);
        return;
      }
      if (pattern.type === 'AssignmentPattern') {
        bindPattern((pattern as ESTree.AssignmentPattern).left as AnyNode, module, declarator);
        return;
      }
      if (pattern.type !== 'ObjectPattern') return;
      for (const property of (pattern as ESTree.ObjectPattern).properties) {
        if (property.type !== 'Property') continue;
        bindPattern(property.value as AnyNode, module, declarator);
      }
    };

    /** The dotenv module a member chain's root object resolves to, plus a readable label. */
    const resolveDotenvObject = (
      expression: AnyNode,
    ): { readonly module: string; readonly label: string } | null => {
      const target = unwrap(expression);
      if (target.type === 'Identifier') {
        const name = (target as ESTree.IdentifierReference).name;
        const module = dotenv.resolve(target, name);
        return module === null ? null : { module, label: name };
      }
      if (target.type !== 'MemberExpression') return null;
      if (staticMemberName(target as ESTree.MemberExpression) !== 'default') return null;
      const inner = resolveDotenvObject((target as ESTree.MemberExpression).object as AnyNode);
      return inner === null ? null : { module: inner.module, label: `${inner.label}.default` };
    };

    return {
      ImportDeclaration(node) {
        // A whole-declaration `import type` is erased even under verbatimModuleSyntax.
        if (node.importKind === 'type') return;
        const module = node.source.value;

        if (NODE_MODULE_SPECIFIER.test(module)) {
          for (const specifier of node.specifiers) {
            if (specifier.type === 'ImportNamespaceSpecifier') {
              moduleNamespace.addImport(specifier.local.name, 'node:module', specifier.local);
              continue;
            }
            if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') continue;
            const imported =
              specifier.imported.type === 'Identifier'
                ? specifier.imported.name
                : specifier.imported.value;
            if (imported === 'createRequire') {
              requireFactory.addImport(specifier.local.name, 'createRequire', specifier.local);
            }
          }
          return;
        }

        if (!isDotenvSpecifier(module)) return;
        for (const specifier of node.specifiers) {
          // An inline `type` specifier binds a type, not a value — but the *declaration* still loads.
          if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue;
          dotenv.addImport(specifier.local.name, module, specifier.local);
        }
        // Under `verbatimModuleSyntax` (tsconfig.base.json) an all-inline-type or empty specifier
        // list still emits `import {} from "dotenv";` — a side-effect import that runs dotenv.
        context.report({ node, messageId: 'dotenvImport', data: { module } });
      },
      ExportNamedDeclaration(node) {
        const source = node.source;
        if (source === null || !isDotenvSpecifier(source.value)) return;
        if (node.exportKind === 'type') return;
        context.report({ node, messageId: 'dotenvImport', data: { module: source.value } });
      },
      ExportAllDeclaration(node) {
        if (!isDotenvSpecifier(node.source.value)) return;
        if (node.exportKind === 'type') return;
        context.report({ node, messageId: 'dotenvImport', data: { module: node.source.value } });
      },
      ImportExpression(node) {
        const module = staticStringValue(node.source as AnyNode);
        if (module === null || !isDotenvSpecifier(module)) return;
        context.report({ node, messageId: 'dotenvDynamicImport', data: { module } });
      },
      TSImportEqualsDeclaration(node) {
        if (node.importKind === 'type') return;
        const reference = node.moduleReference as AnyNode;
        if (reference.type !== 'TSExternalModuleReference') return;
        const module = staticStringValue(
          (reference as ESTree.TSExternalModuleReference).expression as AnyNode,
        );
        if (module === null) return;
        if (NODE_MODULE_SPECIFIER.test(module)) {
          moduleNamespace.addImport(node.id.name, 'node:module', node.id, node);
          return;
        }
        if (!isDotenvSpecifier(module)) return;
        // Anchor on both the declaration and its binding identifier: the scope analyser may model
        // `import x = require(...)` as either an ImportBinding or a plain Variable definition.
        dotenv.addImport(node.id.name, module, node.id, node);
        dotenv.addDeclared(node.id.name, module, node.id, node);
        context.report({ node, messageId: 'dotenvRequire', data: { module } });
      },
      VariableDeclarator(node) {
        const init = node.init as AnyNode | null;
        if (init === null) return;
        const id = node.id as AnyNode;

        // `const require = createRequire(import.meta.url)` — the ESM way to build a real `require`.
        if (id.type === 'Identifier' && isCreateRequireCall(init)) {
          requireLike.addDeclared((id as ESTree.BindingIdentifier).name, 'require', id, node);
          return;
        }

        const value = unwrapValue(init);

        // `const nodeModule = require("node:module")` / `const { createRequire } = await import("node:module")`
        const loaderSpecifier =
          value.type === 'CallExpression' &&
          isModuleLoaderCallee(unwrap((value as ESTree.CallExpression).callee as AnyNode))
            ? staticStringValue(((value as ESTree.CallExpression).arguments[0] as AnyNode) ?? null)
            : value.type === 'ImportExpression'
              ? staticStringValue((value as ESTree.ImportExpression).source as AnyNode)
              : null;
        if (loaderSpecifier !== null && NODE_MODULE_SPECIFIER.test(loaderSpecifier)) {
          if (id.type === 'Identifier') {
            moduleNamespace.addDeclared(
              (id as ESTree.BindingIdentifier).name,
              'node:module',
              id,
              node,
            );
          } else if (id.type === 'ObjectPattern') {
            for (const property of (id as ESTree.ObjectPattern).properties) {
              if (property.type !== 'Property') continue;
              const target = property.value as AnyNode;
              if (target.type !== 'Identifier') continue;
              requireFactory.addDeclared(
                (target as ESTree.BindingIdentifier).name,
                'createRequire',
                target,
                node,
              );
            }
          }
          return;
        }

        const module = dotenvValueOf(init);
        if (module === null) return;
        bindPattern(id, module, node);
      },
      CallExpression(node) {
        const callee = unwrap(node.callee as AnyNode);

        // `require("dotenv")`, `createRequire(import.meta.url)("dotenv")`, `req("dotenv/config")`
        if (isModuleLoaderCallee(callee)) {
          const module = staticStringValue((node.arguments[0] as AnyNode | undefined) ?? null);
          if (module === null || !isDotenvSpecifier(module)) return;
          context.report({ node, messageId: 'dotenvRequire', data: { module } });
          return;
        }

        // `loadDotenv({ path })`, `config()`, `expand(result)` — a named/default binding called directly.
        if (callee.type === 'Identifier') {
          const name = (callee as ESTree.IdentifierReference).name;
          const module = dotenv.resolve(callee, name);
          if (module === null) return;
          context.report({ node, messageId: 'dotenvCall', data: { call: `${name}()`, module } });
          return;
        }

        // `dotenv.config()`, `dotenv["config"]()`, `dotenvNamespace.default.config()`.
        if (callee.type !== 'MemberExpression') return;
        const object = resolveDotenvObject((callee as ESTree.MemberExpression).object as AnyNode);
        if (object === null) return;
        const member = staticMemberName(callee as ESTree.MemberExpression);
        const call = member === null ? `${object.label}[…]()` : `${object.label}.${member}()`;
        context.report({ node, messageId: 'dotenvCall', data: { call, module: object.module } });
      },
    };
  },
});

/** Kept for the CommonJS shapes that declare a binding through a wrapper expression. */
void skipWrappers;
