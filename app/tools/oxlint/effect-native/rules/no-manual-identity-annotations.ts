/**
 * Audit A6 (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`) calls for one outer
 * instrumentation seam and ambient identity annotations, replacing copied per-handler records.
 *
 * Detects configured identity keys in flat literal annotation records, key/value overloads and
 * literal span `attributes` records. Resolves actual Effect imports, configured re-export barrels,
 * immutable local aliases/destructuring, static computed keys and transparent TypeScript wrappers.
 * Shadowed and reassigned bindings do not establish Effect identity.
 *
 * This is a name/AST check, not identity dataflow: domain identifiers can share these names.
 * Nested records, dynamic keys, opaque record variables/helpers and linkSpans' distinct API are not
 * inspected. `flagSpreadHelpers` optionally reports opaque coverage, not proven copied identity.
 * A skipped helper is not proof that it centralizes identity correctly. Seam paths are a convention,
 * not proof of middleware placement. Tests, scripts, generated/declaration files and unrelated APIs
 * are outside the default scope; valid per-event annotations and serialization remain untouched.
 * Report-only, with no fixer or suggestions.
 */
import { defineRule } from '@oxlint/plugins';
import { fileURLToPath } from 'node:url';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings, type EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

const EFFECT_ROOT_MODULE = 'effect';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production defaults instead of forcing the
 * fixture config to pass loosened options (which `run-on-repo.mts` reuses against the repository).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**'];

const DEFAULT_IGNORE = ['**/dist/**', '**/build/**', '**/node_modules/**', '**/*.d.ts'];

/**
 * The single outer HTTP instrumentation seam A6 asks for. Nothing in the repository matches today;
 * that is the finding. Once the seam exists, name its real path here instead of relaxing the rule.
 */
const DEFAULT_SEAM_FILES = [
  '**/request-identity-seam.ts',
  '**/request-identity-seam.tsx',
  '**/http-instrumentation-seam.ts',
  '**/http-instrumentation-seam.tsx',
];

/**
 * Ambient request/runtime identities. A6 lists them by name: *"correlation, tenant, legal-entity,
 * principal, module, action, and invocation identities"*.
 */
const DEFAULT_IDENTITY_KEYS = [
  'correlationId',
  'traceId',
  'traceparent',
  'spanId',
  'requestId',
  'tenantId',
  'legalEntityId',
  'principalId',
  'impersonatorPrincipalId',
  'sessionId',
  'moduleId',
  'moduleKey',
  'actionKey',
  'readKey',
  'workerKey',
  'invocationId',
  'actionInvocationId',
  'deploymentId',
];

/** Combinators whose annotation argument is a flat record (or a `key, value` pair). */
const DEFAULT_ANNOTATION_MEMBERS = [
  'Effect.annotateLogs',
  'Effect.annotateLogsScoped',
  'Effect.annotateSpans',
  'Effect.annotateSpansScoped',
  'Effect.annotateCurrentSpan',
];

/** Combinators whose options object carries an `attributes` record. */
const DEFAULT_SPAN_MEMBERS = ['Effect.withSpan', 'Effect.withLogSpan'];

/** Barrels that re-export Effect namespaces verbatim; `Effect` from them is Effect's `Effect`. */
const DEFAULT_REEXPORT_MODULES = ['@modern-js/plugin-bff/effect-edge'];

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly seamFiles: readonly string[];
  readonly identityKeys: readonly string[];
  readonly annotationMembers: readonly string[];
  readonly spanMembers: readonly string[];
  readonly reexportModules: readonly string[];
  readonly flagSpreadHelpers: boolean;
  readonly includeTests: boolean;
  readonly includeScripts: boolean;
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
    seamFiles: stringArray(record.seamFiles, DEFAULT_SEAM_FILES),
    identityKeys: stringArray(record.identityKeys, DEFAULT_IDENTITY_KEYS),
    annotationMembers: stringArray(record.annotationMembers, DEFAULT_ANNOTATION_MEMBERS),
    spanMembers: stringArray(record.spanMembers, DEFAULT_SPAN_MEMBERS),
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
    flagSpreadHelpers: record.flagSpreadHelpers === true,
    includeTests: record.includeTests === true,
    includeScripts: record.includeScripts === true,
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

function importedName(specifier: ESTree.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : specifier.imported.value;
}

/** `Effect.annotateLogs` → `["Effect", "annotateLogs"]`; malformed entries are dropped. */
function splitMembers(members: readonly string[]): Map<string, Set<string>> {
  const byNamespace = new Map<string, Set<string>>();
  for (const entry of members) {
    const dot = entry.indexOf('.');
    if (dot <= 0 || dot === entry.length - 1) continue;
    const namespace = entry.slice(0, dot);
    const bucket = byNamespace.get(namespace) ?? new Set<string>();
    bucket.add(entry.slice(dot + 1));
    byNamespace.set(namespace, bucket);
  }
  return byNamespace;
}

/** `x-correlation-id`, `correlation_id` and `correlationId` all collapse to `correlationid`. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
}

/** Header-style spellings prefix the identity; `x-correlation-id` and `http.request.id` are the same id. */
const HEADER_PREFIXES = ['x', 'http', 'otel', 'ontos'];

function identityKeyFor(key: string, identities: ReadonlyMap<string, string>): string | null {
  const normalised = normaliseKey(key);
  const direct = identities.get(normalised);
  if (direct !== undefined) return direct;
  for (const prefix of HEADER_PREFIXES) {
    if (!normalised.startsWith(prefix) || normalised.length === prefix.length) continue;
    const stripped = identities.get(normalised.slice(prefix.length));
    if (stripped !== undefined) return stripped;
  }
  return null;
}

/** Non-computed `.annotateLogs`, or computed `["annotateLogs"]`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  return literalString(node.property);
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

function literalString(node: ESTree.Node | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  node = unwrap(node);
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (
    node.type === 'TemplateLiteral' &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0]?.value.cooked ?? null;
  }
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
 * `true` because a module-level import declaration already proved the binding exists; only a local
 * shadow (parameter, `const`, catch clause, ...) rejects the match.
 */
function resolvesToImport(
  context: Context,
  identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
): boolean {
  const variable = lookupVariable(context, identifier);
  if (variable === null) return true;
  if (variable.defs.length === 0) return true;
  return variable.defs.some(
    (definition) =>
      definition.type === 'ImportBinding' &&
      definition.parent?.type === 'ImportDeclaration' &&
      definition.parent.importKind !== 'type' &&
      (definition.node.type !== 'ImportSpecifier' || definition.node.importKind !== 'type'),
  );
}

/**
 * Locals standing for a watched Effect namespace (`Effect`, aliased or submodule-imported) and locals
 * standing for the whole Effect barrel (`import * as E from "effect"` → `E.Effect.annotateLogs`).
 */
function collectNamespaceLocals(
  program: ESTree.Program,
  bindings: EffectBindings,
  watched: ReadonlySet<string>,
  reexportModules: readonly string[],
): { namespaced: ReadonlyMap<string, string>; barrel: ReadonlySet<string> } {
  const namespaced = new Map<string, string>();
  const barrel = new Set<string>();
  for (const [local, namespace] of bindings.namespaces) {
    if (watched.has(namespace)) namespaced.set(local, namespace);
  }
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    const source = statement.source.value;
    if (source !== EFFECT_ROOT_MODULE && !matchesGlobs(source, reexportModules)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') barrel.add(specifier.local.name);
      else if (specifier.type === 'ImportSpecifier') {
        const imported = importedName(specifier);
        if (watched.has(imported)) namespaced.set(specifier.local.name, imported);
      }
    }
  }
  return { namespaced, barrel };
}

/** `effect/Effect`, `effect/unstable/.../Effect` — the trailing segment names the namespace. */
const EFFECT_SUBMODULE = /^effect\/(?:.*\/)?(?<namespace>[A-Za-z][A-Za-z0-9_]*)$/u;

/** Locals bound by `import { annotateLogs } from "effect/Effect"`, mapped to `Namespace.member`. */
function collectDirectMemberImports(
  program: ESTree.Program,
  byNamespace: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, string> {
  const locals = new Map<string, string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    const namespace = EFFECT_SUBMODULE.exec(statement.source.value)?.groups?.namespace;
    if (namespace === undefined) continue;
    const members = byNamespace.get(namespace);
    if (members === undefined) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported = importedName(specifier);
      if (members.has(imported)) locals.set(specifier.local.name, `${namespace}.${imported}`);
    }
  }
  return locals;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A6: no hand-copied identity in log annotations or span attributes. Every handler repeats ' +
        '`Effect.annotateLogs(..., { correlationId, readKey })` and ' +
        '`Effect.withSpan(name, { attributes: { actionKey, correlationId } })`, so correlation, tenant, ' +
        'legal-entity, principal, module, action and invocation identity are threaded manually instead of ' +
        'living in ambient `Context.Reference` values annotated once at the outer instrumentation seam. ' +
        'Static matching covers flat literal keys and lexical Effect aliases, not nested/opaque records or semantic identity dataflow.',
    },
    messages: {
      manualIdentity:
        'Identity `{{key}}` is annotated by hand in `{{member}}`. Put request/runtime identity into an ambient ' +
        '`Context.Reference` (a request-identity service provided by the outer HTTP middleware) and annotate it ' +
        'once at that seam with `Effect.annotateLogs`/`Effect.withSpan` there, so every handler and span below ' +
        'inherits it instead of re-deriving it (add the seam file to `seamFiles`).',
      opaqueAnnotations:
        '`{{member}}` receives its annotations from a helper or spread here, so identity coverage cannot be ' +
        'checked at this call site. Fold the identity part into an ambient `Context.Reference` annotated once at ' +
        'the outer HTTP instrumentation seam and keep only per-event facts in this call.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          seamFiles: { type: 'array', items: { type: 'string' } },
          identityKeys: { type: 'array', items: { type: 'string' } },
          annotationMembers: { type: 'array', items: { type: 'string' } },
          spanMembers: { type: 'array', items: { type: 'string' } },
          reexportModules: { type: 'array', items: { type: 'string' } },
          flagSpreadHelpers: { type: 'boolean' },
          includeTests: { type: 'boolean' },
          includeScripts: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: [...DEFAULT_INCLUDE],
        ignore: [...DEFAULT_IGNORE],
        seamFiles: [...DEFAULT_SEAM_FILES],
        identityKeys: [...DEFAULT_IDENTITY_KEYS],
        annotationMembers: [...DEFAULT_ANNOTATION_MEMBERS],
        spanMembers: [...DEFAULT_SPAN_MEMBERS],
        reexportModules: [...DEFAULT_REEXPORT_MODULES],
        flagSpreadHelpers: false,
        includeTests: false,
        includeScripts: false,
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
    if (matchesGlobs(path, options.seamFiles)) return {};
    if (!matchesGlobs(path, options.include)) return {};
    if (!options.includeTests && isTestFile(path)) return {};
    if (!options.includeScripts && /(?:^|\/)scripts\//u.test(path)) return {};

    const annotationByNamespace = splitMembers(options.annotationMembers);
    const spanByNamespace = splitMembers(options.spanMembers);
    const allByNamespace = splitMembers([...options.annotationMembers, ...options.spanMembers]);
    if (allByNamespace.size === 0) return {};

    const identities = new Map<string, string>();
    for (const key of options.identityKeys) identities.set(normaliseKey(key), key);
    if (identities.size === 0) return {};

    const program = context.sourceCode.ast;
    const bindings = collectEffectBindings(program);
    const watched = new Set(allByNamespace.keys());
    const { namespaced, barrel } = collectNamespaceLocals(
      program,
      bindings,
      watched,
      options.reexportModules,
    );
    const directMembers = collectDirectMemberImports(program, allByNamespace);
    if (namespaced.size === 0 && barrel.size === 0 && directMembers.size === 0) return {};

    /** Resolve immutable aliases by their lexical definitions, never by a global name table. */
    const resolveCallee = (input: ESTree.Node, seen = new Set<Variable>()): string | null => {
      const callee = unwrap(input);
      if (callee.type === 'Identifier') {
        const variable = lookupVariable(context, callee);
        if (variable && !resolvesToImport(context, callee)) {
          if (
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
          const base = resolveCallee(declaration.init!, seen);
          if (declaration.id.type === 'Identifier') return base;
          if (declaration.id.type !== 'ObjectPattern' || base === null) return null;
          for (const property of declaration.id.properties) {
            if (
              property.type !== 'Property' ||
              property.value.type !== 'Identifier' ||
              property.value.name !== callee.name
            )
              continue;
            const key =
              !property.computed && property.key.type === 'Identifier'
                ? property.key.name
                : literalString(property.key);
            return key === null ? null : base === '$root' ? key : `${base}.${key}`;
          }
          return null;
        }
        return (
          directMembers.get(callee.name) ??
          namespaced.get(callee.name) ??
          (barrel.has(callee.name) ? '$root' : null)
        );
      }
      if (callee.type !== 'MemberExpression') return null;
      const member = memberName(callee);
      const base = resolveCallee(callee.object, seen);
      return member === null || base === null
        ? null
        : base === '$root'
          ? member
          : `${base}.${member}`;
    };

    const reportIdentity = (node: ESTree.Node, key: string, member: string): void => {
      context.report({ node, messageId: 'manualIdentity', data: { key, member } });
    };

    const reportOpaque = (node: ESTree.Node, member: string): void => {
      if (!options.flagSpreadHelpers) return;
      context.report({ node, messageId: 'opaqueAnnotations', data: { member } });
    };

    /** Report every identity-named property of a flat annotation/attributes record. */
    const inspectRecord = (record: ESTree.ObjectExpression, member: string): void => {
      for (const property of record.properties) {
        if (property.type === 'SpreadElement') {
          reportOpaque(property, member);
          continue;
        }
        const key =
          property.computed || property.key.type !== 'Identifier'
            ? literalString(property.key)
            : property.key.name;
        if (key === null) continue;
        const identity = identityKeyFor(key, identities);
        if (identity !== null) reportIdentity(property, identity, member);
      }
    };

    /**
     * `annotateLogs` shapes: `({...})`, `(effect, {...})`, `("key", value)`, `(effect, "key", value)`.
     * A non-object annotation argument is a helper (`claimAnnotations(claim)`, `annotations`).
     */
    const inspectAnnotationCall = (node: ESTree.CallExpression, member: string): void => {
      const args = node.arguments;
      if (args.length === 0) return;
      for (const index of [0, 1]) {
        const argument = args[index] === undefined ? undefined : unwrap(args[index]!);
        if (argument === undefined || argument.type !== 'ObjectExpression') continue;
        inspectRecord(argument, member);
        return;
      }
      // `("key", value)` data-last, `(effect, "key", value)` data-first.
      const keyNode = args.length === 2 ? args[0] : args.length === 3 ? args[1] : undefined;
      const key = literalString(keyNode);
      if (key !== null && keyNode !== undefined) {
        const identity = identityKeyFor(key, identities);
        if (identity !== null) reportIdentity(keyNode, identity, member);
        return;
      }
      // No literal record and no literal key: a helper produced the annotations.
      const opaque = args.length === 1 ? args[0] : args.length === 2 ? args[1] : undefined;
      if (opaque !== undefined && opaque.type !== 'ObjectExpression') reportOpaque(opaque, member);
    };

    /** `withSpan(name, { attributes })` / `withSpan(effect, name, { attributes })`. */
    const inspectSpanCall = (node: ESTree.CallExpression, member: string): void => {
      for (const rawArgument of node.arguments) {
        const argument = unwrap(rawArgument);
        if (argument.type !== 'ObjectExpression') continue;
        for (const property of argument.properties) {
          if (property.type === 'SpreadElement') continue;
          const key =
            property.computed || property.key.type !== 'Identifier'
              ? literalString(property.key)
              : property.key.name;
          if (key !== 'attributes') continue;
          const value = unwrap(property.value);
          if (value.type === 'ObjectExpression') inspectRecord(value, member);
          else reportOpaque(value, member);
        }
        return;
      }
    };

    return {
      CallExpression(node) {
        const qualified = resolveCallee(node.callee);
        if (qualified === null) return;
        const dot = qualified.indexOf('.');
        const namespace = qualified.slice(0, dot);
        const member = qualified.slice(dot + 1);
        if (annotationByNamespace.get(namespace)?.has(member))
          inspectAnnotationCall(node, qualified);
        else if (spanByNamespace.get(namespace)?.has(member)) inspectSpanCall(node, qualified);
      },
    };
  },
});
