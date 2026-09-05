/**
 * effect-native/no-effect-run-in-tests
 *
 * Audit findings: **B2** (“Build one Effect-aware testing harness”) and **A1** (“Establish one
 * process-level Layer and ManagedRuntime composition model”) of
 * `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`.
 *
 * ## What this detects
 *
 * Every reference to an `Effect.run*` root-fiber entry point inside a test file. Each such site
 * builds an ad hoc runtime: no `TestClock`, no scoped `Layer`, no map-backed `ConfigProvider`, no
 * shared `ManagedRuntime`, and hand-rewired `Effect.provide` per call. Detected shapes:
 *
 * - direct calls — `Effect.runPromise(program)`, `Effect.runSync`, `Effect.runPromiseExit`,
 *   `Effect.runFork`, `Effect.runCallback`, `Effect.runPromiseWith`, …;
 * - point-free / stored references — `pipe(program, Effect.runPromise)`,
 *   `list.map(Effect.runPromise)`, `{ runEffectRequest: Effect.runPromise }` in module mocks;
 * - aliased and namespace imports — `import { Effect as E } from "effect"`,
 *   `import * as Effect from "effect/Effect"`;
 * - root namespace imports — `import * as EffectLib from "effect"` reaches the same functions
 *   through `EffectLib.Effect.runPromise` because `effect`'s barrel is `export * as Effect from …`;
 * - Effect namespaces re-exported by a first-party barrel (`effectModuleSources`), such as
 *   `import { Effect } from "@modern-js/plugin-bff/effect-edge"` used by the Contacts BFF tests;
 * - optional chaining (`Effect?.runPromise`), computed access (`Effect["runPromise"]`) and
 *   substitution-free template keys (`` Effect[`runPromise`] ``);
 * - erased TS wrappers around the namespace — `Effect!.runPromise`, `(Effect as typeof Effect)
 *   .runPromise`, `(Effect satisfies typeof Effect).runPromise`, `Effect<never>.runPromise`;
 * - one-hop (and short chains of) local value aliases — `const E = Effect; E.runPromise(p)`;
 * - `ObjectPattern` destructuring — `const { runPromise, runSync } = Effect;`;
 * - direct function imports — `import { runPromise } from "effect/Effect"`;
 * - re-export wrappers — `export { runPromise } from "effect/Effect"`,
 *   `export { runSync as runIt } from "effect/Effect"`, `export * from "effect/Effect"`: a
 *   test-support module that hands every importing test an ad hoc root fiber;
 * - dynamic imports, the `vi.resetModules()` / `rstest.resetModules()` shape —
 *   `const { runPromise } = await import("effect/Effect")` and
 *   `const Effect = await import("effect/Effect"); Effect.runSync(p)`.
 *
 * ## What is deliberately allowed
 *
 * - The repository-owned harness itself (`harnessPaths`): `itEffect`/`itLayer` must be free to call
 *   `Effect.runPromise` exactly once, in one place, on an effect that already has its test Layer.
 * - D-tier Promise adapters forced by the framework: Playwright / e2e specs (`ignorePaths`).
 * - Type-only imports and type-only specifiers (`import type { runPromise } from "effect/Effect"`,
 *   `import { type runSync } …`): erased before runtime, so they cannot open a fiber.
 * - Anything that is not an `effect` binding — `runtime.runPromise(...)` on a `ManagedRuntime`
 *   instance, a locally shadowed `Effect` object, `Effect.gen`, `Effect.provide`, `Effect.runtime`.
 * - Deeply nested re-entry (`Effect.runPromise` inside another `Effect.run*` argument) is left to
 *   `effect-native/no-nested-effect-run` so the S1 transaction-sandwich finding keeps its own code.
 *
 * Report-only: no fixer, no suggestion. Existing violations are the intended output.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings, effectMember } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, matchesAny } from '../shared/paths.ts';

/** `run`, `runPromise`, `runSyncExit`, `runPromiseWith`, … but not `runtime`. */
const RUN_MEMBER = /^run(?:$|[A-Z])/u;

/** `effect/Effect`-style submodules whose *named* exports are the run functions themselves. */
const SUBMODULE_SOURCE = /^effect\/(.+)$/u;

/** Type-level wrappers that are erased at build time and cannot change the runtime value. */
const ERASED_WRAPPERS = new Set([
  'ParenthesizedExpression',
  'TSNonNullExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

/** Guard against pathological alias chains / cycles when resolving `const E = Effect`. */
const MAX_ALIAS_HOPS = 8;

const DEFAULT_HARNESS_PATHS: readonly string[] = [
  '**/tests/support/effect-harness.{ts,mts}',
  '**/tests/support/it-effect.{ts,mts}',
  '**/tests/harness/**',
];

/** D-tier: Promise adapters forced by Playwright and other browser drivers. */
const DEFAULT_IGNORE_PATHS: readonly string[] = [
  '**/tests/e2e/**',
  '**/*.e2e.*',
  '**/playwright/**',
];

const DEFAULT_EFFECT_MODULES: readonly string[] = ['Effect'];

/**
 * Module specifiers that hand out Effect namespaces. `effect` / `effect/**` are covered by the shared
 * binding collector; first-party barrels that re-export the namespace must be listed explicitly.
 */
const DEFAULT_EFFECT_MODULE_SOURCES: readonly string[] = [
  'effect',
  'effect/**',
  '@modern-js/plugin-bff/effect-edge',
];

interface RuleOptions {
  readonly harnessPaths?: readonly string[];
  readonly ignorePaths?: readonly string[];
  readonly testPaths?: readonly string[];
  readonly effectModules?: readonly string[];
  readonly effectModuleSources?: readonly string[];
}

interface RunSite {
  readonly node: ESTree.Node;
  readonly member: string;
}

interface Range {
  readonly start: number;
  readonly end: number;
}

function readOptions(context: Context): Required<RuleOptions> {
  const raw = (context.options[0] ?? {}) as RuleOptions;
  return {
    harnessPaths: raw.harnessPaths ?? DEFAULT_HARNESS_PATHS,
    ignorePaths: raw.ignorePaths ?? DEFAULT_IGNORE_PATHS,
    testPaths: raw.testPaths ?? [],
    effectModules: raw.effectModules ?? DEFAULT_EFFECT_MODULES,
    effectModuleSources: raw.effectModuleSources ?? DEFAULT_EFFECT_MODULE_SOURCES,
  };
}

/** Strip erased TS wrappers (`x!`, `x as T`, `x satisfies T`, `(x)`, `x<T>`) from an expression. */
function unwrapErased(node: ESTree.Node): ESTree.Node {
  let current = node;
  for (let hop = 0; hop < MAX_ALIAS_HOPS && ERASED_WRAPPERS.has(current.type); hop += 1) {
    const inner = (current as { expression?: ESTree.Node }).expression;
    if (inner === undefined) break;
    current = inner;
  }
  return current;
}

/** The module specifier of `import("…")` when it is a static string, else `null`. */
function staticStringValue(node: ESTree.Node): string | null {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** Static string key of a member/property node, or `null` when it is dynamic. */
function staticKey(node: ESTree.Node, computed: boolean): string | null {
  if (!computed && node.type === 'Identifier') return node.name;
  return staticStringValue(node);
}

/** `ImportSpecifier.imported` / `ExportSpecifier.local` may be an identifier or a string literal. */
function moduleExportName(node: ESTree.Node): string | null {
  if (node.type === 'Identifier') return node.name;
  return staticStringValue(node);
}

/**
 * Supplement `collectEffectBindings` with namespaces re-exported by non-`effect` barrels, so
 * `import { Effect } from "@modern-js/plugin-bff/effect-edge"` is tracked exactly like `from "effect"`.
 */
function collectBarrelBindings(
  program: ESTree.Program,
  sources: readonly string[],
): Map<string, string> {
  const namespaces = new Map<string, string>();
  const patterns = sources.map(globToRegExp);
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (statement.importKind === 'type') continue;
    if (!patterns.some((pattern) => pattern.test(statement.source.value))) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue;
      if (specifier.importKind === 'type') continue;
      const imported = moduleExportName(specifier.imported);
      if (imported === null) continue;
      namespaces.set(specifier.local.name, imported);
    }
  }
  return namespaces;
}

/**
 * `import * as EffectLib from "effect"` binds the *root* barrel, which is
 * `export * as Effect from "./Effect.ts"` — so `EffectLib.Effect.runPromise` is the same function as
 * `Effect.runPromise`. Submodule namespaces (`effect/Effect`) are already tracked by the shared
 * collector and are deliberately excluded here.
 */
function collectRootNamespaces(program: ESTree.Program, sources: readonly string[]): Set<string> {
  const roots = new Set<string>();
  const patterns = sources.map(globToRegExp);
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (statement.importKind === 'type') continue;
    const source = statement.source.value;
    if (source.startsWith('effect/')) continue;
    if (!patterns.some((pattern) => pattern.test(source))) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') roots.add(specifier.local.name);
    }
  }
  return roots;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B2 + A1: tests must not call Effect.run* directly. Route every test program through the ' +
        'repository-owned itEffect/itLayer harness (effect/testing, TestClock, scoped Layer, ' +
        'ConfigProvider.fromMap) instead of building an ad hoc runtime per assertion.',
    },
    messages: {
      effectRunInTest:
        'Do not call Effect.{{member}} in a test. Run through the shared itEffect/itLayer harness ' +
        '(effect/testing, TestClock, scoped Layer, ConfigProvider.fromMap) so services, time and ' +
        'configuration are substitutable.',
      effectRunReferenceInTest:
        'Do not hand Effect.{{member}} around in a test (point-free, mock factory or destructured ' +
        'reference). Expose the effect and let the shared itEffect/itLayer harness run it with ' +
        'effect/testing, TestClock, a scoped Layer and ConfigProvider.fromMap.',
      effectRunImportInTest:
        'Do not import "{{member}}" from effect/Effect into a test. Import the shared itEffect/itLayer ' +
        'harness instead, so services, time and configuration stay substitutable.',
      effectRunReexportInTest:
        'Do not re-export "{{member}}" from effect/Effect out of a test module. A re-export hands every ' +
        'importing test an ad hoc root fiber; export the shared itEffect/itLayer harness ' +
        '(effect/testing, TestClock, scoped Layer, ConfigProvider.fromMap) instead.',
      effectRunDynamicImportInTest:
        'Do not reach Effect.{{member}} through `await import("effect/Effect")` in a test. Import the ' +
        'shared itEffect/itLayer harness so services, time and configuration stay substitutable.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          harnessPaths: { type: 'array', items: { type: 'string' } },
          ignorePaths: { type: 'array', items: { type: 'string' } },
          testPaths: { type: 'array', items: { type: 'string' } },
          effectModules: { type: 'array', items: { type: 'string' } },
          effectModuleSources: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        harnessPaths: [...DEFAULT_HARNESS_PATHS],
        ignorePaths: [...DEFAULT_IGNORE_PATHS],
        testPaths: [],
        effectModules: [...DEFAULT_EFFECT_MODULES],
        effectModuleSources: [...DEFAULT_EFFECT_MODULE_SOURCES],
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const filename = context.filename;
    if (matchesAny(filename, options.harnessPaths) || matchesAny(filename, options.ignorePaths))
      return {};
    if (!isTestFile(filename) && !matchesAny(filename, options.testPaths)) return {};

    let bindings: EffectBindings = { namespaces: new Map<string, string>(), importsEffect: false };
    /** `import * as X from "effect"` — `X.Effect` is the Effect namespace. */
    let rootNamespaces = new Set<string>();
    /** `const Effect = await import("effect/Effect")` — local name → submodule name. */
    const dynamicNamespaces = new Map<string, { namespace: string; declaration: ESTree.Node }>();
    /** `const Lib = await import("effect")` — `Lib.Effect` is the Effect namespace. */
    const dynamicRootNamespaces = new Map<string, ESTree.Node>();
    /** Argument spans of `Effect.run*(...)` calls; sites inside them belong to no-nested-effect-run. */
    const runArgumentRanges: Range[] = [];
    const callSites: RunSite[] = [];
    const referenceSites: RunSite[] = [];
    const importSites: RunSite[] = [];
    const reexportSites: RunSite[] = [];
    const dynamicSites: RunSite[] = [];

    function lookupVariable(node: ESTree.Node, name: string): Variable | null {
      let scope: Scope | null = context.sourceCode.getScope(node);
      while (scope !== null) {
        const variable = scope.set.get(name);
        if (variable !== undefined) return variable;
        scope = scope.upper;
      }
      return null;
    }

    /**
     * Confirm the identifier really resolves to a module import rather than a local shadow such as
     * `const Effect = { runPromise: () => {} }` inside a test double. Unresolved names (ambient or
     * declared elsewhere) are treated as the import so evasion by `declare` cannot hide a run site.
     */
    function resolvesToDeclaration(
      node: Extract<ESTree.Node, { type: 'Identifier' }>,
      declaration: ESTree.Node,
    ): boolean {
      const variable = lookupVariable(node, node.name);
      return (
        variable?.defs.some(
          (definition) =>
            definition.name.start === declaration.start && definition.name.end === declaration.end,
        ) ?? false
      );
    }

    function resolvesToImport(node: ESTree.Node, name: string): boolean {
      const variable = lookupVariable(node, name);
      if (variable === null) return true;
      return variable.defs.some((definition) => definition.type === 'ImportBinding');
    }

    /**
     * `const E = Effect;` → the initialiser expression, so a value alias of the namespace resolves
     * back to the import. Only single-definition `const`/`let` declarators with an identifier or
     * member initialiser qualify; parameters, catch bindings and destructuring never do.
     */
    function aliasInitialiser(node: ESTree.Node, name: string): ESTree.Node | null {
      const variable = lookupVariable(node, name);
      if (variable === null || variable.defs.length !== 1) return null;
      const definition = variable.defs[0];
      if (definition === undefined || definition.type !== 'Variable') return null;
      const declarator = definition.node;
      if (declarator.type !== 'VariableDeclarator') return null;
      if (declarator.id.type !== 'Identifier' || declarator.init === null) return null;
      const init = unwrapErased(declarator.init);
      return init.type === 'Identifier' || init.type === 'MemberExpression' ? init : null;
    }

    /** Does `node` evaluate to the root `effect` barrel (so that `.Effect` is the namespace)? */
    function isRootBarrel(node: ESTree.Node, hops: number): boolean {
      if (hops > MAX_ALIAS_HOPS) return false;
      const target = unwrapErased(node);
      if (target.type !== 'Identifier') return false;
      const dynamic = dynamicRootNamespaces.get(target.name);
      if (dynamic !== undefined && resolvesToDeclaration(target, dynamic)) return true;
      if (rootNamespaces.has(target.name) && resolvesToImport(target, target.name)) return true;
      const alias = aliasInitialiser(target, target.name);
      return alias === null ? false : isRootBarrel(alias, hops + 1);
    }

    /** Does `node` evaluate to an Effect namespace object that carries the `run*` entry points? */
    function isEffectNamespace(node: ESTree.Node, hops = 0): boolean {
      if (hops > MAX_ALIAS_HOPS) return false;
      const target = unwrapErased(node);
      if (target.type === 'MemberExpression') {
        // `EffectLib.Effect` / `EffectLib["Effect"]` on a root barrel namespace.
        const key = staticKey(target.property, target.computed);
        if (key === null || !options.effectModules.includes(key)) return false;
        return isRootBarrel(target.object, hops + 1);
      }
      if (target.type !== 'Identifier') return false;
      const dynamic = dynamicNamespaces.get(target.name);
      if (
        dynamic !== undefined &&
        options.effectModules.includes(dynamic.namespace) &&
        resolvesToDeclaration(target, dynamic.declaration)
      )
        return true;
      const namespace = bindings.namespaces.get(target.name);
      if (
        namespace !== undefined &&
        options.effectModules.includes(namespace) &&
        resolvesToImport(target, target.name)
      ) {
        return true;
      }
      const alias = aliasInitialiser(target, target.name);
      return alias === null ? false : isEffectNamespace(alias, hops + 1);
    }

    /** `Effect.runPromise` / `Effect["runPromise"]` / `E?.runSync` → the run member name. */
    function runMemberOf(node: ESTree.MemberExpression): string | null {
      if (!isEffectNamespace(node.object)) return null;
      const direct = effectMember(node, bindings);
      const member = direct === null ? staticKey(node.property, node.computed) : direct.member;
      if (member === null || !RUN_MEMBER.test(member)) return null;
      return member;
    }

    function isNested(node: ESTree.Node): boolean {
      return runArgumentRanges.some((range) => node.start >= range.start && node.end <= range.end);
    }

    /** `await import("effect/Effect")` / `import("effect")` → the module specifier, else `null`. */
    function dynamicImportSource(node: ESTree.Node | null): string | null {
      if (node === null) return null;
      let target = unwrapErased(node);
      if (target.type === 'AwaitExpression') target = unwrapErased(target.argument);
      if (target.type !== 'ImportExpression') return null;
      return staticStringValue(target.source);
    }

    return {
      Program(node) {
        const canonical = collectEffectBindings(node);
        const barrel = collectBarrelBindings(node, options.effectModuleSources);
        bindings = {
          namespaces: new Map<string, string>([...barrel, ...canonical.namespaces]),
          importsEffect: canonical.importsEffect || barrel.size > 0,
        };
        rootNamespaces = collectRootNamespaces(node, options.effectModuleSources);
      },

      ImportDeclaration(node) {
        if (node.importKind === 'type') return;
        const submodule = SUBMODULE_SOURCE.exec(node.source.value)?.[1];
        if (submodule === undefined || !options.effectModules.includes(submodule)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') continue;
          if (specifier.importKind === 'type') continue;
          const imported = moduleExportName(specifier.imported);
          if (imported === null || !RUN_MEMBER.test(imported)) continue;
          importSites.push({ node: specifier, member: imported });
        }
      },

      ExportNamedDeclaration(node) {
        if (node.source === null || node.exportKind === 'type') return;
        const submodule = SUBMODULE_SOURCE.exec(node.source.value)?.[1];
        if (submodule === undefined || !options.effectModules.includes(submodule)) return;
        for (const specifier of node.specifiers) {
          if (specifier.exportKind === 'type') continue;
          const local = moduleExportName(specifier.local);
          if (local === null || !RUN_MEMBER.test(local)) continue;
          reexportSites.push({ node: specifier, member: local });
        }
      },

      ExportAllDeclaration(node) {
        if (node.exportKind === 'type' || node.exported !== null) return;
        const submodule = SUBMODULE_SOURCE.exec(node.source.value)?.[1];
        if (submodule === undefined || !options.effectModules.includes(submodule)) return;
        reexportSites.push({ node, member: `* from effect/${submodule}` });
      },

      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression') return;
        if (runMemberOf(node.callee) === null) return;
        const first = node.arguments[0];
        runArgumentRanges.push({
          start: first === undefined ? node.end : first.start,
          end: node.end,
        });
      },

      MemberExpression(node) {
        const member = runMemberOf(node);
        if (member === null) return;
        const parent = node.parent;
        const called =
          parent !== null &&
          parent !== undefined &&
          parent.type === 'CallExpression' &&
          parent.callee === node;
        (called ? callSites : referenceSites).push({ node, member });
      },

      VariableDeclarator(node) {
        const dynamicSource = dynamicImportSource(node.init);
        if (dynamicSource !== null) {
          const submodule = SUBMODULE_SOURCE.exec(dynamicSource)?.[1];
          const isRoot = dynamicSource === 'effect';
          if (submodule !== undefined && options.effectModules.includes(submodule)) {
            if (node.id.type === 'Identifier')
              dynamicNamespaces.set(node.id.name, { namespace: submodule, declaration: node.id });
            else if (node.id.type === 'ObjectPattern') {
              for (const property of node.id.properties) {
                if (property.type !== 'Property') continue;
                const member = staticKey(property.key, property.computed);
                if (member === null || !RUN_MEMBER.test(member)) continue;
                dynamicSites.push({ node: property, member });
              }
            }
            return;
          }
          if (isRoot) {
            if (node.id.type === 'Identifier') dynamicRootNamespaces.set(node.id.name, node.id);
            else if (node.id.type === 'ObjectPattern') {
              for (const property of node.id.properties) {
                if (property.type !== 'Property') continue;
                const key = staticKey(property.key, property.computed);
                if (key === null || !options.effectModules.includes(key)) continue;
                if (property.value.type === 'Identifier')
                  dynamicNamespaces.set(property.value.name, {
                    namespace: key,
                    declaration: property.value,
                  });
              }
            }
          }
          return;
        }
        if (node.id.type !== 'ObjectPattern' || node.init === null || node.init === undefined)
          return;
        if (!isEffectNamespace(node.init)) return;
        for (const property of node.id.properties) {
          if (property.type !== 'Property') continue;
          const member = staticKey(property.key, property.computed);
          if (member === null || !RUN_MEMBER.test(member)) continue;
          referenceSites.push({ node: property, member });
        }
      },

      'Program:exit'() {
        for (const site of importSites) {
          context.report({
            node: site.node,
            messageId: 'effectRunImportInTest',
            data: { member: site.member },
          });
        }
        for (const site of reexportSites) {
          context.report({
            node: site.node,
            messageId: 'effectRunReexportInTest',
            data: { member: site.member },
          });
        }
        for (const site of dynamicSites) {
          if (isNested(site.node)) continue;
          context.report({
            node: site.node,
            messageId: 'effectRunDynamicImportInTest',
            data: { member: site.member },
          });
        }
        for (const site of callSites) {
          if (isNested(site.node)) continue;
          context.report({
            node: site.node,
            messageId: 'effectRunInTest',
            data: { member: site.member },
          });
        }
        for (const site of referenceSites) {
          if (isNested(site.node)) continue;
          context.report({
            node: site.node,
            messageId: 'effectRunReferenceInTest',
            data: { member: site.member },
          });
        }
      },
    };
  },
});
