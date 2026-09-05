/**
 * effect-native/no-ambient-process-env
 *
 * Audit findings enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *   - A3 "Replace ambient configuration with Config, ConfigProvider, and Redacted" —
 *     "Baseline of 141 `process.env` occurrences; approximately 80–110 hand-parsed configuration
 *     sites". Every ambient read bypasses `Config`, hides the requirement from the Layer graph and
 *     ties the program to the real environment of whatever process happens to load the module.
 *   - B2 "Build one Effect-aware testing harness" — the harness must inject configuration through a
 *     map-backed `ConfigProvider`, so a test that *writes* `process.env` to set up a case is the
 *     same defect seen from the other side and is reported here (message `ambientEnvMutation`).
 *
 * ## What is detected
 *
 *   1. `ambientEnvRead` — the innermost `<host>.env` member expression, reported once no matter how
 *      many further members/optional links follow (`process.env.X`, `process.env["X"]?.trim()`,
 *      `process?.env?.X`). Recognised hosts:
 *        - the unshadowed global `process` (scope walk: a local/parameter/imported `process` never
 *          reports),
 *        - a local bound to the process module (`import process from "node:process"`,
 *          `import * as nodeProcess from "process"`) — aliases included,
 *        - `globalThis|global|window|self` + `.process` / `.Bun` / `.Deno`,
 *        - the unshadowed runtime globals `Bun` and `Deno` (`Deno.env.get("X")`),
 *        - `import.meta.env` (MetaProperty), the bundler-injected variant of the same anti-pattern.
 *      Computed string members are handled (`process["env"]`), so is JSX/TSX.
 *   2. `ambientEnvRead` on a destructured env binding — `const { env } = process`,
 *      `const { env: environment } = globalThis.process`, and
 *      `import { env } from "node:process"` (reported once, on the specifier).
 *   3. `ambientEnvMutation` — the same node when it (after any further member accesses and
 *      parenthesis/cast wrappers) is: the left-hand side of an `AssignmentExpression` with any
 *      operator, the operand of `delete`, the operand of `++`/`--`, or the first argument of
 *      `Object.assign` / `Object.defineProperty` / `Object.defineProperties` /
 *      `Reflect.set` / `Reflect.defineProperty` / `Reflect.deleteProperty`.
 *
 * ## What is deliberately allowed
 *
 *   - Type positions. `type Env = typeof process.env` parses as `TSTypeQuery` + `TSQualifiedName`,
 *     never a `MemberExpression`, and is left to no-environment-record-type.
 *   - Any shadowed binding: `const process = { env: { X: "1" } }` or an injected
 *     `environment: Record<string, string>` parameter. Only the real ambient host reports.
 *   - `.env` *files*: D tier keeps "line-preserving `.env` rewriting where comments and ordering
 *     must survive". This rule never looks at file contents or `dotenv` calls — only at ambient
 *     reads of the live environment object.
 *   - Anything under `allowPaths`. The audit expects framework configs (Modern.js / Rspack / Vitest
 *     config files) that are forced to read the environment at load time to be *reported* until the
 *     team ratifies a carve-out; `allowPaths` is that carve-out, empty by default.
 *   - `ignoreTestFiles: true` drops tests entirely. It is `false` by default because B2 explicitly
 *     wants test configuration to come from `ConfigProvider.fromMap`, not from the ambient
 *     environment. Mutations are reported in both production and test code.
 *
 * Scope lives in the rule (`includePaths` defaults to `apps/**`, `verticals/**`, `packages/**`,
 * `scripts/**` — framework configs and tests included), so `oxlint.config.ts` only needs
 * `'effect-native/no-ambient-process-env': 'error'`.
 *
 * Report-only: no fixers, no suggestions.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { isTestFile, matchesAny, normalisePath } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

/** Normalize real paths and remove only the fixture prefix, preserving nested workspace directories. */
function workspacePath(filename: string): string {
  return normalisePath(filename).replace(
    /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u,
    '',
  );
}

/** Modules whose default/namespace export *is* the process object. */
const PROCESS_MODULES = new Set(['process', 'node:process']);

/** Globals that own an `env` bag. */
const ENV_HOSTS = new Set(['process', 'Bun', 'Deno']);

/** Globals that can be used to reach an env host indirectly (`globalThis.process.env`). */
const CONTAINER_GLOBALS = new Set(['globalThis', 'global', 'window', 'self']);

/** Wrappers that do not change "is this expression the target / object of its parent". */
const TRANSPARENT_PARENTS = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

/** `<namespace>.<member>(target, ...)` forms that mutate their first argument. */
const MUTATING_CALLS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['Object', new Set(['assign', 'defineProperty', 'defineProperties'])],
  ['Reflect', new Set(['set', 'defineProperty', 'deleteProperty'])],
]);

const DEFAULT_INCLUDE_PATHS: readonly string[] = [
  'apps/**',
  'verticals/**',
  'packages/**',
  'scripts/**',
];

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly ignoreTestFiles: boolean;
  readonly includePaths: readonly string[];
}

const DEFAULTS: RuleOptions = {
  allowPaths: [],
  ignoreTestFiles: false,
  includePaths: [...DEFAULT_INCLUDE_PATHS],
};

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : fallback;
}

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Partial<Record<keyof RuleOptions, unknown>>;
  const includePaths = stringList(given.includePaths, DEFAULTS.includePaths);
  return {
    allowPaths: stringList(given.allowPaths, DEFAULTS.allowPaths),
    ignoreTestFiles:
      typeof given.ignoreTestFiles === 'boolean' ? given.ignoreTestFiles : DEFAULTS.ignoreTestFiles,
    includePaths: includePaths.length > 0 ? includePaths : DEFAULTS.includePaths,
  };
}

function parentOf(node: AnyNode): AnyNode | null {
  return (node as { parent?: AnyNode | null }).parent ?? null;
}

/** Climb through parentheses/type wrappers; returns the outermost equivalent node and its parent. */
function skipWrappers(node: AnyNode): { readonly node: AnyNode; readonly parent: AnyNode | null } {
  let current = node;
  let parent = parentOf(current);
  while (parent !== null && TRANSPARENT_PARENTS.has(parent.type)) {
    current = parent;
    parent = parentOf(current);
  }
  return { node: current, parent };
}

/** `process.env` / `process["env"]` → `"env"`; a dynamic key → `null`. */
function staticPropertyName(node: ESTree.MemberExpression): string | null {
  const property = node.property as AnyNode;
  if (!node.computed)
    return property.type === 'Identifier' ? (property as ESTree.IdentifierName).name : null;
  const key = unwrap(property);
  return key.type === 'Identifier' ? null : keyName(key);
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

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (TRANSPARENT_PARENTS.has(current.type))
    current = (current as { expression: AnyNode }).expression;
  return current;
}

function keyName(key: AnyNode | undefined): string | null {
  if (!key) return null;
  key = unwrap(key);
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0)
    return key.quasis[0]?.value.cooked ?? null;
  if (key.type === 'Identifier') return (key as ESTree.IdentifierName).name;
  if (key.type === 'Literal') {
    const value = (key as { value?: unknown }).value;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/** Effect-native rule: configuration is declared with `Config` and provided by one `ConfigProvider`. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A3/B2: ambient `process.env` / `import.meta.env` / `Bun.env` / `Deno.env` reads and mutations bypass Config, ConfigProvider and Redacted, hide the requirement from the Layer graph and make tests depend on the real environment. Syntax-only: bounded immutable local aliases and static keys, not arbitrary cross-module flow or dynamic keys.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#a3-replace-ambient-configuration-with-config-configprovider-and-redacted',
    },
    messages: {
      ambientEnvRead:
        'Audit A3: `{{expression}}` reads the ambient environment, so the requirement never appears in the Layer graph and the value is neither typed nor redactable. Declare it once as `Config.string`/`Config.integer`/`Config.redacted` (or `Config.schema` over the application configuration Schema), consume it with `yield* AppConfig`, and provide the values from the single root `ConfigProvider` composed at startup; tests use `ConfigProvider.fromMap`.',
      ambientEnvMutation:
        'Audit A3/B2: `{{expression}}` mutates the ambient environment, so this code configures itself through a process-global side effect that leaks across tests and cannot be typed or redacted. Provide the values through a map-backed `ConfigProvider` test Layer (`Layer.setConfigProvider(ConfigProvider.fromMap(new Map([...])))`) instead of writing to or deleting from `process.env`.',
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
              'Globs of files allowed to read the ambient environment, e.g. a ratified framework-config carve-out (default: none — framework configs are reported).',
          },
          ignoreTestFiles: {
            type: 'boolean',
            description:
              'Skip test files entirely (default: false — audit B2 wants tests configured through ConfigProvider.fromMap).',
          },
          includePaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs the rule applies to (default: apps/**, verticals/**, packages/**, scripts/**).',
          },
        },
      },
    ],
    defaultOptions: [
      { allowPaths: [], ignoreTestFiles: false, includePaths: [...DEFAULT_INCLUDE_PATHS] },
    ],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    const path = workspacePath(context.filename);
    if (!matchesAny(`/${path}`, options.includePaths)) return {};
    if (matchesAny(`/${path}`, options.allowPaths)) return {};
    if (options.ignoreTestFiles && isTestFile(`/${path}`)) return {};

    const printed = (node: AnyNode): string => {
      const text = context.sourceCode.getText(node).replace(/\s+/gu, ' ').trim();
      return text.length > 72 ? `${text.slice(0, 69)}...` : text;
    };

    const report = (node: AnyNode, messageId: string): void => {
      context.report({ node, messageId, data: { expression: printed(node) } });
    };

    /** `true` when this expression evaluates to an environment-owning host object. */
    // Bounded, scope-resolved immutable aliases only; no cross-module value flow or reassignment inference.
    const isEnvHost = (node: AnyNode, depth = 0): boolean => {
      if (depth > 16) return false;
      const inner = unwrap(node);
      if (inner.type === 'AwaitExpression') return isEnvHost(inner.argument as AnyNode, depth + 1);
      if (inner.type === 'ImportExpression') {
        const source = unwrap(inner.source as AnyNode);
        return source.type !== 'Identifier' && PROCESS_MODULES.has(keyName(source) ?? '');
      }
      if (
        inner.type === 'CallExpression' &&
        isUnshadowedGlobal(context, unwrap(inner.callee as AnyNode), 'require')
      ) {
        const argument = inner.arguments[0];
        if (!argument) return false;
        const source = unwrap(argument as AnyNode);
        return source.type !== 'Identifier' && PROCESS_MODULES.has(keyName(source) ?? '');
      }
      if (inner.type === 'MetaProperty') {
        const meta = inner as ESTree.MetaProperty;
        return meta.meta.name === 'import' && meta.property.name === 'meta';
      }
      if (inner.type === 'Identifier') {
        const name = (inner as ESTree.IdentifierReference).name;
        const variable = resolveVariable(context, name, inner);
        const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
        if (definition?.type === 'ImportBinding') {
          const specifier = definition.node as ESTree.ImportDeclaration['specifiers'][number];
          const declaration = parentOf(specifier as AnyNode) as ESTree.ImportDeclaration;
          return (
            declaration?.type === 'ImportDeclaration' &&
            declaration.importKind !== 'type' &&
            PROCESS_MODULES.has(declaration.source.value) &&
            (specifier.type === 'ImportDefaultSpecifier' ||
              specifier.type === 'ImportNamespaceSpecifier' ||
              (specifier.importKind !== 'type' &&
                keyName(specifier.imported as AnyNode) === 'default'))
          );
        }
        if (definition?.type === 'Variable') {
          const declaration = definition.node as ESTree.VariableDeclarator;
          if (
            declaration.id.type === 'Identifier' &&
            declaration.init &&
            (parentOf(declaration as AnyNode) as ESTree.VariableDeclaration)?.kind === 'const'
          ) {
            return isEnvHost(declaration.init as AnyNode, depth + 1);
          }
        }
        return ENV_HOSTS.has(name) && isUnshadowedGlobal(context, inner, name);
      }
      if (inner.type === 'MemberExpression') {
        // `globalThis.process`, `window.Deno`, `global["process"]`.
        const member = inner as ESTree.MemberExpression;
        const hostName = staticPropertyName(member);
        if (hostName === null || !ENV_HOSTS.has(hostName)) return false;
        const container = unwrap(member.object as AnyNode);
        if (container.type !== 'Identifier') return false;
        const containerName = (container as ESTree.IdentifierReference).name;
        return (
          CONTAINER_GLOBALS.has(containerName) &&
          isUnshadowedGlobal(context, container, containerName)
        );
      }
      return false;
    };

    /**
     * `read` or `mutation` for an `<host>.env` node: climb the member chain the access continues
     * into (`process.env` → `process.env.X` → `process.env.X.y`) and inspect what consumes it.
     */
    const classify = (envNode: AnyNode): string => {
      let current = envNode;
      while (true) {
        const { node: reference, parent } = skipWrappers(current);
        if (parent === null) return 'ambientEnvRead';
        if (
          parent.type === 'MemberExpression' &&
          (parent as ESTree.MemberExpression).object === reference
        ) {
          current = parent;
          continue;
        }
        if (parent.type === 'AssignmentExpression') {
          return (parent as ESTree.AssignmentExpression).left === (reference as never)
            ? 'ambientEnvMutation'
            : 'ambientEnvRead';
        }
        if (
          parent.type === 'UnaryExpression' &&
          (parent as ESTree.UnaryExpression).operator === 'delete'
        ) {
          return 'ambientEnvMutation';
        }
        if (parent.type === 'UpdateExpression') return 'ambientEnvMutation';
        if (parent.type === 'CallExpression') {
          const call = parent as ESTree.CallExpression;
          if ((call.arguments[0] as AnyNode | undefined) !== reference) return 'ambientEnvRead';
          const callee = call.callee as AnyNode;
          if (callee.type !== 'MemberExpression') return 'ambientEnvRead';
          const member = callee as ESTree.MemberExpression;
          const namespace = member.object as AnyNode;
          if (namespace.type !== 'Identifier') return 'ambientEnvRead';
          const namespaceName = (namespace as ESTree.IdentifierReference).name;
          const members = MUTATING_CALLS.get(namespaceName);
          const memberName = staticPropertyName(member);
          if (members === undefined || memberName === null || !members.has(memberName))
            return 'ambientEnvRead';
          return isUnshadowedGlobal(context, namespace, namespaceName)
            ? 'ambientEnvMutation'
            : 'ambientEnvRead';
        }
        return 'ambientEnvRead';
      }
      return 'ambientEnvRead';
    };

    return {
      // `import process from "node:process"` / `import { env } from "process"`.
      ImportDeclaration(node) {
        if (node.importKind === 'type' || !PROCESS_MODULES.has(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === 'ImportDefaultSpecifier' ||
            specifier.type === 'ImportNamespaceSpecifier'
          ) {
            continue;
          }
          if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') continue;
          const imported =
            specifier.imported.type === 'Identifier'
              ? specifier.imported.name
              : specifier.imported.value;
          // `import { env } from "node:process"` *is* the ambient environment bag.
          if (imported === 'env') report(specifier as unknown as AnyNode, 'ambientEnvRead');
        }
      },

      ExportNamedDeclaration(node) {
        if (!node.source || node.exportKind === 'type' || !PROCESS_MODULES.has(node.source.value))
          return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === 'ExportSpecifier' &&
            specifier.exportKind !== 'type' &&
            keyName(specifier.local as AnyNode) === 'env'
          )
            report(specifier as AnyNode, 'ambientEnvRead');
        }
      },

      // The anti-pattern itself: `<host>.env`, reported once at the innermost env node.
      MemberExpression(node) {
        if (staticPropertyName(node) !== 'env') return;
        if (!isEnvHost(node.object as AnyNode)) return;
        report(node as unknown as AnyNode, classify(node as unknown as AnyNode));
      },

      // `const { env } = process` / `const { env: environment } = globalThis.process`.
      ObjectPattern(node) {
        const parent = parentOf(node as unknown as AnyNode);
        if (parent === null) return;
        const source =
          parent.type === 'VariableDeclarator'
            ? ((parent as ESTree.VariableDeclarator).init as AnyNode | null)
            : parent.type === 'AssignmentExpression' || parent.type === 'AssignmentPattern'
              ? ((parent as ESTree.AssignmentExpression).right as AnyNode)
              : null;
        if (source === null || !isEnvHost(source)) return;
        for (const property of node.properties) {
          if (property.type !== 'Property') continue;
          const key = unwrap(property.key as AnyNode);
          if (property.computed && key.type === 'Identifier') continue;
          if (keyName(key) !== 'env') continue;
          report(property as unknown as AnyNode, 'ambientEnvRead');
        }
      },
    };
  },
});
