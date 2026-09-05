/**
 * effect-native/no-layer-provide-in-library
 *
 * Audit finding: **A1 — "Establish one process-level Layer and ManagedRuntime composition model"**
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`). The audit records that "some library layers
 * internally provide their own dependencies, hiding their true requirements and prompting
 * `Layer.fresh` workarounds", and the Effect v4 target is: "Keep library Live layers
 * dependency-transparent; compose dependencies at the application root."
 *
 * What is detected
 * - Every reference to `Layer.provide` / `Layer.provideMerge` (configurable via `members`) in a
 *   library file — i.e. any file under `apps/**`, `verticals/**` or `packages/**` that is not an
 *   application composition root.
 * - References are detected lexically, not only as call callees, so all of these report:
 *   `Layer.provide(dep)`, `x.pipe(Layer.provide(dep))`, `pipe(x, Layer.provideMerge(dep))`,
 *   point-free `layers.map(Layer.provide)`, optional `Layer?.provide(dep)`,
 *   computed `Layer["provide"](dep)` and `` Layer[`provide`](dep) ``.
 * - Every way the `Layer` namespace can be spelled: aliased named imports
 *   (`import { Layer as L } from "effect"`), submodule namespace imports
 *   (`import * as L from "effect/Layer"`), root namespace imports
 *   (`import * as Effect from "effect"; Effect.Layer.provide`), and **local rebindings** of any of
 *   those (`const { Layer } = Effect`, `const L = Effect.Layer`, `const L2 = L`), which are followed
 *   transitively.
 * - Escape hatches that drop the namespace entirely: `const { provide, provideMerge } = Layer`,
 *   direct member imports `import { provide, provideMerge as merge } from "effect/Layer"` (bare
 *   references to those locals report, including point-free `.map(provide)`).
 * - Pure re-exports are deliberately not uses: A1 concerns pre-provided Live layers, not barrel
 *   vocabulary. The earlier re-export ban exceeded that evidence and has been narrowed.
 *
 * Identifier matches are confirmed with `context.sourceCode.getScope`: a local binding that shadows
 * the import (`(Layer: LayerPort) => Layer.provide("grid")`) is not the Effect `Layer` module and is
 * never reported.
 *
 * What is deliberately allowed
 * - Application composition roots (`rootFiles`): the `api/index.ts` of each app and vertical, plus
 *   app `src/entry.<name>.ts[x]`. The audit's own valid example lives there:
 *   `HttpApiBuilder.layer(Api).pipe(Layer.provide(Layer.mergeAll(...)))`.
 * - Ratified owner-private composition modules listed in `compositionFiles` (empty by default, so
 *   the strict default reports them; candidates are `packages/core-runtime/src/runtime-infrastructure.ts`
 *   and `apps/shell-super-app/api/auth/runtime-infrastructure.ts`).
 * - Tests and scripts (audit D tier: test harness wiring is not a migration driver), build output
 *   (`dist`, `.output`), and `.d.ts` files.
 * - Every other `Layer.*` combinator: `Layer.mergeAll`, `Layer.merge`, `Layer.effect`, `Layer.scoped`,
 *   `Layer.succeed`, `Layer.fresh`, and `Layer.orDie` at a deliberate startup boundary (D tier).
 * - `Effect.provide` and any non-Effect object that merely happens to be named `Layer`.
 *
 * Report-only: no fixer, no suggestion. Existing violations are the intended output.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings, effectMember } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { isScriptFile, isTestFile, matchesAny } from '../shared/paths.ts';

const LAYER_NAMESPACE = 'Layer';
const EFFECT_ROOT_MODULE = 'effect';
/** `effect/Layer`, and re-exported nestings such as `effect/unstable/Layer`. */
const EFFECT_LAYER_MODULE = /^effect\/(?:.*\/)?Layer$/u;

const DEFAULT_SCOPE: readonly string[] = ['apps/**', 'verticals/**', 'packages/**'];

const DEFAULT_IGNORE: readonly string[] = [
  '**/dist/**',
  '**/dist-*/**',
  '**/.output/**',
  '**/node_modules/**',
  '**/scripts/**',
  '**/*.d.ts',
];

/** Application composition roots: composing dependencies here is the A1 target, not the anti-pattern. */
const DEFAULT_ROOT_FILES: readonly string[] = [
  'apps/*/api/index.ts',
  'apps/*/api/index.tsx',
  'verticals/*/api/index.ts',
  'verticals/*/api/index.tsx',
  'apps/*/src/entry.*.ts',
  'apps/*/src/entry.*.tsx',
];

const DEFAULT_MEMBERS: readonly string[] = ['provide', 'provideMerge'];

interface RuleOptions {
  readonly scope: readonly string[];
  readonly ignore: readonly string[];
  readonly rootFiles: readonly string[];
  readonly compositionFiles: readonly string[];
  readonly members: readonly string[];
  readonly alsoGovern: readonly string[];
}

const DEFAULT_OPTIONS: RuleOptions = {
  scope: DEFAULT_SCOPE,
  ignore: DEFAULT_IGNORE,
  rootFiles: DEFAULT_ROOT_FILES,
  compositionFiles: [],
  members: DEFAULT_MEMBERS,
  alsoGovern: [],
};

const globArray = {
  type: 'array',
  items: { type: 'string' },
  uniqueItems: true,
} as const;

function readOptions(context: Context): RuleOptions {
  const raw = (context.options[0] ?? {}) as Partial<RuleOptions>;
  return {
    scope: raw.scope ?? DEFAULT_OPTIONS.scope,
    ignore: raw.ignore ?? DEFAULT_OPTIONS.ignore,
    rootFiles: raw.rootFiles ?? DEFAULT_OPTIONS.rootFiles,
    compositionFiles: raw.compositionFiles ?? DEFAULT_OPTIONS.compositionFiles,
    members: raw.members ?? DEFAULT_OPTIONS.members,
    alsoGovern: raw.alsoGovern ?? DEFAULT_OPTIONS.alsoGovern,
  };
}

/** `true` when this file is a library file the A1 rule governs. */
function isGovernedLibraryFile(filename: string, options: RuleOptions): boolean {
  if (matchesAny(filename, options.ignore)) return false;
  if (matchesAny(filename, options.rootFiles)) return false;
  if (matchesAny(filename, options.compositionFiles)) return false;
  // `alsoGovern` opts extra paths past the workspace-scope and test/script guards; it never
  // overrides `ignore`, `rootFiles` or `compositionFiles`.
  if (matchesAny(filename, options.alsoGovern)) return true;
  if (isTestFile(filename) || isScriptFile(filename)) return false;
  return matchesAny(filename, options.scope);
}

function importedName(specifier: ESTree.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : specifier.imported.value;
}

/** Local names bound by `import * as X from "effect"` — `X.Layer.provide` must still be caught. */
function collectEffectRootNamespaces(program: ESTree.Program): ReadonlySet<string> {
  const roots = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (statement.source.value !== EFFECT_ROOT_MODULE) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') roots.add(specifier.local.name);
    }
  }
  return roots;
}

/**
 * Locals bound by `import { provide, provideMerge as merge } from "effect/Layer"`. These are the same
 * escape hatch as `const { provide } = Layer`, one step earlier: there is no `Layer.` member
 * expression left to match, so bare references to these locals are what must be reported.
 */
function collectDirectMemberImports(
  program: ESTree.Program,
  members: readonly string[],
): ReadonlyMap<string, string> {
  const locals = new Map<string, string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (!EFFECT_LAYER_MODULE.test(statement.source.value)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported = importedName(specifier);
      if (members.includes(imported)) locals.set(specifier.local.name, imported);
    }
  }
  return locals;
}

/** A single-quasi template literal (`` `provide` ``) or a plain string literal. */
function constantStringName(node: ESTree.Node): string | null {
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null;
  if (
    node.type === 'TemplateLiteral' &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    const cooked = node.quasis[0]?.value.cooked;
    return typeof cooked === 'string' ? cooked : null;
  }
  return null;
}

/** Static property name of a member expression: `x.provide`, `x["provide"]` and `` x[`provide`] `` alike. */
function staticPropertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  return constantStringName(node.property);
}

/** Property key of an object pattern property: `{ provide }`, `{ "provide": p }`, `` { [`provide`]: p } ``. */
function patternKeyName(property: Extract<ESTree.Node, { type: 'Property' }>): string | null {
  if (!property.computed && property.key.type === 'Identifier') return property.key.name;
  return constantStringName(property.key);
}

/** The binding identifiers introduced by a pattern (only the shapes a rebinding can use). */
function patternIdentifiers(pattern: ESTree.Node): Extract<ESTree.Node, { type: 'Identifier' }>[] {
  if (pattern.type === 'Identifier') return [pattern];
  if (pattern.type === 'AssignmentPattern') return patternIdentifiers(pattern.left);
  return [];
}

function unwrap(node: ESTree.Node): ESTree.Node {
  let current = node;
  while (
    [
      'ChainExpression',
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'TSInstantiationExpression',
      'TSTypeAssertion',
    ].includes(current.type)
  ) {
    const inner = (current as { expression?: ESTree.Node }).expression;
    if (inner === undefined) break;
    current = inner;
  }
  return current;
}

function isTypePosition(node: ESTree.Node): boolean {
  const runtime = new Set([
    'TSAsExpression',
    'TSSatisfiesExpression',
    'TSNonNullExpression',
    'TSInstantiationExpression',
    'TSTypeAssertion',
    'TSModuleBlock',
    'TSModuleDeclaration',
    'TSParameterProperty',
  ]);
  for (let at = node.parent; at !== null; at = at.parent) {
    if (at.type.startsWith('TS') && !runtime.has(at.type)) return true;
  }
  return false;
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

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A1: disallow `Layer.provide`/`Layer.provideMerge` inside library Live layers (apps/**, verticals/**, packages/**). Library layers must stay dependency-transparent and be composed once at the application root.',
    },
    messages: {
      layerProvideInLibrary:
        '`Layer.{{member}}` inside a library Live layer hides its real requirements and forces `Layer.fresh` workarounds (audit A1). Export the layer with its dependencies left in `RIn` (`Layer.Layer<Service, never, Dependency>`) and compose them once at the application root.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          scope: globArray,
          ignore: globArray,
          rootFiles: globArray,
          compositionFiles: globArray,
          members: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          alsoGovern: globArray,
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        scope: [...DEFAULT_SCOPE],
        ignore: [...DEFAULT_IGNORE],
        rootFiles: [...DEFAULT_ROOT_FILES],
        compositionFiles: [],
        members: [...DEFAULT_MEMBERS],
        alsoGovern: [],
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    if (!isGovernedLibraryFile(context.filename, options)) return {};

    const program = context.sourceCode.ast;
    const bindings: EffectBindings = collectEffectBindings(program);
    if (!bindings.importsEffect) return {};
    const effectRoots = collectEffectRootNamespaces(program);
    const directMembers = collectDirectMemberImports(program, options.members);
    const members = new Set(options.members);

    /** Locals bound by `import { Layer } from "effect"` / `import * as Layer from "effect/Layer"`. */
    const importedLayerLocals = new Set<string>();
    for (const [local, namespace] of bindings.namespaces) {
      if (namespace === LAYER_NAMESPACE) importedLayerLocals.add(local);
    }
    if (importedLayerLocals.size === 0 && effectRoots.size === 0 && directMembers.size === 0)
      return {};

    // ---- Resolution -------------------------------------------------------------------------
    // `start` offsets of binding identifiers that alias the Effect `Layer` namespace locally
    // (`const { Layer } = Effect`, `const L = Effect.Layer`, `const L2 = L`). Filled by a
    // fixed point at `Program:exit` so declaration order and chains do not matter.
    const layerAliasBindings = new Set<number>();

    /** `true` when the identifier still resolves to the import it names (no local shadow). */
    function resolvesToImport(
      identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
      importedLocals: { has(name: string): boolean },
    ): boolean {
      if (!importedLocals.has(identifier.name)) return false;
      const variable = lookupVariable(context, identifier);
      // Unresolved: the module-level import declaration already proved the binding exists.
      if (variable === null || variable.defs.length === 0) return true;
      return variable.defs.some((definition) => definition.type === 'ImportBinding');
    }

    /** `true` when the identifier resolves to a local rebinding of the `Layer` namespace. */
    function resolvesToLayerAlias(
      identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
    ): boolean {
      const variable = lookupVariable(context, identifier);
      if (variable === null) return false;
      return variable.defs.some((definition) => layerAliasBindings.has(definition.name.start));
    }

    /** `true` when this identifier denotes the Effect `Layer` module in its own scope. */
    function isLayerNamespaceIdentifier(
      identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
    ): boolean {
      if (resolvesToImport(identifier, importedLayerLocals)) return true;
      return resolvesToLayerAlias(identifier);
    }

    /** `true` when this expression denotes the Effect `Layer` module (`Layer`, `Effect.Layer`, alias). */
    function isLayerNamespaceExpression(input: ESTree.Node): boolean {
      const node = unwrap(input);
      if (node.type === 'Identifier') return isLayerNamespaceIdentifier(node);
      if (node.type === 'MemberExpression') {
        if (staticPropertyName(node) !== LAYER_NAMESPACE) return false;
        const object = unwrap(node.object);
        if (object.type !== 'Identifier') return false;
        return resolvesToImport(object, effectRoots);
      }
      return false;
    }

    // ---- Collection -------------------------------------------------------------------------
    interface MemberCandidate {
      readonly node: ESTree.Node;
      readonly member: string;
      readonly namespace: ESTree.Node;
    }
    const memberCandidates: MemberCandidate[] = [];
    const identifierCandidates: Extract<ESTree.Node, { type: 'Identifier' }>[] = [];
    const declarators: ESTree.VariableDeclarator[] = [];
    const reports: Array<{ node: ESTree.Node; messageId: string; data: Record<string, string> }> =
      [];

    function queue(node: ESTree.Node, member: string): void {
      reports.push({ node, messageId: 'layerProvideInLibrary', data: { member } });
    }

    return {
      MemberExpression(node) {
        if (isTypePosition(node)) return;
        // Fast path via the shared matcher: plain `Layer.provide` on an import binding.
        const shared = effectMember(node, bindings);
        const member = shared !== null ? shared.member : staticPropertyName(node);
        if (member === null || !members.has(member)) return;
        memberCandidates.push({ node, member, namespace: node.object });
      },
      Identifier(node) {
        if (isTypePosition(node)) return;
        if (directMembers.size === 0 || !directMembers.has(node.name)) return;
        const parent = node.parent;
        if (parent === null || parent === undefined) return;
        // Declaration sites and non-reference positions are not uses of the escape hatch.
        if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier') return;
        if (parent.type === 'ImportNamespaceSpecifier' || parent.type === 'ExportSpecifier') return;
        if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
          return;
        if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
        if (parent.type === 'PropertyDefinition' && parent.key === node && !parent.computed) return;
        if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) return;
        identifierCandidates.push(node);
      },
      VariableDeclarator(node) {
        if (node.init !== null) declarators.push(node);
      },
      // A pure re-export composes no layer; A1 governs provision, not barrel vocabulary.
      'Program:exit'() {
        // 1. Fixed point over local rebindings of the `Layer` namespace.
        let changed = true;
        while (changed) {
          changed = false;
          for (const declarator of declarators) {
            const init = declarator.init;
            if (init === null) continue;
            // `const L = Layer` / `const L = Effect.Layer` / `const L2 = L`.
            if (isLayerNamespaceExpression(init)) {
              for (const identifier of patternIdentifiers(declarator.id)) {
                if (layerAliasBindings.has(identifier.start)) continue;
                layerAliasBindings.add(identifier.start);
                changed = true;
              }
              continue;
            }
            // `const { Layer } = Effect` / `const { Layer: L } = Effect`.
            if (declarator.id.type !== 'ObjectPattern') continue;
            if (init.type !== 'Identifier' || !resolvesToImport(init, effectRoots)) continue;
            for (const property of declarator.id.properties) {
              if (property.type !== 'Property') continue;
              if (patternKeyName(property) !== LAYER_NAMESPACE) continue;
              for (const identifier of patternIdentifiers(property.value)) {
                if (layerAliasBindings.has(identifier.start)) continue;
                layerAliasBindings.add(identifier.start);
                changed = true;
              }
            }
          }
        }

        // 2. `const { provide, provideMerge } = <layer namespace>` drops the namespace entirely.
        for (const declarator of declarators) {
          const init = declarator.init;
          if (init === null || declarator.id.type !== 'ObjectPattern') continue;
          if (!isLayerNamespaceExpression(init)) continue;
          for (const property of declarator.id.properties) {
            if (property.type !== 'Property') continue;
            const name = patternKeyName(property);
            if (name === null || !members.has(name)) continue;
            queue(property, name);
          }
        }

        // 3. `Layer.provide` in every spelling, confirmed against scope.
        for (const candidate of memberCandidates) {
          if (!isLayerNamespaceExpression(candidate.namespace)) continue;
          queue(candidate.node, candidate.member);
        }

        // 4. Bare references to `import { provide } from "effect/Layer"` locals.
        for (const identifier of identifierCandidates) {
          if (!resolvesToImport(identifier, directMembers)) continue;
          queue(identifier, directMembers.get(identifier.name) ?? identifier.name);
        }

        reports.sort((left, right) => left.node.start - right.node.start);
        for (const report of reports) {
          context.report({ node: report.node, messageId: report.messageId, data: report.data });
        }
      },
    };
  },
});
