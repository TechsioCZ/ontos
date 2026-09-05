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

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import {
  globToRegExp,
  isScriptFile,
  isTestFile,
  matchesAny,
  normalisePath,
} from '../shared/paths.ts';

type AnyNode = ESTree.Node;

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets the fixtures exercise the real production defaults instead of forcing
 * the fixture config to pass loosened options (which `run-on-repo.mts` reuses verbatim).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

/** Modules whose default/namespace export *is* the ambient console object. */
const CONSOLE_MODULES = new Set(['console', 'node:console']);

/** Modules whose default/namespace export *is* the process object. */
const PROCESS_MODULES = new Set(['process', 'node:process']);

/** Globals that can be used to reach `console` / `process` indirectly (`globalThis.console.log`). */
const CONTAINER_GLOBALS = new Set(['globalThis', 'global', 'window', 'self']);

/** The two ambient byte sinks reachable from `process`. */
const STDIO_STREAMS = new Set(['stdout', 'stderr']);

const DEFAULT_METHODS: readonly string[] = ['error', 'warn', 'debug', 'trace'];

/** Wrappers that do not change "is this expression the callee / object of its parent". */
const TRANSPARENT_PARENTS = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

const FUNCTION_LIKE = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
  'StaticBlock',
]);

/** Parents in which an `Identifier` is a name, not a value reference. */
const NON_REFERENCE_PARENTS = new Set([
  'ImportSpecifier',
  'ImportDefaultSpecifier',
  'ImportNamespaceSpecifier',
  'ExportSpecifier',
  'TSTypeReference',
  'TSQualifiedName',
  'TSTypeQuery',
  'TSPropertySignature',
  'TSMethodSignature',
  'LabeledStatement',
  'BreakStatement',
  'ContinueStatement',
]);

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

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : fallback;
}

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Partial<Record<keyof RuleOptions, unknown>>;
  const methods = stringList(given.methods, DEFAULTS.methods);
  return {
    allowPaths: stringList(given.allowPaths, DEFAULTS.allowPaths),
    methods: methods.length > 0 ? methods : DEFAULTS.methods,
    includeStdio:
      typeof given.includeStdio === 'boolean' ? given.includeStdio : DEFAULTS.includeStdio,
    allowAtEntry:
      typeof given.allowAtEntry === 'boolean' ? given.allowAtEntry : DEFAULTS.allowAtEntry,
    reportReferences:
      typeof given.reportReferences === 'boolean'
        ? given.reportReferences
        : DEFAULTS.reportReferences,
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real script paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function parentOf(node: AnyNode): AnyNode | null {
  return (node as { parent?: AnyNode | null }).parent ?? null;
}

/** Climb through parentheses/type/optional-chain wrappers; returns the outermost node and its parent. */
function skipWrappers(node: AnyNode): { readonly node: AnyNode; readonly parent: AnyNode | null } {
  let current = node;
  let parent = parentOf(current);
  while (parent !== null && TRANSPARENT_PARENTS.has(parent.type)) {
    current = parent;
    parent = parentOf(current);
  }
  return { node: current, parent };
}

/** Strip `(...)`, `as`, `satisfies`, `!`, `<T>` and `a?.b` wrappers from an expression. */
function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (TRANSPARENT_PARENTS.has(current.type)) {
    const inner = (current as { expression?: AnyNode }).expression;
    if (inner === undefined || inner === null) return current;
    current = inner;
  }
  return current;
}

/** `console.log` / `console["log"]` → `"log"`; a dynamic key → `null`. */
function staticPropertyName(node: ESTree.MemberExpression): string | null {
  const property = node.property as AnyNode;
  if (!node.computed)
    return property.type === 'Identifier' ? (property as ESTree.IdentifierName).name : null;
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

/** `true` when `node` is the global `name` — not a local, parameter, class or imported binding. */
function isUnshadowedGlobal(context: Context, node: AnyNode, name: string): boolean {
  if (node.type !== 'Identifier') return false;
  if ((node as ESTree.IdentifierReference).name !== name) return false;
  const variable = resolveVariable(context, name, node);
  return variable === null || variable.defs.length === 0;
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

/** Every use of `main` is a call made during module evaluation (top level or an entry guard). */
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
  if (nearestFunction(fn) !== null) return false;
  if (isTopLevelImmediatelyInvoked(fn)) return true;
  const name = programLevelFunctionName(fn);
  if (name === null) return false;
  return isOnlyCalledFromTopLevel(context, fn, name);
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
    if (!inScriptScope(path) || options.allowPaths.some((glob) => globToRegExp(glob).test(path)))
      return {};
    const methods = new Set(options.methods);
    const report = (node: AnyNode, id: string, data: Record<string, string>) => {
      if (options.allowAtEntry && isEntryPosition(context, node)) return;
      context.report({ node, messageId: id, data });
    };
    const inspect = (node: AnyNode) => {
      const identity = provenance(context, node);
      const { node: outer, parent } = skipWrappers(node);
      if (!parent) return;
      // Assigning a sink is not emitting output. Third-party capture is a forced adapter.
      if (
        parent.type === 'AssignmentExpression' &&
        (parent as ESTree.AssignmentExpression).left === outer
      )
        return;
      // `void sink`/`typeof sink` observes no output, and names/type positions are not references.
      if (
        parent.type === 'UnaryExpression' &&
        ['void', 'typeof'].includes((parent as ESTree.UnaryExpression).operator)
      )
        return;
      const called =
        parent.type === 'CallExpression' && (parent as ESTree.CallExpression).callee === outer;
      if (identity === 'process.stderr.write' && options.includeStdio) {
        report(node, 'stdioWrite', { stream: 'stderr' });
        return;
      }
      if (identity?.startsWith('console.')) {
        const method = identity.slice(8);
        if (!methods.has(method)) return;
        if (isRestoredCapture(context, node)) return;
        if (
          parent.type === 'AssignmentExpression' &&
          parent.right === outer &&
          provenance(context, parent.left) === identity
        )
          return;
        if (called || options.reportReferences)
          report(node, called ? 'consoleCall' : 'consoleReference', { method });
        return;
      }
      // Bare sink handoffs and dynamic method keys do not prove diagnostic output.
      // In particular console.log.bind(console) is still successful operational output.
    };
    return {
      MemberExpression(node) {
        inspect(node);
      },
      Identifier(node) {
        if (valueReference(context, node)) inspect(node as AnyNode);
      },
      ExportNamedDeclaration(node) {
        if (!node.source || !CONSOLE_MODULES.has(node.source.value) || node.exportKind === 'type')
          return;
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

/** Narrow save/restore-in-finally recognition. No claim about the vendor's implementation. */
function isRestoredCapture(context: Context, node: AnyNode): boolean {
  const n = syntax(node),
    p = n?.parent;
  if (!n || p?.type !== 'VariableDeclarator' || p.init !== n || p.id.type !== 'Identifier')
    return false;
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
