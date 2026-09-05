/**
 * Audit finding: **A1** — "Establish one process-level Layer and ManagedRuntime composition model"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`). A1 records "four runtime roots, 15+ manually
 * wired layers, ... duplicated persistence providers, multiple pools" and prescribes: "Create one
 * `ManagedRuntime` per long-lived host/runtime" and "Capture the runtime at forced Promise adapters
 * rather than calling bare `Effect.runPromise`". The reference shape is
 * `packages/core-runtime/src/outbox/process.ts:83` — a single `ManagedRuntime.make(input.layer)` at
 * the process entry point, everything below it staying an `Effect<A, E, R>`.
 *
 * What is detected
 * - Every reference to a runtime-constructing Effect member — by default `ManagedRuntime.make`,
 *   and the Effect v3 runtime builders `Layer.toRuntime` / `Layer.toRuntimeWithMemoMap` —
 *   in a file that is in `include` but does not match `rootFiles`.
 * - Called (`ManagedRuntime.make(layer)`) *and* point-free (`pipe(layer, ManagedRuntime.make)`,
 *   `const boot = ManagedRuntime.make`) references: handing the constructor around is the same defect.
 * - Every import and re-binding spelling of the same construction:
 *   aliased imports (`import { ManagedRuntime as MR } from "effect"`), submodule namespace imports
 *   (`import * as ManagedRuntime from "effect/ManagedRuntime"`), root namespace imports
 *   (`import * as EffectNs from "effect"` → `EffectNs.ManagedRuntime.make`), direct member imports
 *   (`import { make } from "effect/ManagedRuntime"`), member destructuring (`const { make } = ManagedRuntime`),
 *   namespace destructuring off the barrel (`const { ManagedRuntime } = EffectNs`), local namespace
 *   aliases (`const MR = ManagedRuntime`), computed access (`ManagedRuntime["make"]`,
 *   ``ManagedRuntime[`make`]``), optional chaining (`ManagedRuntime?.make`), type-erased wrappers
 *   (`(ManagedRuntime as typeof ManagedRuntime).make`, `ManagedRuntime!.make`), and wrapper modules
 *   that re-export the constructor (`export { make as makeRuntime } from "effect/ManagedRuntime"`,
 *   `import { make } from "effect/ManagedRuntime"; export { make }`).
 * - Effect namespaces re-exported verbatim through a barrel (`reexportModules`, default the Modern.js
 *   `@modern-js/plugin-bff/effect-edge` edge barrel every BFF entry point imports from).
 * - More than `maxPerRoot` (default 1) construction sites inside a single composition root: "exactly
 *   one ManagedRuntime per long-lived host" is the whole point of A1, so a root that builds two
 *   runtimes is still a finding.
 *
 * What is deliberately allowed
 * - The composition roots themselves (`rootFiles`): the BFF/process entry points
 *   `apps/*​/api/index.ts` and `verticals/*​/api/index.ts`, the outbox worker process
 *   `packages/core-runtime/src/outbox/process.ts`, the browser runtime modules
 *   `apps/*​/src/runtime/**` / `verticals/*​/src/runtime/**` that own the single browser
 *   `ManagedRuntime` behind the query/mutation adapter (A9's blessed adapter seam), and the operational
 *   script entry points (`scripts/*.mts`, `scripts/*​/cli.mts`, `scripts/postgres/*.mts`) — the audit's
 *   D tier blesses "one small process-exit adapter at the executable edge", and each script *process*
 *   is its own long-lived host. Helper modules under `scripts/**` are **not** roots.
 *   `apps/*​/src/runtime/**` and `verticals/*​/src/runtime/**` are a *convention*: no such directory
 *   exists yet, so the first browser ManagedRuntime must be placed there (next to, not inside,
 *   `src/api/`) or added to `rootFiles`.
 * - `Layer.launch`: `effect@4` types it `(self: Layer<ROut, E, RIn>) => Effect<never, E, RIn>`. It
 *   returns an Effect that still carries `RIn`, owns no Runtime, pools, tracer or logger, and cannot
 *   drop the caller's context — exporting a worker main as `Layer.launch(workerLayer)` for the root to
 *   run is exactly what this rule asks for. It is available through the `members` option for hosts that
 *   want it banned outside roots, but it is not a default.
 * - `runtime.runPromise(...)` and every other *use* of an already-built runtime: this rule is about
 *   construction, not execution (bare `Effect.run*` belongs to `no-bare-effect-run`).
 * - Type-only references: `import type { make } from "effect/ManagedRuntime"`, `import { type make }`,
 *   `typeof make`, `typeof ManagedRuntime.make`, `ManagedRuntime.ManagedRuntime<never, never>` — the
 *   binding is erased and nothing is constructed.
 * - Anything that is not an `effect` binding: a locally shadowed `ManagedRuntime`, a `Layer` object
 *   from another library, `layers.build`, a `.make` property on a domain object, JSX member elements.
 * - Test files, unless `includeTests` is set — the audit targets production composition.
 *
 * Narrower than the earlier spec: Layer.build* return an Effect<Context, E, R | Scope>, not a new
 * runtime (verified in the installed effect/dist/Layer.d.ts). They retain the caller's scope/context
 * and must not consume a root runtime slot. Effect.runtime in v3 captures the current runtime for
 * forced adapters; capture is not construction either. These APIs are not default members.
 * Layer.toRuntime* are retained only as v3 runtime-construction tripwires.
 *
 * This rule only reports. It has no fixer and no suggestions, and no application source is edited to
 * satisfy it.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings, type EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_SUBMODULE_PREFIX = `${EFFECT_ROOT_MODULE}/`;

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production `include`/`rootFiles` defaults
 * instead of forcing the fixture config to pass loosened options (which `run-on-repo.mts` reuses).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];

const DEFAULT_EXCLUDE: readonly string[] = [];

/** The composition roots A1 allows: one long-lived host runtime each. */
const DEFAULT_ROOT_FILES = [
  'apps/*/api/index.ts',
  'verticals/*/api/index.ts',
  'packages/core-runtime/src/outbox/process.ts',
  'apps/*/src/runtime/**',
  'verticals/*/src/runtime/**',
  'scripts/*.{ts,mts,cts,js,mjs,cjs}',
  'scripts/*/cli.mts',
  'scripts/postgres/*.mts',
];

/**
 * Namespace.member pairs that construct a runtime. Layer.build* / launch describe Effects;
 * Effect.runtime captures the current runtime. Neither is runtime construction.
 */
const DEFAULT_MEMBERS = ['ManagedRuntime.make', 'Layer.toRuntime', 'Layer.toRuntimeWithMemoMap'];

/** Barrels that re-export Effect namespaces verbatim; `Layer` from them is Effect's `Layer`. */
const DEFAULT_REEXPORT_MODULES = ['@modern-js/plugin-bff/effect-edge'];

/** Expressions that are erased (or transparent) at runtime and wrap the real namespace identifier. */
const TRANSPARENT_EXPRESSIONS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
  'ParenthesizedExpression',
  'ChainExpression',
]);

/** Parents that put an identifier in a type position, where nothing is constructed at runtime. */
const TYPE_POSITION_PARENTS = new Set([
  'TSTypeQuery',
  'TSQualifiedName',
  'TSTypeReference',
  'TSImportType',
]);

interface RuleOptions {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly rootFiles: readonly string[];
  readonly members: readonly string[];
  readonly maxPerRoot: number;
  readonly reexportModules: readonly string[];
  readonly includeTests: boolean;
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
  const maxPerRoot = record.maxPerRoot;
  return {
    include: stringArray(record.include, DEFAULT_INCLUDE),
    exclude: stringArray(record.exclude, DEFAULT_EXCLUDE),
    rootFiles: stringArray(record.rootFiles, DEFAULT_ROOT_FILES),
    members: stringArray(record.members, DEFAULT_MEMBERS),
    maxPerRoot:
      typeof maxPerRoot === 'number' && Number.isInteger(maxPerRoot) && maxPerRoot >= 0
        ? maxPerRoot
        : 1,
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
    includeTests: record.includeTests === true,
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** `["ManagedRuntime.make", "Layer.build"]` → `{ ManagedRuntime: {make}, Layer: {build} }`. */
function parseMembers(members: readonly string[]): ReadonlyMap<string, ReadonlySet<string>> {
  const byNamespace = new Map<string, Set<string>>();
  for (const entry of members) {
    const dot = entry.indexOf('.');
    if (dot <= 0 || dot === entry.length - 1) continue;
    const namespace = entry.slice(0, dot);
    const member = entry.slice(dot + 1);
    const existing = byNamespace.get(namespace);
    if (existing === undefined) byNamespace.set(namespace, new Set([member]));
    else existing.add(member);
  }
  return byNamespace;
}

/** `import { make as boot }` / `export { make as boot }` → the *exported* name (`make`). */
function moduleExportName(node: ESTree.Node): string | null {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

function importedName(specifier: ESTree.ImportSpecifier): string | null {
  return moduleExportName(specifier.imported as ESTree.Node);
}

/** The last path segment of `effect/ManagedRuntime`, or `null` for anything else. */
function effectSubmodule(source: string): string | null {
  if (!source.startsWith(EFFECT_SUBMODULE_PREFIX)) return null;
  const segment = source.split('/').at(-1);
  return segment === undefined || segment.length === 0 ? null : segment;
}

/** Locals bound by a type-only import: `import type { make }`, `import { type make }`. */
function collectTypeOnlyLocals(program: ESTree.Program): ReadonlySet<string> {
  const locals = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    const declarationIsType = statement.importKind === 'type';
    for (const specifier of statement.specifiers) {
      const specifierIsType =
        specifier.type === 'ImportSpecifier' && specifier.importKind === 'type';
      if (declarationIsType || specifierIsType) locals.add(specifier.local.name);
    }
  }
  return locals;
}

interface NamespaceLocals {
  /** local identifier → Effect namespace name (`MR` → `ManagedRuntime`). */
  readonly namespaces: ReadonlyMap<string, string>;
  /** locals bound to the whole Effect barrel (`import * as EffectNs from "effect"`). */
  readonly barrels: ReadonlySet<string>;
}

/**
 * Locals that stand for one of the tracked Effect namespaces, and locals that stand for the whole
 * Effect barrel. The `effect`/`effect/*` half comes from the shared binding collector;
 * `reexportModules` covers barrels (Modern.js BFF edge) that re-export Effect verbatim. Type-only
 * bindings are dropped: they are erased and cannot construct anything.
 */
function collectNamespaceLocals(
  program: ESTree.Program,
  bindings: EffectBindings,
  tracked: ReadonlySet<string>,
  reexportModules: readonly string[],
  typeOnly: ReadonlySet<string>,
): NamespaceLocals {
  const namespaces = new Map<string, string>();
  const barrels = new Set<string>();
  for (const [local, namespace] of bindings.namespaces) {
    if (tracked.has(namespace) && !typeOnly.has(local)) namespaces.set(local, namespace);
  }
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (statement.importKind === 'type') continue;
    const source = statement.source.value;
    const isEffectRoot = source === EFFECT_ROOT_MODULE;
    const isReexport = matchesGlobs(source, reexportModules);
    if (!isEffectRoot && !isReexport) continue;
    for (const specifier of statement.specifiers) {
      if (typeOnly.has(specifier.local.name)) continue;
      if (specifier.type === 'ImportNamespaceSpecifier') barrels.add(specifier.local.name);
      else if (specifier.type === 'ImportSpecifier') {
        const imported = importedName(specifier);
        if (imported !== null && tracked.has(imported))
          namespaces.set(specifier.local.name, imported);
      }
    }
  }
  return { namespaces, barrels };
}

/** `import { make as boot } from "effect/ManagedRuntime"` → `boot` → `ManagedRuntime.make`. */
function collectDirectMemberImports(
  program: ESTree.Program,
  byNamespace: ReadonlyMap<string, ReadonlySet<string>>,
  typeOnly: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const locals = new Map<string, string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (statement.importKind === 'type') continue;
    const namespace = effectSubmodule(statement.source.value);
    if (namespace === null) continue;
    const members = byNamespace.get(namespace);
    if (members === undefined) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue;
      if (typeOnly.has(specifier.local.name)) continue;
      const imported = importedName(specifier);
      if (imported !== null && members.has(imported))
        locals.set(specifier.local.name, `${namespace}.${imported}`);
    }
  }
  return locals;
}

interface Finding {
  readonly node: ESTree.Node;
  readonly member: string;
  readonly start: number;
}

/**
 * Wrapper modules that hand the constructor to every consumer:
 * `export { make as makeRuntime } from "effect/ManagedRuntime"` (re-export with a source) and
 * `import { make } from "effect/ManagedRuntime"; export { make }` (re-export of a local binding).
 */
function collectReexportedMembers(
  program: ESTree.Program,
  byNamespace: ReadonlyMap<string, ReadonlySet<string>>,
  directMembers: ReadonlyMap<string, string>,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const statement of program.body) {
    if (statement.type !== 'ExportNamedDeclaration') continue;
    if (statement.exportKind === 'type') continue;
    const source = statement.source;
    const namespace =
      source === null || source === undefined ? null : effectSubmodule(source.value);
    const members = namespace === null ? undefined : byNamespace.get(namespace);
    if (source !== null && source !== undefined && members === undefined) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.exportKind === 'type') continue;
      const local = moduleExportName(specifier.local as ESTree.Node);
      if (local === null) continue;
      if (namespace !== null && members !== undefined) {
        // `export { make } from "effect/ManagedRuntime"`.
        if (members.has(local))
          findings.push({
            node: specifier,
            member: `${namespace}.${local}`,
            start: specifier.start,
          });
        continue;
      }
      // `export { make }` where `make` is a direct member import in this file.
      const qualified = directMembers.get(local);
      if (qualified !== undefined)
        findings.push({ node: specifier, member: qualified, start: specifier.start });
    }
  }
  return findings;
}

/** A statically known string key: `"make"` or a no-substitution `` `make` ``. */
function staticStringOf(node: ESTree.Node): string | null {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    const quasi = node.quasis[0];
    if (quasi === undefined) return null;
    const cooked = quasi.value.cooked;
    return typeof cooked === 'string' ? cooked : quasi.value.raw;
  }
  return null;
}

/** Non-computed `.make`, computed `["make"]`, computed `` [`make`] ``. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  return staticStringOf(node.property as ESTree.Node);
}

/** `{ make: boot }`, `{ "make": boot }`, `{ ["make"]: boot }`, `` { [`make`]: boot } ``. */
function propertyKeyName(property: Extract<ESTree.Node, { type: 'Property' }>): string | null {
  const key = property.key as ESTree.Node;
  if (!property.computed) return key.type === 'Identifier' ? key.name : staticStringOf(key);
  return staticStringOf(key);
}

/** Peel `as` / `satisfies` / `!` / `<T>` / parentheses / optional-chain wrappers off an expression. */
function unwrapExpression(node: ESTree.Node): ESTree.Node {
  let current: ESTree.Node = node;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!TRANSPARENT_EXPRESSIONS.has(current.type)) return current;
    const inner = (current as { expression?: ESTree.Node }).expression;
    if (inner === undefined || inner === null) return current;
    current = inner;
  }
  return current;
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

/** Identifier positions that are declarations, property keys or type references — never runtime uses. */
function isNonReferencePosition(node: Extract<ESTree.Node, { type: 'Identifier' }>): boolean {
  const parent = node.parent;
  if (parent === null || parent === undefined) return true;
  if (TYPE_POSITION_PARENTS.has(parent.type)) return true;
  switch (parent.type) {
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier': {
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

/** Stable key for an AST node: oxlint may hand out fresh wrapper objects for the same node. */
function nodeKey(node: ESTree.Node): string {
  return `${node.start}:${node.end}`;
}

type ResolvedBinding =
  | { readonly kind: 'namespace'; readonly namespace: string }
  | { readonly kind: 'barrel' }
  | null;

interface MemberCandidate {
  readonly node: ESTree.Node;
  readonly object: Extract<ESTree.Node, { type: 'Identifier' }>;
  /** Set when the shape is `Barrel.Namespace.member`; the object is then the barrel identifier. */
  readonly viaBarrel: string | null;
  readonly member: string;
}

interface DestructureCandidate {
  readonly node: ESTree.Node;
  readonly source: Extract<ESTree.Node, { type: 'Identifier' }>;
  readonly key: string;
}

interface PlainCandidate {
  readonly node: Extract<ESTree.Node, { type: 'Identifier' }>;
  readonly member: string;
}

interface DestructureBinding {
  readonly source: Extract<ESTree.Node, { type: 'Identifier' }>;
  /** local binding name → property key it was destructured from. */
  readonly keys: ReadonlyMap<string, string>;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A1: build a runtime (`ManagedRuntime.make`, `Layer.toRuntime*`) only in a host composition root. Every other module must stay an ' +
        "`Effect<A, E, R>` and receive the host's single ManagedRuntime by injection.",
    },
    messages: {
      outsideRoot:
        "`{{member}}` constructs or exposes a runtime constructor outside the host's composition root. " +
        'Build the host ManagedRuntime from its shared Layer graph at the root ({{roots}}), rather than ' +
        'creating an independent execution boundary. Keep this module an `Effect<A, E, R>` — declare ' +
        'what it needs in `R` and let the root ' +
        '`Layer.provide` it — or inject the host runtime through a service (audit A1).',
      multipleInRoot:
        '`{{member}}` is runtime construction #{{index}} in this composition root, but A1 allows exactly one ' +
        '`ManagedRuntime` per long-lived host ({{allowed}} permitted here). Merge the Layer graphs ' +
        '(`Layer.mergeAll` / `Layer.provide`) into the single root runtime instead of building a second one ' +
        'with its own resource ownership (audit A1).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          exclude: { type: 'array', items: { type: 'string' } },
          rootFiles: { type: 'array', items: { type: 'string' } },
          members: { type: 'array', items: { type: 'string' } },
          maxPerRoot: { type: 'integer', minimum: 0 },
          reexportModules: { type: 'array', items: { type: 'string' } },
          includeTests: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: [...DEFAULT_INCLUDE],
        exclude: [...DEFAULT_EXCLUDE],
        rootFiles: [...DEFAULT_ROOT_FILES],
        members: [...DEFAULT_MEMBERS],
        maxPerRoot: 1,
        reexportModules: [...DEFAULT_REEXPORT_MODULES],
        includeTests: false,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.exclude)) return {};
    if (!matchesGlobs(path, options.include)) return {};
    if (!options.includeTests && isTestFile(path)) return {};

    const byNamespace = parseMembers(options.members);
    if (byNamespace.size === 0) return {};
    const tracked = new Set(byNamespace.keys());

    const program = context.sourceCode.ast;
    const typeOnly = collectTypeOnlyLocals(program);
    const bindings = collectEffectBindings(program);
    const { namespaces, barrels } = collectNamespaceLocals(
      program,
      bindings,
      tracked,
      options.reexportModules,
      typeOnly,
    );
    const directMembers = collectDirectMemberImports(program, byNamespace, typeOnly);
    const reexports = collectReexportedMembers(program, byNamespace, directMembers);
    if (
      namespaces.size === 0 &&
      barrels.size === 0 &&
      directMembers.size === 0 &&
      reexports.length === 0
    ) {
      return {};
    }

    const isRoot = matchesGlobs(path, options.rootFiles);

    const memberCandidates: MemberCandidate[] = [];
    const destructureCandidates: DestructureCandidate[] = [];
    const plainCandidates: PlainCandidate[] = [];
    /** `const MR = ManagedRuntime` — declarator span → the aliased source identifier. */
    const aliasDeclarators = new Map<string, Extract<ESTree.Node, { type: 'Identifier' }>>();
    /** `const { ManagedRuntime } = EffectNs` — declarator span → source + key mapping. */
    const destructureDeclarators = new Map<string, DestructureBinding>();

    const fromImports = (name: string): ResolvedBinding => {
      const namespace = namespaces.get(name);
      if (namespace !== undefined) return { kind: 'namespace', namespace };
      return barrels.has(name) ? { kind: 'barrel' } : null;
    };

    /**
     * What an identifier stands for at its use site: a tracked Effect namespace, the whole Effect
     * barrel, or nothing. Follows local re-bindings (`const MR = ManagedRuntime`,
     * `const { Layer } = EffectNs`) through the scope graph, so a shadow still rejects the match.
     */
    const resolveBinding = (
      identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
      depth: number,
    ): ResolvedBinding => {
      if (depth > 6) return null;
      const variable = lookupVariable(context, identifier);
      if (variable === null || variable.defs.length === 0) return fromImports(identifier.name);
      if (variable.references.some((reference) => reference.isWrite() && !reference.init))
        return null;
      for (const definition of variable.defs) {
        if (definition.type === 'ImportBinding') return fromImports(identifier.name);
        if (definition.type !== 'Variable') continue;
        const key = nodeKey(definition.node);
        const alias = aliasDeclarators.get(key);
        if (alias !== undefined) return resolveBinding(alias, depth + 1);
        const destructured = destructureDeclarators.get(key);
        if (destructured === undefined) continue;
        const property = destructured.keys.get(identifier.name);
        if (property === undefined || !tracked.has(property)) continue;
        const source = resolveBinding(destructured.source, depth + 1);
        if (source !== null && source.kind === 'barrel')
          return { kind: 'namespace', namespace: property };
      }
      return null;
    };

    return {
      MemberExpression(node) {
        const member = memberName(node);
        if (member === null) return;
        const object = unwrapExpression(node.object as ESTree.Node);

        // `ManagedRuntime.make` / `MR.make` / `ManagedRuntime["make"]` / `ManagedRuntime?.make`.
        if (object.type === 'Identifier') {
          memberCandidates.push({ node, object, viaBarrel: null, member });
          return;
        }

        // `EffectNs.ManagedRuntime.make` via `import * as EffectNs from "effect"` (or a barrel).
        if (object.type !== 'MemberExpression') return;
        const namespace = memberName(object);
        if (namespace === null || !tracked.has(namespace)) return;
        const barrel = unwrapExpression(object.object as ESTree.Node);
        if (barrel.type !== 'Identifier') return;
        memberCandidates.push({ node, object: barrel, viaBarrel: namespace, member });
      },

      // `const { make } = ManagedRuntime`, `const MR = ManagedRuntime`, `const { Layer } = EffectNs`.
      VariableDeclarator(node) {
        const rawInit = node.init;
        if (rawInit === null || rawInit === undefined) return;
        const init = unwrapExpression(rawInit as ESTree.Node);
        if (init.type !== 'Identifier') return;
        if (node.id.type === 'Identifier') {
          aliasDeclarators.set(nodeKey(node), init);
          return;
        }
        if (node.id.type !== 'ObjectPattern') return;
        const keys = new Map<string, string>();
        for (const property of node.id.properties) {
          if (property.type !== 'Property') continue;
          const name = propertyKeyName(property);
          if (name === null) continue;
          const value = property.value as ESTree.Node;
          if (value.type === 'Identifier') keys.set(value.name, name);
          destructureCandidates.push({ node: property, source: init, key: name });
        }
        destructureDeclarators.set(nodeKey(node), { source: init, keys });
      },

      // Bare reference to `import { make } from "effect/ManagedRuntime"`, called or point-free.
      Identifier(node) {
        if (directMembers.size === 0) return;
        const qualified = directMembers.get(node.name);
        if (qualified === undefined) return;
        if (isNonReferencePosition(node)) return;
        plainCandidates.push({ node, member: qualified });
      },

      'Program:exit'() {
        const found: Finding[] = [...reexports];

        for (const candidate of memberCandidates) {
          const resolved = resolveBinding(candidate.object, 0);
          if (resolved === null) continue;
          if (candidate.viaBarrel === null) {
            if (resolved.kind !== 'namespace') continue;
            if (byNamespace.get(resolved.namespace)?.has(candidate.member) !== true) continue;
            found.push({
              node: candidate.node,
              member: `${resolved.namespace}.${candidate.member}`,
              start: candidate.node.start,
            });
            continue;
          }
          if (resolved.kind !== 'barrel') continue;
          if (byNamespace.get(candidate.viaBarrel)?.has(candidate.member) !== true) continue;
          found.push({
            node: candidate.node,
            member: `${candidate.viaBarrel}.${candidate.member}`,
            start: candidate.node.start,
          });
        }

        for (const candidate of destructureCandidates) {
          const resolved = resolveBinding(candidate.source, 0);
          if (resolved === null || resolved.kind !== 'namespace') continue;
          if (byNamespace.get(resolved.namespace)?.has(candidate.key) !== true) continue;
          found.push({
            node: candidate.node,
            member: `${resolved.namespace}.${candidate.key}`,
            start: candidate.node.start,
          });
        }

        for (const candidate of plainCandidates) {
          if (!resolvesToImport(context, candidate.node)) continue;
          found.push({
            node: candidate.node,
            member: candidate.member,
            start: candidate.node.start,
          });
        }

        if (found.length === 0) return;
        found.sort((left, right) => left.start - right.start);
        const allowed = isRoot ? Math.min(options.maxPerRoot, found.length) : 0;
        for (let index = 0; index < found.length; index += 1) {
          const entry = found[index];
          if (entry === undefined) continue;
          if (index < allowed) continue;
          context.report({
            node: entry.node,
            messageId: isRoot ? 'multipleInRoot' : 'outsideRoot',
            data: {
              member: entry.member,
              index: String(index + 1),
              allowed: String(options.maxPerRoot),
              roots: options.rootFiles.join(', '),
            },
          });
        }
      },
    };
  },
});
