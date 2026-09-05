/**
 * Audit findings: **A4** — "Rebuild the error system around typed channels and contract-owned Problem
 * Details" and **A6** — "Activate real observability at the runtime roots"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`).
 *
 * A4 counts *"approximately 20 local defect-to-500 seams"* and lists as evidence
 * `apps/shell-super-app/api/index.ts:186`, `verticals/contacts/api/index.ts:179` and
 * `verticals/contacts/api/read-server-support.ts:67`. Its target is explicit: *"Keep unexpected
 * defects in `Cause` until one outer HTTP seam converts them into a sanitized typed internal
 * problem."* A6 asks for the counterpart: *"Establish one outer HTTP instrumentation/error seam."*
 *
 * Today every handler owns its own miniature seam. `apps/shell-super-app/api/index.ts` repeats
 * `Effect.catchCause((cause) => Cause.hasDies(cause) ? log(...).pipe(Effect.andThen(Effect.fail(
 * internalProblem()))) : Effect.failCause(cause))` ten times with copy-pasted correlation logging;
 * the six Contacts read servers and the Contacts action BFF repeat `Effect.catchDefect((defect) =>
 * log(...).pipe(Effect.andThen(Effect.fail(problems.internal()))))`; and the Action/Read transaction
 * engines re-implement the same split with `Cause.hasDies` / `Cause.hasInterrupts` /
 * `Cause.findErrorOption` before throwing a private rollback sentinel.
 *
 * What is detected (in `include` paths, outside `ignore`/`seamPaths`, never in tests or scripts)
 * - Any reference to a namespace-qualified member listed in `members`, i.e. the defect-catching
 *   combinators (`Effect.catchDefect`, `Effect.catchCause`, `Effect.catchAllCause`,
 *   `Effect.catchSomeCause`, `Effect.sandbox`, ...) and the `Cause` decomposition predicates that
 *   split a cause into "expected failure" vs "defect" locally (`Cause.hasDies`, `Cause.hasInterrupts`,
 *   `Cause.findErrorOption`, `Cause.squash`, `Cause.dieOption`, ...).
 * - Data-first and data-last usage are identical: the rule reports the callee reference itself, so
 *   `Effect.catchCause(effect, f)`, `effect.pipe(Effect.catchCause(f))` and the point-free
 *   `pipe(effect, Effect.sandbox)` all report once.
 * - Aliased imports (`import { Effect as Fx, Cause as C } from "effect"`), submodule namespace
 *   imports (`import * as Cause from "effect/Cause"`), root barrel imports
 *   (`import * as E from "effect"` → `E.Cause.hasDies`), direct member imports
 *   (`import { hasDies } from "effect/Cause"`), computed access (`Cause["hasDies"]`) and optional
 *   chaining (`Cause?.hasDies`).
 * - Effect re-export barrels (`reexportModules`, default the Modern.js
 *   `@modern-js/plugin-bff/effect-edge` edge barrel that both BFF entry points import `Effect` from).
 *
 * What is deliberately allowed
 * - Files matching `seamPaths`: the single outer HTTP instrumentation/error seam the audit asks for.
 *   The default names the conventional file (`**​/http-error-seam.ts[x]`); no such file exists yet,
 *   which is exactly the finding. Add the real path once it is built instead of relaxing the rule.
 * - Re-raising a cause unchanged (`Effect.failCause`, `Effect.tapCause` logging, `Cause.fail`,
 *   `Cause.die`, `Cause.pretty`), typed handling (`Effect.catchTag(s)`, exhaustive `Match`), and
 *   `Exit.isFailure` — none of those convert a defect into a response.
 * - Tests (`includeTests`), `scripts/**`, `tools/**`, `dist/**` and declaration files: the audit
 *   targets production request paths. Worker supervisors that intentionally swallow a defect to keep
 *   a poll loop alive are still reported; add their file to `seamPaths` if that is a deliberate,
 *   reviewed seam.
 *
 * Known limitation: without types this cannot prove that a given `Effect.catchCause` really produces
 * a 500. It reports the *seam primitive* wherever it is not the single blessed one. Report-only: this
 * rule never fixes or suggests.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings, type EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isScriptFile, isTestFile, normalisePath } from '../shared/paths.ts';

const EFFECT_ROOT_MODULE = 'effect';
/** `effect/Cause`, `effect/unstable/.../Effect`, ... — the trailing segment is the namespace. */
const EFFECT_SUBMODULE = /^effect\/(?:.*\/)?(?<namespace>[A-Za-z][A-Za-z0-9_]*)$/u;

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production defaults instead of forcing the
 * fixture config to pass loosened options (which `run-on-repo.mts` reuses against the repository).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**'];

const DEFAULT_IGNORE = ['**/dist/**', '**/build/**', '**/node_modules/**', '**/*.d.ts'];

/**
 * The one outer HTTP instrumentation/error seam A4/A6 asks for. Nothing in the repository matches
 * today; that is the finding, not a bug in the default.
 */
const DEFAULT_SEAM_PATHS = ['**/http-error-seam.ts', '**/http-error-seam.tsx'];

/**
 * Namespace-qualified seam primitives. `Effect.*` catches or exposes the defect channel; `Cause.*`
 * decomposes a cause into "expected failure" vs "defect" at a local site.
 */
const DEFAULT_MEMBERS = [
  'Effect.catchDefect',
  'Effect.catchAllDefect',
  'Effect.catchSomeDefect',
  'Effect.catchCause',
  'Effect.catchAllCause',
  'Effect.catchSomeCause',
  'Effect.catchCauseIf',
  'Effect.sandbox',
  'Cause.hasDies',
  'Cause.isDie',
  'Cause.died',
  'Cause.squash',
  'Cause.squashWith',
  'Cause.dieOption',
  'Cause.findDieOption',
  'Cause.defects',
  'Cause.filterDefects',
  'Cause.hasInterrupts',
  'Cause.isInterrupted',
  'Cause.isInterruptedOnly',
  'Cause.findErrorOption',
  'Cause.failureOrCause',
];

/** Barrels that re-export Effect namespaces verbatim; `Effect` from them is Effect's `Effect`. */
const DEFAULT_REEXPORT_MODULES = ['@modern-js/plugin-bff/effect-edge'];

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly seamPaths: readonly string[];
  readonly members: readonly string[];
  readonly reexportModules: readonly string[];
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
    seamPaths: stringArray(record.seamPaths, DEFAULT_SEAM_PATHS),
    members: stringArray(record.members, DEFAULT_MEMBERS),
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
    includeTests: record.includeTests === true,
    includeScripts: record.includeScripts === true,
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

/** `Effect.catchCause` → `["Effect", "catchCause"]`; unknown namespaces are dropped by the caller. */
function splitMembers(members: readonly string[]): {
  byNamespace: ReadonlyMap<string, ReadonlySet<string>>;
  namespaces: ReadonlySet<string>;
} {
  const byNamespace = new Map<string, Set<string>>();
  for (const entry of members) {
    const dot = entry.indexOf('.');
    if (dot <= 0 || dot === entry.length - 1) continue;
    const namespace = entry.slice(0, dot);
    const member = entry.slice(dot + 1);
    const bucket = byNamespace.get(namespace) ?? new Set<string>();
    bucket.add(member);
    byNamespace.set(namespace, bucket);
  }
  return { byNamespace, namespaces: new Set(byNamespace.keys()) };
}

/**
 * Locals standing for a watched Effect namespace (`Effect`, `Cause`, ...) and locals standing for the
 * whole Effect barrel (`import * as E from "effect"` → `E.Cause.hasDies`). The `effect`/`effect/*`
 * half comes from the shared binding collector; `reexportModules` covers verbatim re-export barrels.
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
    const isEffectRoot = source === EFFECT_ROOT_MODULE;
    const isReexport = matchesGlobs(source, reexportModules);
    if (!isEffectRoot && !isReexport) continue;
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

/**
 * Locals bound by `import { hasDies } from "effect/Cause"` — bare references must be caught. Maps the
 * local name to the qualified `Namespace.member` the import resolves to.
 */
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

/** Non-computed `.hasDies`, or computed `["hasDies"]`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const property = node.property;
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

/**
 * `true` when the identifier still resolves to an `import` binding. Unresolved names fall back to
 * `true` because the module-level import declaration already proved the binding exists; only a local
 * shadow (parameter, `const`, catch clause, ...) rejects the match.
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

/** Declaration and property-key positions are not references to the imported value. */
function isReferencePosition(node: Extract<ESTree.Node, { type: 'Identifier' }>): boolean {
  const parent = node.parent;
  if (parent === null || parent === undefined) return false;
  if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier') return false;
  if (parent.type === 'ImportNamespaceSpecifier' || parent.type === 'ExportSpecifier') return false;
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
    return false;
  if (parent.type === 'Property' && parent.key === node && !parent.computed) return false;
  if (parent.type === 'PropertyDefinition' && parent.key === node && !parent.computed) return false;
  if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) return false;
  return true;
}

// Resolve runtime identity, not spelling. Only immutable same-file aliases are followed;
// dynamic imports, mutable rebinding and arbitrary cross-module re-exports remain unknown.
function effectOrigin(
  context: Context,
  input: ESTree.Node,
  barrels: readonly string[],
  depth = 0,
): readonly string[] | null {
  if (depth > 24) return null;
  let node = input;
  while (
    [
      'ParenthesizedExpression',
      'ChainExpression',
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'TSInstantiationExpression',
      'TSTypeAssertion',
    ].includes(node.type)
  ) {
    node = (node as { expression: ESTree.Node }).expression;
  }
  const keyOf = (key: ESTree.Node, computed: boolean): string | null => {
    if (!computed && key.type === 'Identifier') return key.name;
    if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
    if (key.type === 'TemplateLiteral' && key.expressions.length === 0)
      return key.quasis[0]?.value.cooked ?? null;
    return null;
  };
  if (node.type === 'MemberExpression') {
    const key = keyOf(node.property, node.computed);
    const base = effectOrigin(context, node.object, barrels, depth + 1);
    return base && key !== null ? [...base, key] : null;
  }
  if (node.type !== 'Identifier') return null;
  let scope: ReturnType<Context['sourceCode']['getScope']> | null =
    context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    const defs = variable?.defs.filter(
      (def) =>
        !['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSTypeParameter'].includes(
          def.node.type,
        ),
    );
    if (!variable || !defs?.length) {
      scope = scope.upper;
      continue;
    }
    if (defs.length !== 1) return null;
    const def = defs[0]!;
    if (def.type === 'ImportBinding') {
      const spec = def.node;
      const declaration = def.parent?.type === 'ImportDeclaration' ? def.parent : spec.parent;
      if (
        declaration?.type !== 'ImportDeclaration' ||
        declaration.importKind === 'type' ||
        (spec as { importKind?: string }).importKind === 'type'
      )
        return null;
      const source = declaration.source.value;
      const root = source === 'effect' || barrels.some((glob) => globToRegExp(glob).test(source));
      if (!root && !source.startsWith('effect/')) return null;
      const base = root ? [] : [source.split('/').at(-1)!];
      if (spec.type === 'ImportNamespaceSpecifier' || spec.type === 'ImportDefaultSpecifier')
        return base;
      if (spec.type !== 'ImportSpecifier') return null;
      return [
        ...base,
        spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value,
      ];
    }
    const declaration = def.node;
    if (
      declaration.type !== 'VariableDeclarator' ||
      !declaration.init ||
      declaration.parent?.type !== 'VariableDeclaration' ||
      declaration.parent.kind !== 'const'
    )
      return null;
    if (variable.references.some((reference) => reference.isWrite() && !reference.init))
      return null;
    const base = effectOrigin(context, declaration.init, barrels, depth + 1);
    if (!base) return null;
    if (declaration.id.type === 'Identifier') return base;
    if (declaration.id.type !== 'ObjectPattern') return null;
    for (const property of declaration.id.properties) {
      if (
        property.type !== 'Property' ||
        property.value.type !== 'Identifier' ||
        property.value.name !== node.name
      )
        continue;
      const key = keyOf(property.key, property.computed);
      return key === null ? null : [...base, key];
    }
    return null;
  }
  return null;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A4/A6: no per-handler defect-to-500 seams. `Effect.catchDefect` / `Effect.catchCause` / ' +
        '`Cause.hasDies` / `Cause.findErrorOption` outside the single outer HTTP instrumentation/error seam ' +
        'are seam primitives that require review. Static analysis cannot prove they convert a defect to a response; explicit seamPaths covers reviewed HTTP and worker boundaries.',
    },
    messages: {
      defectCatch:
        'Local defect-channel seam primitive `{{member}}` (audit A4/A6). Preserve Cause and typed failures; own conversion at the outer HTTP or worker boundary, listed in seamPaths. This syntactic rule cannot prove the callback converts a defect or emits HTTP 500.',
      causeInspection:
        'Local Cause inspection primitive `{{member}}` (audit A4/A6). Keep expected failures typed and preserve defects until the owning outer HTTP or worker seam. Review this decomposition and list deliberate seam files in seamPaths; a predicate alone does not prove HTTP conversion.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          seamPaths: { type: 'array', items: { type: 'string' } },
          members: { type: 'array', items: { type: 'string' } },
          reexportModules: { type: 'array', items: { type: 'string' } },
          includeTests: { type: 'boolean' },
          includeScripts: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: DEFAULT_INCLUDE,
        ignore: DEFAULT_IGNORE,
        seamPaths: DEFAULT_SEAM_PATHS,
        members: DEFAULT_MEMBERS,
        reexportModules: DEFAULT_REEXPORT_MODULES,
        includeTests: false,
        includeScripts: false,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore)) return {};
    if (matchesGlobs(path, options.seamPaths)) return {};
    if (!matchesGlobs(path, options.include)) return {};
    if (!options.includeTests && isTestFile(path)) return {};
    if (!options.includeScripts && isScriptFile(path)) return {};

    const { byNamespace, namespaces: watched } = splitMembers(options.members);
    if (byNamespace.size === 0) return {};

    const program = context.sourceCode.ast;
    const bindings = collectEffectBindings(program);
    const { namespaced, barrel } = collectNamespaceLocals(
      program,
      bindings,
      watched,
      options.reexportModules,
    );
    const directMembers = collectDirectMemberImports(program, byNamespace);
    if (namespaced.size === 0 && barrel.size === 0 && directMembers.size === 0) return {};

    const report = (node: ESTree.Node, namespace: string, member: string): void => {
      context.report({
        node,
        messageId: namespace === 'Cause' ? 'causeInspection' : 'defectCatch',
        data: { member: `${namespace}.${member}` },
      });
    };

    const inspect = (node: ESTree.Node): void => {
      const origin = effectOrigin(context, node, options.reexportModules);
      if (origin?.length !== 2 || !byNamespace.get(origin[0]!)?.has(origin[1]!)) return;
      report(node, origin[0]!, origin[1]!);
    };
    return {
      MemberExpression: inspect,
      Identifier(node) {
        if (!isReferencePosition(node)) return;
        const variable = lookupVariable(context, node);
        if (
          !variable?.references.some(
            (reference) => reference.identifier === node && reference.isRead(),
          )
        )
          return;
        // Type queries and type-member names are not runtime seam references.
        let ancestor = node.parent;
        while (ancestor && ancestor.type !== 'Program') {
          if (
            ancestor.type.startsWith('TS') &&
            ![
              'TSAsExpression',
              'TSSatisfiesExpression',
              'TSNonNullExpression',
              'TSInstantiationExpression',
              'TSTypeAssertion',
            ].includes(ancestor.type)
          )
            return;
          ancestor = ancestor.parent;
        }
        inspect(node);
      },
    };
  },
});
