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
import type { Context, ESTree } from '@oxlint/plugins';

import { asNode, keyName as staticKeyName, memberName } from '../shared/ast.ts';
import { lookupVariable } from '../shared/bindings.ts';
import { collectEffectBindings } from '../shared/effect-imports.ts';
import { importedName } from '../shared/imports.ts';
import { optionRecord, positiveInteger, stringArray } from '../shared/options.ts';
import { isTestFile, matchesGlobs, scopePath } from '../shared/paths.ts';

const LAYER_NAMESPACE = 'Layer';
const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_LAYER_MODULE = /^effect\/(?:.*\/)?Layer$/u;

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

function readOptions(context: Context): RuleOptions {
  const record = optionRecord(context.options?.[0]);
  return {
    include: stringArray(record.include, DEFAULT_INCLUDE),
    exclude: stringArray(record.exclude, DEFAULT_EXCLUDE),
    rootFiles: stringArray(record.rootFiles, DEFAULT_ROOT_FILES),
    maxPerRoot: positiveInteger(record.maxPerRoot, 1, 0),
    members: stringArray(record.members, DEFAULT_MEMBERS),
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
    allowTestFiles: record.allowTestFiles === true,
  };
}

/** Strip erased TS value wrappers and parentheses: `(Layer as X)!` → `Layer`. */
function unwrapValue(node: unknown): ESTree.Node | null {
  let current = node as { type?: string; expression?: unknown } | null | undefined;
  for (let guard = 0; guard < 16; guard += 1) {
    if (current === null || current === undefined || typeof current.type !== 'string') return null;
    if (current.type === 'ParenthesizedExpression' || TS_VALUE_WRAPPERS.has(current.type)) {
      current = current.expression as {
        type?: string;
        expression?: unknown;
      } | null;
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

/** Object-pattern computed keys are deliberately excluded. */
function keyName(node: { computed: boolean; key: ESTree.Node }): string | null {
  return node.computed ? null : staticKeyName(node.key, false, { templates: false });
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
    collectDeclaratorChildren(current, stack, found);
  }
  return found;
}

function collectDeclaratorChildren(current: object, stack: unknown[], found: ESTree.VariableDeclarator[]): void {
  if (Array.isArray(current)) {
    for (const item of current) stack.push(item);
    return;
  }
  const record = current as Record<string, unknown>;
  if (record.type === 'VariableDeclarator') found.push(current as ESTree.VariableDeclarator);
  for (const key of Object.keys(record)) {
    if (['parent', 'comments', 'tokens'].includes(key)) continue;
    const value = record[key];
    if (value !== null && typeof value === 'object') stack.push(value);
  }
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

type BindingKind = 'layer' | 'barrel' | 'member';
type BindingMaps = Record<BindingKind, BindingMap>;

function collectImportBindings(
  program: ESTree.Program,
  options: RuleOptions,
  namespaces: ReadonlyMap<string, string>,
  maps: BindingMaps,
): void {
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue;
    const source = statement.source.value;
    const isRoot = source === EFFECT_ROOT_MODULE || matchesGlobs(source, options.reexportModules);
    const isLayer = EFFECT_LAYER_MODULE.test(source);
    for (const specifier of statement.specifiers) {
      collectImportSpecifier(specifier, isRoot, isLayer, namespaces, options.members, maps);
    }
  }
}

function isLayerNamespace(namespaces: ReadonlyMap<string, string>, name: string, isLayer: boolean): boolean {
  return namespaces.get(name) === LAYER_NAMESPACE || isLayer;
}

function isInScope(path: string, options: RuleOptions): boolean {
  if (matchesGlobs(path, options.exclude)) return false;
  if (!matchesGlobs(path, options.include)) return false;
  return options.allowTestFiles || !isTestFile(path);
}

function collectImportSpecifier(
  specifier: ESTree.ImportDeclaration['specifiers'][number],
  isRoot: boolean,
  isLayer: boolean,
  namespaces: ReadonlyMap<string, string>,
  members: readonly string[],
  maps: BindingMaps,
): void {
  const local = specifier.local;
  if (specifier.type === 'ImportNamespaceSpecifier') {
    if (isRoot) addBinding(maps.barrel, local.name, local.start);
    else if (isLayerNamespace(namespaces, local.name, isLayer)) addBinding(maps.layer, local.name, local.start);
    return;
  }
  if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') return;
  const imported = importedName(specifier);
  if (isRoot && imported === LAYER_NAMESPACE) addBinding(maps.layer, local.name, local.start);
  if (isLayer && members.includes(imported)) addBinding(maps.member, local.name, local.start);
}

function isIdentifierNamePosition(node: Extract<ESTree.Node, { type: 'Identifier' }>): boolean {
  const parent = node.parent;
  if (parent == null) return true;
  if (
    ['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier', 'ExportSpecifier'].includes(parent.type)
  )
    return true;
  if (parent.type === 'MemberExpression') return !parent.computed && parent.property.start === node.start;
  if (parent.type === 'Property' || parent.type === 'PropertyDefinition' || parent.type === 'MethodDefinition')
    return !parent.computed && parent.key.start === node.start;
  return false;
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
    if (!isInScope(path, options)) return {};

    const program = context.sourceCode.ast;
    const bindings = collectEffectBindings(program);

    /** Locals standing for Effect's `Layer` namespace. */
    const layerBindings: BindingMap = new Map();
    /** Locals standing for the whole Effect barrel (`import * as Effect from "effect"`). */
    const barrelBindings: BindingMap = new Map();
    /** Locals standing for `Layer.orDie` itself (`import { orDie } from "effect/Layer"`). */
    const memberBindings: BindingMap = new Map();

    collectImportBindings(program, options, bindings.namespaces, {
      layer: layerBindings,
      barrel: barrelBindings,
      member: memberBindings,
    });

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
      if (init.type === 'Identifier' || init.type === 'MemberExpression') noteBindingNames(declarator.id);
    }

    if (layerBindings.size === 0 && barrelBindings.size === 0 && memberBindings.size === 0) {
      return {};
    }

    /**
     * `true` when `identifier` really resolves to one of the recorded binding sites. Unresolved
     * names fall back to `true` because the module-level import already proved the binding exists;
     * a local shadow (parameter, `const`, catch clause, class) resolves elsewhere and is rejected.
     */
    const resolvesTo = (map: BindingMap, identifier: Extract<ESTree.Node, { type: 'Identifier' }>): boolean => {
      const starts = map.get(identifier.name);
      if (starts === undefined) return false;
      const variable = lookupVariable(context, identifier);
      if (variable === null || variable.defs.length === 0) return true;
      if (variable.references.some((reference) => reference.isWrite() && !reference.init)) return false;
      return variable.defs.some((definition) => starts.has(definition.name.start));
    };

    const isDeclarationSite = (identifier: Extract<ESTree.Node, { type: 'Identifier' }>): boolean => {
      const variable = lookupVariable(context, identifier);
      if (variable === null) return false;
      return variable.defs.some((definition) => definition.name.start === identifier.start);
    };

    const maps: BindingMaps = {
      layer: layerBindings,
      barrel: barrelBindings,
      member: memberBindings,
    };

    const propertyKind = (name: string | null, kind: BindingKind): BindingKind | null => {
      if (kind === 'barrel' && name === LAYER_NAMESPACE) return 'layer';
      if (kind === 'layer' && name !== null && options.members.includes(name)) return 'member';
      return null;
    };

    const bindProperty = (property: unknown, kind: BindingKind): boolean => {
      const entry = asNode(property);
      if (entry?.type !== 'Property' || entry.key === undefined) return false;
      const nextKind = propertyKind(keyName({ computed: entry.computed === true, key: entry.key }), kind);
      return nextKind === null ? false : bindPattern(entry.value, nextKind);
    };

    /** Bind names while preserving assignment and nested object-pattern semantics. */
    const bindPattern = (pattern: unknown, kind: BindingKind): boolean => {
      const target = asNode(pattern);
      if (target === null) return false;
      if (target.type === 'AssignmentPattern') return bindPattern(target.left, kind);
      if (target.type === 'Identifier') {
        if (typeof target.name !== 'string' || typeof target.start !== 'number') return false;
        return addBinding(maps[kind], target.name, target.start);
      }
      if (target.type !== 'ObjectPattern' || !Array.isArray(target.properties) || kind === 'member') return false;
      return target.properties.reduce(
        (changed: boolean, property: unknown) => bindProperty(property, kind) || changed,
        false,
      );
    };

    const identifierKind = (node: Extract<ESTree.Node, { type: 'Identifier' }>): BindingKind | null => {
      if (resolvesTo(layerBindings, node)) return 'layer';
      if (resolvesTo(barrelBindings, node)) return 'barrel';
      return resolvesTo(memberBindings, node) ? 'member' : null;
    };

    const aliasKind = (init: ESTree.Node): BindingKind | null => {
      if (init.type === 'Identifier') return identifierKind(init);
      if (init.type !== 'MemberExpression') return null;
      const name = memberName(init);
      if (name === null) return null;
      const object = unwrapValue(init.object);
      if (object?.type !== 'Identifier') return null;
      if (name === LAYER_NAMESPACE && resolvesTo(barrelBindings, object)) return 'layer';
      if (options.members.includes(name) && resolvesTo(layerBindings, object)) return 'member';
      return null;
    };

    /** One pass; evaluate every declarator even after an earlier binding changed. */
    const propagateAliases = (): boolean => {
      let changed = false;
      for (const declarator of declarators) {
        const init = unwrapValue(declarator.init);
        if (init === null) continue;
        const kind = aliasKind(init);
        if (kind !== null) changed = bindPattern(declarator.id, kind) || changed;
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
        if (isIdentifierNamePosition(node)) return;
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
          if (isRoot && value.parent?.type === 'VariableDeclarator' && value.parent.init?.start === value.start)
            return false;
          const map =
            candidate.kind === 'layer' ? layerBindings : candidate.kind === 'barrel' ? barrelBindings : memberBindings;
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
            if (['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration'].includes(current.type))
              return 0;
            if (current.type === 'ExportNamedDeclaration' || current.type === 'ExportDefaultDeclaration') return 1;
            current = current.parent;
          }
          return 0;
        };
        found.sort(
          (left, right) =>
            exportedComposition(left) - exportedComposition(right) || applicationEnd(left) - applicationEnd(right),
        );

        const allowed = isRoot ? Math.min(options.maxPerRoot, found.length) : 0;
        const reportCount = found.length - allowed;
        for (let index = 0; index < reportCount; index += 1) {
          const entry = found[index];
          if (entry === undefined) continue;
          context.report({
            node: entry.node,
            messageId: isRoot ? 'beforeRoot' : 'outsideRoot',
            data: {
              member: entry.member,
              remaining: String(found.length - index - 1),
            },
          });
        }
      },
    };
  },
});
