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
import type { Context, ESTree } from '@oxlint/plugins';

import {
  EXPRESSION_WRAPPERS as TRANSPARENT_WRAPPERS,
  unwrapNode as unwrap,
  staticString,
} from '../shared/ast.ts';
import { lookupVariable } from '../shared/bindings.ts';
import {
  collectEffectBindings,
  effectMember,
} from '../shared/effect-imports.ts';
import {
  collectRootNamespaces,
  collectNamedImports,
} from '../shared/imports.ts';
import { optionRecord } from '../shared/options.ts';
import { stringArray } from '../shared/options.ts';
import { matchesGlobs, scopePath } from '../shared/paths.ts';

const LAYER_NAMESPACE = 'Layer';
const FRESH_MEMBER = 'fresh';
const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_MODULE = /^effect(?:\/.*)?$/u;
const EFFECT_LAYER_MODULE = /^effect\/(?:.*\/)?Layer$/u;
/** Cheap text probe so a file that only reaches `effect` through `import()` still arms the rule. */
const DYNAMIC_EFFECT_IMPORT = /\bimport\s*\(\s*["'`]effect(?:\/[^"'`]*)?["'`]/u;

/** No blessed `Layer.fresh` shape exists in the audit, so nothing is ignored by default. */
const DEFAULT_IGNORE: readonly string[] = [];

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

function readOptions(context: Context): RuleOptions {
  const record = optionRecord(context.options?.[0]);
  return { ignore: stringArray(record.ignore, DEFAULT_IGNORE) };
}

/** Static string of a property key: `x.fresh`, `x["fresh"]`, and the no-substitution template key. */
function staticKey(node: ESTree.Node, computed: boolean): string | null {
  if (!computed) return node.type === 'Identifier' ? node.name : null;
  return staticString(node, {
    templates: true,
    singleQuasi: true,
    rawTemplates: false,
  });
}

function memberName(node: ESTree.MemberExpression): string | null {
  return staticKey(node.property as ESTree.Node, node.computed);
}

function collectTypeOnlyLocals(program: ESTree.Program): Set<string> {
  const locals = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    for (const specifier of statement.specifiers) {
      if (
        statement.importKind === 'type' ||
        (specifier.type === 'ImportSpecifier' &&
          specifier.importKind === 'type')
      ) {
        locals.add(specifier.local.name);
      }
    }
  }
  return locals;
}

const IMPORT_EXPORT_POSITIONS = new Set([
  'ImportSpecifier',
  'ImportDefaultSpecifier',
  'ImportNamespaceSpecifier',
  'ExportSpecifier',
]);

function isNamePosition(node: ESTree.Node): boolean {
  const parent = node.parent;
  if (parent == null) return true;
  if (IMPORT_EXPORT_POSITIONS.has(parent.type)) return true;
  const holder = parent as unknown as {
    key?: ESTree.Node;
    property?: ESTree.Node;
    computed?: boolean;
  };
  const isKey = holder.key === node || holder.property === node;
  return (
    NAME_POSITION_PARENTS.has(parent.type) && isKey && holder.computed !== true
  );
}

/** `await import("effect/Layer")` / `import("effect")` → the module specifier, else `null`. */
function dynamicEffectModule(node: ESTree.Node): string | null {
  let current = unwrap(node);
  if (current.type === 'AwaitExpression')
    current = unwrap(current.argument as ESTree.Node);
  if (current.type !== 'ImportExpression') return null;
  const source = current.source as ESTree.Node;
  if (source.type !== 'Literal' || typeof source.value !== 'string')
    return null;
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
    const directMembers = collectNamedImports(
      program,
      (source) => EFFECT_LAYER_MODULE.test(source),
      new Set([FRESH_MEMBER])
    );
    const hasDynamicImport = DYNAMIC_EFFECT_IMPORT.test(
      context.sourceCode.text
    );
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
    const typeOnlyLocals = collectTypeOnlyLocals(program);
    const isTypePosition = (node: ESTree.Node): boolean => {
      const parent = node.parent;
      return (
        parent != null &&
        parent.type.startsWith('TS') &&
        !TRANSPARENT_WRAPPERS.has(parent.type)
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
      identifier: Extract<ESTree.Node, { type: 'Identifier' }>
    ): boolean => {
      if (typeOnlyLocals.has(identifier.name)) return false;
      const variable = lookupVariable(context, identifier);
      if (variable === null || variable.defs.length === 0) return true;
      if (
        variable.defs.some((definition) => definition.type === 'ImportBinding')
      )
        return true;
      return variable.defs.some((definition) =>
        dynamicLocals.has(definition.name.start)
      );
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
      pattern: Extract<ESTree.Node, { type: 'ObjectPattern' }>
    ): void => {
      for (const property of pattern.properties) {
        if (property.type !== 'Property') continue;
        if (
          staticKey(property.key as ESTree.Node, property.computed === true) !==
          FRESH_MEMBER
        )
          continue;
        report(property as unknown as ESTree.Node);
      }
    };

    const handleRootPattern = (
      pattern: Extract<ESTree.Node, { type: 'ObjectPattern' }>
    ): void => {
      for (const property of pattern.properties) {
        if (property.type !== 'Property') continue;
        if (
          staticKey(property.key as ESTree.Node, property.computed === true) !==
          LAYER_NAMESPACE
        )
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
      handleRootPattern(id);
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
          if (
            shared.namespace !== LAYER_NAMESPACE ||
            shared.member !== FRESH_MEMBER
          )
            return;
          if (
            resolvesToModuleBinding(
              node.object as Extract<ESTree.Node, { type: 'Identifier' }>
            )
          )
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
        if (isNamePosition(node)) return;
        if (!resolvesToModuleBinding(node)) return;
        report(node);
      },
    };
  },
});
