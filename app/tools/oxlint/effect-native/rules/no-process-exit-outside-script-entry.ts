/**
 * effect-native/no-process-exit-outside-script-entry
 *
 * Audit findings enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *   - **B3** "Convert consequential operational scripts into Effect programs" —
 *     "Approximately 79 of 103 scripts are primarily async/await; hundreds of manual throws and
 *     several independent argv parsers remain. […] Use scoped resources, shared Layers, typed
 *     errors, Schema decoders, and `effect/unstable/cli`. **Keep one small process-exit adapter at
 *     the executable edge.**"
 *     42 `process.exit` / `process.exitCode` sites live in 26 scripts today: they terminate the
 *     process from inside helpers and callbacks, so `Scope` finalizers, `Effect.ensuring`, open
 *     database pools and buffered logs never run, and the exit code is decided in several
 *     unrelated places instead of once, from one `Exit`.
 *     Evidence the rule exists for: `scripts/migrate-contacts-authorization.mts:98`,
 *     `scripts/migrate-contacts-authorization.mts:291`, `scripts/postgres/bootstrap-runtime-role.mts:29`,
 *     `scripts/initialize-local-development.mts:652`, `scripts/check-ontos-module-contracts.mts:69`,
 *     `scripts/scaffolding/cli.mts:683`.
 *   - **A8** "Fix the generators before generating more code" — scaffolds, validators and CLIs live
 *     under `scripts/` ("about 28k LOC outside current lint/typecheck coverage"). Every mid-function
 *     `process.exit(1)` a generator or CLI performs is the shape that gets copied into the next
 *     generated MicroVertical, and it is the reason `run-zerops-migrator.mjs` exits from inside a
 *     signal handler — killing the process while the migration fiber still holds resources.
 *
 * ## What is detected (`scripts/**`, tests excluded)
 *
 * Exit sites, where the *process object* is the global `process`, `globalThis.process`,
 * `global.process`, or a `node:process` / `process` default- or namespace-import (aliases included):
 *   1. `process.exit(...)` calls, computed `process["exit"](...)`, optional `process?.exit?.(1)`,
 *      and point-free references (`server.on("close", process.exit)`).
 *   2. `process.exitCode = …` / `||=` / `??=` / `process.exitCode++` writes (`includeExitCode`).
 *   3. `process.kill(process.pid, …)` — self-signalling is `process.exit` with extra steps.
 *   4. `import { exit, exitCode } from "node:process"` bindings: `exit(1)` calls, point-free
 *      `exit` references and writes to `exitCode`, resolved through the scope graph.
 *
 * Each site is classified once, highest priority first:
 *   - `exitInSignalHandler` — the site sits inside an argument of `process.on(...)` / `.once(...)` /
 *     `.addListener(...)` / `.prependListener(...)`. Exiting from a signal handler pre-empts the
 *     running fiber: finalizers, `Scope` release and flushes are skipped by construction.
 *   - `exitInsideFunction` — the site is not at the executable edge (module-evaluation code, a
 *     top-level IIFE, or a Program-level `main` that is only ever invoked from module-evaluation
 *     code, i.e. the `import.meta.url === pathToFileURL(process.argv[1]).href` guard). A helper that
 *     exits cannot be composed, tested, or given a failure channel.
 *   - `extraExitSite` — an edge site beyond `maxExitSites` (default 1). One script decides one exit
 *     code, from one `Exit`.
 *
 * ## What is deliberately allowed
 *
 *   - **The single process-exit adapter at the executable edge** — the audit's "Existing patterns to
 *     preserve" blesses the outer process/framework adapter seam, and B3 asks for exactly one of
 *     them. `const exit = await Effect.runPromiseExit(program); process.exitCode = Exit.match(exit,
 *     { onFailure: () => 1, onSuccess: () => 0 });` at the top level (or in a Program-level `main`
 *     called only from the guard, or a top-level IIFE) never reports.
 *   - **Reads** of `process.exitCode` (`if (process.exitCode !== 0)`) — only writes decide an exit.
 *   - **`process.kill(child.pid, …)` / `kill(pid, "SIGTERM")` on someone else's process** — signalling
 *     a child is resource management, not an exit decision. Only `process.pid` is reported.
 *   - **`result.exitCode`, `child.exitCode`, `spawnSync(...).status`** and every other member access
 *     whose object is not the process object; a local binding named `process` (a parameter, a
 *     variable, an import from anywhere but `node:process`) shadows the global and never reports.
 *   - **Everything outside `scripts/`** — `apps/`, `verticals/`, `packages/`, `tools/`: the browser
 *     and server runtimes have no `process.exit` seam to preserve, and A1/S1 rules own those paths.
 *   - **Test files** (`scripts/tests/**`, `*.test.mts`, `*.spec.ts`, …) — B2 owns the test harness,
 *     and the audit blesses deliberately blunt process handling in fixtures.
 *   - **The rest of the D tier** — `Layer.orDie` at a deliberate startup root, correct Drizzle JSONB
 *     / HttpApi serialization, `JSON.stringify` in external test-fixture APIs and native array
 *     operations contain no exit site, so this rule never touches them.
 *   - **Escape hatches, off by default and unused by the production config:** `allowPaths` (globs),
 *     `maxExitSites` (how many edge sites the adapter may use), `includeExitCode` (drop the
 *     `process.exitCode` writes and report only hard exits).
 *
 * Scope lives in the rule (`scripts/**` minus tests, via `shared/paths.ts`), so `oxlint.config.ts`
 * only needs `'effect-native/no-process-exit-outside-script-entry': 'error'`.
 *
 * Report-only: no fixers, no suggestions.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import {
  globToRegExp,
  isScriptFile,
  isTestFile,
  matchesAny,
  normalisePath,
} from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets the fixtures exercise the real production defaults instead of forcing
 * the fixture config to pass loosened options (which `run-on-repo.mts` reuses verbatim).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

/** `import process from "node:process"` / `"process"`. */
const PROCESS_MODULE = /^(?:node:)?process$/u;

/** Global objects that expose `process` as a property. */
const GLOBAL_OBJECT_NAMES = new Set(['globalThis', 'global']);

/** Emitter registration methods whose callback argument is a signal/exit handler. */
const LISTENER_METHODS = new Set([
  'on',
  'once',
  'addListener',
  'prependListener',
  'prependOnceListener',
]);

/** Wrappers that do not change "is this expression the callee / object / target of its parent". */
const TRANSPARENT_PARENTS = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
  'ChainExpression',
]);

const FUNCTION_LIKE = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
  'StaticBlock',
]);

type AnyNode = ESTree.Node;

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly maxExitSites: number;
  readonly includeExitCode: boolean;
}

const DEFAULTS: RuleOptions = {
  allowPaths: [],
  maxExitSites: 1,
  includeExitCode: true,
};

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Partial<Record<keyof RuleOptions, unknown>>;
  const globs =
    Array.isArray(given.allowPaths) && given.allowPaths.every((entry) => typeof entry === 'string')
      ? (given.allowPaths as readonly string[])
      : DEFAULTS.allowPaths;
  return {
    allowPaths: globs,
    maxExitSites:
      typeof given.maxExitSites === 'number' &&
      Number.isInteger(given.maxExitSites) &&
      given.maxExitSites >= 0
        ? given.maxExitSites
        : DEFAULTS.maxExitSites,
    includeExitCode:
      typeof given.includeExitCode === 'boolean' ? given.includeExitCode : DEFAULTS.includeExitCode,
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real script paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function parentOf(node: AnyNode): AnyNode | null {
  return (node as { parent?: AnyNode | null }).parent ?? null;
}

/** Climb through parentheses/type/chain wrappers; returns the outermost equivalent node and its parent. */
function skipWrappers(node: AnyNode): { readonly node: AnyNode; readonly parent: AnyNode | null } {
  let current = node;
  let parent = parentOf(current);
  while (parent !== null && TRANSPARENT_PARENTS.has(parent.type)) {
    current = parent;
    parent = parentOf(current);
  }
  return { node: current, parent };
}

function nearestFunction(node: AnyNode): AnyNode | null {
  let current = parentOf(node);
  while (current !== null) {
    if (FUNCTION_LIKE.has(current.type)) return current;
    current = parentOf(current);
  }
  return null;
}

/** `true` when the node is evaluated during module evaluation, not inside any function body. */
function isTopLevel(node: AnyNode): boolean {
  return nearestFunction(node) === null;
}

/** A declaration/statement directly in `Program`, optionally behind `export` / `export default`. */
function isProgramLevelStatement(node: AnyNode): boolean {
  const parent = parentOf(node);
  if (parent === null) return false;
  if (parent.type === 'Program') return true;
  if (parent.type !== 'ExportNamedDeclaration' && parent.type !== 'ExportDefaultDeclaration')
    return false;
  return parentOf(parent)?.type === 'Program';
}

/** Name of a Program-level `function main() {}` / `const main = () => {}`, else `null`. */
function programLevelFunctionName(fn: AnyNode): string | null {
  if (fn.type === 'FunctionDeclaration') {
    if (!isProgramLevelStatement(fn)) return null;
    const id = (fn as ESTree.Function).id;
    return id === null || id === undefined ? null : id.name;
  }
  if (fn.type !== 'FunctionExpression' && fn.type !== 'ArrowFunctionExpression') return null;
  const declarator = parentOf(fn);
  if (declarator === null || declarator.type !== 'VariableDeclarator') return null;
  if ((declarator as ESTree.VariableDeclarator).init !== fn) return null;
  const id = (declarator as ESTree.VariableDeclarator).id;
  if (id.type !== 'Identifier') return null;
  const declaration = parentOf(declarator);
  if (declaration === null || declaration.type !== 'VariableDeclaration') return null;
  return isProgramLevelStatement(declaration) ? id.name : null;
}

/** `void (async () => { ... })()` / `(function () { ... })()` evaluated during module evaluation. */
function isTopLevelImmediatelyInvoked(fn: AnyNode): boolean {
  const { node, parent } = skipWrappers(fn);
  if (parent === null || parent.type !== 'CallExpression') return false;
  if ((parent as ESTree.CallExpression).callee !== node) return false;
  return isTopLevel(parent);
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

/** Every use of `main` is a call made during module evaluation (top level or `import.meta.url` guard). */
function isOnlyCalledFromTopLevel(context: Context, fn: AnyNode, name: string): boolean {
  const variable = resolveVariable(context, name, fn);
  if (variable === null) return false;
  const bindingOffsets = new Set(variable.identifiers.map((identifier) => identifier.start));
  const uses = variable.references.filter(
    (reference) => reference.init !== true && !bindingOffsets.has(reference.identifier.start),
  );
  if (uses.length === 0) return false;
  return uses.every((reference) => {
    const { node, parent } = skipWrappers(reference.identifier as unknown as AnyNode);
    if (parent === null || parent.type !== 'CallExpression') return false;
    if ((parent as ESTree.CallExpression).callee !== node) return false;
    return isTopLevel(parent);
  });
}

/**
 * The executable edge of a script: module-evaluation code, a top-level IIFE, or a Program-level
 * `main` that is only ever invoked from module-evaluation code.
 */
function isEntryPosition(context: Context, site: AnyNode): boolean {
  const fn = nearestFunction(site);
  if (fn === null) return true;
  const outer = skipWrappers(fn);
  if (outer.parent?.type === 'CallExpression') {
    const call = outer.parent as ESTree.CallExpression;
    const callee = syntax(call.callee);
    if (
      call.arguments.includes(outer.node as never) &&
      callee?.type === 'MemberExpression' &&
      ['then', 'catch', 'finally'].includes(propertyText(callee) ?? '') &&
      isEffectRunChain(context, callee.object)
    )
      return isEntryPosition(context, call);
  }
  if (nearestFunction(fn) !== null) return false;
  if (isTopLevelImmediatelyInvoked(fn)) return true;
  const name = programLevelFunctionName(fn);
  if (name === null) return false;
  return isOnlyCalledFromTopLevel(context, fn, name);
}

function staticPropertyName(node: ESTree.MemberExpression): string | null {
  const property = syntax(node.property) as AnyNode;
  if (!node.computed)
    return property.type === 'Identifier' ? (property as ESTree.IdentifierName).name : null;
  if (property.type === 'TemplateLiteral') return literalText(property);
  if (property.type !== 'Literal') return null;
  const value = (property as { value?: unknown }).value;
  return typeof value === 'string' ? value : null;
}

/** `true` when the identifier resolves to a global (unresolved, or only implicitly declared). */
function isGlobalIdentifier(context: Context, node: AnyNode, name: string): boolean {
  const variable = resolveVariable(context, name, node);
  if (variable === null) return true;
  return (
    variable.defs.length === 0 ||
    variable.defs.every((definition) => definition.type === 'ImplicitGlobalVariable')
  );
}

interface ProcessBindings {
  /** Locals bound to the whole `node:process` module (`import process from "node:process"`). */
  readonly objectLocals: ReadonlySet<string>;
  /** Locals bound to the named export `exit`. */
  readonly exitLocals: ReadonlySet<string>;
  /** Locals bound to the named export `exitCode`. */
  readonly exitCodeLocals: ReadonlySet<string>;
}

function collectProcessBindings(program: ESTree.Program): ProcessBindings {
  const objectLocals = new Set<string>();
  const exitLocals = new Set<string>();
  const exitCodeLocals = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (!PROCESS_MODULE.test(statement.source.value)) continue;
    for (const specifier of statement.specifiers) {
      if (
        specifier.type === 'ImportDefaultSpecifier' ||
        specifier.type === 'ImportNamespaceSpecifier'
      ) {
        objectLocals.add(specifier.local.name);
        continue;
      }
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported =
        specifier.imported.type === 'Identifier'
          ? specifier.imported.name
          : String(specifier.imported.value);
      if (imported === 'default') objectLocals.add(specifier.local.name);
      else if (imported === 'exit') exitLocals.add(specifier.local.name);
      else if (imported === 'exitCode') exitCodeLocals.add(specifier.local.name);
    }
  }
  return { objectLocals, exitLocals, exitCodeLocals };
}

/** `process`, `globalThis.process`, `global.process`, or a `node:process` default/namespace import. */
function processObjectText(
  context: Context,
  node: AnyNode,
  _bindings: ProcessBindings,
): string | null {
  return provenance(context, node) === 'process' ? 'process' : null;
}

type SiteKind = 'exit' | 'exitCode' | 'kill';

interface ExitSite {
  readonly node: AnyNode;
  readonly kind: SiteKind;
  readonly site: string;
  readonly start: number;
  readonly end: number;
}

function spanOf(node: AnyNode): { readonly start: number; readonly end: number } {
  const span = node as unknown as ESTree.Span;
  return { start: span.start, end: span.end };
}

/** `process.exitCode = 1`, `process.exitCode ||= 2`, `process.exitCode++` — a write, never a read. */
function writeOperator(node: AnyNode): string | null {
  const { node: target, parent } = skipWrappers(node);
  if (parent === null) return null;
  if (parent.type === 'AssignmentExpression') {
    const assignment = parent as ESTree.AssignmentExpression;
    return (assignment.left as unknown as AnyNode) === target ? assignment.operator : null;
  }
  if (parent.type === 'UpdateExpression') {
    const update = parent as ESTree.UpdateExpression;
    return (update.argument as unknown as AnyNode) === target ? update.operator : null;
  }
  return null;
}

/** `process.kill(process.pid, …)`: the first argument must be this process' own pid. */
function isSelfKill(
  call: ESTree.CallExpression,
  context: Context,
  bindings: ProcessBindings,
): boolean {
  const first = (call.arguments as readonly AnyNode[])[0];
  if (first === undefined) return false;
  const argument = skipTransparent(first);
  if (argument.type !== 'MemberExpression') return false;
  const member = argument as ESTree.MemberExpression;
  if (staticPropertyName(member) !== 'pid') return false;
  return processObjectText(context, skipTransparent(member.object as AnyNode), bindings) !== null;
}

/** Strip `(...)`, `as`, `satisfies`, `!`, `<T>` and optional-chaining wrappers from an expression. */
function skipTransparent(node: AnyNode): AnyNode {
  let current = node;
  while (TRANSPARENT_PARENTS.has(current.type)) {
    const inner = (current as { expression?: AnyNode }).expression;
    if (inner === undefined || inner === null) return current;
    current = inner;
  }
  return current;
}

/**
 * `process.on("SIGTERM", …)` / `.once(…)` / `.addListener(…)` containing this site — the signal
 * handler seam, where exiting pre-empts the fiber instead of interrupting it.
 */
function signalHandlerEvent(
  context: Context,
  site: AnyNode,
  bindings: ProcessBindings,
): { readonly method: string; readonly event: string } | null {
  let child: AnyNode = site;
  let parent = parentOf(child);
  while (parent !== null) {
    if (parent.type === 'CallExpression') {
      const call = parent as ESTree.CallExpression;
      if ((call.arguments as readonly AnyNode[]).includes(child)) {
        const callee = skipTransparent(call.callee as AnyNode);
        if (callee.type === 'MemberExpression') {
          const member = callee as ESTree.MemberExpression;
          const method = staticPropertyName(member);
          if (
            method !== null &&
            LISTENER_METHODS.has(method) &&
            processObjectText(context, skipTransparent(member.object as AnyNode), bindings) !== null
          ) {
            const first = (call.arguments as readonly AnyNode[])[0];
            const event =
              first !== undefined &&
              first.type === 'Literal' &&
              typeof (first as { value?: unknown }).value === 'string'
                ? String((first as { value?: unknown }).value)
                : 'signal';
            return { method, event };
          }
        }
      }
    }
    child = parent;
    parent = parentOf(child);
  }
  return null;
}

/** Effect-native rule: a script decides its exit once, at the executable edge, from one `Exit`. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        "Audit B3/A8: process.exit, process.exitCode writes and process.kill(process.pid) belong to the single process-exit adapter at a script's executable edge. Hard exits can skip finalizers; exitCode writes only decide eventual status. Lexical aliases and Effect-run Promise continuations are recognized; arbitrary callback contracts and computed runtime keys are not inferred. The last edge site receives the allowance (a source-order heuristic, not control-flow dominance).",
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#b3-convert-consequential-operational-scripts-into-effect-programs',
    },
    messages: {
      exitCodeInsideFunction:
        'Audit B3/A8: `{{site}}` decides the eventual process status inside a helper. This does not terminate Node or skip finalizers; return the outcome to the single executable-edge adapter instead.',
      exitInsideFunction:
        "Audit B3/A8: `{{site}}` terminates the process from inside a function, so this script's Scope finalizers, Effect.ensuring/onExit handlers, open pools and buffered logs never run, and the failure is invisible to callers. Return a typed Effect failure instead (`yield* new StepFailed({ reason })` / `Effect.fail(...)`) and let the single exit adapter at the executable edge map the Exit to an exit code: `process.exitCode = Exit.match(exit, { onFailure: () => 1, onSuccess: () => 0 })`.",
      extraExitSite:
        'Audit B3: this script already decides its exit at the executable edge; `{{site}}` is another, independent exit decision, so the process outcome depends on which branch happens to reach the process first. Derive one exit code from one `Exit` (`const exit = await Effect.runPromiseExit(program); process.exitCode = Exit.match(exit, { onFailure: () => 1, onSuccess: () => 0 })`) and keep every other failure in the typed error channel.',
      exitInSignalHandler:
        'Audit B3/A8: `{{site}}` inside the `process.{{method}}("{{event}}", …)` handler decides process status outside the executable-edge adapter. Hard exits may skip resource finalizers; exitCode writes do not terminate Node. Interrupt the fiber instead: run the program with `Effect.runFork`, register the listener in a `Scope` (`Effect.acquireRelease` / `Effect.addFinalizer`) and call `Fiber.interrupt(fiber)` so finalizers run, then let the single exit adapter set `process.exitCode` from the resulting `Exit`.',
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
              'Globs of script files exempted from this rule, matched against the repo-relative path (default: none).',
          },
          maxExitSites: {
            type: 'integer',
            minimum: 0,
            description:
              'How many exit sites the executable edge may contain before the rest are reported as extra exit decisions (default: 1 — the single process-exit adapter).',
          },
          includeExitCode: {
            type: 'boolean',
            description:
              'Also treat writes to `process.exitCode` as exit sites (default: true; set to false to report only hard `process.exit` / `process.kill(process.pid, …)` terminations).',
          },
        },
      },
    ],
    defaultOptions: [{ allowPaths: [], maxExitSites: 1, includeExitCode: true }],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    const path = scriptScope(context.filename);
    if (!inScriptScope(path)) return {};
    if (options.allowPaths.some((glob) => globToRegExp(glob).test(path))) return {};

    let bindings: ProcessBindings = {
      objectLocals: new Set<string>(),
      exitLocals: new Set<string>(),
      exitCodeLocals: new Set<string>(),
    };
    const sites: ExitSite[] = [];

    const push = (node: AnyNode, kind: SiteKind, site: string): void => {
      sites.push({ node, kind, site, ...spanOf(node) });
    };

    /** `import { exit, exitCode } from "node:process"`: the local binding really is that import. */
    const isProcessImportBinding = (node: AnyNode, name: string): boolean => {
      const variable = resolveVariable(context, name, node);
      if (variable === null) return false;
      return variable.defs.some((definition) => definition.type === 'ImportBinding');
    };

    return {
      Program(node) {
        bindings = collectProcessBindings(node);
      },
      Identifier(node) {
        const self = node as AnyNode;
        if (!valueReference(context, node)) return;
        const identity = provenance(context, self),
          name = (node as ESTree.IdentifierReference).name;
        if (identity === 'process.exit') {
          const { node: reference, parent: outer } = skipWrappers(self);
          const isCallee =
            outer?.type === 'CallExpression' &&
            (outer as ESTree.CallExpression).callee === reference;
          push(isCallee ? outer : self, 'exit', isCallee ? `${name}(…)` : name);
        }
        // Destructured exitCode is a copied value, not a write to process.exitCode.
      },
      MemberExpression(node) {
        const member = node as ESTree.MemberExpression;
        const property = staticPropertyName(member);
        if (property !== 'exit' && property !== 'exitCode' && property !== 'kill') return;
        const objectText = processObjectText(
          context,
          skipTransparent(member.object as AnyNode),
          bindings,
        );
        if (objectText === null) return;
        const self = node as unknown as AnyNode;
        const { node: reference, parent } = skipWrappers(self);
        const isCallee =
          parent !== null &&
          parent.type === 'CallExpression' &&
          (parent as ESTree.CallExpression).callee === reference;

        if (property === 'exit') {
          // A point-free reference (`process.on("exit", process.exit)`) is still an exit site.
          push(
            isCallee ? (parent as AnyNode) : self,
            'exit',
            isCallee ? `${objectText}.exit(…)` : `${objectText}.exit`,
          );
          return;
        }
        if (property === 'kill') {
          if (!isCallee) return;
          if (!isSelfKill(parent as ESTree.CallExpression, context, bindings)) return;
          push(parent as AnyNode, 'kill', `${objectText}.kill(${objectText}.pid, …)`);
          return;
        }
        if (!options.includeExitCode) return;
        const operator = writeOperator(self);
        if (operator === null) return;
        const written = skipWrappers(self).parent as AnyNode;
        push(
          written,
          'exitCode',
          operator === '++' || operator === '--'
            ? `${objectText}.exitCode${operator}`
            : `${objectText}.exitCode ${operator} …`,
        );
      },
      'Program:exit'() {
        if (sites.length === 0) return;
        const ordered = [...sites].sort((left, right) => right.start - left.start);
        // Drop sites nested inside another site's expression (`process.exitCode = exit(1)`).
        const outer = ordered.filter(
          (site) =>
            !ordered.some(
              (other) =>
                other.node !== site.node && other.start <= site.start && site.end <= other.end,
            ),
        );
        let allowance = options.maxExitSites;
        for (const site of outer) {
          const handler = signalHandlerEvent(context, site.node, bindings);
          if (handler !== null) {
            context.report({
              node: site.node,
              messageId: 'exitInSignalHandler',
              data: { site: site.site, event: handler.event, method: handler.method },
            });
            continue;
          }
          if (!isEntryPosition(context, site.node)) {
            context.report({
              node: site.node,
              messageId: site.kind === 'exitCode' ? 'exitCodeInsideFunction' : 'exitInsideFunction',
              data: { site: site.site },
            });
            continue;
          }
          if (allowance > 0) {
            allowance -= 1;
            continue;
          }
          context.report({
            node: site.node,
            messageId: 'extraExitSite',
            data: { site: site.site },
          });
        }
      },
    };
  },
});

/** Bounded, lexical provenance only; no type checker or interprocedural/data-flow inference. */
type Syntax = ESTree.Node & Record<string, any>;
function syntax(node: unknown): Syntax | null {
  let n = node as Syntax | null;
  while (
    n &&
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'TSTypeAssertion',
      'TSInstantiationExpression',
      'ParenthesizedExpression',
      'ChainExpression',
      'AwaitExpression',
    ].includes(n.type)
  )
    n = n.expression ?? n.argument;
  return n;
}
function lexicalVariable(context: Context, node: Syntax): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope) {
    const v = scope.set.get(node.name);
    if (v) return v;
    scope = scope.upper;
  }
  return null;
}
function literalText(node: unknown): string | null {
  const n = syntax(node);
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'TemplateLiteral' && n.expressions.length === 0)
    return n.quasis[0]?.value.cooked ?? null;
  return null;
}
function propertyText(node: unknown): string | null {
  const n = node as Syntax;
  const key = syntax(n.property ?? n.key);
  return !n.computed && key?.type === 'Identifier' ? key.name : literalText(key);
}
function moduleIdentity(source: string): string {
  if (/^(?:node:)?(?:process|console|util|module)$/.test(source))
    return source.replace(/^node:/, '');
  if (source === 'effect/Effect') return 'Effect';
  if (source === 'effect/ManagedRuntime') return 'ManagedRuntime';
  return source;
}
function bindingPath(pattern: Syntax, name: string): string[] | null {
  if (pattern.type === 'Identifier') return pattern.name === name ? [] : null;
  if (pattern.type === 'AssignmentPattern') return bindingPath(pattern.left, name);
  if (pattern.type !== 'ObjectPattern') return null;
  for (const p of pattern.properties) {
    if (p.type !== 'Property') continue;
    const key = propertyText(p),
      tail = bindingPath(p.value, name);
    if (key !== null && tail !== null) return [key, ...tail];
  }
  return null;
}
function provenance(context: Context, node: unknown, seen = new Set<Variable>()): string | null {
  const n = syntax(node);
  if (!n) return null;
  if (n.type === 'Identifier') {
    const v = lexicalVariable(context, n);
    if (!v || v.defs.length === 0)
      return [
        'process',
        'console',
        'Bun',
        'globalThis',
        'global',
        'window',
        'self',
        'require',
        'Array',
        'Set',
      ].includes(n.name)
        ? n.name
        : null;
    if (seen.has(v) || v.defs.length !== 1) return null;
    const next = new Set(seen);
    next.add(v);
    const def = v.defs[0] as any;
    if (def.type === 'ImportBinding') {
      const spec = def.node as Syntax;
      const decl = (def.parent ?? spec.parent) as Syntax;
      if (decl.importKind === 'type' || spec.importKind === 'type') return null;
      const source = literalText(decl.source);
      if (!source) return null;
      const base = moduleIdentity(source);
      if (spec.type === 'ImportNamespaceSpecifier' || spec.type === 'ImportDefaultSpecifier')
        return base;
      const name = spec.imported?.name ?? spec.imported?.value;
      if (name === 'default') return base;
      if (base === 'effect') return name;
      return `${base}.${name}`;
    }
    if (def.type !== 'Variable' || def.node.type !== 'VariableDeclarator') return null;
    // A declaration is not a reaching-definition analysis: reassigned aliases are unknown.
    if (v.references.some((r: any) => r.init !== true && r.isWrite())) return null;
    const d = def.node as Syntax;
    const base = provenance(context, d.init, next),
      path = bindingPath(d.id, n.name);
    return base !== null && path !== null ? [base, ...path].join('.') : null;
  }
  if (n.type === 'MemberExpression') {
    const base = provenance(context, n.object, seen),
      key = propertyText(n);
    if (base === null || key === null) return null;
    if (
      ['globalThis', 'global', 'window', 'self'].includes(base) &&
      ['process', 'console', 'Bun'].includes(key)
    )
      return key;
    if (['process', 'console', 'util', 'module'].includes(base) && key === 'default') return base;
    if (base === 'effect') return key;
    return `${base}.${key}`;
  }
  if (n.type === 'ImportExpression') {
    const text = literalText(n.source);
    return text === null ? null : moduleIdentity(text);
  }
  if (n.type === 'CallExpression') {
    const callee = provenance(context, n.callee, seen);
    if (callee === 'require') {
      const text = literalText(n.arguments[0]);
      return text === null ? null : moduleIdentity(text);
    }
    if (callee === 'module.createRequire') return 'require';
    if (callee === 'ManagedRuntime.make') return 'Runtime';
  }
  return null;
}
/** Only value references, never property names, bindings or TS-only identifiers. */
function valueReference(context: Context, node: unknown): boolean {
  const n = node as Syntax,
    p = n.parent as Syntax | undefined;
  if (!p) return false;
  if (p.type.startsWith('Import') || p.type === 'ExportSpecifier') return false;
  if (p.type === 'MemberExpression' && p.property === n && !p.computed) return false;
  if (
    [
      'Property',
      'PropertyDefinition',
      'MethodDefinition',
      'TSPropertySignature',
      'TSMethodSignature',
    ].includes(p.type) &&
    p.key === n &&
    !p.computed &&
    !(p.shorthand && p.value === n)
  )
    return false;
  if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(p.type)) return false;
  let child: Syntax = n;
  let parent: Syntax | null = p;
  while (parent) {
    if (
      parent.type.startsWith('TS') &&
      !(
        [
          'TSAsExpression',
          'TSSatisfiesExpression',
          'TSNonNullExpression',
          'TSTypeAssertion',
          'TSInstantiationExpression',
        ].includes(parent.type) && parent.expression === child
      )
    )
      return false;
    if (
      parent.type.endsWith('Statement') ||
      parent.type.endsWith('Declaration') ||
      parent.type.includes('Function')
    )
      break;
    child = parent;
    parent = parent.parent as Syntax | null;
  }
  const v = lexicalVariable(context, n);
  return (
    !v ||
    v.references.some(
      (r: any) =>
        r.identifier === n &&
        r.isRead() &&
        (typeof r.isValueReference !== 'function' || r.isValueReference()),
    )
  );
}
/** Strip fixture scaffolding first; do not renormalise a relative script path around inner markers. */
function scriptScope(filename: string): string {
  const unified = filename.replaceAll('\\', '/');
  const fixture = unified.match(
    /(?:^|\/)tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\/(.*)$/u,
  );
  if (fixture) return fixture[1];
  if (!unified.startsWith('/') && !/^[A-Za-z]:\//u.test(unified))
    return unified.replace(/^\.\//, '');
  const match = unified.match(/(?:^|\/)((?:apps|packages|verticals|scripts|tools)\/.*)$/u);
  return match?.[1] ?? unified;
}
function inScriptScope(path: string): boolean {
  return (
    /(?:^|\/)scripts\//u.test(path) &&
    !/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec|test-d|spec-d)\.[cm]?[jt]sx?$/u.test(path)
  );
}

function isEffectRunChain(context: Context, node: unknown): boolean {
  const n = syntax(node);
  if (n?.type !== 'CallExpression') return false;
  const c = syntax(n.callee),
    id = provenance(context, c);
  if (/^(?:Effect|Runtime)\.run(?:Promise|PromiseExit|Sync|SyncExit)$/u.test(id ?? '')) return true;
  return (
    c?.type === 'MemberExpression' &&
    ['then', 'catch', 'finally'].includes(propertyText(c) ?? '') &&
    isEffectRunChain(context, c.object)
  );
}
