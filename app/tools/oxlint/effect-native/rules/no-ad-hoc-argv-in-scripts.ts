/**
 * Audit B3/A8: consequential scripts should declare arguments with effect/unstable/cli.
 * Detect raw argv indexing/manipulation, aliases, copies/iteration, node:util parseArgs and
 * configured third-party parser loads/re-exports. Import/global identity is lexical; wrappers
 * and literal computed keys are supported. Node entry indices 0/1 are allowed.
 * Passing full argv directly to a call is an opaque CLI seam, not proof of correct parsing.
 * A slice may be pass-through, so the diagnostic does not claim every hit validates arguments.
 * B3 prioritizes consequential scripts over trivial wrappers; this syntactic rule cannot
 * infer operational consequence or child-process flag ownership. No cross-file/mutable alias
 * analysis or arbitrary constant evaluation. Includes workspace-local script segments, not tests.
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

const WORKSPACE_MARKERS: readonly string[] = ['/apps/', '/verticals/', '/packages/', '/scripts/'];

/**
 * Absolute filename → the workspace-relative path the scope globs are written against.
 *
 * The *last* workspace marker wins so real sources (`<root>/scripts/x.mts`) and this plugin's own
 * fixtures (`tools/.../tests/fixtures/<rule>/invalid/scripts/x.mts`) classify identically;
 * `normalisePath` alone would stop at the enclosing `tools/` segment.
 */
function workspacePath(filename: string): string {
  const unified = filename.replaceAll('\\', '/');
  let best = -1;
  for (const marker of WORKSPACE_MARKERS) best = Math.max(best, unified.lastIndexOf(marker));
  return best === -1 ? normalisePath(unified) : unified.slice(best + 1);
}

/** Modules whose default/namespace export *is* the process object. */
const PROCESS_MODULES = new Set(['process', 'node:process']);

/** Modules exposing Node's own argument parser. */
const UTIL_MODULES = new Set(['util', 'node:util']);

/** Globals that own an argv array. */
const ARGV_HOSTS = new Set(['process', 'Bun']);

/** Globals that can be used to reach the process object indirectly (`globalThis.process.argv`). */
const CONTAINER_GLOBALS = new Set(['globalThis', 'global', 'window', 'self']);

/** Wrappers that do not change "is this expression the object / initialiser of its parent". */
const TRANSPARENT = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

/**
 * Third-party CLI argument parsers. The spec's six (`yargs`, `commander`, `minimist`, `cac`, `arg`,
 * `meow`) plus the other common ones in the same class, so a future script cannot sidestep the rule
 * by picking a different package. Subpaths (`yargs/helpers`) resolve to the package name.
 */
const DEFAULT_FORBIDDEN_CLI_MODULES: readonly string[] = [
  'yargs',
  'yargs-parser',
  'commander',
  'minimist',
  'mri',
  'cac',
  'arg',
  'meow',
  'nopt',
  'sade',
  'citty',
  'clipanion',
  'command-line-args',
  '@commander-js/extra-typings',
];

/** Node convention: `argv[0]` is the executable, `argv[1]` the entry module — never user input. */
const DEFAULT_ENTRY_GUARD_INDICES: readonly number[] = [0, 1];

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly allowEntryGuardIndices: readonly number[];
  readonly forbiddenCliModules: readonly string[];
}

const DEFAULTS: RuleOptions = {
  allowPaths: [],
  allowEntryGuardIndices: [...DEFAULT_ENTRY_GUARD_INDICES],
  forbiddenCliModules: [...DEFAULT_FORBIDDEN_CLI_MODULES],
};

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : fallback;
}

function numberList(value: unknown, fallback: readonly number[]): readonly number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number')
    ? (value as readonly number[])
    : fallback;
}

function readOptions(raw: unknown): RuleOptions {
  const given =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    allowPaths: stringList(given.allowPaths, DEFAULTS.allowPaths),
    allowEntryGuardIndices: numberList(
      given.allowEntryGuardIndices,
      DEFAULTS.allowEntryGuardIndices,
    ),
    forbiddenCliModules: stringList(given.forbiddenCliModules, DEFAULTS.forbiddenCliModules),
  };
}

function parentOf(node: AnyNode): AnyNode | null {
  return (node as { parent?: AnyNode | null }).parent ?? null;
}

/** Strip `(...)`, `as`, `satisfies`, `!`, `<T>` and `a?.b` chain wrappers from an expression. */
function unwrap(node: AnyNode | null | undefined): AnyNode | null {
  let current = node ?? null;
  for (let depth = 0; current !== null && depth < 8; depth += 1) {
    if (!TRANSPARENT.has(current.type)) return current;
    const inner = (current as { expression?: AnyNode | null }).expression ?? null;
    if (inner === null) return current;
    current = inner;
  }
  return current;
}

/** `process.argv` / `process["argv"]` → `"argv"`; a dynamic key → `null`. */
function staticPropertyName(node: ESTree.MemberExpression): string | null {
  const property = syntax(node.property) as AnyNode;
  if (!node.computed)
    return property.type === 'Identifier' ? (property as ESTree.IdentifierName).name : null;
  if (property.type === 'TemplateLiteral') return literalText(property);
  if (property.type !== 'Literal') return null;
  const value = (property as { value?: unknown }).value;
  return typeof value === 'string' ? value : null;
}

/** The integer index of a computed member (`argv[2]`, `argv["2"]`), or `null` when it is dynamic. */
function staticIndex(node: ESTree.MemberExpression): number | null {
  if (!node.computed) return null;
  const property = unwrap(node.property as AnyNode);
  if (property === null) return null;
  const value =
    property.type === 'Literal' ? (property as { value?: unknown }).value : literalText(property);
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
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

/** `"yargs/helpers"` → `"yargs"`, `"@commander-js/extra-typings/x"` → `"@commander-js/extra-typings"`. */
function packageName(specifier: string): string {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return specifier;
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) return segments.slice(0, 2).join('/');
  return segments[0] ?? specifier;
}

/** The static string value of an `import(...)` / `require(...)` argument, when there is one. */
function staticStringValue(node: AnyNode | null | undefined): string | null {
  const inner = unwrap(node);
  if (inner === null) return null;
  if (inner.type === 'Literal') {
    const value = (inner as { value?: unknown }).value;
    return typeof value === 'string' ? value : null;
  }
  if (inner.type === 'TemplateLiteral') {
    const template = inner as ESTree.TemplateLiteral;
    if (template.expressions.length !== 0 || template.quasis.length !== 1) return null;
    return template.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/**
 * The array indices a destructuring pattern binds. `null` means "cannot be summarised as a finite
 * set of indices" (a rest element, or an object pattern), which always reports.
 */
function boundIndices(pattern: AnyNode): readonly number[] | null {
  if (pattern.type !== 'ArrayPattern') return null;
  const elements = (pattern as { elements?: readonly (AnyNode | null)[] }).elements ?? [];
  const indices: number[] = [];
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index] ?? null;
    if (element === null) continue;
    if (element.type === 'RestElement') return null;
    indices.push(index);
  }
  return indices;
}

/** Effect-native rule: a script declares its command line with `effect/unstable/cli`, never by hand. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B3/A8: scripts must declare their command line with effect/unstable/cli (Args, Options, Command) ' +
        'instead of parsing process.argv by hand. Every member access, index and destructuring of argv under ' +
        'scripts/** is reported — except the argv[0]/argv[1] entry guard — as are node:util parseArgs and ' +
        'third-party argument parsers. Static lexical provenance includes immutable aliases and literal computed keys; opaque call arguments remain permitted as CLI forwarding seams, not proven CLI identities. Copies and slices are syntactic migration candidates, not proof of parsing.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#b3-convert-consequential-operational-scripts-into-effect-programs',
    },
    messages: {
      argvIndexAccess:
        'Audit B3/A8: `{{expression}}` reads a positional argument straight out of argv, so the value is an ' +
        'unvalidated string and a missing or extra argument becomes a throw instead of usage output. Do not parse ' +
        'process.argv by hand: declare this positional with effect/unstable/cli (`Args.text`, `Args.path`, ' +
        "`Args.choice('mode', ['prepare', 'verify', 'finalize'])`, `Args.withSchema(...)` for a decoded value), " +
        'attach it to `Command.make`, and run the Command once at the executable edge with ' +
        '`Command.run(command, { name, version })(process.argv)`.',
      argvMemberAccess:
        'Audit B3/A8: `{{expression}}` manipulates raw argv — review whether this is parsing or a trivial forwarding adapter. The repository has several ' +
        'independent ones, each producing untyped strings and throw-based validation. Declare the arguments and ' +
        'flags of this script with effect/unstable/cli (`Args.*` for positionals, `Options.boolean` / ' +
        '`Options.text` / `Options.integer` for flags, `Command.make` / `Command.withSubcommands` for the shape) ' +
        'and hand argv to `Command.run(command, { name, version })(process.argv)` at the executable edge instead ' +
        'of slicing, filtering or measuring it here.',
      argvDestructuring:
        'Audit B3/A8: `{{expression}}` destructures raw argv, so every positional arrives as an untyped string ' +
        'and the arity contract lives only in this pattern. Declare the positionals with effect/unstable/cli ' +
        '(`Args.text` / `Args.choice` / `Args.path`, `Args.optional`, `Args.repeated`) on a `Command`, decode ' +
        'them through Schema, and run the Command at the executable edge; only the `process.argv[0]` / ' +
        '`process.argv[1]` entry guard may read argv directly.',
      parseArgsImport:
        'Audit B3/A8: importing `parseArgs` from "{{module}}" declares this script\'s command line a second time, ' +
        'in an untyped vocabulary (`string | boolean` values, a thrown `ERR_PARSE_ARGS_*` on bad input, hand-written ' +
        'usage text). Declare Args/Options with effect/unstable/cli `Command` instead and run the Command at the ' +
        'executable edge.',
      parseArgsCall:
        "Audit B3/A8: `{{expression}}` parses the command line with Node's untyped parser — values come back as " +
        '`string | boolean`, errors are thrown rather than typed, and there is no shared usage or `--help` output. ' +
        'Declare Args/Options with effect/unstable/cli `Command` and run the Command at the executable edge.',
      cliPackageImport:
        'Audit B3/A8: "{{module}}" is a second CLI framework in a repository that already standardises on ' +
        "effect/unstable/cli. Declare this script's Args and Options with `Command.make` (Schema-decoded values, " +
        'typed failures, generated help) and run it with `Command.run(command, { name, version })(process.argv)` ' +
        'at the executable edge.',
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
              'Globs of script files exempted from this rule, matched against the workspace-relative path ' +
              '(default: none — every script declares its command line with effect/unstable/cli).',
          },
          allowEntryGuardIndices: {
            type: 'array',
            items: { type: 'integer' },
            description:
              'argv indices that may be read directly, for the executable-edge entry guard ' +
              '(default: [0, 1] — the node executable and the entry module path; index 2 and beyond are user input).',
          },
          forbiddenCliModules: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Package names of third-party argument parsers that must not be imported (default: yargs, ' +
              'yargs-parser, commander, minimist, mri, cac, arg, meow, nopt, sade, citty, clipanion, ' +
              'command-line-args, @commander-js/extra-typings). Subpaths resolve to the package name.',
          },
        },
      },
    ],
    defaultOptions: [
      {
        allowPaths: [],
        allowEntryGuardIndices: [...DEFAULT_ENTRY_GUARD_INDICES],
        forbiddenCliModules: [...DEFAULT_FORBIDDEN_CLI_MODULES],
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options?.[0]);
    const path = scriptScope(context.filename);
    if (!inScriptScope(path)) return {};
    if (options.allowPaths.some((glob) => globToRegExp(glob).test(path))) return {};

    const allowedIndices = new Set(options.allowEntryGuardIndices);
    const forbiddenModules = new Set(options.forbiddenCliModules);

    /** Locals bound to the process module itself (`import process from "node:process"`). */
    const processLocals = new Set<string>();
    /** Locals bound to `node:util` (`import util from "node:util"`), for `util.parseArgs`. */
    const utilLocals = new Set<string>();
    /** Locals bound to the argv array itself (`import { argv as nodeArgv } from "node:process"`). */
    const argvLocals = new Set<string>();

    const printed = (node: AnyNode): string => {
      const text = context.sourceCode.getText(node).replace(/\s+/gu, ' ').trim();
      return text.length > 72 ? `${text.slice(0, 69)}...` : text;
    };

    const report = (node: AnyNode, messageId: string, data: Record<string, string>): void => {
      context.report({ node, messageId, data });
    };

    const isArgvHost = (node: AnyNode | null): boolean =>
      ['process', 'Bun'].includes(provenance(context, node) ?? '');
    const isArgvSource = (node: AnyNode | null): boolean =>
      ['process.argv', 'Bun.argv'].includes(provenance(context, node) ?? '');

    /** Report a binding/assignment target that is fed directly from argv, unless it is the entry guard. */
    const reportPattern = (target: AnyNode, source: AnyNode, whole: AnyNode): void => {
      if (!isArgvSource(source)) return;
      const indices = boundIndices(target);
      if (indices !== null && indices.every((index) => allowedIndices.has(index))) return;
      report(whole, 'argvDestructuring', { expression: printed(whole) });
    };

    return {
      ImportDeclaration(node) {
        const module = node.source.value;
        const isTypeOnly = node.importKind === 'type';

        if (PROCESS_MODULES.has(module) && !isTypeOnly) {
          for (const specifier of node.specifiers) {
            if (
              specifier.type === 'ImportDefaultSpecifier' ||
              specifier.type === 'ImportNamespaceSpecifier'
            ) {
              processLocals.add(specifier.local.name);
              continue;
            }
            if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') continue;
            const imported =
              specifier.imported.type === 'Identifier'
                ? specifier.imported.name
                : specifier.imported.value;
            // `import { argv } from "node:process"` binds the argv array itself.
            if (imported === 'argv') argvLocals.add(specifier.local.name);
          }
          return;
        }

        if (UTIL_MODULES.has(module) && !isTypeOnly) {
          for (const specifier of node.specifiers) {
            if (
              specifier.type === 'ImportDefaultSpecifier' ||
              specifier.type === 'ImportNamespaceSpecifier'
            ) {
              utilLocals.add(specifier.local.name);
              continue;
            }
            if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') continue;
            const imported =
              specifier.imported.type === 'Identifier'
                ? specifier.imported.name
                : specifier.imported.value;
            if (imported === 'parseArgs') {
              report(specifier as unknown as AnyNode, 'parseArgsImport', { module });
            }
          }
          return;
        }

        if (isTypeOnly) return;
        if (!forbiddenModules.has(packageName(module))) return;
        const valueSpecifiers = node.specifiers.filter(
          (specifier) => !(specifier.type === 'ImportSpecifier' && specifier.importKind === 'type'),
        );
        if (node.specifiers.length > 0 && valueSpecifiers.length === 0) return;
        report(node as unknown as AnyNode, 'cliPackageImport', { module });
      },

      ImportExpression(node) {
        const module = staticStringValue(node.source as AnyNode);
        if (module === null || !forbiddenModules.has(packageName(module))) return;
        report(node as unknown as AnyNode, 'cliPackageImport', { module });
      },

      MemberExpression(node) {
        const member = node as ESTree.MemberExpression;

        // `util.parseArgs(...)` / `util["parseArgs"]` on a node:util default/namespace import.
        if (provenance(context, member) === 'util.parseArgs') {
          report(member, 'parseArgsCall', { expression: printed(member) });
          return;
        }

        // Any access *on* the argv array. `process.argv` itself is only the object here.
        if (!isArgvSource(member.object as AnyNode)) return;
        const index = staticIndex(member);
        if (index !== null) {
          if (allowedIndices.has(index)) return;
          report(member as unknown as AnyNode, 'argvIndexAccess', {
            expression: printed(member as unknown as AnyNode),
          });
          return;
        }
        report(member as unknown as AnyNode, 'argvMemberAccess', {
          expression: printed(member as unknown as AnyNode),
        });
      },

      VariableDeclarator(node) {
        const declarator = node as ESTree.VariableDeclarator;
        const init = declarator.init as AnyNode | null;
        if (init === null) return;
        if (declarator.id.type === 'ObjectPattern') {
          const host = provenance(context, init);
          for (const prop of declarator.id.properties) {
            if (prop.type !== 'Property') continue;
            // Taking argv from the host is an alias; downstream access decides whether it is parsed.
            if (host === 'util' && propertyText(prop) === 'parseArgs')
              report(prop, 'parseArgsImport', { module: 'node:util' });
          }
        }
        reportPattern(declarator.id as AnyNode, init, declarator as unknown as AnyNode);
      },

      AssignmentPattern(node) {
        const pattern = node as ESTree.AssignmentPattern;
        reportPattern(
          pattern.left as AnyNode,
          pattern.right as AnyNode,
          pattern as unknown as AnyNode,
        );
      },

      AssignmentExpression(node) {
        const assignment = node as ESTree.AssignmentExpression;
        if (assignment.operator !== '=') return;
        const target = assignment.left as AnyNode;
        // Only destructuring targets: `foo.bar = process.argv` merely forwards the array on.
        if (
          target.type !== 'Identifier' &&
          target.type !== 'ArrayPattern' &&
          target.type !== 'ObjectPattern'
        )
          return;
        reportPattern(target, assignment.right as AnyNode, assignment as unknown as AnyNode);
      },

      SpreadElement(node) {
        if (isArgvSource(node.argument))
          report(node, 'argvDestructuring', { expression: printed(node) });
      },
      ForOfStatement(node) {
        if (isArgvSource(node.right))
          report(node.right, 'argvMemberAccess', { expression: printed(node.right) });
      },
      NewExpression(node) {
        if (
          ['Set', 'Array'].includes(provenance(context, node.callee) ?? '') &&
          node.arguments.some((a) => isArgvSource(a))
        )
          report(node, 'argvMemberAccess', { expression: printed(node) });
      },
      ExportNamedDeclaration(node) {
        if (
          !node.source ||
          node.exportKind === 'type' ||
          (node.specifiers.length > 0 && node.specifiers.every((s) => s.exportKind === 'type'))
        )
          return;
        const module = node.source.value;
        if (forbiddenModules.has(packageName(module))) report(node, 'cliPackageImport', { module });
      },
      ExportAllDeclaration(node) {
        if (node.exportKind !== 'type' && forbiddenModules.has(packageName(node.source.value)))
          report(node, 'cliPackageImport', { module: node.source.value });
      },
      CallExpression(node) {
        const identity = provenance(context, node.callee);
        if (identity === 'Array.from' && node.arguments.some((a) => isArgvSource(a)))
          report(node, 'argvMemberAccess', { expression: printed(node) });
        if (identity !== 'require') return;
        const module = staticStringValue(node.arguments[0]);
        if (module !== null && forbiddenModules.has(packageName(module)))
          report(node, 'cliPackageImport', { module });
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
