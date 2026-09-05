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
import { fileURLToPath } from 'node:url';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

const EFFECT_MODULE = /^effect(?:\/.*)?$/u;
const EFFECT_ROOT_MODULE = 'effect';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production `include`/`rootFiles` defaults.
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

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
const EFFECT_NAMESPACE = 'Effect';

interface RequireOptions {
  readonly logger: boolean;
  readonly tracer: boolean;
  readonly minimumLogLevel: boolean;
}

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly rootFiles: readonly string[];
  readonly runtimeMembers: readonly string[];
  readonly runtimeTypeNames: readonly string[];
  readonly otelModules: readonly string[];
  readonly reexportModules: readonly string[];
  readonly minimumLogLevelMembers: readonly string[];
  readonly includeScripts: boolean;
  readonly includeTests: boolean;
  readonly require: RequireOptions;
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function boolOption(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readOptions(context: Context): RuleOptions {
  const raw = context.options?.[0];
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const rawRequire = record.require;
  const requireRecord: Record<string, unknown> =
    typeof rawRequire === 'object' && rawRequire !== null && !Array.isArray(rawRequire)
      ? (rawRequire as Record<string, unknown>)
      : {};
  return {
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    rootFiles: stringArray(record.rootFiles, DEFAULT_ROOT_FILES),
    runtimeMembers: stringArray(record.runtimeMembers, DEFAULT_RUNTIME_MEMBERS),
    runtimeTypeNames: stringArray(record.runtimeTypeNames, DEFAULT_RUNTIME_TYPE_NAMES),
    otelModules: stringArray(record.otelModules, DEFAULT_OTEL_MODULES),
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
    minimumLogLevelMembers: stringArray(
      record.minimumLogLevelMembers,
      DEFAULT_MINIMUM_LOG_LEVEL_MEMBERS,
    ),
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
  const unified = filename.replaceAll('\\', '/');
  const fixture =
    /(?:^|\/)tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\/(.*)$/u.exec(unified);
  if (fixture?.[1]) return fixture[1];
  const root = fileURLToPath(new URL('../../../../', import.meta.url)).replaceAll('\\', '/');
  return unified.startsWith(root)
    ? unified.slice(root.length)
    : normalisePath(unified).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
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

function importedName(specifier: ESTree.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : specifier.imported.value;
}

function isTypeOnly(
  declaration: ESTree.ImportDeclaration,
  specifier: ESTree.ImportDeclarationSpecifier,
): boolean {
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

function collectFileBindings(program: ESTree.Program, options: RuleOptions): FileBindings {
  const namespaces = new Map<string, string>();
  const directMembers = new Map<string, string>();
  const barrels = new Set<string>();
  const otelLocals = new Map<string, string>();
  const runtimeTypeLocals = new Set<string>();
  const runtimeTypeNamespaces = new Set<string>();
  const runtimeTypeNames = new Set(options.runtimeTypeNames);
  let importsEffect = false;
  let loggerModuleImport = false;
  let tracerModuleImport = false;
  let otelValueImport = false;

  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    const source = statement.source.value;

    // Runtime type identities are accepted only from configured framework barrels.
    if (matchesGlobs(source, options.reexportModules)) {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier')
          runtimeTypeNamespaces.add(specifier.local.name);
        if (specifier.type === 'ImportSpecifier' && runtimeTypeNames.has(importedName(specifier)))
          runtimeTypeLocals.add(specifier.local.name);
      }
    }

    if (EFFECT_MODULE.test(source)) {
      const submodule = source.split('/').at(-1);
      for (const specifier of statement.specifiers) {
        if (isTypeOnly(statement, specifier)) continue;
        importsEffect = true;
        if (specifier.type === 'ImportSpecifier') {
          if (source !== EFFECT_ROOT_MODULE && submodule && /^[A-Z]/u.test(submodule))
            directMembers.set(specifier.local.name, `${submodule}.${importedName(specifier)}`);
          else namespaces.set(specifier.local.name, importedName(specifier));
        } else if (specifier.type === 'ImportNamespaceSpecifier') {
          if (source === EFFECT_ROOT_MODULE) barrels.add(specifier.local.name);
          else if (submodule !== undefined) namespaces.set(specifier.local.name, submodule);
        }
      }
      if (
        source !== EFFECT_ROOT_MODULE &&
        statement.specifiers.some((specifier) => !isTypeOnly(statement, specifier))
      ) {
        if (submodule === LOGGER_NAMESPACE) loggerModuleImport = true;
        if (submodule === TRACER_NAMESPACE) tracerModuleImport = true;
      }
      continue;
    }

    if (matchesGlobs(source, options.otelModules)) {
      for (const specifier of statement.specifiers) {
        if (isTypeOnly(statement, specifier)) continue;
        otelValueImport = true;
        const imported =
          specifier.type === 'ImportSpecifier' ? importedName(specifier) : specifier.local.name;
        otelLocals.set(specifier.local.name, imported);
      }
      continue;
    }

    if (matchesGlobs(source, options.reexportModules)) {
      for (const specifier of statement.specifiers) {
        if (isTypeOnly(statement, specifier)) continue;
        importsEffect = true;
        if (specifier.type === 'ImportSpecifier') {
          if (importedName(specifier) === 'OpenTelemetry') {
            otelLocals.set(specifier.local.name, 'OpenTelemetry');
            otelValueImport = true;
          } else namespaces.set(specifier.local.name, importedName(specifier));
        } else if (specifier.type === 'ImportNamespaceSpecifier') barrels.add(specifier.local.name);
      }
    }
  }

  return {
    namespaces,
    directMembers,
    barrels,
    otelLocals,
    runtimeTypeLocals,
    runtimeTypeNamespaces,
    importsEffect,
    loggerModuleImport,
    tracerModuleImport,
    otelValueImport,
  };
}

function unwrap(node: ESTree.Node): ESTree.Node {
  while (
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSTypeAssertion',
      'TSNonNullExpression',
      'TSInstantiationExpression',
      'ChainExpression',
      'ParenthesizedExpression',
    ].includes(node.type)
  ) {
    node = (node as unknown as { expression: ESTree.Node }).expression;
  }
  return node;
}

/** Non-computed `.make`, or computed `["make"]`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const property = unwrap(node.property);
  if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
  if (property.type === 'TemplateLiteral' && property.expressions.length === 0)
    return property.quasis[0]?.value.cooked ?? null;
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

/**
 * `true` when the identifier still resolves to an `import` binding. Unresolved names fall back to
 * `true` because the module-level import declaration already proved the binding exists; only a local
 * shadow (parameter, `const`, catch clause, …) rejects the match.
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

/** Identifier positions that are declarations or property keys, never references to the import. */
function isNonReferencePosition(node: Extract<ESTree.Node, { type: 'Identifier' }>): boolean {
  const parent = node.parent;
  if (parent === null || parent === undefined) return true;
  switch (parent.type) {
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier': {
      return true;
    }
    case 'VariableDeclarator': {
      return parent.id === node;
    }
    case 'TSTypeQuery':
    case 'TSTypeReference':
    case 'TSQualifiedName': {
      return true;
    }
    case 'MemberExpression': {
      return parent.property === node && !parent.computed;
    }
    case 'Property':
    case 'PropertyDefinition':
    case 'MethodDefinition': {
      return parent.key === node && !parent.computed;
    }
    default: {
      return false;
    }
  }
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** `true` when any ancestor is a function — i.e. the node is *not* at module top level. */
function insideFunction(node: ESTree.Node): boolean {
  let current: ESTree.Node | null | undefined = node.parent;
  while (current !== null && current !== undefined) {
    if (FUNCTION_TYPES.has(current.type)) {
      let expression = current;
      while (expression.parent && unwrap(expression.parent) === current)
        expression = expression.parent;
      const parent = expression.parent;
      if (parent?.type !== 'CallExpression' || parent.callee !== expression) return true;
    }
    if (current.type === 'Program') return false;
    current = current.parent;
  }
  return false;
}

/** Type positions a runtime type may hide inside while still being *the* return type. */
const RETURN_TYPE_WRAPPERS = new Set([
  'TSIntersectionType',
  'TSUnionType',
  'TSParenthesizedType',
  'TSTypeReference',
]);

/**
 * When `node` is (part of) a function's return type annotation, return that function. Walks up
 * through `&`, `|` and parentheses only, so a runtime type used as a *type argument*
 * (`Layer.Layer<EffectBffRuntime<…>>`) or in a plain alias is not mistaken for a root.
 */
function functionOwningReturnType(node: ESTree.Node): ESTree.Node | null {
  let current: ESTree.Node | null | undefined = node.parent;
  while (current !== null && current !== undefined) {
    if (current.type === 'TSTypeAnnotation') {
      const owner = current.parent as (ESTree.Node & { returnType?: unknown }) | null | undefined;
      if (owner === null || owner === undefined) return null;
      if (owner.returnType !== current) return null;
      if (FUNCTION_TYPES.has(owner.type) && (owner as { body?: unknown }).body) return owner;
      // A function type annotating an initialized variable is executable; a type alias,
      // interface member, ambient declaration or abstract signature is not.
      if (owner.type === 'TSFunctionType') {
        const annotation = owner.parent;
        if (annotation?.type !== 'TSTypeAnnotation') return null;
        const binding = annotation.parent;
        const declaration = binding?.parent;
        if (
          declaration?.type === 'VariableDeclarator' &&
          declaration.id === binding &&
          declaration.init
        )
          return declaration;
      }
      return null;
    }
    if (!RETURN_TYPE_WRAPPERS.has(current.type)) return null;
    current = current.parent;
  }
  return null;
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
    if (
      /\.d\.[cm]?ts$/u.test(path) ||
      /(?:^|\/)(?:dist(?:-[^/]+)?|build|\.output|node_modules)\//u.test(path)
    )
      return {};
    if (matchesGlobs(path, options.ignore)) return {};
    if (!options.includeTests && isTestFile(path)) return {};
    const script = /(?:^|\/)scripts\//u.test(path);
    if (script && !options.includeScripts) return {};
    if (!script && !matchesGlobs(path, options.include)) return {};

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
        return base === null || key === null ? null : base === '$root' ? key : `${base}.${key}`;
      }
      if (node.type !== 'Identifier') return null;
      const variable = lookupVariable(context, node);
      if (resolvesToImport(context, node))
        return (
          bindings.directMembers.get(node.name) ??
          bindings.namespaces.get(node.name) ??
          (bindings.barrels.has(node.name) ? '$root' : null)
        );
      if (
        !variable ||
        seen.has(variable) ||
        variable.references.some((reference) => reference.isWrite() && !reference.init)
      )
        return null;
      seen.add(variable);
      const definition = variable.defs[0];
      if (
        definition?.type !== 'Variable' ||
        definition.node.type !== 'VariableDeclarator' ||
        !definition.node.init
      )
        return null;
      const declaration = definition.node;
      const base = resolveValue(declaration.init!, seen);
      if (declaration.id.type === 'Identifier') return base;
      if (declaration.id.type !== 'ObjectPattern' || base === null) return null;
      for (const property of declaration.id.properties) {
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
              : null;
        return key === null ? null : base === '$root' ? key : `${base}.${key}`;
      }
      return null;
    };

    return {
      MemberExpression(node) {
        const member = memberName(node);
        if (member === null) return;
        const namespace = resolveValue(node.object);
        if (namespace === null) {
          // `Otel.OtelLogger` / `NodeSdkNs.layer` — namespace import of the OTel package.
          if (node.object.type !== 'Identifier') return;
          if (!bindings.otelLocals.has(node.object.name)) return;
          if (!resolvesToImport(context, node.object)) return;
          hasTracer = true;
          if (member.includes(LOGGER_NAMESPACE)) hasLogger = true;
          return;
        }
        const qualified = `${namespace}.${member}`;

        if (runtimeMembers.has(qualified)) recordRoot(node, qualified);
        else if (
          namespace === EFFECT_NAMESPACE &&
          member.startsWith('run') &&
          !insideFunction(node)
        ) {
          recordRoot(node, `module-level ${qualified}`);
        }

        if (namespace === LOGGER_NAMESPACE) hasLogger = true;
        if (namespace === TRACER_NAMESPACE) hasTracer = true;
        if (minimumLogLevelMembers.has(qualified)) hasMinimumLogLevel = true;
      },

      // Bare reference to an `@effect/opentelemetry` binding: `NodeSdk.layer` is caught above, but
      // `Layer.provide(otelLayer, NodeSdk)` / point-free hand-offs must count as evidence too.
      Identifier(node) {
        if (isNonReferencePosition(node)) return;
        const direct = resolveValue(node);
        if (direct) {
          if (runtimeMembers.has(direct)) recordRoot(node, direct);
          else if (direct.startsWith('Effect.run') && !insideFunction(node))
            recordRoot(node, `module-level ${direct}`);
          if (direct.startsWith('Logger.')) hasLogger = true;
          if (direct.startsWith('Tracer.')) hasTracer = true;
          if (minimumLogLevelMembers.has(direct)) hasMinimumLogLevel = true;
        }
        const imported = bindings.otelLocals.get(node.name);
        if (imported === undefined) return;
        if (isNonReferencePosition(node)) return;
        if (!resolvesToImport(context, node)) return;
        hasTracer = true;
        if (imported.includes(LOGGER_NAMESPACE)) hasLogger = true;
      },

      // `(...): EffectBffDefinition<A> & EffectBffRuntime<A> => { … }` — the BFF composition root.
      TSTypeReference(node) {
        const typeName = node.typeName;
        const name =
          typeName.type === 'Identifier'
            ? typeName.name
            : typeName.type === 'TSQualifiedName' && typeName.right.type === 'Identifier'
              ? typeName.right.name
              : null;
        if (name === null) return;
        const known =
          typeName.type === 'Identifier'
            ? bindings.runtimeTypeLocals.has(name) && resolvesToImport(context, typeName)
            : typeName.type === 'TSQualifiedName' &&
              typeName.left.type === 'Identifier' &&
              runtimeTypeNameSet.has(name) &&
              bindings.runtimeTypeNamespaces.has(typeName.left.name) &&
              resolvesToImport(context, typeName.left);
        if (!known) return;
        const owner = functionOwningReturnType(node);
        if (owner === null) return;
        recordRoot(owner, `${name} factory`);
      },

      'Program:exit'(node) {
        const isDeclaredRoot = matchesGlobs(path, options.rootFiles) && bindings.importsEffect;
        if (roots.length === 0 && !isDeclaredRoot) return;

        const missing: Array<{ readonly messageId: string; readonly label: string }> = [];
        if (options.require.logger && !hasLogger)
          missing.push({ messageId: 'missingLogger', label: 'Logger' });
        if (options.require.tracer && !hasTracer)
          missing.push({ messageId: 'missingTracer', label: 'Tracer' });
        if (options.require.minimumLogLevel && !hasMinimumLogLevel) {
          missing.push({ messageId: 'missingMinimumLogLevel', label: 'MinimumLogLevel' });
        }
        if (missing.length === 0) return;

        roots.sort((left, right) => left.start - right.start);
        const first = roots[0];
        const anchor = first?.node ?? node.body[0] ?? node;
        const kind = first?.kind ?? 'declared host entry point';

        for (const entry of missing) {
          context.report({ node: anchor, messageId: entry.messageId, data: { root: path, kind } });
        }
      },
    };
  },
});
