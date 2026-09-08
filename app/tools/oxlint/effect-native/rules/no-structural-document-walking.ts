/**
 * effect-native/no-structural-document-walking
 *
 * Audit findings: **A7** — "Give topology, composition, and authorization evidence shared Schemas"
 * ("Authoritative topology and authorization documents are decoded using combinations of
 * `JSON.parse`, `Schema.Json`, optional interfaces, **structural walking**, **exact-key
 * comparisons**, and casts") and **A2** — "Make Schema the sole authority for contracts and domain
 * models" ("Move refinements and cross-field rules into the owning Schema"; "removal of manual
 * guards") — `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`.
 *
 * The repository decodes authoritative documents — reference topology, deployment allowlists,
 * installed-vertical manifests, module contracts, authorization rollout evidence — into
 * `Schema.Json` / `unknown` and then *walks* them by hand:
 * `Predicate.isObjectKeyword(value) && value !== null && !Array.isArray(value)` object guards,
 * `Array.isArray(topology['verticals'])` string-keyed probes, `'ontosLifecycle' in decoded`
 * membership tests, `Object.hasOwn(topology, field)` field presence, and
 * `Object.keys(record).toSorted().join('\0') !== [...exactKeys].toSorted().join('\0')` exact-key
 * joins or `JSON.stringify(a) === JSON.stringify(b)` structural comparisons. Every one of those is a
 * second, undeclared authority over a document shape: the key set, the vocabulary, the excess-property
 * policy and the failure vocabulary live in an if-ladder instead of in a Schema that build scripts,
 * the runtime and the tests can all share.
 *
 * ## What this detects
 *
 * 1. **Object-shape guards** — the outermost `LogicalExpression` that combines an object guard
 *    (`typeof X === 'object'`, `Predicate.isObjectKeyword(X)`, `Predicate.isRecord(X)`,
 *    `Predicate.isObject(X)`) with `Array.isArray(X)` on the *same* expression. Reported once, on the
 *    whole condition, because the ladder as a whole is the hand-rolled `Schema.Struct` guard.
 * 2. **Field probes on a document** — `Array.isArray(M)`, `Predicate.isString|isNumber|isBoolean(M)`
 *    and `typeof M === '…'` where `M` reaches a field either through a computed string key
 *    (`topology['verticals']`, `entry['kind']`) or through a static key on an identifier named like a
 *    decoded document (`documentIdentifiers`, default `record|raw|decoded|parsed|value|entry|input|
 *    object|json|document|payload`).
 * 3. **Key-membership tests** — `'field' in value`, `Object.hasOwn(value, 'field')`,
 *    `value.hasOwnProperty('field')` and `Object.prototype.hasOwnProperty.call(value, 'field')`.
 * 4. **Exact-key and serialized comparisons** — `Object.keys(x).toSorted()/sort().join(…)` (the join
 *    is reported) and a `BinaryExpression` comparing two `JSON.stringify(…)` calls.
 *
 * Effect namespaces are resolved through the file's real import bindings
 * (`shared/effect-imports.ts`), so `import * as P from 'effect/Predicate'` and
 * `import { isRecord } from 'effect/Predicate'` are recognised, while a local object literal named
 * `Predicate` is not. `Array.isArray`, `Object.keys`, `Object.hasOwn` and `JSON.stringify` are only
 * recognised when the global is unshadowed (`context.sourceCode.getScope`).
 *
 * ## What is deliberately allowed
 *
 * - **`packages/core-runtime/src/actions/repository.ts`** (`allowPaths` default) — the audit's
 *   "Existing patterns to preserve" section blesses "`Array.isArray` in recursive JSON
 *   normalization"; that normalizer is the one place a document genuinely has no static shape.
 * - **Tests** (`ignoreTestFiles: true`) — assertion-side `Object.hasOwn(result, 'secret') === false`
 *   and `'field' in value` probes are the D-tier "deliberately malformed / shape-proving" tests.
 * - **Discriminant and driver-failure keys** (`allowInKeys`) — `'_tag' in error` belongs to
 *   `no-manual-tag-comparison`, and `'cause' | 'code' | 'constraint' | 'detail' | 'sqlState' |
 *   'errno' | 'syscall' | 'routine' | 'schema' | 'table' | 'column'` belong to the driver-failure
 *   rule; reporting them here would double-report the same span.
 * - **Guards on a plain local value** — `Array.isArray(items)`, `Predicate.isString(id)`: nothing
 *   says those came out of a decoded document, and the audit does not ask for `Schema` around every
 *   local branch.
 * - **A lone object guard** — `typeof x === 'object' && x !== null` without an `Array.isArray` arm is
 *   ordinary nullability narrowing, not document walking.
 * - **`Object.hasOwn(map, dynamicKey)`** — a registry lookup with a computed key is a dictionary
 *   access, not a hand-written key set.
 * - Anything outside `includePaths` (`tools/**`, `dist/**`, generated bundles).
 *
 * Static limitations: receiver names are configurable candidate-document heuristics, not provenance
 * or type proof. Nested dot/computed fields share the same receiver test. Membership and equality
 * checks on unrelated receivers are excluded; arbitrary canonicalizer calls are not presumed to
 * return documents. Recursive array/Object.values traversals permit generic object-kind probes,
 * not field vocabulary validation. Opaque aliases and cross-file document provenance are not tracked.
 *
 * Report-only: no fixers, no suggestions.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Variable } from '@oxlint/plugins';

import {
  parentOf,
  unwrapNode as unwrap,
  staticString,
  nearestFunction,
  walk,
} from '../shared/ast.ts';
import { resolveVariable } from '../shared/bindings.ts';
import { importedName } from '../shared/imports.ts';
import { stringList } from '../shared/options.ts';
import { isTestFile, matchesAny, workspacePath } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

const DEFAULT_INCLUDE_PATHS: readonly string[] = [
  'apps/**',
  'verticals/**',
  'packages/**',
  'scripts/**',
  '**/*.config.{ts,mts,cts}',
];

/** Audit "Existing patterns to preserve": `Array.isArray` in recursive JSON normalization. */
const DEFAULT_ALLOW_PATHS: readonly string[] = ['packages/core-runtime/src/actions/repository.ts'];

/**
 * Keys owned by sibling rules: `_tag` by `no-manual-tag-comparison`, the driver-failure vocabulary by
 * `no-driver-failure-inspection`. Excluded so one span never earns two diagnostics.
 */
const DEFAULT_ALLOW_IN_KEYS: readonly string[] = [
  '_tag',
  'cause',
  'code',
  'constraint',
  'detail',
  'sqlState',
  'errno',
  'syscall',
  'routine',
  'schema',
  'table',
  'column',
];

const DEFAULT_DOCUMENT_IDENTIFIERS =
  '^(record|raw|decoded|parsed|value|entry|input|object|json|document|payload|topology|evidence|manifest|allowlist|overlay|ownership)$';

/** Globals that can be reached indirectly (`globalThis.Array.isArray`). */
const CONTAINER_GLOBALS = new Set(['globalThis', 'global', 'window', 'self']);

/** Wrappers that never change what an expression denotes. */
const TRANSPARENT_PARENTS = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

const EQUALITY_OPERATORS = new Set(['===', '!==', '==', '!=']);

/** `Predicate.*` guards that assert "this is an object bag" — the hand-rolled `Schema.Struct` test. */
const OBJECT_GUARDS = new Set(['isObjectKeyword', 'isRecord', 'isObject']);

/** `Predicate.*` guards applied to a single decoded field — the hand-rolled field Schema. */
const FIELD_GUARDS = new Set(['isString', 'isNumber', 'isBoolean']);

/** Sorting methods that turn a key set into a comparable string. */
const SORT_METHODS = new Set(['sort', 'toSorted']);

const MAX_TEXT_LENGTH = 72;

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly ignoreTestFiles: boolean;
  readonly includePaths: readonly string[];
  readonly documentIdentifiers: string;
  readonly allowInKeys: readonly string[];
}

const DEFAULTS: RuleOptions = {
  allowPaths: [...DEFAULT_ALLOW_PATHS],
  ignoreTestFiles: true,
  includePaths: [...DEFAULT_INCLUDE_PATHS],
  documentIdentifiers: DEFAULT_DOCUMENT_IDENTIFIERS,
  allowInKeys: [...DEFAULT_ALLOW_IN_KEYS],
};

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Partial<Record<keyof RuleOptions, unknown>>;
  const includePaths = stringList(given.includePaths, DEFAULTS.includePaths);
  return {
    allowPaths: stringList(given.allowPaths, DEFAULTS.allowPaths),
    ignoreTestFiles:
      typeof given.ignoreTestFiles === 'boolean' ? given.ignoreTestFiles : DEFAULTS.ignoreTestFiles,
    includePaths: includePaths.length > 0 ? includePaths : DEFAULTS.includePaths,
    documentIdentifiers:
      typeof given.documentIdentifiers === 'string' && given.documentIdentifiers.length > 0
        ? given.documentIdentifiers
        : DEFAULTS.documentIdentifiers,
    allowInKeys: stringList(given.allowInKeys, DEFAULTS.allowInKeys),
  };
}

function compilePattern(source: string): RegExp {
  try {
    return new RegExp(source, 'u');
  } catch {
    return new RegExp(DEFAULT_DOCUMENT_IDENTIFIERS, 'u');
  }
}

function spanOf(node: AnyNode): { readonly start: number; readonly end: number } {
  return node as unknown as { readonly start: number; readonly end: number };
}

function asStringLiteral(node: AnyNode): string | null {
  return staticString(node, { unwrap: {}, templates: true, rawTemplates: true });
}

/** `x.y` / `x["y"]` → `"y"`; a dynamic key → `null`. */
function staticPropertyName(node: ESTree.MemberExpression): string | null {
  const property = node.property as AnyNode;
  if (!node.computed)
    return property.type === 'Identifier' ? (property as ESTree.IdentifierName).name : null;
  return asStringLiteral(property);
}

/** `true` when `node` is the unshadowed global `name`. */
function isUnshadowedGlobal(context: Context, node: AnyNode, name: string): boolean {
  if (node.type !== 'Identifier') return false;
  if ((node as ESTree.IdentifierReference).name !== name) return false;
  const variable = resolveVariable(context, name, node);
  return (
    variable === null ||
    variable.defs.every((definition) => {
      const def = definition as unknown as {
        type: string;
        node?: { importKind?: string };
        parent?: { importKind?: string };
      };
      return (
        def.type === 'Type' ||
        (def.type === 'ImportBinding' &&
          (def.node?.importKind === 'type' || def.parent?.importKind === 'type'))
      );
    })
  );
}

function typeofComparison(
  binary: ESTree.BinaryExpression,
): { argument: AnyNode; other: AnyNode } | null {
  const left = unwrap(binary.left);
  const right = unwrap(binary.right);
  if (left.type === 'UnaryExpression' && left.operator === 'typeof')
    return { argument: unwrap(left.argument), other: right };
  if (right.type === 'UnaryExpression' && right.operator === 'typeof')
    return { argument: unwrap(right.argument), other: left };
  return null;
}

/**
 * Effect-native rule: a document's shape, key set and vocabulary belong to a Schema, never to an
 * if-ladder walking the decoded value.
 */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        "Audit A7/A2: topology, allowlist, manifest and authorization-evidence documents are validated by structural walking — object guards plus `Array.isArray`, string-keyed field probes, `'x' in decoded` membership tests, `Object.hasOwn` field checks, exact-key joins and `JSON.stringify` comparisons — instead of by a shared `Schema.Struct`/`Schema.Union` decoded with `onExcessProperty: 'error'`.",
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#a7-give-topology-composition-and-authorization-evidence-shared-schemas',
    },
    messages: {
      structuralObjectGuard:
        "Audit A7/A2: `{{expression}}` hand-rolls the object-shape check for a decoded document (an object guard plus an `Array.isArray` arm). Declare the document as a shared `Schema.Struct`/`Schema.Union` and decode it with `Schema.decodeUnknownEffect(Document, { onExcessProperty: 'error' })` — the struct already rejects arrays, primitives and `null`, and it fails with a typed `ParseError` instead of a hand-thrown `TypeError`.",
      documentFieldGuard:
        "Audit A7/A2: `{{expression}}` probes a decoded document's field by hand, so the field's type, optionality and vocabulary live here instead of in the contract. Put the field in the owning `Schema.Struct` (`Schema.Array(Vertical)`, `Schema.Literal('vertical')`, a branded id Schema) and decode once with `Schema.decodeUnknownEffect(Document, { onExcessProperty: 'error' })`.",
      documentKeyProbe:
        "Audit A7/A2: `{{expression}}` tests key membership on a decoded document, making the key set an undeclared, drifting authority. Declare the key in the shared `Schema.Struct` (optional fields via `Schema.optional`, closed shapes via `onExcessProperty: 'error'`) and branch on the decoded value — `Schema.decodeUnknownEffect`, `Match`, or `Option` for a genuinely optional field.",
      exactKeyJoin:
        "Audit A7/A2: `{{expression}}` compares a document's key set as a sorted joined string — an exact-key comparison that no contract owns and that silently accepts a renamed key. Decode through the shared `Schema.Struct` with `onExcessProperty: 'error'`: excess and missing keys then fail as a typed `ParseError` naming the offending path.",
      serializedComparison:
        'Audit A7/A2: `{{expression}}` compares document-like operands using serialized text. This rule cannot prove canonicalization or equivalence semantics. Decode both sides through the shared Schema and compare with `Equal.equals` or a Schema-derived `Equivalence`.',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowPaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs allowed to walk documents structurally (default: the recursive JSON normalizer the audit blesses, `packages/core-runtime/src/actions/repository.ts`).',
          },
          ignoreTestFiles: {
            type: 'boolean',
            description:
              "Skip test files (default: true — shape-proving assertions such as `Object.hasOwn(result, 'secret') === false` are D tier).",
          },
          includePaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs the rule applies to (default: apps/**, verticals/**, packages/**, scripts/** and `*.config.*` files).',
          },
          documentIdentifiers: {
            type: 'string',
            description:
              'Regular expression matching receiver names that denote a decoded document, used for static-key field probes (default: `^(record|raw|decoded|parsed|value|entry|input|object|json|document|payload|topology|evidence|manifest|allowlist|ownership|overlay)$`).',
          },
          allowInKeys: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Literal keys exempt from the `in` / `Object.hasOwn` membership check because a sibling rule owns them (default: `_tag` plus the driver-failure vocabulary).',
          },
        },
      },
    ],
    defaultOptions: [
      {
        allowPaths: [...DEFAULT_ALLOW_PATHS],
        ignoreTestFiles: true,
        includePaths: [...DEFAULT_INCLUDE_PATHS],
        documentIdentifiers: DEFAULT_DOCUMENT_IDENTIFIERS,
        allowInKeys: [...DEFAULT_ALLOW_IN_KEYS],
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    const path = workspacePath(context.filename);
    if (!matchesAny(path, options.includePaths)) return {};
    if (matchesAny(path, options.allowPaths)) return {};
    if (options.ignoreTestFiles && isTestFile(path)) return {};

    const documentIdentifier = compilePattern(options.documentIdentifiers);
    const allowedKeys = new Set(options.allowInKeys);
    /** Spans already reported as a whole object-shape guard; nested field probes stay silent there. */
    const guardedSpans: Array<{ readonly start: number; readonly end: number }> = [];

    const printed = (node: AnyNode): string => {
      const text = context.sourceCode.getText(node).replace(/\s+/gu, ' ').trim();
      if (text.length === 0) return '…';
      return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
    };

    const report = (node: AnyNode, messageId: string): void => {
      context.report({ node, messageId, data: { expression: printed(node) } });
    };

    const insideReportedGuard = (node: AnyNode): boolean => {
      const span = spanOf(node);
      return guardedSpans.some((guard) => span.start >= guard.start && span.end <= guard.end);
    };

    /** `true` when this expression is the ambient `name` global (`Array`, `Object`, `JSON`). */
    const isGlobalHost = (node: AnyNode, name: string): boolean => {
      const inner = unwrap(node);
      if (inner.type === 'Identifier') return isUnshadowedGlobal(context, inner, name);
      if (inner.type !== 'MemberExpression') return false;
      const member = inner as ESTree.MemberExpression;
      if (staticPropertyName(member) !== name) return false;
      const container = unwrap(member.object as AnyNode);
      if (container.type !== 'Identifier') return false;
      const containerName = (container as ESTree.IdentifierReference).name;
      return (
        CONTAINER_GLOBALS.has(containerName) &&
        isUnshadowedGlobal(context, container, containerName)
      );
    };

    /** `Array.isArray` / `Object.keys` / `JSON.stringify` — the global namespace method itself. */
    const isGlobalMethod = (callee: AnyNode, host: string, method: string): boolean => {
      const inner = unwrap(callee);
      if (inner.type !== 'MemberExpression') return false;
      const member = inner as ESTree.MemberExpression;
      if (staticPropertyName(member) !== method) return false;
      return isGlobalHost(member.object as AnyNode, host);
    };

    /**
     * `Predicate.isRecord(x)` / `P.isObjectKeyword(x)` / bare `isRecord(x)` → the guard name.
     * Effect namespaces resolve through the file's import bindings; the conventional name
     * `Predicate` is accepted when it is an import (a re-export barrel this rule cannot follow),
     * never when it is a local object literal.
     */
    const namedPredicateIdentity = (
      source: string,
      imported: string,
      submodule: boolean,
    ): string | null => {
      if (submodule) return imported;
      return source === 'effect' && imported === 'Predicate' ? '@predicate' : null;
    };
    const importPredicateIdentity = (def: Variable['defs'][number]): string | null => {
      if (
        def.type !== 'ImportBinding' ||
        def.parent?.type !== 'ImportDeclaration' ||
        def.parent.importKind === 'type'
      )
        return null;
      const source = def.parent.source.value;
      const submodule = /^effect\/(?:.*\/)?Predicate$/u.test(source);
      if (def.node.type === 'ImportNamespaceSpecifier') return submodule ? '@predicate' : null;
      if (def.node.type !== 'ImportSpecifier' || def.node.importKind === 'type') return null;
      return namedPredicateIdentity(source, importedName(def.node), submodule);
    };
    const constantInitializer = (def: Variable['defs'][number]): AnyNode | null => {
      if (def.type !== 'Variable' || def.node.type !== 'VariableDeclarator') return null;
      if (def.node.id.type !== 'Identifier' || def.node.parent?.type !== 'VariableDeclaration')
        return null;
      return def.node.parent.kind === 'const' ? def.node.init : null;
    };
    const predicateIdentity = (input: AnyNode, depth = 0): string | null => {
      if (depth > 12) return null;
      const node = unwrap(input);
      if (node.type === 'MemberExpression')
        return predicateIdentity(node.object, depth + 1) === '@predicate'
          ? staticPropertyName(node)
          : null;
      if (node.type !== 'Identifier') return null;
      const variable = resolveVariable(context, node.name, node);
      for (const def of variable?.defs ?? []) {
        const imported = importPredicateIdentity(def);
        if (imported !== null) return imported;
        const initializer = constantInitializer(def);
        if (initializer) return predicateIdentity(initializer, depth + 1);
      }
      return null;
    };
    const predicateGuardName = (callee: AnyNode): string | null => predicateIdentity(callee);

    /** The single argument of a one-argument call, unwrapped. */
    const soleArgument = (node: ESTree.CallExpression): AnyNode | null => {
      const [first] = node.arguments;
      if (first === undefined || node.arguments.length !== 1) return null;
      if (first.type === 'SpreadElement') return null;
      return unwrap(first as AnyNode);
    };

    /** `Array.isArray(X)` → the guarded expression. */
    const arrayGuardArgument = (node: AnyNode): AnyNode | null => {
      const call = unwrap(node);
      if (call.type !== 'CallExpression') return null;
      const expression = call as ESTree.CallExpression;
      if (!isGlobalMethod(expression.callee as AnyNode, 'Array', 'isArray')) return null;
      return soleArgument(expression);
    };

    /** `typeof X === 'object'` / `Predicate.isRecord(X)` → the guarded expression. */
    const objectGuardArgument = (node: AnyNode): AnyNode | null => {
      const expression = unwrap(node);
      if (expression.type === 'BinaryExpression') {
        const binary = expression as ESTree.BinaryExpression;
        if (!EQUALITY_OPERATORS.has(binary.operator)) return null;
        const comparison = typeofComparison(binary);
        if (!comparison || asStringLiteral(comparison.other) !== 'object') return null;
        return comparison.argument;
      }
      if (expression.type !== 'CallExpression') return null;
      const call = expression as ESTree.CallExpression;
      const guard = predicateGuardName(call.callee as AnyNode);
      if (guard === null || !OBJECT_GUARDS.has(guard)) return null;
      return soleArgument(call);
    };

    /** Flatten `&&` / `||` / `!` into the leaf tests the condition is made of. */
    const logicalLeaves = (node: AnyNode, into: AnyNode[]): void => {
      const expression = unwrap(node);
      if (expression.type === 'LogicalExpression') {
        const logical = expression as ESTree.LogicalExpression;
        logicalLeaves(logical.left as AnyNode, into);
        logicalLeaves(logical.right as AnyNode, into);
        return;
      }
      if (
        expression.type === 'UnaryExpression' &&
        (expression as ESTree.UnaryExpression).operator === '!'
      ) {
        logicalLeaves((expression as ESTree.UnaryExpression).argument as AnyNode, into);
        return;
      }
      into.push(expression);
    };

    /** `true` when no enclosing `&&`/`||`/`!` chain contains this logical expression. */
    const isOutermostLogical = (node: AnyNode): boolean => {
      let current = node;
      let parent = parentOf(current);
      for (;;) {
        if (parent === null) return true;
        if (parent.type === 'LogicalExpression') return false;
        const negation =
          parent.type === 'UnaryExpression' && (parent as ESTree.UnaryExpression).operator === '!';
        if (negation || TRANSPARENT_PARENTS.has(parent.type)) {
          current = parent;
          parent = parentOf(current);
          continue;
        }
        return true;
      }
    };

    /** Source text used to decide "the same X" across guard arms. */
    const targetKey = (node: AnyNode): string =>
      context.sourceCode.getText(node).replace(/\s+/gu, ' ').trim();

    /**
     * A member access that reads a field out of a decoded document: a computed string key
     * (`topology['verticals']`) or a static key on a document-named receiver (`decoded.kind`).
     */
    const documentRoot = (input: AnyNode): AnyNode => {
      let node = unwrap(input);
      while (node.type === 'MemberExpression' && staticPropertyName(node) !== null)
        node = unwrap(node.object);
      return node;
    };
    // Receiver hints constrain membership/equality checks too. A DOM Event, service or driver
    // failure is not a decoded document merely because it is probed with a literal key.
    const isDocumentReceiver = (input: AnyNode): boolean => {
      const root = documentRoot(input);
      if (root.type === 'MemberExpression' && root.object.type === 'ThisExpression') {
        const key = root.property;
        return (
          (key.type === 'PrivateIdentifier' || key.type === 'Identifier') &&
          documentIdentifier.test(key.name)
        );
      }
      if (root.type === 'ThisExpression') {
        const member = unwrap(input);
        return (
          member.type === 'MemberExpression' &&
          documentIdentifier.test(staticPropertyName(member) ?? '')
        );
      }
      return root.type === 'Identifier' && documentIdentifier.test(root.name);
    };
    const isDocumentField = (node: AnyNode): boolean => {
      const expression = unwrap(node);
      return (
        expression.type === 'MemberExpression' &&
        staticPropertyName(expression) !== null &&
        isDocumentReceiver(expression)
      );
    };
    const recursiveCache = new WeakMap<AnyNode, boolean>();
    const functionIdentifier = (fn: AnyNode): ESTree.BindingIdentifier | null => {
      if (fn.type === 'FunctionDeclaration' || fn.type === 'FunctionExpression') return fn.id;
      const parent = parentOf(fn);
      return parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier'
        ? parent.id
        : null;
    };
    const inGenericRecursiveTraversal = (node: AnyNode): boolean => {
      const fn = nearestFunction(node);
      if (!fn) return false;
      const cached = recursiveCache.get(fn);
      if (cached !== undefined) return cached;
      const id = functionIdentifier(fn);
      if (!id) return false;
      const binding = resolveVariable(context, id.name, id);
      let recursive = false,
        genericKeys = false,
        array = false;
      walk(
        fn,
        {},
        (current) => {
          if (
            current !== fn &&
            ['FunctionDeclaration', 'FunctionExpression'].includes(current.type)
          )
            return false;
          if (current.type !== 'CallExpression') return;
          const callee = unwrap(current.callee);
          if (
            callee.type === 'Identifier' &&
            resolveVariable(context, callee.name, callee) === binding
          )
            recursive = true;
          if (
            ['values', 'entries', 'keys'].some((method) => isGlobalMethod(callee, 'Object', method))
          )
            genericKeys = true;
          if (isGlobalMethod(callee, 'Array', 'isArray')) array = true;
        },
        false,
      );
      const result = recursive && genericKeys && array;
      recursiveCache.set(fn, result);
      return result;
    };
    const serializedDocument = (node: ESTree.CallExpression): boolean => {
      const first = node.arguments[0];
      return first !== undefined && first.type !== 'SpreadElement' && isDocumentReceiver(first);
    };

    const isSerializedComparison = (node: ESTree.BinaryExpression): boolean => {
      const left = unwrap(node.left),
        right = unwrap(node.right);
      if (left.type !== 'CallExpression' || right.type !== 'CallExpression') return false;
      return (
        isGlobalMethod(left.callee, 'JSON', 'stringify') &&
        isGlobalMethod(right.callee, 'JSON', 'stringify') &&
        (serializedDocument(left) || serializedDocument(right))
      );
    };
    const reportMembership = (
      node: AnyNode,
      receiver: AnyNode | undefined,
      keyNode: AnyNode | undefined,
    ): void => {
      if (!receiver || receiver.type === 'SpreadElement' || !isDocumentReceiver(receiver)) return;
      if (!keyNode || keyNode.type === 'SpreadElement' || keyNode.type === 'PrivateIdentifier')
        return;
      const key = asStringLiteral(keyNode);
      if (key !== null && !allowedKeys.has(key)) report(node, 'documentKeyProbe');
    };
    const fieldCallTarget = (call: ESTree.CallExpression): AnyNode | null => {
      const arrayTarget = arrayGuardArgument(call);
      if (arrayTarget !== null && isDocumentField(arrayTarget)) return arrayTarget;
      const guard = predicateGuardName(call.callee);
      if (guard === null || !(FIELD_GUARDS.has(guard) || OBJECT_GUARDS.has(guard))) return null;
      const target = soleArgument(call);
      return target !== null && isDocumentField(target) ? target : null;
    };
    const reportFieldCall = (call: ESTree.CallExpression): boolean => {
      if (fieldCallTarget(call) === null) return false;
      if (!insideReportedGuard(call)) report(call, 'documentFieldGuard');
      return true;
    };
    const spreadKeys = (node: AnyNode): AnyNode => {
      if (
        node.type === 'ArrayExpression' &&
        node.elements.length === 1 &&
        node.elements[0]?.type === 'SpreadElement'
      )
        return unwrap(node.elements[0].argument);
      return node;
    };
    const reportExactKeyJoin = (
      call: ESTree.CallExpression,
      member: ESTree.MemberExpression,
    ): void => {
      const sorted = unwrap(member.object);
      if (sorted.type !== 'CallExpression') return;
      const sortCallee = unwrap(sorted.callee);
      if (sortCallee.type !== 'MemberExpression') return;
      const method = staticPropertyName(sortCallee);
      if (method === null || !SORT_METHODS.has(method)) return;
      const keys = spreadKeys(unwrap(sortCallee.object));
      if (keys.type !== 'CallExpression' || !isGlobalMethod(keys.callee, 'Object', 'keys')) return;
      const receiver = soleArgument(keys);
      if (receiver && isDocumentReceiver(receiver)) report(call, 'exactKeyJoin');
    };
    const isStaticMembership = (member: ESTree.MemberExpression, method: string | null): boolean =>
      (method === 'hasOwn' && isGlobalHost(member.object, 'Object')) ||
      (method === 'has' && isGlobalHost(member.object, 'Reflect'));
    const reportMemberCall = (
      call: ESTree.CallExpression,
      member: ESTree.MemberExpression,
    ): void => {
      const method = staticPropertyName(member);
      if (isStaticMembership(member, method)) {
        reportMembership(call, call.arguments[0], call.arguments[1]);
        return;
      }
      if (method === 'hasOwnProperty') {
        reportMembership(call, member.object, call.arguments[0]);
        return;
      }
      if (method === 'call') {
        const host = unwrap(member.object);
        if (host.type === 'MemberExpression' && staticPropertyName(host) === 'hasOwnProperty')
          reportMembership(call, call.arguments[0], call.arguments[1]);
        return;
      }
      if (method === 'join') reportExactKeyJoin(call, member);
    };

    return {
      LogicalExpression(node) {
        const expression = node as unknown as AnyNode;
        if (!isOutermostLogical(expression) || inGenericRecursiveTraversal(expression)) return;
        const leaves: AnyNode[] = [];
        logicalLeaves(expression, leaves);
        const objectTargets = new Set<string>();
        const arrayTargets = new Set<string>();
        for (const leaf of leaves) {
          const objectTarget = objectGuardArgument(leaf);
          if (objectTarget !== null) objectTargets.add(targetKey(objectTarget));
          const arrayTarget = arrayGuardArgument(leaf);
          if (arrayTarget !== null) arrayTargets.add(targetKey(arrayTarget));
        }
        for (const target of objectTargets) {
          if (!arrayTargets.has(target)) continue;
          guardedSpans.push(spanOf(expression));
          report(expression, 'structuralObjectGuard');
          return;
        }
      },

      BinaryExpression(node) {
        if (node.operator === 'in') {
          reportMembership(node, node.right, node.left);
          return;
        }
        if (!EQUALITY_OPERATORS.has(node.operator)) return;
        if (isSerializedComparison(node)) {
          report(node, 'serializedComparison');
          return;
        }
        const comparison = typeofComparison(node);
        if (!comparison || asStringLiteral(comparison.other) === null) return;
        if (!isDocumentField(comparison.argument)) return;
        if (insideReportedGuard(node) || inGenericRecursiveTraversal(node)) return;
        report(node, 'documentFieldGuard');
      },
      CallExpression(node) {
        if (inGenericRecursiveTraversal(node) || reportFieldCall(node)) return;
        const callee = unwrap(node.callee);
        if (callee.type !== 'MemberExpression') return;
        reportMemberCall(node, callee);
      },
    };
  },
});
