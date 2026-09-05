/**
 * Audit finding: **A1** — "Establish one process-level Layer and ManagedRuntime composition model"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`). A1 counts 12 `Layer.orDie` sites while the
 * D-tier list blesses exactly one shape: "`Layer.orDie` at a deliberate outer startup boundary —
 * provided the typed cause is logged first."
 *
 * What is detected
 * - Every reference to `Layer.orDie` / `Layer.orDieWith` in in-scope files, whether it is called
 *   (`Layer.orDie(layer)`) or passed point-free (`layer.pipe(Layer.provide(x), Layer.orDie)`).
 * - Aliased imports (`import { Layer as L } from "effect"`), submodule namespace imports
 *   (`import * as Layer from "effect/Layer"`), root namespace imports (`import * as Effect from "effect"`
 *   then `Effect.Layer.orDie`), direct member imports (`import { orDie } from "effect/Layer"`),
 *   computed access (`Layer["orDie"]`) and optional chaining (`Layer?.orDie`).
 * - Namespaces laundered through locals: `const Lay = Layer`, `const { Layer: L } = EffectBarrel`,
 *   `const { orDie } = Layer`, `const die = Layer.orDie` — resolved to a fixed point so chains of
 *   aliases (`const A = Layer; const B = A;`) collapse back to the Effect binding.
 * - TypeScript expression wrappers around the namespace: `(Layer as typeof Layer).orDie`,
 *   `Layer!.orDie`, `(Layer satisfies typeof Layer).orDie`, `Layer<never>.orDie`, `(Layer).orDie`.
 * - `Layer` re-exported through an Effect barrel (`reexportModules`, default the Modern.js
 *   `@modern-js/plugin-bff/effect-edge` edge barrel the BFF entry points import from).
 *
 * What is deliberately allowed
 * - The final `Layer.orDie` in a file that matches `rootFiles` (default: the process/BFF entry
 *   points `apps/*​/api/index.ts`, `verticals/*​/api/index.ts`, and `scripts/**`). That is the
 *   "deliberate outer startup boundary" the audit preserves. Exported top-level compositions are
 *   preferred over later helper bodies; nested applications are ordered by completion, not callee
 *   offset. `maxPerRoot` widens that allowance.
 * - Type-only positions: `typeof orDie`, `typeof Layer.orDie`, `ReturnType<typeof orDie>` and any
 *   `import type` / `{ type orDie }` binding. Erased types convert no layer failure into a defect.
 * - Test files (the audit only targets production composition) and anything outside `include`.
 * - Any `Layer`/`orDie` shadowed by a local binding (parameter, catch clause, class, block const,
 *   object key) or imported from a non-Effect module.
 *
 * Known limitations: selecting an exported/final composition is still a syntactic heuristic (it
 * under-reports a root whose true outer composition has no `Layer.orDie` at all), the audit's real
 * precondition ("the typed cause is logged first") is not observable without types, and a project
 * module that re-exports `effect` (`export * from "effect"`) cannot be followed across files by an
 * AST-only plugin. Reports are informational only; this rule never fixes or suggests.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

const LAYER_NAMESPACE = 'Layer';
const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_LAYER_MODULE = /^effect\/(?:.*\/)?Layer$/u;

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production `include`/`rootFiles` defaults
 * instead of forcing the fixture config to pass loosened options (which `run-on-repo.mts` reuses).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];

const DEFAULT_EXCLUDE: readonly string[] = [];

/** Deliberate outer startup boundaries: one process root per host. */
const DEFAULT_ROOT_FILES = [
  'apps/*/api/index.ts',
  'apps/*/api/server.ts',
  'apps/*/src/entry.server.ts',
  'apps/*/src/entry.server.tsx',
  'verticals/*/api/index.ts',
  'scripts/**',
];

const DEFAULT_MEMBERS = ['orDie', 'orDieWith'];

/** Barrels that re-export Effect namespaces verbatim; `Layer` from them is Effect's `Layer`. */
const DEFAULT_REEXPORT_MODULES = ['@modern-js/plugin-bff/effect-edge'];

/**
 * TypeScript nodes that wrap a *value* and are erased at runtime. `(Layer as typeof Layer).orDie`
 * still calls `Layer.orDie`, so these are unwrapped rather than treated as type positions.
 */
const TS_VALUE_WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

interface RuleOptions {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly rootFiles: readonly string[];
  readonly maxPerRoot: number;
  readonly members: readonly string[];
  readonly reexportModules: readonly string[];
  readonly allowTestFiles: boolean;
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
    maxPerRoot:
      typeof maxPerRoot === 'number' && Number.isInteger(maxPerRoot) && maxPerRoot >= 0
        ? maxPerRoot
        : 1,
    members: stringArray(record.members, DEFAULT_MEMBERS),
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
    allowTestFiles: record.allowTestFiles === true,
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

/** Strip erased TS value wrappers and parentheses: `(Layer as X)!` → `Layer`. */
function unwrapValue(node: unknown): ESTree.Node | null {
  let current = node as { type?: string; expression?: unknown } | null | undefined;
  for (let guard = 0; guard < 16; guard += 1) {
    if (current === null || current === undefined || typeof current.type !== 'string') return null;
    if (current.type === 'ParenthesizedExpression' || TS_VALUE_WRAPPERS.has(current.type)) {
      current = current.expression as { type?: string; expression?: unknown } | null;
      continue;
    }
    return current as unknown as ESTree.Node;
  }
  return null;
}

/**
 * `true` when the identifier sits in an erased type position (`typeof orDie`, `typeof Layer.orDie`,
 * `const x: orDie`). Any `TS*` parent that is not an erased *value* wrapper is type land.
 */
function isTypePosition(node: ESTree.Node): boolean {
  const parent = (node as { parent?: { type?: string } | null }).parent;
  if (parent === null || parent === undefined || typeof parent.type !== 'string') return false;
  if (!parent.type.startsWith('TS')) return false;
  return !TS_VALUE_WRAPPERS.has(parent.type);
}

/** Non-computed `.orDie`, or computed `["orDie"]`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const property = node.property;
  if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
  return null;
}

/** Non-computed object-pattern / object-literal key name. */
function keyName(node: { computed: boolean; key: ESTree.Node }): string | null {
  if (node.computed) return null;
  const key = node.key as { type: string; name?: string; value?: unknown };
  if (key.type === 'Identifier' && typeof key.name === 'string') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
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
 * Every `VariableDeclarator` in the file, collected up front so alias resolution is independent of
 * traversal order (`export const f = () => Lay.orDie(x); const Lay = Layer;` still resolves).
 */
function collectDeclarators(program: ESTree.Program): ESTree.VariableDeclarator[] {
  const found: ESTree.VariableDeclarator[] = [];
  const seen = new Set<object>();
  const stack: unknown[] = [program.body];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (record.type === 'VariableDeclarator')
      found.push(current as unknown as ESTree.VariableDeclarator);
    for (const key of Object.keys(record)) {
      if (key === 'parent' || key === 'comments' || key === 'tokens') continue;
      const value = record[key];
      if (value !== null && typeof value === 'object') stack.push(value);
    }
  }
  return found;
}

/** name → start offsets of every binding site that makes that name stand for the tracked thing. */
type BindingMap = Map<string, Set<number>>;

function addBinding(map: BindingMap, name: string, start: number): boolean {
  const existing = map.get(name);
  if (existing === undefined) {
    map.set(name, new Set([start]));
    return true;
  }
  if (existing.has(start)) return false;
  existing.add(start);
  return true;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A1: allow `Layer.orDie` only once, at the outermost startup root. Intermediate library and ' +
        'per-service `Layer.orDie` calls convert typed layer failures into defects before the root can log them.',
    },
    messages: {
      outsideRoot:
        '`Layer.{{member}}` here converts a typed layer failure into a defect before the startup root can log it. ' +
        'Keep the error in `E` (compose the layer dependency-transparently and let requirements propagate), and ' +
        'apply `Layer.orDie` once at the outermost application root after logging the typed cause.',
      beforeRoot:
        '`Layer.{{member}}` precedes {{remaining}} other error-conversion site(s) in this startup root. ' +
        'Only the deliberate outer composition may discard the typed error: keep ' +
        "this layer's failure in `E`, log the cause at the root, and call `Layer.orDie` there once.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          exclude: { type: 'array', items: { type: 'string' } },
          rootFiles: { type: 'array', items: { type: 'string' } },
          maxPerRoot: { type: 'integer', minimum: 0 },
          members: { type: 'array', items: { type: 'string' } },
          reexportModules: { type: 'array', items: { type: 'string' } },
          allowTestFiles: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: [...DEFAULT_INCLUDE],
        exclude: [...DEFAULT_EXCLUDE],
        rootFiles: [...DEFAULT_ROOT_FILES],
        maxPerRoot: 1,
        members: [...DEFAULT_MEMBERS],
        reexportModules: [...DEFAULT_REEXPORT_MODULES],
        allowTestFiles: false,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.exclude)) return {};
    if (!matchesGlobs(path, options.include)) return {};
    if (!options.allowTestFiles && isTestFile(path)) return {};

    const program = context.sourceCode.ast;
    const bindings = collectEffectBindings(program);

    /** Locals standing for Effect's `Layer` namespace. */
    const layerBindings: BindingMap = new Map();
    /** Locals standing for the whole Effect barrel (`import * as Effect from "effect"`). */
    const barrelBindings: BindingMap = new Map();
    /** Locals standing for `Layer.orDie` itself (`import { orDie } from "effect/Layer"`). */
    const memberBindings: BindingMap = new Map();

    for (const statement of program.body) {
      if (statement.type !== 'ImportDeclaration') continue;
      // `import type { Layer } from "effect"` is erased: it can never produce a defect.
      if ((statement as { importKind?: string }).importKind === 'type') continue;
      const source = statement.source.value;
      const isEffectRoot = source === EFFECT_ROOT_MODULE;
      const isReexport = matchesGlobs(source, options.reexportModules);
      const isLayerModule = EFFECT_LAYER_MODULE.test(source);
      for (const specifier of statement.specifiers) {
        const local = specifier.local;
        if (specifier.type === 'ImportNamespaceSpecifier') {
          if (isEffectRoot || isReexport) addBinding(barrelBindings, local.name, local.start);
          else if (bindings.namespaces.get(local.name) === LAYER_NAMESPACE || isLayerModule) {
            addBinding(layerBindings, local.name, local.start);
          }
          continue;
        }
        if (specifier.type !== 'ImportSpecifier') continue;
        if ((specifier as { importKind?: string }).importKind === 'type') continue;
        const imported = importedName(specifier);
        if ((isEffectRoot || isReexport) && imported === LAYER_NAMESPACE) {
          addBinding(layerBindings, local.name, local.start);
        }
        if (isLayerModule && options.members.includes(imported)) {
          addBinding(memberBindings, local.name, local.start);
        }
      }
    }

    const declarators = collectDeclarators(program);

    /**
     * Cheap superset of names that could end up standing for `Layer.orDie` after alias
     * resolution. Used only to keep the `Identifier` visitor from queueing every name in the file.
     */
    const candidateMemberNames = new Set<string>(memberBindings.keys());
    const noteBindingNames = (pattern: unknown): void => {
      const target = pattern as {
        type?: string;
        name?: string;
        properties?: unknown[];
        left?: unknown;
      } | null;
      if (target === null || target === undefined) return;
      if (target.type === 'AssignmentPattern') return noteBindingNames(target.left);
      if (target.type === 'Identifier' && typeof target.name === 'string') {
        candidateMemberNames.add(target.name);
        return;
      }
      if (target.type !== 'ObjectPattern' || !Array.isArray(target.properties)) return;
      for (const property of target.properties) {
        const entry = property as { type?: string; value?: unknown };
        if (entry.type === 'Property') noteBindingNames(entry.value);
      }
    };
    for (const declarator of declarators) {
      const init = unwrapValue(declarator.init);
      if (init === null) continue;
      if (init.type === 'Identifier' || init.type === 'MemberExpression')
        noteBindingNames(declarator.id);
    }

    if (layerBindings.size === 0 && barrelBindings.size === 0 && memberBindings.size === 0) {
      return {};
    }

    /**
     * `true` when `identifier` really resolves to one of the recorded binding sites. Unresolved
     * names fall back to `true` because the module-level import already proved the binding exists;
     * a local shadow (parameter, `const`, catch clause, class) resolves elsewhere and is rejected.
     */
    const resolvesTo = (
      map: BindingMap,
      identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
    ): boolean => {
      const starts = map.get(identifier.name);
      if (starts === undefined) return false;
      const variable = lookupVariable(context, identifier);
      if (variable === null || variable.defs.length === 0) return true;
      if (variable.references.some((reference) => reference.isWrite() && !reference.init))
        return false;
      return variable.defs.some((definition) => starts.has(definition.name.start));
    };

    const isDeclarationSite = (
      identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
    ): boolean => {
      const variable = lookupVariable(context, identifier);
      if (variable === null) return false;
      return variable.defs.some((definition) => definition.name.start === identifier.start);
    };

    /** Bind every name introduced by `pattern` to `kind`; returns whether anything was new. */
    const bindPattern = (pattern: unknown, kind: 'layer' | 'barrel' | 'member'): boolean => {
      const target = pattern as
        | { type?: string; name?: string; start?: number; properties?: unknown[]; left?: unknown }
        | null
        | undefined;
      if (target === null || target === undefined || typeof target.type !== 'string') return false;
      if (target.type === 'AssignmentPattern') return bindPattern(target.left, kind);
      if (
        target.type === 'Identifier' &&
        typeof target.name === 'string' &&
        typeof target.start === 'number'
      ) {
        const map =
          kind === 'layer' ? layerBindings : kind === 'barrel' ? barrelBindings : memberBindings;
        return addBinding(map, target.name, target.start);
      }
      if (target.type !== 'ObjectPattern' || !Array.isArray(target.properties)) return false;
      if (kind === 'member') return false;
      let changed = false;
      for (const property of target.properties) {
        const entry = property as {
          type?: string;
          computed?: boolean;
          key?: ESTree.Node;
          value?: unknown;
        };
        if (entry.type !== 'Property' || entry.key === undefined) continue;
        const name = keyName({ computed: entry.computed === true, key: entry.key });
        if (name === null) continue;
        if (kind === 'barrel' && name === LAYER_NAMESPACE)
          changed = bindPattern(entry.value, 'layer') || changed;
        else if (kind === 'layer' && options.members.includes(name)) {
          changed = bindPattern(entry.value, 'member') || changed;
        }
      }
      return changed;
    };

    /** One alias-propagation pass over every declarator; returns whether anything was learned. */
    const propagateAliases = (): boolean => {
      let changed = false;
      for (const declarator of declarators) {
        const init = unwrapValue(declarator.init);
        if (init === null) continue;
        if (init.type === 'Identifier') {
          if (resolvesTo(layerBindings, init))
            changed = bindPattern(declarator.id, 'layer') || changed;
          else if (resolvesTo(barrelBindings, init))
            changed = bindPattern(declarator.id, 'barrel') || changed;
          else if (resolvesTo(memberBindings, init))
            changed = bindPattern(declarator.id, 'member') || changed;
          continue;
        }
        if (init.type !== 'MemberExpression') continue;
        const name = memberName(init);
        if (name === null) continue;
        const object = unwrapValue(init.object);
        if (object === null || object.type !== 'Identifier') continue;
        // `const L = Effect.Layer` / `const { orDie } = Effect.Layer`
        if (name === LAYER_NAMESPACE && resolvesTo(barrelBindings, object)) {
          changed = bindPattern(declarator.id, 'layer') || changed;
          continue;
        }
        // `const die = Layer.orDie`
        if (options.members.includes(name) && resolvesTo(layerBindings, object)) {
          changed = bindPattern(declarator.id, 'member') || changed;
        }
      }
      return changed;
    };

    interface Candidate {
      readonly node: ESTree.Node;
      readonly member: string;
      readonly kind: 'layer' | 'barrel' | 'member';
      readonly identifier: Extract<ESTree.Node, { type: 'Identifier' }>;
      readonly start: number;
    }
    const candidates: Candidate[] = [];

    return {
      MemberExpression(node) {
        const member = memberName(node);
        if (member === null || !options.members.includes(member)) return;
        if (isTypePosition(node)) return;

        const object = unwrapValue(node.object);
        if (object === null) return;

        // `Layer.orDie` / `L.orDie` / `Layer["orDie"]` / `Layer?.orDie` / `(Layer as X).orDie`.
        if (object.type === 'Identifier') {
          candidates.push({
            node,
            member,
            kind: 'layer',
            identifier: object as Extract<ESTree.Node, { type: 'Identifier' }>,
            start: node.start,
          });
          return;
        }

        // `Effect.Layer.orDie` via `import * as Effect from "effect"` (or an Effect barrel).
        if (object.type !== 'MemberExpression') return;
        if (memberName(object as ESTree.MemberExpression) !== LAYER_NAMESPACE) return;
        const root = unwrapValue((object as ESTree.MemberExpression).object);
        if (root === null || root.type !== 'Identifier') return;
        candidates.push({
          node,
          member,
          kind: 'barrel',
          identifier: root as Extract<ESTree.Node, { type: 'Identifier' }>,
          start: node.start,
        });
      },
      Identifier(node) {
        if (!candidateMemberNames.has(node.name)) return;
        if (isTypePosition(node)) return;
        const parent = node.parent;
        if (parent === null || parent === undefined) return;
        // Declaration sites and non-reference positions are not calls.
        if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier') return;
        if (parent.type === 'ImportNamespaceSpecifier' || parent.type === 'ExportSpecifier') return;
        if (
          parent.type === 'MemberExpression' &&
          !parent.computed &&
          parent.property.start === node.start
        )
          return;
        if (parent.type === 'Property' && !parent.computed && parent.key.start === node.start)
          return;
        if (
          parent.type === 'PropertyDefinition' &&
          !parent.computed &&
          parent.key.start === node.start
        )
          return;
        if (
          parent.type === 'MethodDefinition' &&
          !parent.computed &&
          parent.key.start === node.start
        )
          return;
        if (isDeclarationSite(node)) return;
        candidates.push({
          node,
          member: node.name,
          kind: 'member',
          identifier: node,
          start: node.start,
        });
      },
      'Program:exit'() {
        if (candidates.length === 0) return;
        // Alias chains (`const A = Layer; const B = A;`) need a fixed point, not one pass.
        // Bounded: each pass is O(declarators), and real chains are one or two links deep.
        const passes = Math.min(declarators.length + 1, 32);
        for (let pass = 0; pass < passes; pass += 1) {
          if (!propagateAliases()) break;
        }

        const outerValue = (node: ESTree.Node): ESTree.Node => {
          let current = node;
          while (
            current.parent != null &&
            unwrapValue(current.parent)?.start === node.start &&
            unwrapValue(current.parent)?.end === node.end
          ) {
            current = current.parent;
          }
          return current;
        };
        const isRoot = matchesGlobs(path, options.rootFiles);
        const found = candidates.filter((candidate) => {
          // Naming the startup adapter does not apply it twice. Count its uses, not the alias definition.
          const value = outerValue(candidate.node);
          if (
            isRoot &&
            value.parent?.type === 'VariableDeclarator' &&
            value.parent.init?.start === value.start
          )
            return false;
          const map =
            candidate.kind === 'layer'
              ? layerBindings
              : candidate.kind === 'barrel'
                ? barrelBindings
                : memberBindings;
          return resolvesTo(map, candidate.identifier);
        });
        if (found.length === 0) return;
        // Calls evaluate their arguments first: lexical start order misidentifies
        // Layer.orDie(inner.pipe(Layer.orDie)) as an intermediate boundary.
        const applicationEnd = (entry: Candidate): number => {
          const parent = outerValue(entry.node).parent;
          return parent?.type === 'CallExpression' ? parent.end : entry.node.end;
        };
        const exportedComposition = (entry: Candidate): number => {
          let current: ESTree.Node | null | undefined = entry.node;
          while (current != null) {
            if (
              ['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration'].includes(
                current.type,
              )
            )
              return 0;
            if (
              current.type === 'ExportNamedDeclaration' ||
              current.type === 'ExportDefaultDeclaration'
            )
              return 1;
            current = current.parent;
          }
          return 0;
        };
        found.sort(
          (left, right) =>
            exportedComposition(left) - exportedComposition(right) ||
            applicationEnd(left) - applicationEnd(right),
        );

        const allowed = isRoot ? Math.min(options.maxPerRoot, found.length) : 0;
        const reportCount = found.length - allowed;
        for (let index = 0; index < reportCount; index += 1) {
          const entry = found[index];
          if (entry === undefined) continue;
          context.report({
            node: entry.node,
            messageId: isRoot ? 'beforeRoot' : 'outsideRoot',
            data: { member: entry.member, remaining: String(found.length - index - 1) },
          });
        }
      },
    };
  },
});
