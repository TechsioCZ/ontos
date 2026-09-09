import { fileURLToPath } from 'node:url';

/**
 * Audit A6 (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`) asks for Logger,
 * Tracer/OpenTelemetry and minimum-level Layers at runtime roots.
 *
 * Recognizes runtime-construction member references, module-level Effect.run* references (including
 * directly invoked module-level functions), executable factories annotated with imported framework
 * EffectBffRuntime, and configured host entry files importing Effect. EffectRuntimeLayer is a Layer,
 * not a runtime factory return type. Pure type aliases, ambient signatures and leaf adapters are not
 * execution roots. Actual imports, immutable local aliases, static computed members and TS wrappers
 * are resolved; root/member presence is still a syntactic candidate, not proof of execution.
 *
 * For each root file, reports missing recognized local Logger/Tracer/minimum-level evidence once
 * per category. Imports/member uses count as evidence; they do NOT prove those Layers are composed,
 * provided, initialized or exporting spans. Conversely an opaque shared ObservabilityLive may supply
 * all three without recognizable local evidence. There is no cross-file Layer-graph/type analysis.
 * Framework/OTel barrel conventions are configurable. Do not infer missing runtime instrumentation
 * solely from this diagnostic, or treat a clean result as proof of installed observability.
 *
 * Leaf Effects, forced outer adapters, startup orDie after typed logging, native collections and
 * serialization remain untouched. Tests/scripts are excluded by default. No fixer or suggestions.
 */
import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree, Variable } from '@oxlint/plugins';

import { unwrapNode as unwrap, memberName as sharedMemberName, keyName } from '../shared/ast.ts';
import { lookupVariable, resolvesToImport } from '../shared/bindings.ts';
import { importedName } from '../shared/imports.ts';
import { optionRecord } from '../shared/options.ts';
import { stringArray, booleanOption as boolOption } from '../shared/options.ts';
import { isTestFile, rootedScopePath, matchesGlobs } from '../shared/paths.ts';
import { isNonReferencePosition as sharedNonReferencePosition } from '../shared/reference-positions.ts';

const EFFECT_MODULE = /^effect(?:\/.*)?$/u;
const EFFECT_ROOT_MODULE = 'effect';

/** A6 targets the deployed hosts; `scripts/**` joins only through `includeScripts`. */
const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**'];

const DEFAULT_IGNORE: readonly string[] = [];

/** The declared composition roots (same list as `no-runtime-construction-outside-root`). */
const DEFAULT_ROOT_FILES = [
  'apps/*/api/index.ts',
  'verticals/*/api/index.ts',
  'packages/core-runtime/src/outbox/process.ts',
  'apps/*/src/runtime/**',
  'verticals/*/src/runtime/**',
];

/** `Namespace.member` references that mark a candidate runtime root. */
const DEFAULT_RUNTIME_MEMBERS = [
  'ManagedRuntime.make',
  'Layer.launch',
  'Layer.toRuntime',
  'Layer.toRuntimeWithMemoMap',
];

/** Framework return types that mark a factory as a BFF/composition root. */
const DEFAULT_RUNTIME_TYPE_NAMES = ['EffectBffRuntime'];

const DEFAULT_OTEL_MODULES = ['@effect/opentelemetry', '@effect/opentelemetry/**'];

/** Barrels that re-export Effect namespaces verbatim; `Logger` from them is Effect's `Logger`. */
const DEFAULT_REEXPORT_MODULES = [
  '@modern-js/plugin-bff/effect-edge',
  '@modern-js/plugin-bff/effect-server',
  '@modern-js/plugin-bff/server',
  '@modern-js/plugin-bff/effect',
];

const DEFAULT_MINIMUM_LOG_LEVEL_MEMBERS = [
  'References.MinimumLogLevel',
  'Logger.withMinimumLogLevel',
  'Logger.minimumLogLevel',
  'Effect.withMinimumLogLevel',
];

/** Effect namespaces whose use is recognized local observability evidence. */
const LOGGER_NAMESPACE = 'Logger';
const TRACER_NAMESPACE = 'Tracer';

type RuleOptions = Readonly<ReturnType<typeof readOptions>>;

function readOptions(context: Context) {
  const record = optionRecord(context.options?.[0]);
  const requireRecord = optionRecord(record.require);
  return {
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    rootFiles: stringArray(record.rootFiles, DEFAULT_ROOT_FILES),
    runtimeMembers: stringArray(record.runtimeMembers, DEFAULT_RUNTIME_MEMBERS),
    runtimeTypeNames: stringArray(record.runtimeTypeNames, DEFAULT_RUNTIME_TYPE_NAMES),
    otelModules: stringArray(record.otelModules, DEFAULT_OTEL_MODULES),
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
    minimumLogLevelMembers: stringArray(record.minimumLogLevelMembers, DEFAULT_MINIMUM_LOG_LEVEL_MEMBERS),
    includeScripts: boolOption(record.includeScripts, false),
    includeTests: boolOption(record.includeTests, false),
    require: {
      logger: boolOption(requireRecord.logger, true),
      tracer: boolOption(requireRecord.tracer, true),
      minimumLogLevel: boolOption(requireRecord.minimumLogLevel, true),
    },
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return rootedScopePath(filename, fileURLToPath(new URL('../../../../', import.meta.url)));
}

/** `["ManagedRuntime.make"]` → `Set{"ManagedRuntime.make"}`, ignoring malformed entries. */
function qualifiedSet(entries: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const entry of entries) {
    const dot = entry.indexOf('.');
    if (dot <= 0 || dot === entry.length - 1) continue;
    set.add(entry);
  }
  return set;
}

function isTypeOnly(declaration: ESTree.ImportDeclaration, specifier: ESTree.ImportDeclarationSpecifier): boolean {
  if (declaration.importKind === 'type') return true;
  return specifier.type === 'ImportSpecifier' && specifier.importKind === 'type';
}

interface FileBindings {
  /** local identifier → Effect namespace (`L` → `Logger`), value imports only. */
  readonly namespaces: ReadonlyMap<string, string>;
  readonly directMembers: ReadonlyMap<string, string>;
  /** locals bound to the whole Effect barrel (`import * as EffectNs from "effect"`). */
  readonly barrels: ReadonlySet<string>;
  /** local identifier → imported name, for value bindings from `@effect/opentelemetry[/*]`. */
  readonly otelLocals: ReadonlyMap<string, string>;
  /** local type names that stand for the framework runtime type (`EffectBffRuntime`). */
  readonly runtimeTypeLocals: ReadonlySet<string>;
  readonly runtimeTypeNamespaces: ReadonlySet<string>;
  /** `true` when the file value-imports `effect` / `effect/*` or an Effect re-export barrel. */
  readonly importsEffect: boolean;
  /** direct evidence taken from import sources alone (`import … from "effect/Logger"`). */
  readonly loggerModuleImport: boolean;
  readonly tracerModuleImport: boolean;
  readonly otelValueImport: boolean;
}

type CollectedBindings = {
  namespaces: Map<string, string>;
  directMembers: Map<string, string>;
  barrels: Set<string>;
  otelLocals: Map<string, string>;
  runtimeTypeLocals: Set<string>;
  runtimeTypeNamespaces: Set<string>;
  importsEffect: boolean;
  loggerModuleImport: boolean;
  tracerModuleImport: boolean;
  otelValueImport: boolean;
};

function collectRuntimeTypes(
  statement: ESTree.ImportDeclaration,
  names: ReadonlySet<string>,
  bindings: CollectedBindings,
): void {
  for (const specifier of statement.specifiers) {
    if (specifier.type === 'ImportNamespaceSpecifier') bindings.runtimeTypeNamespaces.add(specifier.local.name);
    if (specifier.type === 'ImportSpecifier' && names.has(importedName(specifier)))
      bindings.runtimeTypeLocals.add(specifier.local.name);
  }
}

function collectEffectSpecifier(
  specifier: ESTree.ImportDeclarationSpecifier,
  source: string,
  bindings: CollectedBindings,
): void {
  const submodule = source.split('/').at(-1);
  const local = specifier.local.name;
  if (specifier.type === 'ImportSpecifier') {
    if (source !== EFFECT_ROOT_MODULE && submodule && /^[A-Z]/u.test(submodule))
      bindings.directMembers.set(local, `${submodule}.${importedName(specifier)}`);
    else bindings.namespaces.set(local, importedName(specifier));
    return;
  }
  if (specifier.type !== 'ImportNamespaceSpecifier') return;
  if (source === EFFECT_ROOT_MODULE) bindings.barrels.add(local);
  else if (submodule !== undefined) bindings.namespaces.set(local, submodule);
}

function collectBarrelSpecifier(specifier: ESTree.ImportDeclarationSpecifier, bindings: CollectedBindings): void {
  if (specifier.type === 'ImportNamespaceSpecifier') bindings.barrels.add(specifier.local.name);
  if (specifier.type !== 'ImportSpecifier') return;
  const imported = importedName(specifier);
  if (imported === 'OpenTelemetry') {
    bindings.otelLocals.set(specifier.local.name, imported);
    bindings.otelValueImport = true;
  } else bindings.namespaces.set(specifier.local.name, imported);
}

function collectEffectImport(
  specifiers: readonly ESTree.ImportDeclarationSpecifier[],
  source: string,
  bindings: CollectedBindings,
): void {
  if (specifiers.length === 0) return;
  bindings.importsEffect = true;
  const submodule = source.split('/').at(-1);
  if (submodule === LOGGER_NAMESPACE) bindings.loggerModuleImport = true;
  if (submodule === TRACER_NAMESPACE) bindings.tracerModuleImport = true;
  for (const specifier of specifiers) collectEffectSpecifier(specifier, source, bindings);
}

function collectValueImport(
  statement: ESTree.ImportDeclaration,
  options: RuleOptions,
  bindings: CollectedBindings,
): void {
  const source = statement.source.value;
  const specifiers = statement.specifiers.filter((specifier) => !isTypeOnly(statement, specifier));
  if (EFFECT_MODULE.test(source)) {
    collectEffectImport(specifiers, source, bindings);
    return;
  }
  if (matchesGlobs(source, options.otelModules)) {
    for (const specifier of specifiers) {
      bindings.otelValueImport = true;
      bindings.otelLocals.set(
        specifier.local.name,
        specifier.type === 'ImportSpecifier' ? importedName(specifier) : specifier.local.name,
      );
    }
    return;
  }
  if (!matchesGlobs(source, options.reexportModules)) return;
  for (const specifier of specifiers) {
    bindings.importsEffect = true;
    collectBarrelSpecifier(specifier, bindings);
  }
}

function collectFileBindings(program: ESTree.Program, options: RuleOptions): FileBindings {
  const bindings: CollectedBindings = {
    namespaces: new Map(),
    directMembers: new Map(),
    barrels: new Set(),
    otelLocals: new Map(),
    runtimeTypeLocals: new Set(),
    runtimeTypeNamespaces: new Set(),
    importsEffect: false,
    loggerModuleImport: false,
    tracerModuleImport: false,
    otelValueImport: false,
  };
  const names = new Set(options.runtimeTypeNames);
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (matchesGlobs(statement.source.value, options.reexportModules)) collectRuntimeTypes(statement, names, bindings);
    collectValueImport(statement, options, bindings);
  }
  return bindings;
}

function memberName(node: ESTree.MemberExpression): string | null {
  return sharedMemberName(node, { templates: true, unwrap: {} });
}
const NON_REFERENCE_TYPES = new Set(['TSTypeQuery', 'TSTypeReference', 'TSQualifiedName']);
function isNonReferencePosition(node: ESTree.Node): boolean {
  return sharedNonReferencePosition(node, {
    variableBindings: true,
    nonReferenceParents: NON_REFERENCE_TYPES,
  });
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** `true` when any ancestor is a function — i.e. the node is *not* at module top level. */
function insideFunction(node: ESTree.Node): boolean {
  let current: ESTree.Node | null | undefined = node.parent;
  while (current !== null && current !== undefined) {
    if (FUNCTION_TYPES.has(current.type)) {
      let expression = current;
      while (expression.parent && unwrap(expression.parent) === current) expression = expression.parent;
      const parent = expression.parent;
      if (parent?.type !== 'CallExpression' || parent.callee !== expression) return true;
    }
    if (current.type === 'Program') return false;
    current = current.parent;
  }
  return false;
}

/** Type positions a runtime type may hide inside while still being *the* return type. */
const RETURN_TYPE_WRAPPERS = new Set(['TSIntersectionType', 'TSUnionType', 'TSParenthesizedType', 'TSTypeReference']);

/**
 * When `node` is (part of) a function's return type annotation, return that function. Walks up
 * through `&`, `|` and parentheses only, so a runtime type used as a *type argument*
 * (`Layer.Layer<EffectBffRuntime<…>>`) or in a plain alias is not mistaken for a root.
 */
function initializedFunctionType(owner: ESTree.Node): ESTree.Node | null {
  if (owner.type !== 'TSFunctionType') return null;
  const annotation = owner.parent;
  if (annotation?.type !== 'TSTypeAnnotation') return null;
  const binding = annotation.parent;
  const declaration = binding?.parent;
  if (declaration?.type !== 'VariableDeclarator' || declaration.id !== binding || !declaration.init) return null;
  return declaration;
}

function returnAnnotationOwner(annotation: ESTree.Node): ESTree.Node | null {
  const owner = annotation.parent as (ESTree.Node & { returnType?: unknown; body?: unknown }) | null | undefined;
  if (!owner || owner.returnType !== annotation) return null;
  if (FUNCTION_TYPES.has(owner.type) && owner.body) return owner;
  return initializedFunctionType(owner);
}

function functionOwningReturnType(node: ESTree.Node): ESTree.Node | null {
  let current = node.parent;
  while (current) {
    if (current.type === 'TSTypeAnnotation') return returnAnnotationOwner(current);
    if (!RETURN_TYPE_WRAPPERS.has(current.type)) return null;
    current = current.parent;
  }
  return null;
}

function excludedPath(path: string, options: RuleOptions): boolean {
  if (/\.d\.[cm]?ts$/u.test(path) || /(?:^|\/)(?:dist(?:-[^/]+)?|build|\.output|node_modules)\//u.test(path))
    return true;
  if (matchesGlobs(path, options.ignore)) return true;
  if (!options.includeTests && isTestFile(path)) return true;
  return /(?:^|\/)scripts\//u.test(path) ? !options.includeScripts : !matchesGlobs(path, options.include);
}

function qualifyValue(base: string | null, key: string | null): string | null {
  if (base === null || key === null) return null;
  return base === '$root' ? key : `${base}.${key}`;
}

function destructuredValue(declaration: ESTree.VariableDeclarator, name: string, base: string | null): string | null {
  if (declaration.id.type === 'Identifier') return base;
  if (declaration.id.type !== 'ObjectPattern' || base === null) return null;
  for (const property of declaration.id.properties) {
    if (property.type !== 'Property' || property.value.type !== 'Identifier' || property.value.name !== name) continue;
    return qualifyValue(base, keyName(property.key, property.computed, { templates: false }));
  }
  return null;
}

function aliasDeclaration(variable: Variable | null, seen: Set<Variable>): ESTree.VariableDeclarator | null {
  if (!variable || seen.has(variable)) return null;
  if (variable.references.some((reference) => reference.isWrite() && !reference.init)) return null;
  seen.add(variable);
  const definition = variable.defs[0];
  if (definition?.type !== 'Variable' || definition.node.type !== 'VariableDeclarator' || !definition.node.init)
    return null;
  return definition.node;
}

function rootAnchor(roots: RootHit[], program: ESTree.Program): { node: ESTree.Node; kind: string } {
  roots.sort((left, right) => left.start - right.start);
  const first = roots[0];
  return {
    node: first?.node ?? program.body[0] ?? program,
    kind: first?.kind ?? 'declared host entry point',
  };
}

interface RootHit {
  readonly node: ESTree.Node;
  readonly kind: string;
  readonly start: number;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A6: every runtime root (`ManagedRuntime.make`, `Layer.launch`, a module-level `Effect.run*`, ' +
        'an `EffectBffRuntime` factory, or a declared host entry point) must install a Logger Layer, a Tracer ' +
        'Layer (`@effect/opentelemetry` or `Layer.succeed(Tracer.Tracer, …)`) and a minimum log level ' +
        '(`References.MinimumLogLevel`) once. This AST rule checks local import/member evidence only; ' +
        'it neither proves Layer installation nor resolves opaque shared observability graphs.',
    },
    messages: {
      missingLogger:
        'Runtime-root candidate `{{root}}` ({{kind}}) has no recognized local Logger evidence (audit A6). ' +
        'Verify Logger Layer composition, including shared imported layers; this file-local check cannot prove installation is absent.',
      missingTracer:
        'Runtime-root candidate `{{root}}` ({{kind}}) has no recognized local Tracer/OTel evidence (audit A6). ' +
        'Verify Tracer Layer composition and export configuration, including shared imported layers; this check cannot prove spans are unexported.',
      missingMinimumLogLevel:
        'Runtime-root candidate `{{root}}` ({{kind}}) has no recognized local minimum-log-level evidence (audit A6). ' +
        "Verify the root's minimum-level configuration, including shared imported layers; this check does not resolve the effective runtime level.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          rootFiles: { type: 'array', items: { type: 'string' } },
          runtimeMembers: { type: 'array', items: { type: 'string' } },
          runtimeTypeNames: { type: 'array', items: { type: 'string' } },
          otelModules: { type: 'array', items: { type: 'string' } },
          reexportModules: { type: 'array', items: { type: 'string' } },
          minimumLogLevelMembers: { type: 'array', items: { type: 'string' } },
          includeScripts: { type: 'boolean' },
          includeTests: { type: 'boolean' },
          require: {
            type: 'object',
            properties: {
              logger: { type: 'boolean' },
              tracer: { type: 'boolean' },
              minimumLogLevel: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: [...DEFAULT_INCLUDE],
        ignore: [...DEFAULT_IGNORE],
        rootFiles: [...DEFAULT_ROOT_FILES],
        runtimeMembers: [...DEFAULT_RUNTIME_MEMBERS],
        runtimeTypeNames: [...DEFAULT_RUNTIME_TYPE_NAMES],
        otelModules: [...DEFAULT_OTEL_MODULES],
        reexportModules: [...DEFAULT_REEXPORT_MODULES],
        minimumLogLevelMembers: [...DEFAULT_MINIMUM_LOG_LEVEL_MEMBERS],
        includeScripts: false,
        includeTests: false,
        require: { logger: true, tracer: true, minimumLogLevel: true },
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (excludedPath(path, options)) return {};

    const program = context.sourceCode.ast;
    const bindings = collectFileBindings(program, options);
    const runtimeMembers = qualifiedSet(options.runtimeMembers);
    const minimumLogLevelMembers = qualifiedSet(options.minimumLogLevelMembers);
    const runtimeTypeNameSet = new Set(options.runtimeTypeNames);

    const roots: RootHit[] = [];
    let hasLogger = bindings.loggerModuleImport;
    let hasTracer = bindings.tracerModuleImport || bindings.otelValueImport;
    let hasMinimumLogLevel = false;

    const recordRoot = (node: ESTree.Node, kind: string): void => {
      roots.push({ node, kind, start: node.start });
    };

    const resolveValue = (input: ESTree.Node, seen = new Set<Variable>()): string | null => {
      const node = unwrap(input);
      if (node.type === 'MemberExpression') {
        const base = resolveValue(node.object, seen);
        const key = memberName(node);
        return qualifyValue(base, key);
      }
      if (node.type !== 'Identifier') return null;
      const variable = lookupVariable(context, node);
      if (resolvesToImport(context, node))
        return (
          bindings.directMembers.get(node.name) ??
          bindings.namespaces.get(node.name) ??
          (bindings.barrels.has(node.name) ? '$root' : null)
        );
      const declaration = aliasDeclaration(variable, seen);
      if (!declaration?.init) return null;
      return destructuredValue(declaration, node.name, resolveValue(declaration.init, seen));
    };

    const recordEvidence = (qualified: string): void => {
      if (qualified.startsWith('Logger.')) hasLogger = true;
      if (qualified.startsWith('Tracer.')) hasTracer = true;
      if (minimumLogLevelMembers.has(qualified)) hasMinimumLogLevel = true;
    };
    const recordQualifiedRoot = (
      node: ESTree.Node,
      qualified: string,
      moduleRun = qualified.startsWith('Effect.run'),
    ): void => {
      if (runtimeMembers.has(qualified)) recordRoot(node, qualified);
      else if (moduleRun && !insideFunction(node)) recordRoot(node, `module-level ${qualified}`);
    };
    const recordOtel = (node: ESTree.Node, name: string): void => {
      if (!resolvesToImport(context, node)) return;
      hasTracer = true;
      if (name.includes(LOGGER_NAMESPACE)) hasLogger = true;
    };
    const runtimeTypeName = (typeName: ESTree.TSTypeName): string | null => {
      if (typeName.type === 'Identifier') {
        return bindings.runtimeTypeLocals.has(typeName.name) && resolvesToImport(context, typeName)
          ? typeName.name
          : null;
      }
      if (typeName.type !== 'TSQualifiedName' || typeName.left.type !== 'Identifier') return null;
      const name = typeName.right.name;
      if (!runtimeTypeNameSet.has(name) || !bindings.runtimeTypeNamespaces.has(typeName.left.name)) return null;
      return resolvesToImport(context, typeName.left) ? name : null;
    };
    const missingEvidence = (): string[] => {
      const missing: string[] = [];
      if (options.require.logger && !hasLogger) missing.push('missingLogger');
      if (options.require.tracer && !hasTracer) missing.push('missingTracer');
      if (options.require.minimumLogLevel && !hasMinimumLogLevel) missing.push('missingMinimumLogLevel');
      return missing;
    };

    return {
      MemberExpression(node) {
        const member = memberName(node);
        if (member === null) return;
        const namespace = resolveValue(node.object);
        if (namespace === null) {
          if (node.object.type === 'Identifier' && bindings.otelLocals.has(node.object.name))
            recordOtel(node.object, member);
          return;
        }
        const qualified = `${namespace}.${member}`;
        recordQualifiedRoot(node, qualified, namespace === 'Effect' && member.startsWith('run'));
        // Namespace evidence is intentionally limited to the immediate namespace.
        if (namespace === LOGGER_NAMESPACE) hasLogger = true;
        if (namespace === TRACER_NAMESPACE) hasTracer = true;
        if (minimumLogLevelMembers.has(qualified)) hasMinimumLogLevel = true;
      },
      Identifier(node) {
        if (isNonReferencePosition(node)) return;
        const direct = resolveValue(node);
        if (direct) {
          recordQualifiedRoot(node, direct);
          recordEvidence(direct);
        }
        const imported = bindings.otelLocals.get(node.name);
        if (imported !== undefined) recordOtel(node, imported);
      },

      // `(...): EffectBffDefinition<A> & EffectBffRuntime<A> => { … }` — the BFF composition root.
      TSTypeReference(node) {
        const name = runtimeTypeName(node.typeName);
        if (name === null) return;
        const owner = functionOwningReturnType(node);
        if (owner === null) return;
        recordRoot(owner, `${name} factory`);
      },

      'Program:exit'(node) {
        const isDeclaredRoot = matchesGlobs(path, options.rootFiles) && bindings.importsEffect;
        if (roots.length === 0 && !isDeclaredRoot) return;

        const missing = missingEvidence();
        if (missing.length === 0) return;

        const { node: anchor, kind } = rootAnchor(roots, node);

        for (const entry of missing) {
          context.report({
            node: anchor,
            messageId: entry,
            data: { root: path, kind },
          });
        }
      },
    };
  },
});
