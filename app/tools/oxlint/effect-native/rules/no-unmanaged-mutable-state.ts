/**
 * Audit A4/C3/B4 (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`) targets WeakMap
 * defect-cause storage, non-reactive Contacts UI side channels and module memoization whose lifecycle
 * should be runtime-owned. This is a bounded AST detector, not proof that all native state is wrong.
 *
 * Reports stored/returned/default-position weak allocations at any nesting depth, recognizing real
 * globals, immutable constructor aliases and subclasses. Direct call-argument allocations (recursive
 * JSON cycle guards) and immediately accessed allocations are skipped: audit D and "Existing patterns
 * to preserve" retain native local computation. This is not escape analysis: an opaque callee may
 * retain an argument, and a locally bound per-call guard may still report as a storage candidate.
 *
 * Also reports module let/var bindings, known native module containers with syntactic mutations,
 * mutated module-class static fields and direct globalThis/global/self assignments. Native literal,
 * selected factory/alias and nested-container shapes are recognized; arbitrary .set/.add methods do
 * not imply mutation. Shadowed globals/imports are not native constructors. Unknown factory results,
 * mutation via opaque helpers/aliases, this-based static access and deep global writes are not fully
 * traced. No assertion about cross-tenant leakage or inability to reset state follows from syntax.
 *
 * Seeded read-only native collections, function-local ordinary state, frozen constants, forced
 * framework/process adapters, startup orDie with typed logging, JSONB/HttpApi serialization and
 * deliberate malformed test casts are preserved. Tests/scripts/config/generated files are outside
 * the default scope. Explicit runtime ownership is the target, not replacing every native collection.
 * Report-only, with no fixer or suggestions.
 */
import { defineRule } from '@oxlint/plugins';
import { fileURLToPath } from 'node:url';

import type { Context, ESTree, Reference, Scope, Variable } from '@oxlint/plugins';

import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

/** Exact app-root/fixture-prefix normalization; nested workspace markers never change scope. */
function workspacePath(filename: string): string {
  const unified = filename.replaceAll('\\', '/');
  const fixture =
    /(?:^|\/)tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\/(.*)$/u.exec(unified);
  if (fixture?.[1]) return fixture[1];
  const root = fileURLToPath(new URL('../../../../', import.meta.url)).replaceAll('\\', '/');
  return unified.startsWith(root) ? unified.slice(root.length) : normalisePath(unified);
}
function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

/** Generated output is never source; not overridable through options. */
const ALWAYS_IGNORED: readonly string[] = [
  '**/dist/**',
  '**/.output/**',
  '**/build/**',
  '**/node_modules/**',
  '**/*.gen.ts',
  '**/*.gen.tsx',
];

/** Globals that can be used to reach a constructor indirectly (`globalThis.WeakMap`). */
const CONTAINER_GLOBALS = new Set(['globalThis', 'global', 'window', 'self']);

/** Wrappers that do not change what an expression *is*. */
const TRANSPARENT_PARENTS = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

/** Identity-keyed collections that carry data beside the typed model. */
const WEAK_CONSTRUCTORS: readonly string[] = ['WeakMap', 'WeakSet'];
/** Added when `includeWeakRef` is enabled: lifecycle side channels rather than data side channels. */
const WEAK_REF_CONSTRUCTORS: readonly string[] = ['WeakRef', 'FinalizationRegistry'];

/** Constructors whose instances are mutable containers when held at module scope. */
const CONTAINER_CONSTRUCTORS = new Set(['Map', 'Set', 'Array']);

const DEFAULT_INCLUDE: readonly string[] = ['apps/**', 'verticals/**', 'packages/**'];
const DEFAULT_IGNORE: readonly string[] = ['**/*.config.ts', '**/*.config.mts'];
const DEFAULT_MUTATING_MEMBERS: readonly string[] = [
  'set',
  'add',
  'delete',
  'clear',
  'push',
  'pop',
  'splice',
  'unshift',
  'shift',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
];

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly ignore: readonly string[];
  readonly include: readonly string[];
  readonly includeScripts: boolean;
  readonly includeTests: boolean;
  readonly includeWeakRef: boolean;
  readonly mutatingMembers: readonly string[];
}

const DEFAULTS: RuleOptions = {
  allowPaths: [],
  ignore: DEFAULT_IGNORE,
  include: DEFAULT_INCLUDE,
  includeScripts: false,
  includeTests: false,
  includeWeakRef: false,
  mutatingMembers: DEFAULT_MUTATING_MEMBERS,
};

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Partial<Record<keyof RuleOptions, unknown>>;
  const include = stringList(given.include, DEFAULTS.include);
  return {
    allowPaths: stringList(given.allowPaths, DEFAULTS.allowPaths),
    ignore: stringList(given.ignore, DEFAULTS.ignore),
    include: include.length > 0 ? include : DEFAULTS.include,
    includeScripts: boolean(given.includeScripts, DEFAULTS.includeScripts),
    includeTests: boolean(given.includeTests, DEFAULTS.includeTests),
    includeWeakRef: boolean(given.includeWeakRef, DEFAULTS.includeWeakRef),
    mutatingMembers: stringList(given.mutatingMembers, DEFAULTS.mutatingMembers),
  };
}

function parentOf(node: AnyNode): AnyNode | null {
  return (node as { parent?: AnyNode | null }).parent ?? null;
}

/** Climb through parentheses / type wrappers; returns the outermost equivalent node and its parent. */
function skipWrappers(node: AnyNode): { readonly node: AnyNode; readonly parent: AnyNode | null } {
  let current = node;
  let parent = parentOf(current);
  while (parent !== null && TRANSPARENT_PARENTS.has(parent.type)) {
    current = parent;
    parent = parentOf(current);
  }
  return { node: current, parent };
}

/** Strip wrappers *inwards*: `[] as const` / `(new Map())` → the container expression itself. */
function unwrap(node: AnyNode): AnyNode {
  let current = node;
  for (let depth = 0; depth < 10; depth += 1) {
    if (!TRANSPARENT_PARENTS.has(current.type)) return current;
    const inner = (current as { expression?: AnyNode }).expression;
    if (inner === undefined || inner === null) return current;
    current = inner;
  }
  return current;
}

/** `x.name` / `x["name"]` → `"name"`; a dynamic key → `null`. */
function staticPropertyName(node: ESTree.MemberExpression): string | null {
  const property = unwrap(node.property);
  if (!node.computed)
    return property.type === 'Identifier' ? (property as ESTree.IdentifierName).name : null;
  if (property.type === 'TemplateLiteral' && property.expressions.length === 0)
    return property.quasis[0]?.value.cooked ?? null;
  if (property.type !== 'Literal') return null;
  const value = (property as { value?: unknown }).value;
  return typeof value === 'string' ? value : null;
}

function resolveVariable(context: Context, name: string, from: AnyNode): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(from);
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/** `true` when `node` is the ambient global `name` — not a local, parameter, class or import. */
function isUnshadowedGlobal(context: Context, node: AnyNode, name: string): boolean {
  if (node.type !== 'Identifier') return false;
  if ((node as ESTree.IdentifierReference).name !== name) return false;
  const variable = resolveVariable(context, name, node);
  return variable === null || variable.defs.length === 0;
}

/**
 * The global constructor a `new` callee names, or `null`.
 *
 * Accepts the bare global (`new WeakMap()`) and the container-global forms
 * (`new globalThis.WeakMap()`, `new window["WeakSet"]()`, `new globalThis?.WeakMap()`).
 */
function globalConstructorName(
  context: Context,
  callee: AnyNode,
  seen = new Set<Variable>(),
): string | null {
  const node = unwrap(callee);
  if (node.type === 'Identifier') {
    const name = (node as ESTree.IdentifierReference).name;
    if (isUnshadowedGlobal(context, node, name)) return name;
    const variable = resolveVariable(context, name, node);
    if (
      !variable ||
      seen.has(variable) ||
      variable.references.some((reference) => reference.isWrite() && !reference.init)
    )
      return null;
    seen.add(variable);
    const definition = variable.defs[0];
    if (
      definition?.type === 'Variable' &&
      definition.node.type === 'VariableDeclarator' &&
      definition.node.init
    )
      return globalConstructorName(context, definition.node.init, seen);
    if (
      definition?.type === 'ClassName' &&
      (definition.node.type === 'ClassDeclaration' || definition.node.type === 'ClassExpression') &&
      definition.node.superClass
    )
      return globalConstructorName(context, definition.node.superClass, seen);
    return null;
  }
  if (node.type !== 'MemberExpression') return null;
  const member = node as ESTree.MemberExpression;
  const name = staticPropertyName(member);
  if (name === null) return null;
  const container = unwrap(member.object as AnyNode);
  if (container.type !== 'Identifier') return null;
  const containerName = (container as ESTree.IdentifierReference).name;
  if (!CONTAINER_GLOBALS.has(containerName)) return null;
  return isUnshadowedGlobal(context, container, containerName) ? name : null;
}

/** Module-body `VariableDeclaration`s, including the `export let x` / `export const x` wrapper. */
function moduleDeclarations(program: ESTree.Program): readonly ESTree.VariableDeclaration[] {
  const declarations: ESTree.VariableDeclaration[] = [];
  for (const statement of program.body as readonly AnyNode[]) {
    const candidate =
      statement.type === 'VariableDeclaration'
        ? statement
        : statement.type === 'ExportNamedDeclaration'
          ? ((statement as ESTree.ExportNamedDeclaration).declaration as AnyNode | null)
          : null;
    if (candidate === null || candidate === undefined) continue;
    if (candidate.type !== 'VariableDeclaration') continue;
    // `declare let x` is an ambient type declaration, not state.
    if ((candidate as { declare?: boolean }).declare === true) continue;
    declarations.push(candidate as ESTree.VariableDeclaration);
  }
  return declarations;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A4/C3/B4: detect retained weak-allocation candidates and syntactically mutable module/static/global state. Prefer typed cause/UI contracts and runtime-owned resources where lifecycle matters. Native ephemeral computation is preserved; bounded initializer/reference analysis is not escape analysis or proof of absent ownership.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#a4-rebuild-the-error-system-around-typed-channels-and-contract-owned-problem-details',
    },
    messages: {
      weakSideChannel:
        'Audit A4/C3: `new {{name}}` occurs in a possible retained-state position. Review defect causes against typed error/Cause contracts, UI state against router/mutation/QueryClient contracts, and caches against runtime ownership. This syntactic allocation check does not establish escape, lifetime or intent; native transient cycle guards are not prohibited by the audit.',
      moduleMutable:
        'Audit B4/C3: `{{name}}` matches mutable module/static/global state. Where lifecycle matters, own it inside the runtime using Ref/SynchronizedRef, cached Effects/Cache, Context or scoped resources. This syntactic check does not prove leakage or absent cleanup. Seeded native lookup tables with no recognized mutation are allowed.',
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
              'Globs of files allowed to keep unmanaged mutable state, e.g. a ratified carve-out (default: none).',
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs skipped inside the included scope (default: `**/*.config.ts`, `**/*.config.mts`). Generated output (dist, .output, build, node_modules, *.gen.*) is always skipped.',
          },
          include: {
            type: 'array',
            items: { type: 'string' },
            description: 'Globs the rule applies to (default: apps/**, verticals/**, packages/**).',
          },
          includeScripts: {
            type: 'boolean',
            description:
              'Also lint `scripts/**` (default: false — audit B3 migrates only the consequential operational scripts).',
          },
          includeTests: {
            type: 'boolean',
            description:
              'Also lint test files (default: false — module-level accumulators are ordinary test scaffolding).',
          },
          includeWeakRef: {
            type: 'boolean',
            description: 'Also report `new WeakRef` / `new FinalizationRegistry` (default: false).',
          },
          mutatingMembers: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Mutating methods recognized only on known native collections (default: set, add, delete, clear, push, pop, splice, unshift, shift, sort, reverse, fill, copyWithin).',
          },
        },
      },
    ],
    defaultOptions: [
      {
        allowPaths: [],
        ignore: [...DEFAULT_IGNORE],
        include: [...DEFAULT_INCLUDE],
        includeScripts: false,
        includeTests: false,
        includeWeakRef: false,
        mutatingMembers: [...DEFAULT_MUTATING_MEMBERS],
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    const path = workspacePath(context.filename);

    const include = options.includeScripts ? [...options.include, 'scripts/**'] : options.include;
    if (!matchesAny(path, include)) return {};
    if (matchesAny(path, ALWAYS_IGNORED)) return {};
    if (matchesAny(path, options.ignore)) return {};
    if (matchesAny(path, options.allowPaths)) return {};
    if (!options.includeTests && isTestFile(path)) return {};
    if (!options.includeScripts && /(?:^|\/)scripts\//u.test(path)) return {};

    const weakConstructors = new Set<string>(
      options.includeWeakRef ? [...WEAK_CONSTRUCTORS, ...WEAK_REF_CONSTRUCTORS] : WEAK_CONSTRUCTORS,
    );
    const mutatingMembers = new Set<string>(options.mutatingMembers);

    /** Resolve only locally known native containers; an arbitrary `.set` API is not mutation. */
    const valueOf = (input: AnyNode | null, seen = new Set<Variable>()): AnyNode | null => {
      if (!input) return null;
      const value = unwrap(input);
      if (value.type !== 'Identifier') return value;
      const variable = resolveVariable(context, value.name, value);
      if (!variable || seen.has(variable)) return null;
      seen.add(variable);
      const definition = variable.defs[0];
      return definition?.type === 'Variable' && definition.node.type === 'VariableDeclarator'
        ? valueOf(definition.node.init ?? null, seen)
        : null;
    };
    const containerKind = (input: AnyNode | null, depth = 0): 'object' | 'collection' | null => {
      if (depth > 16) return null;
      const value = valueOf(input);
      if (!value) return null;
      if (value.type === 'ArrayExpression') return 'collection';
      if (value.type === 'ObjectExpression') return 'object';
      if (value.type === 'NewExpression') {
        const name = globalConstructorName(context, value.callee);
        return name && CONTAINER_CONSTRUCTORS.has(name) ? 'collection' : null;
      }
      if (value.type !== 'CallExpression') return null;
      const callee = unwrap(value.callee);
      if (callee.type !== 'MemberExpression') return null;
      const method = staticPropertyName(callee);
      const object = unwrap(callee.object);
      if (isUnshadowedGlobal(context, object, 'Object')) {
        if (method === 'create' || method === 'fromEntries') return 'object';
        if (['entries', 'keys', 'values'].includes(method ?? '')) return 'collection';
      }
      if (isUnshadowedGlobal(context, object, 'Array') && (method === 'from' || method === 'of'))
        return 'collection';
      if (
        ['slice', 'concat', 'map', 'filter', 'flat', 'flatMap'].includes(method ?? '') &&
        containerKind(object, depth + 1) === 'collection'
      )
        return 'collection';
      return null;
    };
    const propertyValue = (input: AnyNode | null, key: string | null): AnyNode | null => {
      const value = valueOf(input);
      if (value?.type !== 'ObjectExpression' || key === null) return null;
      for (const property of value.properties) {
        if (property.type !== 'Property') continue;
        const name =
          !property.computed && property.key.type === 'Identifier'
            ? property.key.name
            : property.key.type === 'Literal'
              ? property.key.value
              : null;
        if (name === key) return property.value;
      }
      return null;
    };
    const mutatedAt = (input: AnyNode, initial: AnyNode | null): boolean => {
      let { node: current, parent } = skipWrappers(input);
      let receiver = initial;
      while (parent?.type === 'MemberExpression' && parent.object === current) {
        const member = parent;
        const method = staticPropertyName(member);
        const outer = skipWrappers(member);
        if (outer.parent?.type === 'CallExpression' && outer.parent.callee === outer.node) {
          return (
            method !== null &&
            mutatingMembers.has(method) &&
            containerKind(receiver) === 'collection'
          );
        }
        receiver = propertyValue(receiver, method);
        current = outer.node;
        parent = outer.parent;
      }
      if (parent?.type === 'AssignmentExpression' && parent.left === current) return true;
      if (
        parent?.type === 'UpdateExpression' ||
        (parent?.type === 'UnaryExpression' && parent.operator === 'delete')
      )
        return true;
      if (parent?.type === 'CallExpression' && parent.arguments[0] === current) {
        const callee = unwrap(parent.callee);
        return (
          callee.type === 'MemberExpression' &&
          staticPropertyName(callee) === 'assign' &&
          isUnshadowedGlobal(context, unwrap(callee.object), 'Object')
        );
      }
      return false;
    };
    const isMutatingReference = (reference: Reference, init: AnyNode | null): boolean => {
      if (reference.init) return false;
      return reference.isWrite() || mutatedAt(reference.identifier, init);
    };
    const globalContainer = (input: AnyNode, seen = new Set<Variable>()): boolean => {
      const node = unwrap(input);
      if (node.type !== 'Identifier') return false;
      if (
        ['globalThis', 'global', 'self'].includes(node.name) &&
        isUnshadowedGlobal(context, node, node.name)
      )
        return true;
      const variable = resolveVariable(context, node.name, node);
      if (
        !variable ||
        seen.has(variable) ||
        variable.references.some((reference) => reference.isWrite() && !reference.init)
      )
        return false;
      seen.add(variable);
      const definition = variable.defs[0];
      return (
        definition?.type === 'Variable' &&
        definition.node.type === 'VariableDeclarator' &&
        !!definition.node.init &&
        globalContainer(definition.node.init, seen)
      );
    };

    const reportDeclarator = (declarator: ESTree.VariableDeclarator): void => {
      const variables = context.sourceCode.getDeclaredVariables(declarator as unknown as AnyNode);
      if (variables.length === 0) {
        context.report({
          node: declarator.id as unknown as AnyNode,
          messageId: 'moduleMutable',
          data: { name: context.sourceCode.getText(declarator.id as unknown as AnyNode) },
        });
        return;
      }
      for (const variable of variables) {
        const anchor =
          (variable.identifiers[0] as AnyNode | undefined) ?? (declarator.id as unknown as AnyNode);
        context.report({ node: anchor, messageId: 'moduleMutable', data: { name: variable.name } });
      }
    };

    return {
      AssignmentExpression(node) {
        const left = unwrap(node.left);
        if (left.type !== 'MemberExpression' || !globalContainer(left.object)) return;
        context.report({
          node: left,
          messageId: 'moduleMutable',
          data: { name: context.sourceCode.getText(left) },
        });
      },
      PropertyDefinition(node) {
        if (!node.static || node.declare || !node.value) return;
        const body = node.parent;
        const owner = body?.type === 'ClassBody' ? body.parent : null;
        if (owner?.type !== 'ClassDeclaration' || !owner.id) return;
        let ancestor = owner.parent;
        if (ancestor?.type === 'ExportNamedDeclaration') ancestor = ancestor.parent;
        if (ancestor?.type !== 'Program') return;
        const key =
          node.key.type === 'Identifier' || node.key.type === 'PrivateIdentifier'
            ? node.key.name
            : node.key.type === 'Literal'
              ? String(node.key.value)
              : null;
        if (key === null) return;
        const variables = context.sourceCode.getDeclaredVariables(owner);
        const mutated = variables.some((variable) =>
          variable.references.some((reference) => {
            const access = skipWrappers(reference.identifier).parent;
            return (
              access?.type === 'MemberExpression' &&
              staticPropertyName(access) === key &&
              mutatedAt(access, node.value)
            );
          }),
        );
        if (mutated)
          context.report({
            node: node.key,
            messageId: 'moduleMutable',
            data: { name: `${owner.id.name}.${key}` },
          });
      },
      // (1) `new WeakMap()` / `new globalThis.WeakSet()` at any nesting depth.
      NewExpression(node) {
        const name = globalConstructorName(context, node.callee as AnyNode);
        if (name === null || !weakConstructors.has(name)) return;
        const outer = skipWrappers(node);
        // A4 targets cause/provenance/UI storage, not ephemeral recursive cycle guards
        // (D tier and Existing patterns to preserve). No escape analysis is claimed.
        if (
          outer.parent?.type === 'CallExpression' &&
          outer.parent.arguments.includes(outer.node as never)
        )
          return;
        if (outer.parent?.type === 'MemberExpression' && outer.parent.object === outer.node) return;
        context.report({
          node: node as unknown as AnyNode,
          messageId: 'weakSideChannel',
          data: { name },
        });
      },

      // (2) module-scope `let`/`var`, and mutated module-scope container `const`s.
      Program(node) {
        for (const declaration of moduleDeclarations(node)) {
          const mutableBinding = declaration.kind === 'let' || declaration.kind === 'var';
          for (const declarator of declaration.declarations) {
            if (mutableBinding) {
              reportDeclarator(declarator);
              continue;
            }
            if (declaration.kind !== 'const') continue;
            if ((declarator.id as AnyNode).type !== 'Identifier') continue;
            if (!containerKind(declarator.init ?? null)) continue;
            const variables = context.sourceCode.getDeclaredVariables(
              declarator as unknown as AnyNode,
            );
            const mutated = variables.some((variable) =>
              variable.references.some((reference) =>
                isMutatingReference(reference, declarator.init ?? null),
              ),
            );
            if (mutated) reportDeclarator(declarator);
          }
        }
      },
    };
  },
});
