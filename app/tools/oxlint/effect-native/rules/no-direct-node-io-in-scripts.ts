/**
 * effect-native/no-direct-node-io-in-scripts
 *
 * Audit findings enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *   - **B3** "Convert consequential operational scripts into Effect programs" —
 *     "Approximately 79 of 103 scripts are primarily async/await […] Prioritize migration,
 *     bootstrap, authorization, topology, and scaffold scripts—not trivial wrappers. Use **scoped
 *     resources**, shared Layers, typed errors, Schema decoders, and `effect/unstable/cli`."
 *     Evidence sites that open files and spawn processes by hand:
 *     `scripts/migrate-contacts-authorization.mts`, `scripts/postgres/bootstrap-runtime-role.mts`,
 *     `scripts/initialize-local-development.mts`, `scripts/check-ontos-module-contracts.mts`,
 *     `scripts/scaffolding/cli.mts`.
 *   - **A8** "Fix the generators before generating more code" — the scaffolds and validators
 *     (`scripts/scaffolding/**`, `scripts/validate-ultramodern-workspace.mts`) are "about 28k LOC
 *     outside current lint/typecheck coverage"; whatever file/process idiom they use is the idiom
 *     every generated MicroVertical inherits. "Bring `scripts/` and `tools/oxlint` under explicit
 *     TypeScript and anti-slop gates."
 *
 * A direct `node:fs` / `node:child_process` dependency is not a stylistic detail. `readFileSync`,
 * `mkdtemp`, `rm`, `spawnSync` and friends:
 *   - open handles, temp directories and child processes that no `Scope` owns, so nothing is
 *     released on interruption or failure;
 *   - throw `ErrnoException` defects instead of producing a typed failure in `E`;
 *   - hard-wire the real filesystem/process into the module, so a script can only be tested by
 *     touching the developer's disk (no `FileSystem.layerNoop`, no in-memory seam);
 *   - bypass the script's `ConfigProvider`, `Clock`, spans and log annotations entirely.
 * The Effect-native answer is a service yielded from the environment — `FileSystem.FileSystem`,
 * `Path.Path`, a command/process service — provided once by the Node platform layer at the
 * executable edge.
 *
 * ## What is detected (`scripts/**` only, tests excluded)
 *
 *   1. `nodeIoImport` — a value `import` (named, default, namespace, side-effect only) or a
 *      re-export (`export … from`) whose specifier is one of `modules`. `node:`-prefixed and bare
 *      specifiers are the same module, and a subpath (`node:fs/promises`, `fs-extra/esm`) matches
 *      its listed root.
 *   2. `nodeIoDynamicImport` — `import("node:fs")` / `await import("node:child_process")` with a
 *      statically known specifier (single-quasi template literals included).
 *   3. `nodeIoRequire` — `require("node:fs")` and `import fs = require("fs")`, where `require` is
 *      either the CommonJS global or a `createRequire(import.meta.url)` binding.
 *   4. `nodeIoCall` — only with `reportCalls: true`: every call of a binding that came from one of
 *      those imports — named (`readFile(path)`, aliased `readFile as read`), default/namespace
 *      (`fs.readFileSync(p)`, `fs.promises.readFile(p)`), computed (`fs["readFileSync"](p)`),
 *      optional (`fs?.readFileSync?.(p)`) and the CommonJS destructured `require` shapes.
 *      Off by default: the import is the coupling, and one diagnostic per import keeps the
 *      migration unit (the file) obvious.
 *
 * Binding identity is resolved through `context.sourceCode.getScope`, so a local `const fs = …`,
 * a parameter named `readFile`, or a `require` rebound to a local helper never reports.
 *
 * ## What is deliberately allowed
 *
 *   - **Type-only imports** — `import type { Dirent } from "node:fs"`, `import { type Stats }`,
 *     `export type { Stats } from "node:fs"`. They are erased; they create no resource.
 *   - **Test files** — `scripts/tests/**`, `scripts/scaffolding/tests/**`, `*.test.mts`, `*.spec.ts`.
 *     B2 owns the test harness migration, and the audit blesses test-local fixture plumbing.
 *   - **Everything outside `scripts/`** — `apps/`, `verticals/`, `packages/`, `tools/` are not
 *     B3's subject; the Node platform seam there is owned by A1/S1 rules.
 *   - **Pure, lifecycle-free builtins** — `node:path`, `node:url`, `node:os`, `node:util`,
 *     `node:assert` are not in `modules` by default. They allocate nothing and release nothing;
 *     flagging them would be the D-tier "native operations where Effect APIs add no semantic
 *     value". Add `node:path` to `modules` once `Path.Path` is provided if you want them too.
 *   - **Generated source inside template literals** — a scaffold that *emits* the text
 *     `import fs from "node:fs"` writes a string, not an `ImportDeclaration`; only the scaffold's
 *     own dependencies report. A8 wants exactly that distinction.
 *   - **`allowPaths`** (default: none) for globs that must keep a direct dependency.
 *   - Nothing in the audit's "Existing patterns to preserve" or D tier involves `node:fs` /
 *     `node:child_process` inside `scripts/`: the blessed items are the single outer process
 *     adapter seam, `Layer.orDie` at a startup root, Drizzle JSONB / HttpApi serialization,
 *     `JSON.stringify` in external test fixtures, deliberately malformed test casts and native
 *     array operations. None of them is touched here.
 *
 * Known false-positive risk recorded by the audit review: the Node platform layer is not yet
 * installed in this repo, so every current hit is a genuine instance of the anti-pattern but the
 * migration is blocked on that dependency decision. The rule is report-only by design.
 *
 * Scope lives in the rule (`scripts/**` minus tests, via `shared/paths.ts`), so `oxlint.config.ts`
 * only needs `'effect-native/no-direct-node-io-in-scripts': 'error'`.
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

/**
 * Modules whose exports open a resource nobody owns: the filesystem (sync and promise flavours,
 * plus the `fs-extra` superset) and child processes (`child_process`, `execa`). `node:`-prefixed
 * and bare specifiers are treated as the same module.
 */
const DEFAULT_MODULES: readonly string[] = [
  'node:fs',
  'fs',
  'node:fs/promises',
  'fs/promises',
  'node:child_process',
  'child_process',
  'fs-extra',
  'execa',
];

/** Wrappers that do not change the value of an expression. */
const TRANSPARENT_TYPES = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
  'ChainExpression',
]);

type AnyNode = ESTree.Node;

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly modules: readonly string[];
  readonly reportCalls: boolean;
}

const DEFAULTS: RuleOptions = {
  allowPaths: [],
  modules: [...DEFAULT_MODULES],
  reportCalls: false,
};

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  return value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : fallback;
}

function readOptions(raw: unknown): RuleOptions {
  const given =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    allowPaths: stringArray(given.allowPaths, DEFAULTS.allowPaths),
    modules: stringArray(given.modules, DEFAULTS.modules),
    reportCalls: typeof given.reportCalls === 'boolean' ? given.reportCalls : DEFAULTS.reportCalls,
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

/** `node:fs/promises` → `fs/promises`; leaves package specifiers untouched. */
function withoutNodeProtocol(specifier: string): string {
  return specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
}

/**
 * `true` when the specifier is one of the configured modules: exact match after dropping the
 * `node:` protocol, or a subpath of a configured root (`fs-extra/esm`, `node:fs/promises` under
 * `fs`), so aliases of the same package cannot slip past the rule.
 */
function isNodeIoSpecifier(specifier: string, modules: readonly string[]): boolean {
  const normalised = withoutNodeProtocol(specifier);
  return modules.some((module) => {
    const candidate = withoutNodeProtocol(module);
    return normalised === candidate || normalised.startsWith(`${candidate}/`);
  });
}

/** The static string value of an `import(...)` / `require(...)` argument, when there is one. */
function staticStringValue(node: AnyNode | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  node = unwrap(node);
  if (node.type === 'Literal') {
    const value = (node as { value?: unknown }).value;
    return typeof value === 'string' ? value : null;
  }
  if (node.type === 'TemplateLiteral') {
    const template = node as ESTree.TemplateLiteral;
    if (template.expressions.length !== 0 || template.quasis.length !== 1) return null;
    return template.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (TRANSPARENT_TYPES.has(current.type)) {
    const inner = (current as { expression?: AnyNode }).expression ?? null;
    if (inner === null) break;
    current = inner;
  }
  return current;
}

function parentOf(node: AnyNode): AnyNode | null {
  return (node as { parent?: AnyNode | null }).parent ?? null;
}

/** Climb through parentheses/type wrappers to the outermost equivalent node. */
function skipWrappers(node: AnyNode): { readonly node: AnyNode; readonly parent: AnyNode | null } {
  let current = node;
  let parent = parentOf(current);
  while (parent !== null && TRANSPARENT_TYPES.has(parent.type)) {
    current = parent;
    parent = parentOf(current);
  }
  return { node: current, parent };
}

/** Non-computed `.readFileSync`, or computed `["readFileSync"]`. */
function staticMemberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) {
    const property = node.property as AnyNode;
    return property.type === 'Identifier' ? (property as ESTree.IdentifierName).name : null;
  }
  return staticStringValue(node.property as AnyNode);
}

function lookupVariable(context: Context, node: AnyNode, name: string): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/** The base identifier of a (possibly nested, possibly optional) member chain: `fs.promises.readFile`. */
function memberChainRoot(
  node: ESTree.MemberExpression,
): { readonly root: AnyNode; readonly path: string[] } | null {
  const path: string[] = [];
  let current: AnyNode = node;
  while (current.type === 'MemberExpression') {
    const member = current as ESTree.MemberExpression;
    path.unshift(staticMemberName(member) ?? '…');
    current = unwrap(member.object as AnyNode);
  }
  return current.type === 'Identifier' ? { path, root: current } : null;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B3/A8: operational scripts must not import node:fs, node:fs/promises, node:child_process, ' +
        'fs-extra or execa directly. Yield the FileSystem / Path / process services provided by the Node ' +
        'platform layer so handles, temp directories and child processes are owned by a Scope and failures ' +
        'are typed. Static loads and lexical import/require bindings only; opaque specifiers and cross-file aliases are not inferred.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#b3-convert-consequential-operational-scripts-into-effect-programs',
    },
    messages: {
      nodeIoImport:
        'Audit B3/A8: this script imports "{{module}}" directly, so its file handles, temp directories and ' +
        'child processes belong to no Scope, its errors are untyped ErrnoException defects, and it can only ' +
        'be tested against the real disk. Yield the services instead — `const fs = yield* FileSystem.FileSystem` ' +
        '(effect/FileSystem), `const path = yield* Path.Path` (effect/Path), a command/process service ' +
        '(effect/unstable/process) — and provide the Node platform layer once at the executable edge.',
      nodeIoDynamicImport:
        'Audit B3/A8: dynamically importing "{{module}}" is the same unscoped filesystem/process dependency, ' +
        'loaded at an unpredictable point. Yield FileSystem.FileSystem / Path.Path / the process service from ' +
        'the Effect environment and let the Node platform layer decide the implementation.',
      nodeIoRequire:
        'Audit B3/A8: require("{{module}}") gives this script an unscoped filesystem/process dependency with ' +
        'untyped throws. Yield FileSystem.FileSystem / Path.Path / the process service instead and provide the ' +
        'Node platform layer once at the executable edge.',
      nodeIoCall:
        'Audit B3/A8: {{call}} from "{{module}}" performs I/O outside the Effect runtime: the resource is not ' +
        'released by a Scope on interruption and the failure is an untyped defect. Replace it with the ' +
        'equivalent service operation (`yield* fs.readFileString(path)`, `fs.makeTempDirectoryScoped()`, a ' +
        'typed command execution) yielded from the Effect environment.',
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
              'Globs of script files allowed to depend on node:fs / node:child_process directly (default: none).',
          },
          modules: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Module specifiers treated as direct Node I/O (default: ["node:fs", "fs", "node:fs/promises", ' +
              '"fs/promises", "node:child_process", "child_process", "fs-extra", "execa"]). The `node:` protocol ' +
              'is ignored when matching and subpaths of a listed root also match.',
          },
          reportCalls: {
            type: 'boolean',
            description:
              'Also report every call of a binding imported from those modules (default: false — the import ' +
              'is the coupling, and one diagnostic per import keeps the migration unit obvious).',
          },
        },
      },
    ],
    defaultOptions: [
      {
        allowPaths: [],
        modules: [...DEFAULT_MODULES],
        reportCalls: false,
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options?.[0]);
    const path = scriptScope(context.filename);
    if (!inScriptScope(path)) return {};
    if (options.allowPaths.some((glob) => globToRegExp(glob).test(path))) return {};

    /** local name → the Node I/O module it came from, for `import` bindings. */
    const importedLocals = new Map<string, string>();
    /** local name → the Node I/O module it came from, for `const fs = require("node:fs")` bindings. */
    const requiredLocals = new Map<string, string>();
    /** Declarator start offsets of the `require` bindings above, to reject same-named shadows. */
    const requiredDeclarators = new Set<number>();

    const isNodeIo = (specifier: string): boolean => isNodeIoSpecifier(specifier, options.modules);

    /** `true` when this identifier reference still resolves to the Node I/O binding we recorded. */
    const resolvesToNodeIo = (node: AnyNode, name: string): string | null => {
      const fromImport = importedLocals.get(name);
      const fromRequire = requiredLocals.get(name);
      if (fromImport === undefined && fromRequire === undefined) return null;
      const variable = lookupVariable(context, node, name);
      // Unresolved: the module-level declaration already proved the binding exists.
      if (variable === null || variable.defs.length === 0) return fromImport ?? fromRequire ?? null;
      if (
        fromImport !== undefined &&
        variable.defs.some((definition) => definition.type === 'ImportBinding')
      ) {
        return fromImport;
      }
      if (fromRequire === undefined) return null;
      const matchesDeclarator = variable.defs.some(
        (definition) =>
          definition.type === 'Variable' &&
          requiredDeclarators.has((definition.node as ESTree.Span).start),
      );
      return matchesDeclarator ? fromRequire : null;
    };

    /**
     * This callee really is a CommonJS `require`: either the global (an unresolved identifier
     * named `require`) or any binding initialised from `createRequire(import.meta.url)`, which
     * is how ESM scripts reach `require` — the local name is often `localRequire` / `req`.
     */
    const isRequireCallee = (node: AnyNode, _name: string): boolean =>
      provenance(context, node) === 'require';

    /** Register `const fs = require("node:fs")` / `const { readFile } = require("node:fs/promises")`. */
    const registerRequireBinding = (call: ESTree.CallExpression, module: string): void => {
      const { parent } = skipWrappers(call as unknown as AnyNode);
      if (parent === null || parent.type !== 'VariableDeclarator') return;
      const declarator = parent as ESTree.VariableDeclarator;
      const id = declarator.id as AnyNode;
      if (id.type === 'Identifier') {
        requiredLocals.set((id as ESTree.BindingIdentifier).name, module);
        requiredDeclarators.add((declarator as ESTree.Span).start);
        return;
      }
      if (id.type !== 'ObjectPattern') return;
      for (const property of (id as ESTree.ObjectPattern).properties) {
        if (property.type !== 'Property') continue;
        const value = property.value as AnyNode;
        if (value.type !== 'Identifier') continue;
        requiredLocals.set((value as ESTree.BindingIdentifier).name, module);
        requiredDeclarators.add((declarator as ESTree.Span).start);
      }
    };

    return {
      ImportDeclaration(node) {
        const module = node.source.value;
        if (!isNodeIo(module)) return;
        // `import type fs from "node:fs"` is erased at runtime and opens nothing.
        if (node.importKind === 'type') return;
        const valueSpecifiers = node.specifiers.filter(
          (specifier) => !(specifier.type === 'ImportSpecifier' && specifier.importKind === 'type'),
        );
        for (const specifier of valueSpecifiers) importedLocals.set(specifier.local.name, module);
        // `import { type Stats } from "node:fs"` — every specifier is type-only: nothing is loaded.
        if (node.specifiers.length > 0 && valueSpecifiers.length === 0) return;
        context.report({ node, messageId: 'nodeIoImport', data: { module } });
      },
      ExportNamedDeclaration(node) {
        const source = node.source;
        if (source === null || source === undefined || !isNodeIo(source.value)) return;
        if (
          node.exportKind === 'type' ||
          (node.specifiers.length > 0 && node.specifiers.every((s) => s.exportKind === 'type'))
        )
          return;
        context.report({ node, messageId: 'nodeIoImport', data: { module: source.value } });
      },
      ExportAllDeclaration(node) {
        if (!isNodeIo(node.source.value)) return;
        if (node.exportKind === 'type') return;
        context.report({ node, messageId: 'nodeIoImport', data: { module: node.source.value } });
      },
      ImportExpression(node) {
        const module = staticStringValue(node.source as AnyNode);
        if (module === null || !isNodeIo(module)) return;
        context.report({ node, messageId: 'nodeIoDynamicImport', data: { module } });
      },
      TSImportEqualsDeclaration(node) {
        const reference = node.moduleReference as AnyNode;
        if (reference.type !== 'TSExternalModuleReference') return;
        const module = staticStringValue(
          (reference as ESTree.TSExternalModuleReference).expression as AnyNode,
        );
        if (module === null || !isNodeIo(module)) return;
        if (node.importKind === 'type') return;
        importedLocals.set(node.id.name, module);
        context.report({ node, messageId: 'nodeIoRequire', data: { module } });
      },
      CallExpression(node) {
        const callee = unwrap(node.callee as AnyNode);

        // `require("node:fs")`, and `const localRequire = createRequire(import.meta.url)` calls.
        if (callee.type === 'Identifier') {
          const calleeName = (callee as ESTree.IdentifierReference).name;
          const required = staticStringValue((node.arguments[0] as AnyNode | undefined) ?? null);
          if (
            required !== null &&
            isNodeIo(required) &&
            isRequireCallee(callee as AnyNode, calleeName)
          ) {
            registerRequireBinding(node, required);
            context.report({ node, messageId: 'nodeIoRequire', data: { module: required } });
            return;
          }
        }

        if (!options.reportCalls) return;

        // `readFile(path)`, `spawnSync(bin, args)`, `read?.(path)` — a named/default binding called directly.
        if (callee.type === 'Identifier') {
          const name = (callee as ESTree.IdentifierReference).name;
          const module = resolvesToNodeIo(callee as AnyNode, name);
          if (module === null) return;
          context.report({ node, messageId: 'nodeIoCall', data: { call: `${name}()`, module } });
          return;
        }

        // `fs.readFileSync(p)`, `fs["readFileSync"](p)`, `fs.promises.readFile(p)`.
        if (callee.type !== 'MemberExpression') return;
        const chain = memberChainRoot(callee as ESTree.MemberExpression);
        if (chain === null) return;
        const rootName = (chain.root as ESTree.IdentifierReference).name;
        const module = resolvesToNodeIo(chain.root, rootName);
        if (module === null) return;
        context.report({
          node,
          messageId: 'nodeIoCall',
          data: { call: `${[rootName, ...chain.path].join('.')}()`, module },
        });
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
