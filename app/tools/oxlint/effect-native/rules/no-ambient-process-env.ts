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
import type { Context, ESTree } from '@oxlint/plugins';

import { keyName as sharedKeyName, memberName, parentOf, skipWrappers, unwrapNode as unwrap } from '../shared/ast.ts';
import { isUnshadowedGlobal, resolveVariable } from '../shared/bindings.ts';
import { booleanOption, stringList } from '../shared/options.ts';
import { includesRuleFile } from '../shared/paths.ts';
import { snippet } from '../shared/reporting.ts';

type AnyNode = ESTree.Node;

/** Modules whose default/namespace export *is* the process object. */
const PROCESS_MODULES = new Set(['process', 'node:process']);

/** Globals that own an `env` bag. */
const ENV_HOSTS = new Set(['process', 'Bun', 'Deno']);

/** Globals that can be used to reach an env host indirectly (`globalThis.process.env`). */
const CONTAINER_GLOBALS = new Set(['globalThis', 'global', 'window', 'self']);

/** `<namespace>.<member>(target, ...)` forms that mutate their first argument. */
const MUTATING_CALLS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['Object', new Set(['assign', 'defineProperty', 'defineProperties'])],
  ['Reflect', new Set(['set', 'defineProperty', 'deleteProperty'])],
]);

const DEFAULT_INCLUDE_PATHS: readonly string[] = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];

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

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Partial<Record<keyof RuleOptions, unknown>>;
  const includePaths = stringList(given.includePaths, DEFAULTS.includePaths);
  return {
    allowPaths: stringList(given.allowPaths, DEFAULTS.allowPaths),
    ignoreTestFiles: booleanOption(given.ignoreTestFiles, DEFAULTS.ignoreTestFiles),
    includePaths: includePaths.length > 0 ? includePaths : DEFAULTS.includePaths,
  };
}

function staticPropertyName(node: ESTree.MemberExpression): string | null {
  return memberName(node, { templates: true, unwrap: {} });
}

function keyName(key: AnyNode | undefined): string | null {
  return sharedKeyName(key, false, { templates: true, unwrap: {} });
}

function isProcessSource(node: AnyNode | undefined): boolean {
  if (!node) return false;
  const source = unwrap(node);
  return source.type !== 'Identifier' && PROCESS_MODULES.has(keyName(source) ?? '');
}

function isProcessImport(specifier: ESTree.ImportDeclaration['specifiers'][number]): boolean {
  const declaration = parentOf(specifier);
  if (declaration?.type !== 'ImportDeclaration' || declaration.importKind === 'type') return false;
  if (!PROCESS_MODULES.has(declaration.source.value)) return false;
  if (specifier.type !== 'ImportSpecifier') return true;
  return specifier.importKind !== 'type' && keyName(specifier.imported) === 'default';
}

function immutableInitializer(declaration: ESTree.VariableDeclarator): AnyNode | null {
  if (declaration.id.type !== 'Identifier' || parentOf(declaration)?.kind !== 'const') return null;
  return declaration.init;
}

function isImportMeta(node: ESTree.MetaProperty): boolean {
  return node.meta.name === 'import' && node.property.name === 'meta';
}

function isContainerHost(context: Context, member: ESTree.MemberExpression): boolean {
  const hostName = staticPropertyName(member);
  if (hostName === null || !ENV_HOSTS.has(hostName)) return false;
  const container = unwrap(member.object);
  return (
    container.type === 'Identifier' &&
    CONTAINER_GLOBALS.has(container.name) &&
    isUnshadowedGlobal(context, container, container.name)
  );
}

function isMutatingCall(context: Context, call: ESTree.CallExpression, reference: AnyNode): boolean {
  if (call.arguments[0] !== reference || call.callee.type !== 'MemberExpression') return false;
  const member = call.callee;
  if (member.object.type !== 'Identifier') return false;
  const namespace = member.object;
  const members = MUTATING_CALLS.get(namespace.name);
  const name = staticPropertyName(member);
  return (
    members !== undefined &&
    name !== null &&
    members.has(name) &&
    isUnshadowedGlobal(context, namespace, namespace.name)
  );
}

function isMutation(context: Context, parent: AnyNode | null, reference: AnyNode): boolean {
  switch (parent?.type) {
    case 'AssignmentExpression':
      return parent.left === reference;
    case 'UnaryExpression':
      return parent.operator === 'delete';
    case 'UpdateExpression':
      return true;
    case 'CallExpression':
      return isMutatingCall(context, parent, reference);
    default:
      return false;
  }
}

function patternSource(node: AnyNode): AnyNode | null {
  const parent = parentOf(node);
  switch (parent?.type) {
    case 'VariableDeclarator':
      return parent.init;
    case 'AssignmentExpression':
    case 'AssignmentPattern':
      return parent.right;
    default:
      return null;
  }
}

function isEnvProperty(property: ESTree.ObjectPattern['properties'][number]): boolean {
  if (property.type !== 'Property') return false;
  return (
    sharedKeyName(property.key, property.computed, {
      templates: true,
      unwrap: {},
    }) === 'env'
  );
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
            description: 'Globs the rule applies to (default: apps/**, verticals/**, packages/**, scripts/**).',
          },
        },
      },
    ],
    defaultOptions: [
      {
        allowPaths: [],
        ignoreTestFiles: false,
        includePaths: [...DEFAULT_INCLUDE_PATHS],
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    if (!includesRuleFile(context.filename, options)) return {};

    const printed = (node: AnyNode): string => snippet(context.sourceCode.getText(node), 72, 69, '...');

    const report = (node: AnyNode, messageId: string): void => {
      context.report({ node, messageId, data: { expression: printed(node) } });
    };

    const identifierHost = (inner: AnyNode & { readonly name: string }, depth: number): boolean => {
      const variable = resolveVariable(context, inner.name, inner);
      const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
      if (definition?.type === 'ImportBinding') {
        return isProcessImport(definition.node as ESTree.ImportDeclaration['specifiers'][number]);
      }
      if (definition?.type === 'Variable') {
        const initializer = immutableInitializer(definition.node as ESTree.VariableDeclarator);
        if (initializer) return isEnvHost(initializer, depth + 1);
      }
      return ENV_HOSTS.has(inner.name) && isUnshadowedGlobal(context, inner, inner.name);
    };

    // Bounded immutable aliases only; no cross-module flow or reassignment inference.
    const isEnvHost = (node: AnyNode, depth = 0): boolean => {
      if (depth > 16) return false;
      const inner = unwrap(node);
      switch (inner.type) {
        case 'AwaitExpression':
          return isEnvHost(inner.argument, depth + 1);
        case 'ImportExpression':
          return isProcessSource(inner.source);
        case 'CallExpression':
          return isUnshadowedGlobal(context, unwrap(inner.callee), 'require') && isProcessSource(inner.arguments[0]);
        case 'MetaProperty':
          return isImportMeta(inner);
        case 'Identifier':
          return identifierHost(inner, depth);
        case 'MemberExpression':
          return isContainerHost(context, inner);
        default:
          return false;
      }
    };

    /** Climb the continued member chain before classifying its consumer. */
    const classify = (envNode: AnyNode): string => {
      let current = skipWrappers(envNode);
      while (current.parent?.type === 'MemberExpression' && current.parent.object === current.node) {
        current = skipWrappers(current.parent);
      }
      return isMutation(context, current.parent, current.node) ? 'ambientEnvMutation' : 'ambientEnvRead';
    };

    return {
      // `import process from "node:process"` / `import { env } from "process"`.
      ImportDeclaration(node) {
        if (node.importKind === 'type' || !PROCESS_MODULES.has(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportDefaultSpecifier' || specifier.type === 'ImportNamespaceSpecifier') {
            continue;
          }
          if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') continue;
          const imported =
            specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
          // `import { env } from "node:process"` *is* the ambient environment bag.
          if (imported === 'env') report(specifier as unknown as AnyNode, 'ambientEnvRead');
        }
      },

      ExportNamedDeclaration(node) {
        if (!node.source || node.exportKind === 'type' || !PROCESS_MODULES.has(node.source.value)) return;
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
        const source = patternSource(node);
        if (source === null || !isEnvHost(source)) return;
        for (const property of node.properties) {
          if (isEnvProperty(property)) report(property, 'ambientEnvRead');
        }
      },
    };
  },
});
