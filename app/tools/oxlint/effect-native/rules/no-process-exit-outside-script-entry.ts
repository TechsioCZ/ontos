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

import type { Context, ESTree } from '@oxlint/plugins';
import {
  parentOf,
  skipWrappers,
  syntax,
  propertyText,
  unwrapNode as skipTransparent,
} from '../shared/ast.ts';
import { provenance, valueReference } from '../shared/provenance.ts';
import {
  isEntryPosition as isBasicEntryPosition,
  nearestFunction,
} from '../shared/script-entry.ts';
import { scriptScope, inScriptScope, matchesGlobs } from '../shared/paths.ts';
import { stringList, positiveInteger, booleanOption } from '../shared/options.ts';

/** Emitter registration methods whose callback argument is a signal/exit handler. */
const LISTENER_METHODS = new Set([
  'on',
  'once',
  'addListener',
  'prependListener',
  'prependOnceListener',
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
  return {
    allowPaths: stringList(given.allowPaths, DEFAULTS.allowPaths),
    maxExitSites: positiveInteger(given.maxExitSites, DEFAULTS.maxExitSites, 0),
    includeExitCode: booleanOption(given.includeExitCode, DEFAULTS.includeExitCode),
  };
}

/** Effect-run continuations retain the executable position of their originating call. */
function entryContinuation(context: Context, fn: AnyNode): ESTree.CallExpression | null {
  const outer = skipWrappers(fn);
  if (outer.parent?.type !== 'CallExpression') return null;
  const call = outer.parent;
  const callee = syntax(call.callee);
  if (!call.arguments.includes(outer.node as never)) return null;
  if (callee?.type !== 'MemberExpression') return null;
  if (!['then', 'catch', 'finally'].includes(propertyText(callee) ?? '')) return null;
  return isEffectRunChain(context, callee.object) ? call : null;
}

function isEntryPosition(context: Context, site: AnyNode): boolean {
  const fn = nearestFunction(site);
  const continuation = fn === null ? null : entryContinuation(context, fn);
  return continuation === null
    ? isBasicEntryPosition(context, site)
    : isEntryPosition(context, continuation);
}

function processObjectText(context: Context, node: AnyNode): string | null {
  return provenance(context, node) === 'process' ? 'process' : null;
}

const EXIT_PROPERTIES = new Set<string | null>(['exit', 'exitCode', 'kill']);
type SiteKind = 'exit' | 'exitCode' | 'kill';
interface ExitSite {
  readonly node: AnyNode;
  readonly kind: SiteKind;
  readonly site: string;
  readonly start: number;
  readonly end: number;
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
function isSelfKill(call: ESTree.CallExpression, context: Context): boolean {
  const first = (call.arguments as readonly AnyNode[])[0];
  if (first === undefined) return false;
  const argument = skipTransparent(first);
  if (argument.type !== 'MemberExpression') return false;
  const member = argument as ESTree.MemberExpression;
  if (propertyText(member) !== 'pid') return false;
  return processObjectText(context, skipTransparent(member.object as AnyNode)) !== null;
}

function listenerEvent(context: Context, call: ESTree.CallExpression) {
  const callee = skipTransparent(call.callee);
  if (callee.type !== 'MemberExpression') return null;
  const method = propertyText(callee);
  if (method === null || !LISTENER_METHODS.has(method)) return null;
  if (processObjectText(context, skipTransparent(callee.object)) === null) return null;
  const first = call.arguments[0];
  const event =
    first?.type === 'Literal' && typeof first.value === 'string' ? first.value : 'signal';
  return { method, event };
}

/** Find the enclosing process listener registration, retaining literal-only event labels. */
function signalHandlerEvent(context: Context, site: AnyNode) {
  let child = site;
  let parent = parentOf(child);
  while (parent !== null) {
    if (parent.type === 'CallExpression' && parent.arguments.includes(child as never)) {
      const event = listenerEvent(context, parent);
      if (event !== null) return event;
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
    if (matchesGlobs(path, options.allowPaths)) return {};

    const sites: ExitSite[] = [];

    const push = (node: AnyNode, kind: SiteKind, site: string): void => {
      sites.push({ node, kind, site, start: node.start, end: node.end });
    };

    const collectSelfKill = (call: ESTree.CallExpression, objectText: string): void => {
      if (isSelfKill(call, context)) push(call, 'kill', `${objectText}.kill(${objectText}.pid, …)`);
    };
    const collectExitCode = (self: AnyNode, objectText: string): void => {
      if (!options.includeExitCode) return;
      const operator = writeOperator(self);
      if (operator === null) return;
      const written = skipWrappers(self).parent as AnyNode;
      const text =
        operator === '++' || operator === '--'
          ? `${objectText}.exitCode${operator}`
          : `${objectText}.exitCode ${operator} …`;
      push(written, 'exitCode', text);
    };

    return {
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
        const property = propertyText(member);
        if (!EXIT_PROPERTIES.has(property)) return;
        const objectText = processObjectText(context, skipTransparent(member.object as AnyNode));
        if (objectText === null) return;
        const self = node as unknown as AnyNode;
        const { node: reference, parent } = skipWrappers(self);
        const isCallee =
          parent !== null &&
          parent.type === 'CallExpression' &&
          (parent as ESTree.CallExpression).callee === reference;

        if (property === 'exit') {
          push(
            isCallee ? parent : self,
            'exit',
            isCallee ? `${objectText}.exit(…)` : `${objectText}.exit`,
          );
        } else if (property === 'kill') {
          if (isCallee) collectSelfKill(parent as ESTree.CallExpression, objectText);
        } else {
          collectExitCode(self, objectText);
        }
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
          const handler = signalHandlerEvent(context, site.node);
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
