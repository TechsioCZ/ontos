/**
 * effect-native/no-nested-effect-run
 *
 * Audit findings: **S1** (Eliminate the Effect–Promise–Effect transaction sandwich) and **A1**
 * (Establish one process-level Layer and ManagedRuntime composition model) of
 * `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`.
 *
 * ## What is detected
 *
 * A *run site* is a reference to `Effect.runPromise`, `runPromiseExit`, `runSync`, `runSyncExit`,
 * `runFork`, `runCallback` (and their `*With` variants) where `Effect` really resolves to an import
 * of `effect` / `effect/*` (or of a configured `effectModules` re-export barrel). Import shapes
 * covered:
 *
 * - `import { Effect } from "effect"`, `import { Effect as Fx } from "effect"`
 * - `import * as Effect from "effect/Effect"`
 * - `import * as effect from "effect"` → `effect.Effect.runPromise` (root-barrel namespace)
 * - `import { runPromise } from "effect/Effect"` → the bare `runPromise(...)` call
 *
 * Run sites are recognised in every position, not only as a call callee:
 *
 * - `Effect.runPromise(program)`, `Effect?.runPromise?.(p)`, `Effect["runPromise"](p)`,
 *   ``Effect[`runPromise`](p)``, `(Effect.runPromise as Runner)(p)`
 * - point-free arguments: `pipe(program, Effect.runSync)`, `items.map(Effect.runPromise)`
 * - aliases: `const run = Effect.runPromise`, `run = Effect.runPromise` (assignment),
 *   `const { runPromise: go } = Effect` — every scope-resolved read reference is a run site too
 *
 * A run site is reported when it sits **inside Effect-owned code**: walking from the site up to
 * `Program` passes through the arguments of a call whose callee is `Effect.*`, `Layer.*`,
 * `Stream.*`, `Schedule.*`, `Scope.*` or `Fiber.*` — directly, nested in an object literal such as
 * the `try:` / `catch:` handlers of `Effect.tryPromise`, or through a curried owner such as
 * `Effect.fn("name")(body)`. The walk deliberately crosses nested function boundaries, and takes one
 * bounded hop through a named callback (`const body = async (t) => ...; db.transaction(body)`) so
 * hoisting the callback out of the `Effect.tryPromise` arguments does not hide the re-entry.
 *
 * Each such call starts a **new root fiber**, severing parent spans, log annotations,
 * `Context.Reference` values, `ConfigProvider`, `Clock`/`TestClock`, interruption and the handler's
 * `R` environment from the surrounding Effect.
 *
 * ## What is deliberately allowed
 *
 * - The single outer process / framework adapter seam, in both spellings: `Effect.runPromise(program)`
 *   at module level or in an exported entrypoint, **and** its point-free form
 *   `program.pipe(Effect.provide(AppLayer), Effect.runPromise)` / `pipe(program, ..., Effect.runSync)`.
 *   A sibling stage of the same `pipe` chain is not an enclosing scope: nothing runs the run site
 *   inside a fiber, so it stays silent. The audit preserves this verbatim ("Bare `Effect.runPromise`
 *   is acceptable at the single outer process or framework adapter seam; the problem is repeated deep
 *   re-entry").
 * - Runtime-captured runs (`Effect.runPromiseExitWith(context)(body)`, `ManagedRuntime`'s
 *   `runtime.runPromise(...)`) — the S1 *target* shape. `*With` members are exempt while
 *   `allowRuntimeCapturedRuns` is `true` (the default); `runtime.runPromise` is never a run site
 *   because `runtime` is not an `effect` import binding.
 * - Anything named `Effect`/`Layer`/... that is *not* the import: a shadowing parameter or local
 *   binding is resolved through the scope chain and never matched.
 * - Plain (non-Effect) generators that merely pass a run function along as a value.
 * - Everything in D tier that has nothing to do with root-fiber re-entry (`Layer.orDie` at a
 *   deliberate startup root, Drizzle/React/Playwright Promise adapters at the outer seam).
 *
 * Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, SourceCode, Variable } from '@oxlint/plugins';

import { bindingsFor, effectMember } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { matchesAny } from '../shared/paths.ts';

/** Root-fiber entry points. Every one of these starts a fresh runtime with no inherited context. */
const RUN_MEMBERS = new Set([
  'runCallback',
  'runFork',
  'runPromise',
  'runPromiseExit',
  'runSync',
  'runSyncExit',
]);

/** Context-capturing variants — the S1 target shape at the single unavoidable Promise boundary. */
const WITH_MEMBERS = new Set([
  'runCallbackWith',
  'runForkWith',
  'runPromiseExitWith',
  'runPromiseWith',
  'runSyncExitWith',
  'runSyncWith',
]);

/** Namespaces whose call arguments are Effect-owned code: callbacks there run inside a fiber. */
const OWNING_NAMESPACES = new Set(['Effect', 'Fiber', 'Layer', 'Schedule', 'Scope', 'Stream']);

const DEFAULT_EFFECT_MODULES = [
  '@modern-js/plugin-bff/effect-client',
  '@modern-js/plugin-bff/effect-edge',
];

const EFFECT_MODULE = /^effect(?:\/.*)?$/u;

/** Bounded budgets: the walk crosses function boundaries, so it must never run away on huge files. */
const MAX_WALK_STEPS = 512;
const MAX_ALIAS_HOPS = 8;

interface RuleOptions {
  readonly allowRuntimeCapturedRuns: boolean;
  readonly effectModules: readonly string[];
  readonly ignore: readonly string[];
}

function readOptions(context: Context): RuleOptions {
  const raw = (context.options[0] ?? {}) as {
    allowRuntimeCapturedRuns?: boolean;
    effectModules?: readonly string[];
    ignore?: readonly string[];
  };
  return {
    allowRuntimeCapturedRuns: raw.allowRuntimeCapturedRuns ?? true,
    effectModules: raw.effectModules ?? DEFAULT_EFFECT_MODULES,
    ignore: raw.ignore ?? [],
  };
}

interface AnyNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly parent?: AnyNode | null;
  readonly [key: string]: unknown;
}

function asNode(value: unknown): AnyNode | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { type?: unknown; start?: unknown };
  if (typeof candidate.type !== 'string' || typeof candidate.start !== 'number') return null;
  return value as AnyNode;
}

/** Lazily materialised AST nodes are not reference-stable; compare by kind + span instead. */
function sameNode(left: AnyNode | null, right: AnyNode | null): boolean {
  if (left === null || right === null) return false;
  return left.type === right.type && left.start === right.start && left.end === right.end;
}

function nodeKey(node: AnyNode): string {
  return `${node.type}:${node.start}:${node.end}`;
}

/** Strip parens, `!`, `as`, `satisfies` and optional-chaining wrappers to reach the real expression. */
function unwrap(node: unknown): AnyNode | null {
  let current = asNode(node);
  for (let guard = 0; current !== null && guard < 16; guard += 1) {
    if (
      current.type !== 'ParenthesizedExpression' &&
      current.type !== 'ChainExpression' &&
      current.type !== 'TSNonNullExpression' &&
      current.type !== 'TSAsExpression' &&
      current.type !== 'TSSatisfiesExpression' &&
      current.type !== 'TSInstantiationExpression'
    ) {
      return current;
    }
    const inner = asNode(current.expression);
    if (inner === null) return current;
    current = inner;
  }
  return current;
}

function isRunMemberName(name: string): boolean {
  return RUN_MEMBERS.has(name) || WITH_MEMBERS.has(name);
}

function keyName(key: AnyNode | null, computed: boolean): string | null {
  if (key === null) return null;
  if (computed) {
    // `Effect["runPromise"]` and `Effect[`runPromise`]` — static string keys only.
    if (key.type === 'Literal') return typeof key.value === 'string' ? key.value : null;
    if (key.type === 'TemplateLiteral') {
      const expressions = Array.isArray(key.expressions) ? key.expressions : [];
      const quasis = Array.isArray(key.quasis) ? key.quasis : [];
      if (expressions.length !== 0 || quasis.length !== 1) return null;
      const cooked = (asNode(quasis[0])?.value as { cooked?: unknown } | undefined)?.cooked;
      return typeof cooked === 'string' ? cooked : null;
    }
    return null;
  }
  if (key.type === 'Identifier' && typeof key.name === 'string') return key.name;
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : null;
}

/** Property name of a `MemberExpression`, honouring computed static access. */
function staticPropertyName(node: AnyNode): string | null {
  return keyName(asNode(node.property), node.computed === true);
}

/** Key name of an object/pattern `Property`, honouring computed static keys. */
function propertyKeyName(node: AnyNode): string | null {
  return keyName(asNode(node.key), node.computed === true);
}

function importedName(specifier: {
  imported: { type: string; name?: string; value?: string };
}): string | null {
  const imported = specifier.imported;
  if (imported.type === 'Identifier') return imported.name ?? null;
  return typeof imported.value === 'string' ? imported.value : null;
}

interface FileImports {
  /** Locals bound to `import * as x from "effect"` — the root barrel (`x.Effect.runPromise`). */
  readonly barrelLocals: ReadonlySet<string>;
  readonly bindings: EffectBindings;
  /** `import { gen } from "effect/Effect"` → `gen` → `"Effect"` (an Effect-owning combinator). */
  readonly flatOwners: ReadonlyMap<string, string>;
  /** `import { runPromise } from "effect/Effect"` → `runPromise` → `"runPromise"`. */
  readonly flatRuns: ReadonlyMap<string, string>;
}

/**
 * Extend the shared `effect` import bindings with the shapes the shared collector does not model:
 * re-export barrels (`@modern-js/plugin-bff/effect-edge` re-exports `Effect` verbatim), the root
 * `effect` namespace import, and flat named imports of combinators / run functions from
 * `effect/<Namespace>`.
 */
function collectImports(context: Context, modules: readonly string[]): FileImports {
  const base = bindingsFor(context);
  const namespaces = new Map(base.namespaces);
  const barrelLocals = new Set<string>();
  const flatOwners = new Map<string, string>();
  const flatRuns = new Map<string, string>();
  let importsEffect = base.importsEffect;

  for (const statement of context.sourceCode.ast.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    const source = statement.source.value;
    const isEffectPackage = EFFECT_MODULE.test(source);
    const isExtraModule = modules.includes(source);
    if (!isEffectPackage && !isExtraModule) continue;
    importsEffect = true;
    const submodule = isEffectPackage ? (source.split('/').at(-1) ?? '') : '';
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') {
        if (isEffectPackage && submodule === 'effect') barrelLocals.add(specifier.local.name);
        continue;
      }
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported = importedName(specifier);
      if (imported === null) continue;
      const local = specifier.local.name;
      if (isExtraModule) {
        // The barrel re-exports the namespaces (`Effect`, `Layer`, ...) verbatim.
        namespaces.set(local, imported);
        if (isRunMemberName(imported)) flatRuns.set(local, imported);
        continue;
      }
      if (submodule === 'Effect' && isRunMemberName(imported)) {
        flatRuns.set(local, imported);
        continue;
      }
      if (OWNING_NAMESPACES.has(submodule)) flatOwners.set(local, submodule);
    }
  }

  return { barrelLocals, bindings: { importsEffect, namespaces }, flatOwners, flatRuns };
}

function resolveVariable(sourceCode: SourceCode, identifier: AnyNode): Variable | null {
  const name = typeof identifier.name === 'string' ? identifier.name : null;
  if (name === null) return null;
  let scope: Scope | null = null;
  try {
    scope = sourceCode.getScope(identifier as unknown as ESTree.Node);
  } catch {
    return null;
  }
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/** Ban new root fibers started from inside Effect-owned code (audit S1 + A1). */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow Effect.run* re-entry inside Effect-owned code (audit S1 transaction sandwich, A1 runtime composition). Keep the body an Effect and capture the context once at the single unavoidable Promise boundary.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#s1-eliminate-the-effectpromiseeffect-transaction-sandwich',
    },
    messages: {
      nestedRun:
        '`Effect.{{member}}` starts a new root fiber inside Effect-owned code and severs spans, annotations, Context.Reference, ConfigProvider, Clock and interruption. Keep the body an Effect (Effect.gen/flatMap) or capture the context once and use Effect.runPromiseExitWith(context) at the single unavoidable Promise callback boundary.',
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          allowRuntimeCapturedRuns: {
            description:
              'Allow Effect.run*With(context) — the context-capturing target shape at the single Promise boundary.',
            type: 'boolean',
          },
          effectModules: {
            description:
              'Extra modules whose named imports bind Effect namespaces (re-export barrels).',
            items: { type: 'string' },
            type: 'array',
          },
          ignore: {
            description: 'Repo-relative globs whose files are exempt from this rule.',
            items: { type: 'string' },
            type: 'array',
          },
        },
        type: 'object',
      },
    ],
    defaultOptions: [
      {
        allowRuntimeCapturedRuns: true,
        effectModules: DEFAULT_EFFECT_MODULES,
        ignore: [],
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    if (matchesAny(context.filename, options.ignore)) return {};

    let imports: FileImports = {
      barrelLocals: new Set(),
      bindings: { importsEffect: false, namespaces: new Map() },
      flatOwners: new Map(),
      flatRuns: new Map(),
    };
    let active = false;
    const reported = new Set<string>();

    /**
     * Confirm an identifier still resolves to the module-level `effect` import rather than to a
     * parameter or local that happens to share its name (README: rules must confirm through scope).
     * An unresolvable identifier falls back to the module-level import table.
     */
    const resolvesToEffectImport = (identifier: AnyNode): boolean => {
      const variable = resolveVariable(context.sourceCode, identifier);
      if (variable === null) return true;
      return variable.defs.some((definition) => definition.type === 'ImportBinding');
    };

    /**
     * Namespace an object expression stands for: `Effect` → `"Effect"`, `effect.Layer` → `"Layer"`
     * (root-barrel namespace import). `null` when the object is not a confirmed effect namespace.
     */
    const namespaceOfObject = (object: AnyNode | null): string | null => {
      if (object === null) return null;
      if (object.type === 'Identifier' && typeof object.name === 'string') {
        const namespace = imports.bindings.namespaces.get(object.name);
        if (namespace === undefined) return null;
        return resolvesToEffectImport(object) ? namespace : null;
      }
      if (object.type !== 'MemberExpression') return null;
      const base = unwrap(object.object);
      if (base === null || base.type !== 'Identifier' || typeof base.name !== 'string') return null;
      if (!imports.barrelLocals.has(base.name)) return null;
      if (!resolvesToEffectImport(base)) return null;
      return staticPropertyName(object);
    };

    /** `Effect.runPromise` / `effect.Effect["runSync"]` → the run member name; else `null`. */
    const runMemberOf = (node: AnyNode | null): string | null => {
      if (node === null || node.type !== 'MemberExpression') return null;
      const viaShared = effectMember(node as unknown as ESTree.Node, imports.bindings);
      if (viaShared !== null && !isRunMemberName(viaShared.member)) return null;
      const namespace = namespaceOfObject(unwrap(node.object));
      if (namespace !== 'Effect') return null;
      const member = staticPropertyName(node);
      return member !== null && isRunMemberName(member) ? member : null;
    };

    /**
     * Namespace of an Effect-family callee whose call arguments are Effect-owned code:
     * `Effect.gen` → `"Effect"`, `Layer.effect` → `"Layer"`, bare `gen` from `effect/Effect` →
     * `"Effect"`. Run members are excluded: the argument of `Effect.runPromise(...)` is the program
     * being run at the seam, not a callback executed inside a parent fiber.
     */
    const owningNamespaceOf = (callee: AnyNode | null): string | null => {
      if (callee === null) return null;
      if (callee.type === 'Identifier' && typeof callee.name === 'string') {
        const namespace = imports.flatOwners.get(callee.name);
        if (namespace === undefined) return null;
        return resolvesToEffectImport(callee) ? namespace : null;
      }
      if (callee.type !== 'MemberExpression') return null;
      const member = staticPropertyName(callee);
      if (member === null || isRunMemberName(member)) return null;
      const namespace = namespaceOfObject(unwrap(callee.object));
      return namespace !== null && OWNING_NAMESPACES.has(namespace) ? namespace : null;
    };

    /** `Effect.fn("name")(body)` — peel curried calls to reach the Effect-family member. */
    const calleeOwner = (callee: AnyNode | null): string | null => {
      let current = callee;
      for (
        let guard = 0;
        current !== null && current.type === 'CallExpression' && guard < 8;
        guard += 1
      ) {
        current = unwrap(current.callee);
      }
      return owningNamespaceOf(current);
    };

    const callArguments = (node: AnyNode): readonly AnyNode[] => {
      const raw = node.arguments;
      if (!Array.isArray(raw)) return [];
      const nodes: AnyNode[] = [];
      for (const entry of raw) {
        const parsed = asNode(entry);
        if (parsed !== null) nodes.push(parsed);
      }
      return nodes;
    };

    const isFunctionNode = (node: AnyNode | null): boolean =>
      node !== null &&
      (node.type === 'ArrowFunctionExpression' ||
        node.type === 'FunctionExpression' ||
        node.type === 'FunctionDeclaration');

    /**
     * One bounded hop for a named callback: `const body = async (t) => ...; db.transaction(body)`.
     * Continue the search from every read reference of the binding so hoisting the callback out of
     * the `Effect.tryPromise` arguments does not hide the re-entry.
     */
    const referenceStartsFor = (identifier: AnyNode | null): readonly AnyNode[] => {
      if (identifier === null || identifier.type !== 'Identifier') return [];
      const variable = resolveVariable(context.sourceCode, identifier);
      if (variable === null || variable.defs.length !== 1) return [];
      const starts: AnyNode[] = [];
      for (const reference of variable.references) {
        if (!reference.isRead()) continue;
        const node = asNode(reference.identifier);
        if (node === null) continue;
        if (variable.identifiers.some((declared) => sameNode(asNode(declared), node))) continue;
        starts.push(node);
      }
      return starts;
    };

    /**
     * True when the search from `start` reaches Effect-owned code: the arguments of an Effect-family
     * call (directly, through an object literal such as `{ try:, catch: }`, or through a curried
     * owner). Nested function bodies are crossed on purpose — the S1 sandwich hides its re-entry
     * inside `async` callbacks. A sibling stage of a `pipe(...)` chain is *not* an enclosing scope,
     * so the point-free outer seam stays silent.
     */
    const isInsideEffectOwnedCode = (start: AnyNode): boolean => {
      const queue: AnyNode[] = [start];
      const seen = new Set<string>([nodeKey(start)]);
      let hops = 0;
      while (queue.length > 0 && hops < MAX_ALIAS_HOPS) {
        hops += 1;
        const from = queue.shift();
        if (from === undefined) break;
        let child: AnyNode = from;
        let parent = asNode(child.parent);
        for (
          let guard = 0;
          parent !== null && parent.type !== 'Program' && guard < MAX_WALK_STEPS;
          guard += 1
        ) {
          if (parent.type === 'CallExpression' || parent.type === 'NewExpression') {
            const args = callArguments(parent);
            if (
              args.some((argument) => sameNode(argument, child)) &&
              calleeOwner(unwrap(parent.callee)) !== null
            ) {
              return true;
            }
          }
          if (
            parent.type === 'VariableDeclarator' &&
            isFunctionNode(child) &&
            sameNode(unwrap(parent.init), child)
          ) {
            for (const next of referenceStartsFor(asNode(parent.id))) {
              const key = nodeKey(next);
              if (seen.has(key)) continue;
              seen.add(key);
              queue.push(next);
            }
          }
          if (parent.type === 'FunctionDeclaration' && sameNode(asNode(parent.body), child)) {
            for (const next of referenceStartsFor(asNode(parent.id))) {
              const key = nodeKey(next);
              if (seen.has(key)) continue;
              seen.add(key);
              queue.push(next);
            }
          }
          child = parent;
          parent = asNode(parent.parent);
        }
      }
      return false;
    };

    const report = (node: AnyNode, member: string): void => {
      // Type queries nested in an Effect callback are erased, not re-entry sites.
      for (let at = asNode(node.parent); at !== null; at = asNode(at.parent)) {
        if (
          [
            'TSTypeQuery',
            'TSTypeAnnotation',
            'TSTypeReference',
            'TSImportType',
            'TSQualifiedName',
          ].includes(at.type)
        )
          return;
      }
      if (options.allowRuntimeCapturedRuns && WITH_MEMBERS.has(member)) return;
      if (!isInsideEffectOwnedCode(node)) return;
      const key = `${node.start}:${node.end}`;
      if (reported.has(key)) return;
      reported.add(key);
      context.report({
        data: { member },
        messageId: 'nestedRun',
        node: node as unknown as ESTree.Node,
      });
    };

    /**
     * The run member a variable stands for: a flat named import of the run function, an alias
     * declarator, an alias assignment, or a destructure of the Effect namespace. `null` for every
     * other binding, so `const runtime = ManagedRuntime.make(...)` stays inert.
     */
    const aliasedRunMember = (variable: Variable): string | null => {
      for (const definition of variable.defs) {
        if (definition.type === 'ImportBinding') {
          const flat = imports.flatRuns.get(variable.name);
          if (flat !== undefined) return flat;
          continue;
        }
        if (definition.type !== 'Variable') continue;
        const declarator = asNode(definition.node);
        if (declarator === null || declarator.type !== 'VariableDeclarator') continue;
        const id = asNode(declarator.id);
        if (id === null) continue;
        const init = unwrap(declarator.init);
        if (id.type === 'Identifier') {
          if (init === null) continue;
          const member = runMemberOf(init);
          if (member !== null) return member;
          continue;
        }
        if (id.type !== 'ObjectPattern') continue;
        if (init === null || init.type !== 'Identifier') continue;
        if (namespaceOfObject(init) !== 'Effect') continue;
        const properties = Array.isArray(id.properties) ? id.properties : [];
        for (const entry of properties) {
          const property = asNode(entry);
          if (property === null || property.type !== 'Property') continue;
          const key = propertyKeyName(property);
          if (key === null || !isRunMemberName(key)) continue;
          const rawValue = asNode(property.value);
          const bound =
            rawValue !== null && rawValue.type === 'AssignmentPattern'
              ? asNode(rawValue.left)
              : rawValue;
          if (bound !== null && bound.type === 'Identifier' && bound.name === variable.name)
            return key;
        }
      }
      // `let run; run = Effect.runPromise;` — the alias is bound by an assignment, not a declarator.
      for (const reference of variable.references) {
        if (!reference.isWrite()) continue;
        const member = runMemberOf(unwrap(reference.writeExpr));
        if (member !== null) return member;
      }
      return null;
    };

    return {
      Program() {
        imports = collectImports(context, options.effectModules);
        active =
          imports.bindings.importsEffect &&
          (imports.bindings.namespaces.size > 0 ||
            imports.barrelLocals.size > 0 ||
            imports.flatRuns.size > 0 ||
            imports.flatOwners.size > 0);
        if (!active) return;

        // Alias references are resolved through the scope manager so declaration order and the
        // binding position (declarator, assignment, destructure, flat import) do not matter.
        for (const scope of context.sourceCode.scopeManager.scopes) {
          for (const variable of scope.variables) {
            const member = aliasedRunMember(variable);
            if (member === null) continue;
            for (const reference of variable.references) {
              if (!reference.isRead()) continue;
              const identifier = asNode(reference.identifier);
              if (identifier === null) continue;
              if (variable.identifiers.some((declared) => sameNode(asNode(declared), identifier)))
                continue;
              report(identifier, member);
            }
          }
        }
      },
      MemberExpression(node) {
        if (!active) return;
        const member = runMemberOf(node as unknown as AnyNode);
        if (member === null) return;
        report(node as unknown as AnyNode, member);
      },
    };
  },
});
