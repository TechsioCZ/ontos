/**
 * Audit finding: **A1** — "Establish one process-level Layer and ManagedRuntime composition model"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`). A1 records that "some library layers internally
 * provide their own dependencies, hiding their true requirements and prompting `Layer.fresh`
 * workarounds", with `packages/core-runtime/src/reads/runtime.ts:746` as the evidence site.
 *
 * `Layer.fresh` defeats Layer memoization. A1 identifies its use as a workaround for hidden
 * dependencies; syntax alone cannot prove that motive. This is a project policy against fresh
 * acquisition by default, not a claim that every fresh acquisition is semantically wrong. Intentional
 * independent acquisitions require an explicit policy exception (`ignore` or a justified suppression).
 *
 * What is detected
 * - Every reference to `Layer.fresh`, whether called (`Layer.fresh(layer)`) or passed point-free
 *   (`Resolver.pipe(Layer.provide(ctx), Layer.fresh)`).
 * - Aliased imports (`import { Layer as L } from "effect"`), submodule namespace imports
 *   (`import * as Layer from "effect/Layer"`), root namespace imports (`import * as Effect from "effect"`
 *   then `Effect.Layer.fresh`), direct member imports (`import { fresh } from "effect/Layer"`),
 *   computed access (`Layer["fresh"]` and the template-literal key) and optional chaining (`Layer?.fresh`).
 * - Type-level wrappers around the namespace object, which erase nothing at runtime:
 *   `(Layer as typeof Layer).fresh`, `Layer!.fresh`, `(Layer satisfies typeof Layer).fresh`.
 * - Destructuring the namespace to hide the member access: `const { fresh } = Layer`,
 *   `const { fresh: freshAlias } = LayerNs` (the pattern property is reported once; the later call is
 *   not double-reported).
 * - Dynamic imports of the same modules: `const { Layer } = await import("effect")`,
 *   `const LayerNs = await import("effect/Layer")`.
 * - All paths, including tests, scripts and `.tsx`: the audit gives `Layer.fresh` no blessed form.
 *
 * What is deliberately allowed
 * - Anything that is not the `effect` `Layer` module: a local `const Layer = { fresh }` shadow, an
 *   unrelated `cache.fresh` / `{ fresh: true }` property, a `fresh` binding imported from elsewhere.
 * - TypeScript *member names* spelled `fresh` — `interface CacheEntry { fresh: boolean }`,
 *   `type CacheApi = { fresh(): void }`, enum members, abstract members. A property name in a type is
 *   not a value reference and cannot defeat Layer memoization.
 * - `Layer.orDie` at a deliberate startup root and every other D-tier / "existing patterns to preserve"
 *   shape — this rule looks at exactly one member name.
 * - Files matching the `ignore` path globs (default: none).
 *
 * Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings, effectMember } from '../shared/effect-imports.ts';
import { globToRegExp, normalisePath } from '../shared/paths.ts';

const LAYER_NAMESPACE = 'Layer';
const FRESH_MEMBER = 'fresh';
const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_MODULE = /^effect(?:\/.*)?$/u;
const EFFECT_LAYER_MODULE = /^effect\/(?:.*\/)?Layer$/u;
/** Cheap text probe so a file that only reaches `effect` through `import()` still arms the rule. */
const DYNAMIC_EFFECT_IMPORT = /\bimport\s*\(\s*["'`]effect(?:\/[^"'`]*)?["'`]/u;

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production defaults instead of forcing the
 * fixture config to pass loosened options (which `run-on-repo.mts` reuses against the real repo).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

/** No blessed `Layer.fresh` shape exists in the audit, so nothing is ignored by default. */
const DEFAULT_IGNORE: readonly string[] = [];

/** Wrappers that change types only: the runtime value on either side is identical. */
const TRANSPARENT_WRAPPERS = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

/**
 * Parent nodes in which an identifier is a *name*, not a reference: object/class members and every
 * TypeScript signature key. `interface CacheEntry { fresh: boolean }` is not `Layer.fresh`.
 */
const NAME_POSITION_PARENTS = new Set([
  'MemberExpression',
  'Property',
  'PropertyDefinition',
  'MethodDefinition',
  'AccessorProperty',
  'TSAbstractMethodDefinition',
  'TSAbstractPropertyDefinition',
  'TSPropertySignature',
  'TSMethodSignature',
  'TSIndexSignature',
  'TSEnumMember',
]);

interface RuleOptions {
  readonly ignore: readonly string[];
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
  return { ignore: stringArray(record.ignore, DEFAULT_IGNORE) };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Strip type-only / parenthetical wrappers to reach the expression that actually runs. */
function unwrap(node: ESTree.Node): ESTree.Node {
  let current = node;
  while (TRANSPARENT_WRAPPERS.has(current.type)) {
    const inner = (current as unknown as { expression?: ESTree.Node }).expression;
    if (inner === undefined || inner === null) break;
    current = inner;
  }
  return current;
}

/** Static string of a property key: `x.fresh`, `x["fresh"]`, and the no-substitution template key. */
function staticKey(node: ESTree.Node, computed: boolean): string | null {
  if (!computed) return node.type === 'Identifier' ? node.name : null;
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

function memberName(node: ESTree.MemberExpression): string | null {
  return staticKey(node.property as ESTree.Node, node.computed);
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

/** Locals bound by `import * as X from "effect"` — `X.Layer.fresh` must still be caught. */
function collectRootNamespaces(program: ESTree.Program): Set<string> {
  const locals = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (statement.source.value !== EFFECT_ROOT_MODULE) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') locals.add(specifier.local.name);
    }
  }
  return locals;
}

/** Locals bound by `import { fresh as freshLayer } from "effect/Layer"` — bare references must be caught. */
function collectDirectMemberImports(program: ESTree.Program): Set<string> {
  const locals = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (!EFFECT_LAYER_MODULE.test(statement.source.value)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported =
        specifier.imported.type === 'Identifier'
          ? specifier.imported.name
          : specifier.imported.value;
      if (imported === FRESH_MEMBER) locals.add(specifier.local.name);
    }
  }
  return locals;
}

/** `await import("effect/Layer")` / `import("effect")` → the module specifier, else `null`. */
function dynamicEffectModule(node: ESTree.Node): string | null {
  let current = unwrap(node);
  if (current.type === 'AwaitExpression') current = unwrap(current.argument as ESTree.Node);
  if (current.type !== 'ImportExpression') return null;
  const source = current.source as ESTree.Node;
  if (source.type !== 'Literal' || typeof source.value !== 'string') return null;
  return EFFECT_MODULE.test(source.value) ? source.value : null;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A1: disallow `Layer.fresh`. It defeats Layer memoization to work around a layer that ' +
        'provides its own dependencies; make the layer dependency-transparent and compose it once at the ' +
        'application root instead.',
    },
    messages: {
      layerFresh:
        '`Layer.fresh` bypasses Layer memoization (audit A1: ' +
        '`packages/core-runtime/src/reads/runtime.ts:746`). Keep the Live layer dependency-transparent — let ' +
        'its requirements propagate instead of providing them inside — and compose the graph once at the ' +
        'application root when fresh acquisition compensates for hidden dependencies. Intentional independent ' +
        'acquisition needs a justified policy exception; this syntax-only rule cannot infer that intent.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          ignore: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ ignore: [...DEFAULT_IGNORE] }],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore)) return {};

    const program = context.sourceCode.ast;
    const bindings = collectEffectBindings(program);
    const rootNamespaces = collectRootNamespaces(program);
    const directMembers = collectDirectMemberImports(program);
    const hasDynamicImport = DYNAMIC_EFFECT_IMPORT.test(context.sourceCode.text);
    if (
      !bindings.importsEffect &&
      rootNamespaces.size === 0 &&
      directMembers.size === 0 &&
      !hasDynamicImport
    ) {
      return {};
    }

    /** Locals that hold the effect `Layer` module object (static imports plus `await import(...)`). */
    const layerLocals = new Set<string>();
    for (const [local, namespace] of bindings.namespaces) {
      if (namespace === LAYER_NAMESPACE) layerLocals.add(local);
    }
    /** Locals introduced by a dynamic `import("effect...")`; their def is a `Variable`, not an import. */
    const dynamicLocals = new Set<number>();
    const typeOnlyLocals = new Set<string>();
    for (const statement of program.body) {
      if (statement.type !== 'ImportDeclaration') continue;
      for (const specifier of statement.specifiers) {
        if (
          statement.importKind === 'type' ||
          (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type')
        ) {
          typeOnlyLocals.add(specifier.local.name);
        }
      }
    }
    const isTypePosition = (node: ESTree.Node): boolean => {
      const parent = node.parent;
      return (
        parent != null && parent.type.startsWith('TS') && !TRANSPARENT_WRAPPERS.has(parent.type)
      );
    };

    const report = (node: ESTree.Node): void => {
      context.report({ node, messageId: 'layerFresh' });
    };

    /**
     * `true` when the identifier still resolves to the module binding. Unresolved names fall back to
     * `true` because the import declaration already proved the binding exists; only a local shadow
     * (parameter, `const`, catch clause, class name, …) rejects the match.
     */
    const resolvesToModuleBinding = (
      identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
    ): boolean => {
      if (typeOnlyLocals.has(identifier.name)) return false;
      const variable = lookupVariable(context, identifier);
      if (variable === null || variable.defs.length === 0) return true;
      if (variable.defs.some((definition) => definition.type === 'ImportBinding')) return true;
      return variable.defs.some((definition) => dynamicLocals.has(definition.name.start));
    };

    /** `Layer` / `L` / `LayerNs`, including through type-only wrappers. */
    const isLayerNamespace = (node: ESTree.Node): boolean => {
      const object = unwrap(node);
      if (object.type !== 'Identifier') return false;
      if (!layerLocals.has(object.name)) return false;
      return resolvesToModuleBinding(object);
    };

    /** `EffectNs.Layer` — the `Layer` member of a root `import * as EffectNs from "effect"`. */
    const isRootLayerMember = (node: ESTree.Node): boolean => {
      const object = unwrap(node);
      if (object.type !== 'MemberExpression') return false;
      if (memberName(object) !== LAYER_NAMESPACE) return false;
      const root = unwrap(object.object as ESTree.Node);
      if (root.type !== 'Identifier') return false;
      if (!rootNamespaces.has(root.name)) return false;
      return resolvesToModuleBinding(root);
    };

    const isLayerModuleExpression = (node: ESTree.Node): boolean =>
      isLayerNamespace(node) || isRootLayerMember(node);

    /** `const { fresh } = Layer` / `const { fresh: alias } = EffectNs.Layer` — report the binding site. */
    const reportFreshPatternProperties = (
      pattern: Extract<ESTree.Node, { type: 'ObjectPattern' }>,
    ): void => {
      for (const property of pattern.properties) {
        if (property.type !== 'Property') continue;
        if (staticKey(property.key as ESTree.Node, property.computed === true) !== FRESH_MEMBER)
          continue;
        report(property as unknown as ESTree.Node);
      }
    };

    /** Record what a `const … = await import("effect…")` binds, and report direct `fresh` grabs. */
    const handleDynamicImport = (id: ESTree.Node, source: string): void => {
      const isLayerModule = EFFECT_LAYER_MODULE.test(source);
      if (id.type === 'Identifier') {
        if (isLayerModule) layerLocals.add(id.name);
        else if (source === EFFECT_ROOT_MODULE) rootNamespaces.add(id.name);
        else return;
        dynamicLocals.add(id.start);
        return;
      }
      if (id.type !== 'ObjectPattern') return;
      if (isLayerModule) {
        reportFreshPatternProperties(id);
        return;
      }
      if (source !== EFFECT_ROOT_MODULE) return;
      for (const property of id.properties) {
        if (property.type !== 'Property') continue;
        if (staticKey(property.key as ESTree.Node, property.computed === true) !== LAYER_NAMESPACE)
          continue;
        const value = property.value as ESTree.Node;
        if (value.type === 'Identifier') {
          layerLocals.add(value.name);
          dynamicLocals.add(value.start);
        } else if (value.type === 'ObjectPattern') {
          reportFreshPatternProperties(value);
        }
      }
    };

    return {
      VariableDeclarator(node) {
        const init = node.init as ESTree.Node | null | undefined;
        if (init === null || init === undefined) return;
        const dynamicSource = dynamicEffectModule(init);
        if (dynamicSource !== null) {
          handleDynamicImport(node.id as ESTree.Node, dynamicSource);
          return;
        }
        if (node.id.type !== 'ObjectPattern') return;
        if (!isLayerModuleExpression(init)) return;
        reportFreshPatternProperties(node.id);
      },
      MemberExpression(node) {
        if (isTypePosition(node)) return;
        // Fast path via the shared matcher: plain, non-computed `Layer.fresh`.
        const shared = effectMember(node, bindings);
        if (shared !== null) {
          if (shared.namespace !== LAYER_NAMESPACE || shared.member !== FRESH_MEMBER) return;
          if (resolvesToModuleBinding(node.object as Extract<ESTree.Node, { type: 'Identifier' }>))
            report(node);
          return;
        }
        // Computed, wrapped and root-namespace forms.
        if (memberName(node) !== FRESH_MEMBER) return;
        if (isLayerModuleExpression(node.object as ESTree.Node)) report(node);
      },
      Identifier(node) {
        if (isTypePosition(node)) return;
        if (directMembers.size === 0 || !directMembers.has(node.name)) return;
        const parent = node.parent;
        if (parent === null || parent === undefined) return;
        // Declaration sites: `import { fresh }`, `export { fresh }`.
        if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier') return;
        if (parent.type === 'ImportNamespaceSpecifier' || parent.type === 'ExportSpecifier') return;
        // Name positions: object/class members and TypeScript signature keys are not references.
        const holder = parent as unknown as {
          key?: ESTree.Node;
          property?: ESTree.Node;
          computed?: boolean;
        };
        const isKey = holder.key === node || holder.property === node;
        if (NAME_POSITION_PARENTS.has(parent.type) && isKey && holder.computed !== true) return;
        if (!resolvesToModuleBinding(node)) return;
        report(node);
      },
    };
  },
});
