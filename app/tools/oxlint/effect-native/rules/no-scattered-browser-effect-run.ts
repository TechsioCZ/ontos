/**
 * Audit findings: A9 (preserve typed Effects through the frontend), A1 (one ManagedRuntime per
 * host), A4 (typed error channels — frontend reclassification after `runPromise` erases the union).
 * See `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`.
 *
 * Detected in browser code (`browserGlobs`, excluding `adapterFiles`, `serverGlobs` and tests):
 *  1. Every Effect run seam — `Effect.runPromise` / `runSync` / `runFork` / `runCallback`
 *     (also `*Exit`, `*With`, computed `Effect["runPromise"]` and a substitution-free template
 *     literal, optional chaining, and point-free references such as `pipe(effect, Effect.runPromise)`),
 *     resolved through the real `effect` import bindings so aliases
 *     (`import { Effect as EffectRuntime }`), submodule namespace imports
 *     (`import * as EffectModule from "effect/Effect"`) and the root namespace import
 *     (`import * as effect from "effect"` → `effect.Effect.runPromise`) are covered. A binding that
 *     merely *shadows* an effect namespace (a parameter or local named `Effect`) is not a seam:
 *     every match is confirmed against the scope chain.
 *  2. Effect v4 member imports of the runner itself — `import { runPromise } from "effect/Effect"`,
 *     including aliases (`import { runFork as boot }`) and point-free use — plus destructuring a
 *     runner out of the namespace (`const { runPromise } = Effect`).
 *  3. Every call or non-callee reference of an ad hoc runner imported by name (`runEffectRequest`,
 *     `runEffectView` by default) from any module: named, default and namespace imports
 *     (`api.runEffectRequest(...)`), including through TypeScript value wrappers
 *     (`as`, `!`, `satisfies`).
 *  4. Re-exports of known ad hoc runners across browser modules:
 *     `export { runEffectRequest } from "..."`, `export { runEffectRequest }` (after importing it),
 *     `export { default as runEffectRequest } from "..."`.
 *     Namespace-only exports are allowed: the earlier specification overreached A9 by treating
 *     composition vocabulary as execution. They start no fiber and erase no error channel.
 * A run seam lexically nested inside an already reported seam is reported once (outermost only).
 * Sites whose nearest enclosing function is a TanStack/router boundary (`queryFn`, `mutationFn`,
 * `loader`, `action`) get the sharper `queryBoundary` message.
 *
 * Deliberately allowed (audit "Existing patterns to preserve" / D tier):
 *  - The single browser adapter seam: files under `adapterFiles` (`apps/*​/src/runtime/**`,
 *    `verticals/*​/src/runtime/**`) own the browser `ManagedRuntime` and the query/mutation adapter
 *    that React and TanStack force to be a Promise. React/TanStack Promise adapters are D tier.
 *  - Server code that happens to live under a browser glob: `serverGlobs` (`**​/src/db/**`,
 *    `**​/src/services/**`, `**​/src/actions/**`, `**​/src/server/**`, `*.server.ts[x]`). A process
 *    entry seam there is the audit-blessed single outer adapter and is governed by
 *    `no-bare-effect-run` / `no-runtime-construction-outside-root`, not by this browser rule.
 *  - Test and script code: only `browserGlobs` are in scope and test files are skipped.
 *  - Type-only positions (`typeof Effect.runPromise`, `export type { runEffectRequest }`).
 *  - Look-alikes that are not the Effect runner: `workerPool.runPromise("job")`, a domain class
 *    method named `runPromise`, `runPromise` imported from a non-effect module, and locally
 *    defined or shadowed runner identifiers.
 *  - Everything that is not a run seam: composing, piping, `Effect.gen`, client construction and
 *    passing Effects around stay untouched — the rule only objects to *running* them ad hoc.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope } from '@oxlint/plugins';

import { collectEffectBindings } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, matchesAny } from '../shared/paths.ts';

const DEFAULT_BROWSER_GLOBS = ['apps/*/src/**', 'verticals/*/src/**'];
const DEFAULT_ADAPTER_FILES = ['apps/*/src/runtime/**', 'verticals/*/src/runtime/**'];
const DEFAULT_SERVER_GLOBS = [
  '**/src/db/**',
  '**/src/server/**',
  '**/src/services/**',
  '**/src/actions/**',
  '**/*.server.ts',
  '**/*.server.tsx',
];
const DEFAULT_RUNNER_NAMES = ['runEffectRequest', 'runEffectView'];
const DEFAULT_BOUNDARY_KEYS = ['queryFn', 'mutationFn', 'loader', 'action'];
const DEFAULT_EFFECT_MODULES = ['effect', 'effect/*', 'effect/**'];

/** `Effect.runPromise`, `runPromiseExit`, `runSyncExit`, `runForkWith`, `runCallback`, ... */
const RUN_MEMBER = /^run(?:Sync|Promise|Fork|Callback)(?:Exit)?(?:With)?$/u;
/** Namespaces of `effect` that expose root fiber runners. */
const RUNNER_NAMESPACES = new Set(['Effect']);
// Runtime/ManagedRuntime functions require a captured runtime; they are A1's replacement,
// not evidence of a fresh root. Re-exporting an Effect namespace alone runs nothing.
/** Parents that put an identifier in a *type* position; TS value wrappers stay reportable. */
const TYPE_POSITION_PARENTS = new Set([
  'TSClassImplements',
  'TSImportType',
  'TSImportTypeQualifiedName',
  'TSInterfaceHeritage',
  'TSMethodSignature',
  'TSPropertySignature',
  'TSQualifiedName',
  'TSTypeAliasDeclaration',
  'TSTypeAnnotation',
  'TSTypeOperator',
  'TSTypeParameterInstantiation',
  'TSTypePredicate',
  'TSTypeQuery',
  'TSTypeReference',
]);
/** Wrappers that keep a callee in value position, so the reported site is the whole call. */
const VALUE_WRAPPERS = new Set([
  'ChainExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSInstantiationExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
]);

interface RuleOptions {
  readonly browserGlobs?: readonly string[];
  readonly adapterFiles?: readonly string[];
  readonly serverGlobs?: readonly string[];
  readonly runnerNames?: readonly string[];
  readonly boundaryKeys?: readonly string[];
  readonly effectModules?: readonly string[];
  readonly includeTestFiles?: boolean;
}

const FUNCTION_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);

function readOptions(context: Context): Required<RuleOptions> {
  const raw = (context.options[0] ?? {}) as RuleOptions;
  return {
    adapterFiles: raw.adapterFiles ?? DEFAULT_ADAPTER_FILES,
    boundaryKeys: raw.boundaryKeys ?? DEFAULT_BOUNDARY_KEYS,
    browserGlobs: raw.browserGlobs ?? DEFAULT_BROWSER_GLOBS,
    effectModules: raw.effectModules ?? DEFAULT_EFFECT_MODULES,
    includeTestFiles: raw.includeTestFiles ?? false,
    runnerNames: raw.runnerNames ?? DEFAULT_RUNNER_NAMES,
    serverGlobs: raw.serverGlobs ?? DEFAULT_SERVER_GLOBS,
  };
}

function moduleExportName(name: ESTree.Node): string | null {
  if (name.type === 'Identifier') return name.name;
  if (name.type === 'Literal' && typeof name.value === 'string') return name.value;
  return null;
}

/** `x.member`, `x["member"]` and a substitution-free `x[`member`]` → `"member"`; dynamic → `null`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const property = node.property;
  if (property.type === 'Literal')
    return typeof property.value === 'string' ? property.value : null;
  if (property.type === 'TemplateLiteral' && property.expressions.length === 0) {
    const quasi = property.quasis[0];
    return quasi === undefined ? null : (quasi.value.cooked ?? quasi.value.raw);
  }
  return null;
}

/** True when `name` at `node` still resolves to the module-level import (no shadowing binding). */
function resolvesToModuleImport(context: Context, node: ESTree.Node, name: string): boolean {
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) {
      return variable.defs.some((definition) => definition.type === 'ImportBinding');
    }
    scope = scope.upper;
  }
  // Unresolved (e.g. a scope-analysis gap): trust the module-level import table.
  return true;
}

/** Locals bound to an ad hoc runner by name, default or namespace import; local → imported name. */
function collectRunnerImports(
  program: ESTree.Program,
  runnerNames: readonly string[],
): ReadonlyMap<string, string> {
  const locals = new Map<string, string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier') {
        if (specifier.importKind === 'type') continue;
        const imported = moduleExportName(specifier.imported);
        if (imported !== null && runnerNames.includes(imported))
          locals.set(specifier.local.name, imported);
        continue;
      }
      // `import runEffectRequest from "..."` / `import * as runEffectRequest from "..."`.
      if (runnerNames.includes(specifier.local.name))
        locals.set(specifier.local.name, specifier.local.name);
    }
  }
  return locals;
}

/** Locals bound by `import * as ns from "..."` (any module), local → module source. */
function collectNamespaceImports(program: ESTree.Program): ReadonlyMap<string, string> {
  const locals = new Map<string, string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportNamespaceSpecifier') continue;
      locals.set(specifier.local.name, statement.source.value);
    }
  }
  return locals;
}

/**
 * Locals bound by `import * as effect from "effect"` (the bare root). `collectEffectBindings`
 * deliberately drops these — a root namespace is not a single Effect namespace — but they still
 * reach every runner one member deeper (`effect.Effect.runPromise`).
 */
function collectRootNamespaceImports(
  program: ESTree.Program,
  effectModulePatterns: readonly RegExp[],
): ReadonlySet<string> {
  const locals = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue;
    const source = statement.source.value;
    if (!effectModulePatterns.some((pattern) => pattern.test(source))) continue;
    if (source.split('/').at(-1) !== 'effect') continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') locals.add(specifier.local.name);
    }
  }
  return locals;
}

function unwrap(node: ESTree.Node): ESTree.Node {
  let current = node;
  while (VALUE_WRAPPERS.has(current.type)) {
    const expression = (current as { expression?: ESTree.Node }).expression;
    if (expression === undefined) break;
    current = expression;
  }
  return current;
}

function ancestorsOf(node: ESTree.Node): ESTree.Node[] {
  const ancestors: ESTree.Node[] = [];
  for (let current = node.parent; current !== null; current = current.parent)
    ancestors.push(current);
  return ancestors.reverse();
}

/** The boundary key (`queryFn`, `loader`, ...) owning the nearest enclosing function, if any. */
function boundaryKeyFor(
  context: Context,
  node: ESTree.Node,
  boundaryKeys: readonly string[],
): string | null {
  const ancestors = ancestorsOf(node);
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (ancestor === undefined) continue;
    const owner = index > 0 ? ancestors[index - 1] : undefined;
    if (owner === undefined) return null;
    if (ancestor.type === 'Property' && !ancestor.computed) {
      const key = moduleExportName(ancestor.key);
      if (key !== null && boundaryKeys.includes(key)) return key;
      return null;
    }
    if (ancestor.type === 'VariableDeclarator' && ancestor.id.type === 'Identifier') {
      return boundaryKeys.includes(ancestor.id.name) ? ancestor.id.name : null;
    }
    if (FUNCTION_TYPES.has(ancestor.type)) {
      // Only the function directly owned by a boundary property/binding counts.
      if (owner.type === 'Property' || owner.type === 'VariableDeclarator') continue;
      return null;
    }
  }
  return null;
}

export const rule = defineRule({
  meta: {
    defaultOptions: [
      {
        adapterFiles: DEFAULT_ADAPTER_FILES,
        boundaryKeys: DEFAULT_BOUNDARY_KEYS,
        browserGlobs: DEFAULT_BROWSER_GLOBS,
        effectModules: DEFAULT_EFFECT_MODULES,
        includeTestFiles: false,
        runnerNames: DEFAULT_RUNNER_NAMES,
        serverGlobs: DEFAULT_SERVER_GLOBS,
      },
    ],
    docs: {
      description:
        'Audit A9/A1/A4: browser code must not run Effects ad hoc (`runEffectRequest`, `Effect.run*`). One browser ManagedRuntime and one cancellation-aware query adapter own the only Promise seam.',
    },
    messages: {
      adHocRun:
        'Browser code must not run Effects ad hoc with `{{runner}}`; it erases the typed failure union before React/TanStack sees it and bypasses cancellation. Run it through the single browser ManagedRuntime exposed by the shared query/mutation adapter (audit A9/A1/A4).',
      destructuredRunner:
        'Destructuring `{{runner}}` out of the Effect namespace hides an ad hoc browser run seam; every use then erases the typed failure union outside the adapter. Keep Effects typed and run them through the single browser ManagedRuntime query/mutation adapter (audit A9/A1/A4).',
      queryBoundary:
        'Browser code must not run Effects ad hoc with `{{runner}}` inside `{{key}}`; it erases the typed failure union and bypasses the signal-driven cancellation TanStack already provides. Use the shared Effect query/mutation adapter backed by the single browser ManagedRuntime and keep `{{key}}` as the only Promise seam (audit A9/A1/A4).',
      runnerReexport:
        'Do not re-export the ad hoc Effect runner `{{runner}}`; every importing route module becomes another untyped Promise seam. Export typed Effects and let the single browser ManagedRuntime query/mutation adapter be the only place that runs them (audit A9/A1).',
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          adapterFiles: { items: { type: 'string' }, type: 'array' },
          boundaryKeys: { items: { type: 'string' }, type: 'array' },
          browserGlobs: { items: { type: 'string' }, type: 'array' },
          effectModules: { items: { type: 'string' }, type: 'array' },
          includeTestFiles: { type: 'boolean' },
          runnerNames: { items: { type: 'string' }, type: 'array' },
          serverGlobs: { items: { type: 'string' }, type: 'array' },
        },
        type: 'object',
      },
    ],
    type: 'problem',
  },
  create(context) {
    const options = readOptions(context);
    const filename = context.filename;
    if (!matchesAny(filename, options.browserGlobs)) return {};
    if (matchesAny(filename, options.adapterFiles)) return {};
    if (matchesAny(filename, options.serverGlobs)) return {};
    if (!options.includeTestFiles && isTestFile(filename)) return {};

    const effectModulePatterns = options.effectModules.map((glob) => globToRegExp(glob));
    let bindings: EffectBindings = { importsEffect: false, namespaces: new Map() };
    let runnerImports: ReadonlyMap<string, string> = new Map();
    let namespaceImports: ReadonlyMap<string, string> = new Map();
    let rootNamespaces: ReadonlySet<string> = new Set();
    const reported: Array<{ readonly start: number; readonly end: number }> = [];

    /** `Effect.runPromise` / `Effect["runPromise"]` / `effect.Effect.runPromise` on real imports. */
    const runSeam = (node: ESTree.MemberExpression): string | null => {
      const object = unwrap(node.object);
      const member = memberName(node);
      if (member === null || !RUN_MEMBER.test(member)) return null;
      if (object.type === 'Identifier') {
        const namespace = bindings.namespaces.get(object.name);
        if (namespace === undefined || !RUNNER_NAMESPACES.has(namespace)) return null;
        if (!resolvesToModuleImport(context, object, object.name)) return null;
        return `${object.name}.${member}`;
      }
      if (object.type === 'MemberExpression') {
        const root = unwrap(object.object);
        if (root.type !== 'Identifier' || !rootNamespaces.has(root.name)) return null;
        const namespace = memberName(object);
        if (namespace === null || !RUNNER_NAMESPACES.has(namespace)) return null;
        if (!resolvesToModuleImport(context, root, root.name)) return null;
        return `${root.name}.${namespace}.${member}`;
      }
      return null;
    };

    /** `api.runEffectRequest(...)` where `api` is a namespace import of the runner's module. */
    const namespacedRunner = (node: ESTree.MemberExpression): string | null => {
      if (node.object.type !== 'Identifier') return null;
      if (!namespaceImports.has(node.object.name)) return null;
      const member = memberName(node);
      if (member === null || !options.runnerNames.includes(member)) return null;
      if (!resolvesToModuleImport(context, node.object, node.object.name)) return null;
      return `${node.object.name}.${member}`;
    };

    /** `import { runPromise } from "effect/Effect"` — the runner bound as a bare identifier. */
    const importedRunMember = (name: string): boolean => {
      return context.sourceCode.ast.body.some(
        (statement) =>
          statement.type === 'ImportDeclaration' &&
          statement.source.value === 'effect/Effect' &&
          statement.importKind !== 'type' &&
          statement.specifiers.some(
            (specifier) =>
              specifier.type === 'ImportSpecifier' &&
              specifier.importKind !== 'type' &&
              specifier.local.name === name &&
              RUN_MEMBER.test(moduleExportName(specifier.imported) ?? ''),
          ),
      );
    };

    /** The call expression a callee belongs to, so nested seams inside its arguments dedupe. */
    const siteOf = (node: ESTree.Node): { readonly start: number; readonly end: number } => {
      const ancestors = ancestorsOf(node);
      let current: ESTree.Node = node;
      for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        const ancestor = ancestors[index];
        if (ancestor === undefined) break;
        if (VALUE_WRAPPERS.has(ancestor.type)) {
          current = ancestor;
          continue;
        }
        if (ancestor.type === 'CallExpression' && ancestor.callee === current) return ancestor;
        break;
      }
      return current;
    };

    /** Report unless the site is lexically nested inside an already reported run seam. */
    const reportSite = (node: ESTree.Node, runner: string): void => {
      if (ancestorsOf(node).some((parent) => TYPE_POSITION_PARENTS.has(parent.type))) return;
      const site = siteOf(node);
      if (reported.some((range) => site.start >= range.start && site.end <= range.end)) return;
      reported.push(site);
      const key = boundaryKeyFor(context, node, options.boundaryKeys);
      if (key === null) {
        context.report({ data: { runner }, messageId: 'adHocRun', node });
      } else {
        context.report({ data: { key, runner }, messageId: 'queryBoundary', node });
      }
    };

    return {
      Program(node) {
        bindings = collectEffectBindings(node);
        runnerImports = collectRunnerImports(node, options.runnerNames);
        namespaceImports = collectNamespaceImports(node);
        rootNamespaces = collectRootNamespaceImports(node, effectModulePatterns);
      },
      MemberExpression(node) {
        const runner = runSeam(node) ?? namespacedRunner(node);
        if (runner === null) return;
        reportSite(node, runner);
      },
      Identifier(node) {
        if (!runnerImports.has(node.name) && !importedRunMember(node.name)) return;
        const parent = ancestorsOf(node).at(-1);
        if (parent === undefined) return;
        // Declaration and re-export sites are handled by their own visitors.
        if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier') return;
        if (parent.type === 'ImportNamespaceSpecifier' || parent.type === 'ExportSpecifier') return;
        if (parent.type === 'MemberExpression' && !parent.computed && parent.property === node)
          return;
        if (
          parent.type === 'Property' &&
          !parent.computed &&
          parent.key === node &&
          !parent.shorthand
        )
          return;
        if (
          (parent.type === 'PropertyDefinition' ||
            parent.type === 'MethodDefinition' ||
            parent.type === 'AccessorProperty') &&
          parent.key === node &&
          !parent.computed
        )
          return;
        if (TYPE_POSITION_PARENTS.has(parent.type)) return;
        if (!resolvesToModuleImport(context, node, node.name)) return;
        reportSite(node, node.name);
      },
      VariableDeclarator(node) {
        if (node.id.type !== 'ObjectPattern') return;
        const init = node.init;
        if (init === null || init === undefined || init.type !== 'Identifier') return;
        const namespace = bindings.namespaces.get(init.name);
        if (namespace === undefined || !RUNNER_NAMESPACES.has(namespace)) return;
        if (!resolvesToModuleImport(context, init, init.name)) return;
        for (const property of node.id.properties) {
          if (property.type !== 'Property' || property.computed) continue;
          const key = moduleExportName(property.key);
          if (key === null || !RUN_MEMBER.test(key)) continue;
          context.report({
            data: { runner: `${init.name}.${key}` },
            messageId: 'destructuredRunner',
            node: property,
          });
        }
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind === 'type') return;
        const source = node.source?.value ?? null;
        // Namespace barrels are not run seams; only known runner exports are governed.
        for (const specifier of node.specifiers) {
          if (specifier.exportKind === 'type') continue;
          const local = moduleExportName(specifier.local);
          const exported = moduleExportName(specifier.exported);
          if (local === null) continue;
          const named = [local, exported].filter((name): name is string => name !== null);
          const isRunner =
            source === null
              ? (runnerImports.has(local) || importedRunMember(local)) &&
                resolvesToModuleImport(context, specifier.local, local)
              : named.some((name) => options.runnerNames.includes(name));
          if (!isRunner) continue;
          context.report({
            data: { runner: isRunner ? (exported ?? local) : local },
            messageId: 'runnerReexport',
            node: specifier,
          });
        }
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === 'type') return;
        const exported = node.exported;
        if (exported === null || exported === undefined) return;
        const name = moduleExportName(exported);
        if (name === null) return;
        if (!options.runnerNames.includes(name)) return;
        context.report({
          data: { runner: name },
          messageId: 'runnerReexport',
          node,
        });
      },
    };
  },
});
