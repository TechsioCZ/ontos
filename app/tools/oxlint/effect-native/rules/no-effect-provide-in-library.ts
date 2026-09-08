/**
 * effect-native/no-effect-provide-in-library
 *
 * Audit findings: S1 ("Eliminate the Effect–Promise–Effect transaction sandwich") and
 * A1 ("Establish one process-level Layer and ManagedRuntime composition model") in
 * `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`.
 *
 * What is detected
 * ----------------
 * Every reference to `Effect.provide`, `Effect.provideService`, `Effect.provideServices`,
 * `Effect.provideServiceEffect` or `Effect.provideReferences` that lives in
 * library code — i.e. anywhere that is not an allowlisted composition root. References are matched
 * whether they are the callee of a call (`Effect.provide(layer)`), a point-free argument
 * (`program.pipe(Effect.provide(layer))`, `pipe(program, Effect.provide(layer))`), a bare function
 * reference, an optional-chained member (`Effect?.provide`), a non-null-asserted member
 * (`Effect!.provide`) or a computed string member (`Effect["provide"]`). Every import shape that can
 * name the combinator is tracked:
 *   - `import { Effect } from "effect"` and aliases (`import { Effect as Fx } from "effect"`);
 *   - submodule namespaces (`import * as Effect from "effect/Effect"`);
 *   - the root barrel (`import * as EffectNs from "effect"` → `EffectNs.Effect.provide`);
 *   - direct member imports (`import { provide, provideService as supply } from "effect/Effect"` →
 *     `program.pipe(provide(L))`), which are the cheapest way to evade a namespace-only matcher.
 * Each identifier is resolved through `context.sourceCode.getScope`, so a local shadow (a parameter
 * named `Effect`, a `const provide = container.provide`) is not reported. `Layer.provide` and any
 * other non-Effect `x.provide` are ignored.
 *
 * Why: a local `Effect.provide` inside a service, handler or transaction body (the audit's evidence
 * sites `packages/core-runtime/src/actions/runtime.ts:814,838` and
 * `packages/core-runtime/src/reads/runtime.ts:482,508`) exists only to replace the environment that
 * was lost by re-entering a new root fiber. It hides the program's true `R` and makes the requirement
 * invisible to the composition root.
 *
 * What is deliberately allowed
 * ----------------------------
 * - Files matching `rootFiles` (the process/browser composition roots) — audit "Existing patterns to
 *   preserve": the single outer process or framework adapter seam.
 * - The outer process seam itself: a provide that is a *direct argument pipeline* of a module
 *   top-level `Effect.run*` call (e.g. `await Effect.runPromise(Effect.provide(program, RuntimeLive))`
 *   or `Effect.runFork(program.pipe(Effect.provide(L)))` at the end of a `verify-db-schema.mts`
 *   entrypoint). Only `pipe`/`.pipe` links may sit between the provide and the run call, and the whole
 *   chain must be at the executable edge (including a singly invoked module main or IIFE): callbacks, class bodies or
 *   transaction body, and anything laundered through another combinator
 *   (`Effect.runSync(Effect.succeed(p.pipe(Effect.provide(L))))`), is still reported.
 *   Disable the exemption entirely with `allowOuterRunSeam: false`.
 * - Test files (`includeTests: false` by default); tests legitimately provide stub layers.
 * - `Layer.provide` / `Layer.provideMerge` (layer composition, not requirement erasure) and
 *   `Layer.orDie` at a deliberate startup root (D tier) are never matched by this rule.
 * - Type positions (`Parameters<typeof Effect.provide>`, `typeof provide`) are erased at runtime.
 * - `updateService` retains a service requirement in R; the earlier specification incorrectly
 *   grouped it with requirement-discharge APIs. It is not a default member anymore.
 *
 * Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree } from '@oxlint/plugins';

import {
  unwrapNode as unwrap,
  memberName as staticMemberName,
  FUNCTION_TYPES,
} from '../shared/ast.ts';
import { lookupVariable, resolvesToImport } from '../shared/bindings.ts';
import { collectNamedImports, collectRootNamespaces } from '../shared/imports.ts';
import {
  isInTypePosition as inTypePosition,
  isNonReferencePosition as nonReferencePosition,
} from '../shared/reference-positions.ts';
import { bindingsFor } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { isTestFile, matchesAny } from '../shared/paths.ts';

const EFFECT_ROOT_MODULE = 'effect';
/** `effect/Effect`, and the same module reached through a deeper path (`effect/unstable/.../Effect`). */
const EFFECT_EFFECT_MODULE = /^effect\/(?:.*\/)?Effect$/u;
const EFFECT_NAMESPACE = 'Effect';
const PIPE_NAMESPACE = 'pipe';

const DEFAULT_ROOT_FILES: readonly string[] = [
  'apps/*/api/index.ts',
  'verticals/*/api/index.ts',
  'packages/core-runtime/src/outbox/process.ts',
];

const DEFAULT_MEMBERS: readonly string[] = [
  'provide',
  'provideService',
  'provideServices',
  'provideServiceEffect',
  'provideReferences',
  // updateService transforms an existing service but retains its requirement in R.
];

interface ResolvedOptions {
  readonly rootFiles: readonly string[];
  readonly members: ReadonlySet<string>;
  readonly includeTests: boolean;
  readonly allowOuterRunSeam: boolean;
}

/** Locals that can name `Effect.provide*` in this module. */
interface ProvideBindings {
  /** `Effect` / `Fx` / `import * as Effect from "effect/Effect"` → the Effect namespace. */
  readonly namespaces: ReadonlySet<string>;
  /** `import * as EffectNs from "effect"` → `EffectNs.Effect.provide`. */
  readonly barrels: ReadonlySet<string>;
  /** `import { provide as supply } from "effect/Effect"` → local `supply` → member `provide`. */
  readonly directMembers: ReadonlyMap<string, string>;
  /** Locals bound to Effect's standalone `pipe` (used to recognise the run seam pipeline). */
  readonly pipes: ReadonlySet<string>;
  readonly directRuns: ReadonlySet<string>;
  readonly any: boolean;
}

function readStringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries;
}

function resolveOptions(context: Context): ResolvedOptions {
  const raw = context.options?.[0];
  const option: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    rootFiles: readStringArray(option.rootFiles, DEFAULT_ROOT_FILES),
    members: new Set(readStringArray(option.members, DEFAULT_MEMBERS)),
    includeTests: option.includeTests === true,
    allowOuterRunSeam: option.allowOuterRunSeam !== false,
  };
}

const RUN_MEMBER = /^run(?:Promise|Sync|Fork|Callback)(?:Exit)?$/u;

/** Preserve root/submodule filtering and run-before-provide-before-pipe priority. */
function collectProvideBindings(
  program: ESTree.Program,
  bindings: EffectBindings,
  members: ReadonlySet<string>,
): ProvideBindings {
  const isRoot = (source: string) => source === EFFECT_ROOT_MODULE;
  const isSubmodule = (source: string) => EFFECT_EFFECT_MODULE.test(source);
  const policy = { valueOnly: true };
  const namespaces = new Set(
    [...bindings.namespaces]
      .filter(([, name]) => name === EFFECT_NAMESPACE)
      .map(([local]) => local),
  );
  const pipes = new Set(
    [...bindings.namespaces].filter(([, name]) => name === PIPE_NAMESPACE).map(([local]) => local),
  );
  const barrels = collectRootNamespaces(program, isRoot, policy);
  for (const local of collectRootNamespaces(program, isSubmodule, policy)) namespaces.add(local);
  for (const [local, name] of collectNamedImports(program, isRoot, undefined, policy)) {
    if (name === EFFECT_NAMESPACE) namespaces.add(local);
    else if (name === PIPE_NAMESPACE) pipes.add(local);
  }
  const direct = collectNamedImports(program, isSubmodule, undefined, policy);
  const directRuns = new Set(
    [...direct].filter(([, name]) => RUN_MEMBER.test(name)).map(([local]) => local),
  );
  const directMembers = new Map(
    [...direct].filter(([, name]) => !RUN_MEMBER.test(name) && members.has(name)),
  );
  for (const [local, name] of direct) {
    if (name === PIPE_NAMESPACE && !members.has(name)) pipes.add(local);
  }
  return {
    namespaces,
    barrels,
    directMembers,
    pipes,
    directRuns,
    any: namespaces.size > 0 || barrels.size > 0 || directMembers.size > 0,
  };
}

/** TS nodes that still contain runtime expressions; every other `TS*` ancestor means a type position. */
const TS_EXPRESSION_NODES = new Set<string>([
  'TSAsExpression',
  'TSInstantiationExpression',
  'TSModuleBlock',
  'TSModuleDeclaration',
  'TSNonNullExpression',
  'TSParameterProperty',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
]);

function isInTypePosition(node: ESTree.Node): boolean {
  return inTypePosition(node, TS_EXPRESSION_NODES);
}

function memberName(node: ESTree.MemberExpression): string | null {
  return staticMemberName(node, { templates: true, rawTemplates: true, singleQuasi: true });
}

/**
 * `Effect.provide` / `Effect["provide"]` / `Effect!.provide` / `EffectNs.Effect.provide` → the member
 * name, or `null` when this member expression is not an Effect combinator reference.
 */
function resolveProvideMember(
  context: Context,
  node: ESTree.MemberExpression,
  bindings: ProvideBindings,
): string | null {
  const member = memberName(node);
  if (member === null) return null;
  const object = unwrap(node.object);
  if (object.type === 'Identifier') {
    if (!bindings.namespaces.has(object.name)) return null;
    return resolvesToImport(context, object) ? member : null;
  }
  // `import * as EffectNs from "effect"` → `EffectNs.Effect.provide`.
  if (object.type !== 'MemberExpression') return null;
  if (memberName(object) !== EFFECT_NAMESPACE) return null;
  const root = unwrap(object.object);
  if (root.type !== 'Identifier') return null;
  if (!bindings.barrels.has(root.name)) return null;
  return resolvesToImport(context, root) ? member : null;
}

function isFunctionLikeBoundary(node: ESTree.Node): boolean {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'StaticBlock' ||
    node.type === 'ClassBody' ||
    node.type === 'MethodDefinition' ||
    node.type === 'PropertyDefinition' ||
    node.type === 'AccessorProperty'
  );
}

/** Wrappers that keep a value inside the same expression pipeline on the way up to a run call. */
function preservesPipeline(node: ESTree.Node): boolean {
  return (
    node.type === 'AwaitExpression' ||
    node.type === 'ChainExpression' ||
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSInstantiationExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSTypeAssertion'
  );
}

/** `program.pipe(...)` or `pipe(program, ...)` — the only links allowed inside the run seam pipeline. */
function isPipeCall(
  context: Context,
  call: ESTree.CallExpression,
  bindings: ProvideBindings,
): boolean {
  const callee = unwrap(call.callee);
  if (callee.type === 'MemberExpression') return memberName(callee) === 'pipe';
  if (callee.type !== 'Identifier') return false;
  if (!bindings.pipes.has(callee.name)) return false;
  return resolvesToImport(context, callee);
}

function isRunReference(context: Context, node: ESTree.Node, bindings: ProvideBindings): boolean {
  const callee = unwrap(node);
  if (callee.type === 'Identifier')
    return bindings.directRuns.has(callee.name) && resolvesToImport(context, callee);
  if (callee.type !== 'MemberExpression') return false;
  const member = resolveProvideMember(context, callee, bindings);
  return member !== null && /^run(?:Promise|Sync|Fork|Callback)(?:Exit)?$/u.test(member);
}

function isModuleEvaluation(node: ESTree.Node): boolean {
  for (let at: ESTree.Node | null = node.parent; at !== null; at = at.parent)
    if (isFunctionLikeBoundary(at)) return false;
  return true;
}

function isProgramParent(parent: ESTree.Node | null): boolean {
  if (parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportDefaultDeclaration')
    parent = parent.parent;
  return parent?.type === 'Program';
}

function entryFunctionIdentifier(
  fn: ESTree.Node,
): Extract<ESTree.Node, { type: 'Identifier' }> | null {
  let parent = fn.parent;
  let id: Extract<ESTree.Node, { type: 'Identifier' }> | null = null;
  if (fn.type === 'FunctionDeclaration') id = fn.id;
  else if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    id = parent.id;
    parent = parent.parent?.parent ?? null;
  }
  return isProgramParent(parent) ? id : null;
}

function isSingleModuleCall(
  context: Context,
  id: Extract<ESTree.Node, { type: 'Identifier' }>,
): boolean {
  const variable = lookupVariable(context, id);
  if (variable === null) return false;
  const reads = variable.references.filter(
    (ref) =>
      ref.isRead() &&
      ref.identifier.parent?.type !== 'ExportSpecifier' &&
      ref.identifier.parent?.type !== 'ExportDefaultDeclaration',
  );
  if (reads.length !== 1) return false;
  const reference = reads[0]?.identifier;
  const call = reference?.parent;
  return call?.type === 'CallExpression' && call.callee === reference && isModuleEvaluation(call);
}

/** Recognise only an immediately invoked wrapper or a single top-level invocation. */
function isEntryFunction(context: Context, fn: ESTree.Node): boolean {
  if (!FUNCTION_TYPES.has(fn.type)) return false;
  const parent = fn.parent;
  if (parent?.type === 'CallExpression' && parent.callee === fn) return isModuleEvaluation(parent);
  const id = entryFunctionIdentifier(fn);
  return id !== null && isSingleModuleCall(context, id);
}

/**
 * True when this reference sits at module top level and is a *direct argument pipeline* of an
 * `Effect.run*` call — the single outer process/framework adapter seam the audit blesses.
 *
 * Two independent conditions must hold, and both are needed:
 *  1. Only module evaluation or a singly invoked module main/IIFE may enclose the seam.
 *     Other callbacks, class bodies and exported library functions are not process seams.
 *  2. The reference reaches the run call through its own call and `pipe`/`.pipe` links only. A provide
 *     laundered through another combinator (`Effect.runSync(Effect.succeed(p.pipe(Effect.provide(L))))`)
 *     escapes the run as a pre-provided library value and is still reported.
 */
interface PipelineState {
  inPipeline: boolean;
  sawRunSeam: boolean;
}

function aliasRead(context: Context, node: ESTree.VariableDeclarator): ESTree.Node | null {
  if (node.id.type !== 'Identifier') return null;
  const variable = lookupVariable(context, node.id);
  const reads = variable?.references.filter((ref) => ref.isRead()) ?? [];
  if (reads.length !== 1 || variable?.references.some((ref) => ref.isWrite() && !ref.init))
    return null;
  return reads[0]!.identifier;
}

function pipelineAlias(
  current: ESTree.Node,
  child: ESTree.Node,
  state: PipelineState,
): current is ESTree.VariableDeclarator {
  return (
    state.inPipeline &&
    !state.sawRunSeam &&
    current.type === 'VariableDeclarator' &&
    current.init === child &&
    current.id.type === 'Identifier'
  );
}

function hasTerminalRun(
  context: Context,
  call: ESTree.CallExpression,
  bindings: ProvideBindings,
): boolean {
  const terminal = call.arguments.at(-1);
  return terminal !== undefined && isRunReference(context, terminal, bindings);
}

function visitPipelineCall(
  context: Context,
  call: ESTree.CallExpression,
  child: ESTree.Node,
  bindings: ProvideBindings,
  state: PipelineState,
): void {
  const pipe = isPipeCall(context, call, bindings);
  if (state.inPipeline && pipe && hasTerminalRun(context, call, bindings)) state.sawRunSeam = true;
  if (Object.is(unwrap(call.callee), child) || Object.is(call.callee, child)) return;
  if (state.inPipeline && !state.sawRunSeam && isRunReference(context, call.callee, bindings))
    state.sawRunSeam = true;
  else if (!pipe) state.inPipeline = false;
}

function visitPipelineNode(
  context: Context,
  current: ESTree.Node,
  child: ESTree.Node,
  bindings: ProvideBindings,
  state: PipelineState,
): void {
  if (current.type === 'CallExpression') {
    visitPipelineCall(context, current, child, bindings, state);
  } else if (current.type === 'MemberExpression') {
    const isObject = Object.is(current.object, child) || Object.is(unwrap(current.object), child);
    if (!isObject || memberName(current) !== 'pipe') state.inPipeline = false;
  } else if (!preservesPipeline(current)) state.inPipeline = false;
}

function isOuterRunSeam(
  context: Context,
  node: ESTree.Node,
  bindings: ProvideBindings,
  hops = 0,
): boolean {
  if (hops > 8) return false;
  let child = node;
  const state: PipelineState = { inPipeline: true, sawRunSeam: false };
  for (let current = node.parent; current !== null; current = current.parent) {
    if (isFunctionLikeBoundary(current) && !isEntryFunction(context, current)) return false;
    if (current.type === 'Program') return state.sawRunSeam;
    if (pipelineAlias(current, child, state)) {
      if (current.parent?.parent?.type === 'ExportNamedDeclaration') return false;
      const read = aliasRead(context, current);
      if (read !== null) return isOuterRunSeam(context, read, bindings, hops + 1);
    }
    visitPipelineNode(context, current, child, bindings, state);
    child = current;
  }
  return state.sawRunSeam;
}

const REFERENCE_KEYS = new Set([
  'Property',
  'PropertyDefinition',
  'MethodDefinition',
  'AccessorProperty',
]);
function isRuntimeImportReference(
  context: Context,
  node: Extract<ESTree.Node, { type: 'Identifier' }>,
): boolean {
  return (
    !nonReferencePosition(node, { keyParents: REFERENCE_KEYS }) &&
    !isInTypePosition(node) &&
    resolvesToImport(context, node)
  );
}

/** S1/A1: keep `Effect.provide*` at the composition root so every program's `R` stays honest. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit S1/A1: disallow Effect.provide/provideService(s) outside the allowlisted composition roots; library programs must let their requirements (R) propagate.',
    },
    messages: {
      provideInLibrary:
        "`Effect.{{member}}` inside library code hides this Effect's real requirements. Let `R` propagate out of this program and satisfy it once at the composition root (the process/browser Layer graph or ManagedRuntime), instead of re-supplying the environment that a nested `Effect.run*` re-entry threw away.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          rootFiles: { type: 'array', items: { type: 'string' } },
          members: { type: 'array', items: { type: 'string' } },
          includeTests: { type: 'boolean' },
          allowOuterRunSeam: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        rootFiles: [...DEFAULT_ROOT_FILES],
        members: [...DEFAULT_MEMBERS],
        includeTests: false,
        allowOuterRunSeam: true,
      },
    ],
  },
  createOnce(context) {
    let options: ResolvedOptions | null = null;
    let bindings: ProvideBindings | null = null;

    const report = (node: ESTree.Node, member: string): void => {
      context.report({ node, messageId: 'provideInLibrary', data: { member } });
    };

    return {
      before() {
        options = resolveOptions(context);
        if (!options.includeTests && isTestFile(context.filename)) return false;
        if (matchesAny(context.filename, options.rootFiles)) return false;
        const imports: EffectBindings = bindingsFor(context);
        if (!imports.importsEffect) return false;
        bindings = collectProvideBindings(context.sourceCode.ast, imports, options.members);
        return bindings.any;
      },
      after() {
        bindings = null;
      },
      MemberExpression(node) {
        const resolved = options;
        const imports = bindings;
        if (resolved === null || imports === null) return;
        const member = resolveProvideMember(context, node, imports);
        if (member === null || !resolved.members.has(member)) return;
        if (isInTypePosition(node)) return;
        if (resolved.allowOuterRunSeam && isOuterRunSeam(context, node, imports)) return;
        report(node, member);
      },
      Identifier(node) {
        const resolved = options;
        const imports = bindings;
        if (resolved === null || imports === null || imports.directMembers.size === 0) return;
        const member = imports.directMembers.get(node.name);
        if (member === undefined || !resolved.members.has(member)) return;
        if (!isRuntimeImportReference(context, node)) return;
        if (resolved.allowOuterRunSeam && isOuterRunSeam(context, node, imports)) return;
        report(node, member);
      },
    };
  },
});
