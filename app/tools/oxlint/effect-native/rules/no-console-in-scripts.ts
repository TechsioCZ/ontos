/**
 * Audit B3/A6: operational script diagnostics belong in Effect logging.
 * Existing oxlint.config.ts script policy intentionally allows successful command output:
 * log/info/table/other non-diagnostic methods and stdout remain legal by default.
 * Detect configured diagnostic methods (error/warn/debug/trace), point-free references,
 * named re-exports, and stderr.write using lexical import/global identity and immutable aliases.
 * Assignment targets and save/restore-in-finally vendor capture are forced adapters (audit D).
 * A bare console object, dynamic method, or ambient declaration does not prove diagnostic output.
 * Includes workspace-local scripts and excludes tests. AST/scope only: no type checker,
 * message interpretation, mutable alias data-flow or cross-file sink inference.
 * Report-only: no fixers or suggestions.
 */
import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree } from '@oxlint/plugins';

import { skipWrappers, syntax } from '../shared/ast.ts';
import { lookupVariable as lexicalVariable } from '../shared/bindings.ts';
import { booleanOption, stringList } from '../shared/options.ts';
import { globToRegExp, inScriptScope, scriptScope } from '../shared/paths.ts';
import { provenance, valueReference } from '../shared/provenance.ts';
import { isEntryPosition, nearestFunction } from '../shared/script-entry.ts';

type AnyNode = ESTree.Node;

const CONSOLE_MODULES = new Set(['console', 'node:console']);
const DEFAULT_METHODS: readonly string[] = ['error', 'warn', 'debug', 'trace'];
const FUNCTION_LIKE = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression', 'StaticBlock']);

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly methods: readonly string[];
  readonly includeStdio: boolean;
  readonly allowAtEntry: boolean;
  readonly reportReferences: boolean;
}

const DEFAULTS: RuleOptions = {
  allowPaths: [],
  methods: [...DEFAULT_METHODS],
  includeStdio: true,
  allowAtEntry: false,
  reportReferences: true,
};

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Partial<Record<keyof RuleOptions, unknown>>;
  const methods = stringList(given.methods, DEFAULTS.methods);
  return {
    allowPaths: stringList(given.allowPaths, DEFAULTS.allowPaths),
    methods: methods.length > 0 ? methods : DEFAULTS.methods,
    includeStdio: booleanOption(given.includeStdio, DEFAULTS.includeStdio),
    allowAtEntry: booleanOption(given.allowAtEntry, DEFAULTS.allowAtEntry),
    reportReferences: booleanOption(given.reportReferences, DEFAULTS.reportReferences),
  };
}

/** Assignment targets and non-emitting unary observations do not use the sink. */
function observesSink(parent: AnyNode, outer: AnyNode): boolean {
  if (parent.type === 'AssignmentExpression') return parent.left === outer;
  return parent.type === 'UnaryExpression' && ['void', 'typeof'].includes(parent.operator);
}

function restoresSink(context: Context, parent: AnyNode, outer: AnyNode, identity: string): boolean {
  return (
    parent.type === 'AssignmentExpression' && parent.right === outer && provenance(context, parent.left) === identity
  );
}

/** Effect-native rule: scripts log through the Effect runtime, never through the ambient console. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B3/A6: operational scripts must log through the Effect runtime. Severity/debug console methods and stderr writes in script segments are reported using lexical import/global identity. Successful operational output (log/info/table and stdout), sink assignments, and save/restore vendor capture are preserved per existing script policy and audit D tier. This is a method-based boundary, not semantic inference of message success; ambient declarations, dynamic levels and opaque sink handoffs remain unknown.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#b3-convert-consequential-operational-scripts-into-effect-programs',
    },
    messages: {
      consoleCall:
        'Audit B3/A6: `console.{{method}}(...)` in a script writes unstructured text outside the Effect runtime — no log level, no annotations, no span, no Logger Layer, and nothing the B2 test harness can capture. Log inside the program instead: `yield* Effect.logInfo(\'Verified role\').pipe(Effect.annotateLogs({ role }))` (`Effect.logError` / `Effect.logWarning` for failures), or use the effect Console service (`import { Console } from "effect"` then `yield* Console.log(report)`), and keep only the process-exit adapter at the executable edge.',
      consoleDynamic:
        'Audit B3/A6: `console[...]` dispatches a log level at runtime, hand-rolling what the Effect Logger already owns. Choose the level at the call site (`Effect.logDebug` / `Effect.logInfo` / `Effect.logWarning` / `Effect.logError`) and let a `Logger.minimumLogLevel` Layer decide what is emitted, instead of indexing the ambient console object.',
      consoleReference:
        'Audit B3/A6: this reference exposes the ambient diagnostic sink `console.{{method}}`. Route the output through the Effect runtime — `Effect.logInfo`/`Effect.logError` with `Effect.annotateLogs`, and a `Logger.replace(...)` / `Logger.add(...)` Layer when the sink must change — so the sink is a Layer in the runtime graph, not a monkey-patched global.',
      consoleObject:
        'Audit B3/A6: handing the ambient `console` object to other code hard-wires the log sink into this script and hides it from the Layer graph. Depend on the effect Console service (`import { Console } from "effect"`) or log with `Effect.log*` and provide the sink as a `Logger` Layer at the runtime root, so tests and the runtime can replace it.',
      stdioWrite:
        "Audit B3/A6: `process.{{stream}}.write(...)` bypasses the Effect runtime entirely — unlevelled, unannotated bytes that no Logger Layer or test harness can intercept. Emit the message with `Effect.logInfo`/`Effect.logError` (annotated) or the effect Console service. If this stream is a deliberate machine-readable data channel at the executable edge rather than logging, that carve-out is the rule's `includeStdio: false` option, which is off by default.",
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
          methods: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Console methods that are reported (default: error, warn, debug, trace; successful operational output remains allowed).',
          },
          includeStdio: {
            type: 'boolean',
            description:
              'Also report process.stderr.write (default: true). stdout remains an operational data/output channel.',
          },
          allowAtEntry: {
            type: 'boolean',
            description:
              'Do not report console sites at the executable edge — module-evaluation code, a top-level IIFE, or a Program-level `main` only ever called from the top level (default: false; the exit adapter should set `process.exitCode` from an Exit, not print).',
          },
          reportReferences: {
            type: 'boolean',
            description:
              'Report captures and point-free references to configured diagnostic methods (default: true). Assignments, bare sinks and dynamic methods are not evidence of diagnostic output.',
          },
        },
      },
    ],
    defaultOptions: [
      {
        allowPaths: [],
        methods: [...DEFAULT_METHODS],
        includeStdio: true,
        allowAtEntry: false,
        reportReferences: true,
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    const path = scriptScope(context.filename);
    if (!inScriptScope(path) || options.allowPaths.some((glob) => globToRegExp(glob).test(path))) return {};
    const methods = new Set(options.methods);
    const report = (node: AnyNode, id: string, data: Record<string, string>) => {
      if (options.allowAtEntry && isEntryPosition(context, node)) return;
      context.report({ node, messageId: id, data });
    };
    const inspectConsole = (node: AnyNode, outer: AnyNode, parent: AnyNode, identity: string) => {
      const method = identity.slice(8);
      if (!methods.has(method)) return;
      if (isRestoredCapture(context, node)) return;
      if (restoresSink(context, parent, outer, identity)) return;
      const called = parent.type === 'CallExpression' && parent.callee === outer;
      if (called || options.reportReferences) report(node, called ? 'consoleCall' : 'consoleReference', { method });
    };
    const inspect = (node: AnyNode) => {
      const identity = provenance(context, node);
      const { node: outer, parent } = skipWrappers(node);
      if (!parent || observesSink(parent, outer)) return;
      if (identity === 'process.stderr.write' && options.includeStdio) {
        report(node, 'stdioWrite', { stream: 'stderr' });
        return;
      }
      if (identity?.startsWith('console.')) inspectConsole(node, outer, parent, identity);
      // Bare sinks and dynamic methods do not prove diagnostic output.
    };
    return {
      MemberExpression(node) {
        inspect(node);
      },
      Identifier(node) {
        if (valueReference(context, node)) inspect(node as AnyNode);
      },
      ExportNamedDeclaration(node) {
        if (!node.source || !CONSOLE_MODULES.has(node.source.value) || node.exportKind === 'type') return;
        for (const s of node.specifiers) {
          if (s.exportKind === 'type') continue;
          const name = s.local.type === 'Identifier' ? s.local.name : s.local.value;
          if (methods.has(name)) report(s, 'consoleReference', { method: name });
        }
      },
    };
  },
});

/** Bounded, lexical provenance only; no type checker or interprocedural/data-flow inference. */
/** Narrow save/restore-in-finally recognition. No claim about the vendor's implementation. */
function isRestoredCapture(context: Context, node: AnyNode): boolean {
  const n = syntax(node),
    p = n?.parent;
  if (!n || p?.type !== 'VariableDeclarator' || p.init !== n || p.id.type !== 'Identifier') return false;
  const variable = lexicalVariable(context, p.id);
  if (!variable) return false;
  const reads = variable.references.filter((r) => r.isRead());
  return (
    reads.length > 0 &&
    reads.every((r: any) => {
      const assignment = r.identifier.parent;
      if (
        assignment?.type !== 'AssignmentExpression' ||
        assignment.right !== r.identifier ||
        provenance(context, assignment.left) !== provenance(context, n)
      )
        return false;
      if (nearestFunction(assignment) !== nearestFunction(n)) return false;
      let child = assignment,
        parent = child.parent;
      while (parent && !FUNCTION_LIKE.has(parent.type)) {
        if (parent.type === 'TryStatement' && parent.finalizer === child) return true;
        child = parent;
        parent = child.parent;
      }
      return false;
    })
  );
}
