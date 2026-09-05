/**
 * effect-native/no-throw-in-configuration-parser
 *
 * Audit finding enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *   - **A3** "Replace ambient configuration with Config, ConfigProvider, and Redacted" —
 *     "Configuration currently combines `process.env`, per-module dotenv loading, `trim`, `new URL`,
 *     number/range checks, `JSON.parse`, synchronous Schema decoding, **and throws**."
 *     A configuration parser that signals a missing or malformed value by throwing has no typed
 *     failure channel: it may collapse distinct problems into one generic `XConfigError` (or an
 *     untyped defect), the requirement never appears in the Layer graph, and tests cannot drive the
 *     failure through a map-backed `ConfigProvider`.
 *
 *     Concrete evidence the rule exists for:
 *       - `verticals/contacts/api/auth/action-principal.ts:110` — `parseConfiguration(environment)`
 *         throws `configurationError()` six times for six different causes.
 *       - `packages/core-runtime/src/install/spicedb-database-config.ts:26` —
 *         `parseSpiceDbDatabaseBootstrapConfig(environment)` plus its local `parsePostgresUrl`
 *         helper throw plain `Error`s for every range/shape violation.
 *       - `apps/shell-super-app/api/auth/gateway-issuer-config.ts:54` — `parsePrivateJwk`, reached
 *         only from the gateway configuration parser, throws on malformed key material.
 *
 * ## What is detected
 *
 * Two passes over the file.
 *
 * **Pass 1 — which functions are configuration parsers.** A function is marked when any of:
 *   1. it lexically contains an *environment read*:
 *      - an ambient environment host access — `process.env`, `process?.env?.X`, `process["env"]`,
 *        `globalThis.process.env`, `Bun.env`, `Deno.env.get(...)`, `import.meta.env`, a local bound
 *        to the process module (`import process from "node:process"`), or a destructured
 *        `const { env } = process`. A shadowed `process` never counts (scope walk);
 *      - a member read off an identifier whose name matches `environmentIdentifiers`, indexed by a
 *        *variable key* — a computed key (`environment['ONTOS_GATEWAY_ISSUER']`, `environment[key]`)
 *        or a `SCREAMING_SNAKE_CASE` property (`env.PORT`). A plain property such as
 *        `environment.length` is a string, not a bag, and never counts;
 *      - a call to one of `environmentReaders` (`requireEnv("PORT")`).
 *      Every *enclosing* function is marked, not just the innermost one, so a read inside an
 *      `Effect.try({ try: () => … })` callback still marks the exported parser that owns it
 *      (the walk continues upward through call-argument and object-property positions).
 *      A read at module scope marks the module itself.
 *   2. it declares a parameter whose type names an environment record — a `TSTypeReference`
 *      (or qualified name) matching `environmentTypeNames`, e.g. `Environment`, `ProcessEnv`,
 *      `NodeJS.ProcessEnv`, `StageDemoEnvironment`.
 *   3. it declares an optional-string dictionary parameter, including renamed/destructured forms:
 *      `Readonly<Record<string, string | undefined>>`, `Partial<Record<string, string>>`, or an
 *      optional-string index signature. Total header/translation maps are not evidence by themselves.
 *      Untyped parameters matching `environmentIdentifiers` are also marked heuristically.
 *   4. `followLocalHelpers` (default `true`): it is a private file-local function whose references are all calls from
 *      marked functions with configuration-derived inputs, up to `maxHelperDepth` hops. This is what catches `parsePostgresUrl` and
 *      `parsePrivateJwk` — helpers that exist only to parse configuration-derived inputs and that throw
 *      instead of failing.
 *
 * **Pass 2 — the report.** Every `ThrowStatement` whose enclosing function chain contains a marked
 * function (or, at module scope, in a module marked by a top-level environment read) is reported.
 *
 * ## What is deliberately allowed
 *
 *   - **Throws lexically inside an Effect callback.** `Effect.try({ try: () => { throw … } })`,
 *     `Effect.gen(function* () { throw … })`, `Schema.transform(…, { decode: () => { throw … } })`,
 *     `pipe(x, Effect.map(() => { throw … }))` — those callbacks are owned by `effect-native/no-throw-in-effect-callback`. Aliased
 *     (`import { Effect as E }`), submodule (`import * as Schema from "effect/Schema"`) and barrel
 *     namespace imports resolve. A .pipe callback is excluded only when its receiver is a known Effect call.
 *   - **`scripts/**`** — operational scripts are owned by `effect-native/no-throw-in-scripts`, and
 *     the audit's migration order puts them last ("migrate only the consequential scripts first").
 *   - **Test files** (`ignoreTestFiles: true` by default) — the D tier blesses "deliberately
 *     malformed casts in tests proving rejection behaviour", and a test that throws to fail fast is
 *     not a configuration parser.
 *   - **Throws with no configuration provenance.** `const parseHttpOrigin = (value: string) => { …
 *     throw new Error('x') }` never reads the environment and takes no environment record, so it is
 *     not reported: this rule is about *configuration* failures, not about `throw` in general.
 *   - **A value merely *named* `environment`.** `deriveDeploymentAllowlist` destructures a deployment
 *     environment *name* and calls `environment.length`; because the property is not a variable key
 *     the function is not a configuration parser, and its JSON-decode throws (audit A2/A4 territory)
 *     are left alone.
 *   - **A shadowed environment host** — a parameter or local named `process`/`env` that is plainly
 *     an injected port (`(process: { readonly env: Record<string, string> }) => …`) resolves through
 *     the scope chain and does not turn its function into a parser.
 *   - **Type positions.** `typeof process.env` parses as `TSTypeQuery`, never a `MemberExpression`.
 *   - Anything under `allowPaths` (empty by default) or outside `includePaths`.
 *
 * Syntax-only limitations: reader/record names and optional-string dictionary shapes are heuristics,
 * not proof of configuration semantics. Lexical ownership cannot distinguish every throw's purpose.
 * Aliases and simple local returns have bounded provenance; arbitrary cross-module flow is not inferred.
 * The rule never fixes and never suggests.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the production defaults instead of forcing the fixture
 * config (which `run-on-repo.mts` reuses verbatim) to loosen options.
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE_PATHS: readonly string[] = ['apps/**', 'verticals/**', 'packages/**'];

/** Spec default: alias names that stand for "the environment record". */
const DEFAULT_ENVIRONMENT_TYPE_NAMES = '(^|\\.)(Environment|ProcessEnv|StageDemoEnvironment)$';

/** Binding names that stand for an environment bag (`environment['X']`, `env.PORT`). */
const DEFAULT_ENVIRONMENT_IDENTIFIERS =
  '^(?:environment|env|processEnv|rawEnv|rawEnvironment|envRecord|environmentRecord|envVars|environmentVariables)$';

/** Hand-rolled "read one environment variable" helpers. */
const DEFAULT_ENVIRONMENT_READERS: readonly string[] = [
  'getEnv',
  'readEnv',
  'requireEnv',
  'requiredEnv',
  'getRequiredEnv',
  'optionalEnv',
  'envVar',
  'getEnvVar',
  'readEnvVar',
  'requireEnvVar',
  'getEnvironmentVariable',
  'readEnvironmentVariable',
  'requireEnvironmentVariable',
];

const DEFAULT_MAX_HELPER_DEPTH = 3;

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** Modules whose default/namespace export *is* the process object. */
const PROCESS_MODULES = new Set(['process', 'node:process']);

/** Globals that own an `env` bag. */
const ENV_HOSTS = new Set(['process', 'Bun', 'Deno']);

/** Globals that reach an env host indirectly (`globalThis.process.env`). */
const CONTAINER_GLOBALS = new Set(['globalThis', 'global', 'window', 'self']);

/** Wrappers that keep a function in "argument of the enclosing call" position. */
const TRANSPARENT = new Set([
  'ChainExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
]);
function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (TRANSPARENT.has(current.type)) current = (current as { expression: AnyNode }).expression;
  return current;
}
function parentOf(node: AnyNode): AnyNode | null {
  return (node as { parent?: AnyNode }).parent ?? null;
}
const ARGUMENT_WRAPPERS = new Set([
  'Property',
  'ObjectExpression',
  'ArrayExpression',
  'SpreadElement',
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
]);

/**
 * Effect module namespaces. Used only to *widen the exclusion* of throws already owned by
 * `no-throw-in-effect-callback`, so a barrel access (`E.Effect.try`) that `effectMember` cannot
 * resolve still counts as an Effect callback rather than becoming a duplicate report here.
 */
const EFFECT_NAMESPACES = new Set([
  'Effect',
  'Layer',
  'Schema',
  'Stream',
  'Sink',
  'Option',
  'Result',
  'Either',
  'Match',
  'Config',
  'ConfigProvider',
  'Schedule',
  'STM',
  'Fiber',
  'Ref',
  'SynchronizedRef',
  'Cause',
  'Exit',
  'Pool',
  'Queue',
  'PubSub',
  'Metric',
  'Micro',
  'Data',
  'Chunk',
  'Predicate',
  'Duration',
  'Console',
  'Runtime',
  'ManagedRuntime',
  'Scope',
  'Deferred',
  'Cache',
  'Semaphore',
]);

/** Environment variables are `SCREAMING_SNAKE_CASE`; `environment.length` is not a variable read. */
const ENV_VARIABLE_KEY = /^[A-Z][A-Z0-9_]*$/u;

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly ignoreTestFiles: boolean;
  readonly includePaths: readonly string[];
  readonly environmentIdentifiers: string;
  readonly environmentReaders: readonly string[];
  readonly environmentTypeNames: string;
  readonly followLocalHelpers: boolean;
  readonly maxHelperDepth: number;
}

const DEFAULTS: RuleOptions = {
  allowPaths: [],
  ignoreTestFiles: true,
  includePaths: [...DEFAULT_INCLUDE_PATHS],
  environmentIdentifiers: DEFAULT_ENVIRONMENT_IDENTIFIERS,
  environmentReaders: [...DEFAULT_ENVIRONMENT_READERS],
  environmentTypeNames: DEFAULT_ENVIRONMENT_TYPE_NAMES,
  followLocalHelpers: true,
  maxHelperDepth: DEFAULT_MAX_HELPER_DEPTH,
};

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function safeRegExp(source: string, fallback: string): RegExp {
  try {
    return new RegExp(source, 'u');
  } catch {
    return new RegExp(fallback, 'u');
  }
}

function readOptions(context: Context): RuleOptions {
  const raw = context.options?.[0];
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const includePaths = stringArray(record.includePaths, DEFAULTS.includePaths);
  const depth = record.maxHelperDepth;
  return {
    allowPaths: stringArray(record.allowPaths, DEFAULTS.allowPaths),
    ignoreTestFiles: record.ignoreTestFiles !== false,
    includePaths: includePaths.length > 0 ? includePaths : DEFAULTS.includePaths,
    environmentIdentifiers:
      typeof record.environmentIdentifiers === 'string'
        ? record.environmentIdentifiers
        : DEFAULTS.environmentIdentifiers,
    environmentReaders: stringArray(record.environmentReaders, DEFAULTS.environmentReaders),
    environmentTypeNames:
      typeof record.environmentTypeNames === 'string'
        ? record.environmentTypeNames
        : DEFAULTS.environmentTypeNames,
    followLocalHelpers: record.followLocalHelpers !== false,
    maxHelperDepth:
      typeof depth === 'number' && Number.isInteger(depth) && depth >= 0
        ? depth
        : DEFAULTS.maxHelperDepth,
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function isFunctionNode(node: AnyNode | undefined): boolean {
  return node !== undefined && FUNCTION_TYPES.has(node.type);
}

/** `process.env` / `process["env"]` → `"env"`; a dynamic key → `null`. */
function staticPropertyName(node: ESTree.MemberExpression): string | null {
  const property = node.property as AnyNode;
  if (!node.computed)
    return property.type === 'Identifier' ? (property as ESTree.IdentifierName).name : null;
  if (property.type === 'TemplateLiteral' && property.expressions.length === 0)
    return property.quasis[0]?.value.cooked ?? null;
  if (property.type !== 'Literal') return null;
  const value = (property as { value?: unknown }).value;
  return typeof value === 'string' ? value : null;
}

/** `NodeJS.ProcessEnv` → `"NodeJS.ProcessEnv"`; a computed/import type → `null`. */
function qualifiedTypeName(node: AnyNode): string | null {
  if (node.type === 'Identifier') return (node as ESTree.IdentifierName).name;
  if (node.type !== 'TSQualifiedName') return null;
  const qualified = node as ESTree.TSQualifiedName;
  const left = qualifiedTypeName(qualified.left as AnyNode);
  const right = qualifiedTypeName(qualified.right as AnyNode);
  return left === null || right === null ? null : `${left}.${right}`;
}

function keyName(key: AnyNode): string | null {
  if (key.type === 'Identifier') return (key as ESTree.IdentifierName).name;
  if (key.type === 'Literal') {
    const value = (key as { value?: unknown }).value;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

interface ThrowRecord {
  readonly node: AnyNode;
  /** `start` offsets of every enclosing function, outermost first. */
  readonly chain: readonly number[];
  readonly insideEffectCallback: boolean;
}

/** Effect-native rule: configuration failures are typed `ConfigError`s, never thrown. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A3: configuration parsers must not signal a missing or malformed value with `throw`. A thrown ' +
        'configuration failure is signalled synchronously and keeps the requirement out of the Layer graph rather than being ' +
        'driven from a map-backed `ConfigProvider` in tests. Model the value with `Config`/`Config.schema` or ' +
        'return `Effect.fail(new XConfigError(...))`. Syntax-only: record names and lexical ownership are heuristics; only bounded local return/alias provenance and private helper calls are followed.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#a3-replace-ambient-configuration-with-config-configprovider-and-redacted',
    },
    messages: {
      throwInConfigurationParser:
        'Audit A3: configuration parsers must not throw. This `throw` sits in a function that reads the ' +
        'environment (or takes an environment record), so missing or malformed values are signalled synchronously rather than through Config. Model the value with ' +
        '`Config.string`/`Config.integer`/`Config.redacted`/`Config.schema(...)` so absence and malformation ' +
        'are typed `ConfigError`s decoded by the root `ConfigProvider`, or return ' +
        '`Effect.fail(new XConfigError({ reason: ... }))` from an `Effect`-returning parser.',
      throwInConfigurationHelper:
        'Audit A3: this `throw` is inside `{{helper}}`, a file-local helper reached only from a configuration ' +
        'parser, so a malformed value escapes as an untyped defect instead of a typed failure. Move the check ' +
        'into the owning Schema (`Schema.filter`/`Schema.transformOrFail`) and decode it through ' +
        '`Config.schema(...)`, or return `Effect.fail(new XConfigError({ reason: ... }))` instead of throwing.',
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
              'Globs of files allowed to throw from a configuration parser (default: none).',
          },
          ignoreTestFiles: {
            type: 'boolean',
            description:
              'Skip test files (default: true — the D tier blesses fail-fast throws in tests).',
          },
          includePaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs the rule applies to (default: apps/**, verticals/**, packages/**; scripts/** is owned by no-throw-in-scripts).',
          },
          environmentIdentifiers: {
            type: 'string',
            description:
              'Regular expression for binding names that stand for an environment record (default matches environment, env, processEnv, ...).',
          },
          environmentReaders: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Hand-rolled single-variable readers whose call counts as an environment read.',
          },
          environmentTypeNames: {
            type: 'string',
            description:
              "Regular expression matched against a parameter's type name (default: (^|\\.)(Environment|ProcessEnv|StageDemoEnvironment)$).",
          },
          followLocalHelpers: {
            type: 'boolean',
            description:
              'Also mark file-local functions called from a configuration parser (default: true) — catches parsePostgresUrl/parsePrivateJwk style helpers.',
          },
          maxHelperDepth: {
            type: 'integer',
            minimum: 0,
            description: 'How many local call hops followLocalHelpers propagates (default: 3).',
          },
        },
      },
    ],
    defaultOptions: [
      {
        allowPaths: [],
        ignoreTestFiles: true,
        includePaths: [...DEFAULT_INCLUDE_PATHS],
        environmentIdentifiers: DEFAULT_ENVIRONMENT_IDENTIFIERS,
        environmentReaders: [...DEFAULT_ENVIRONMENT_READERS],
        environmentTypeNames: DEFAULT_ENVIRONMENT_TYPE_NAMES,
        followLocalHelpers: true,
        maxHelperDepth: DEFAULT_MAX_HELPER_DEPTH,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.includePaths)) return {};
    if (matchesGlobs(path, options.allowPaths)) return {};
    // `scripts/**` throws are owned by `effect-native/no-throw-in-scripts`.
    if (/(?:^|\/)scripts\//u.test(path)) return {};
    if (options.ignoreTestFiles && isTestFile(`/${path}`)) return {};

    const environmentIdentifier = safeRegExp(
      options.environmentIdentifiers,
      DEFAULTS.environmentIdentifiers,
    );
    const environmentTypeName = safeRegExp(
      options.environmentTypeNames,
      DEFAULTS.environmentTypeNames,
    );
    const environmentReaders = new Set(options.environmentReaders);

    /** `start` offsets of functions proven to parse configuration. */
    const markedFunctions = new Set<number>();
    /** A top-level environment read makes the module itself a configuration parser. */
    let markedModule = false;

    /** Function `start` → a readable name, for the helper message. */
    const functionNames = new Map<number, string>();
    /** File-local function name → its `start` offset (helper propagation targets). */
    const functionNodes = new Map<number, AnyNode>();
    /** Owner function `start` (or `-1` for module scope) → names it calls directly. */
    const calls: { owner: number; node: ESTree.CallExpression }[] = [];
    /** Functions marked only by helper propagation, for the dedicated message. */
    const helperMarked = new Set<number>();

    const throwRecords: ThrowRecord[] = [];

    const resolveVariable = (name: string, from: AnyNode): Variable | null => {
      let scope: Scope | null = context.sourceCode.getScope(from);
      while (scope !== null) {
        const variable = scope.set.get(name);
        if (variable !== undefined) return variable;
        scope = scope.upper;
      }
      return null;
    };

    /** `true` when `node` is the global `name` — not a local, parameter, class or imported binding. */
    const isUnshadowedGlobal = (node: AnyNode, name: string): boolean => {
      if (node.type !== 'Identifier') return false;
      if ((node as ESTree.IdentifierReference).name !== name) return false;
      const variable = resolveVariable(name, node);
      return variable === null || variable.defs.length === 0;
    };

    const declarationOf = (node: AnyNode): ESTree.VariableDeclarator | null => {
      if (node.type !== 'Identifier') return null;
      const variable = resolveVariable(node.name, node);
      if (
        !variable ||
        variable.defs.length !== 1 ||
        variable.references.some((reference) => reference.isWrite() && !reference.init)
      )
        return null;
      const definition = variable.defs[0];
      return definition.type === 'Variable' && definition.node.type === 'VariableDeclarator'
        ? (definition.node as ESTree.VariableDeclarator)
        : null;
    };
    const importOf = (node: AnyNode): { source: string; member: string } | null => {
      if (node.type !== 'Identifier') return null;
      const variable = resolveVariable(node.name, node);
      const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
      if (definition?.type !== 'ImportBinding') return null;
      const specifier = definition.node as ESTree.ImportDeclaration['specifiers'][number];
      const declaration = parentOf(specifier as AnyNode) as ESTree.ImportDeclaration;
      if (
        declaration?.type !== 'ImportDeclaration' ||
        declaration.importKind === 'type' ||
        (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type')
      )
        return null;
      return {
        source: declaration.source.value,
        member: specifier.type === 'ImportSpecifier' ? (keyName(specifier.imported) ?? '') : '*',
      };
    };
    const isEnvHost = (input: AnyNode, depth = 0): boolean => {
      if (depth > 12) return false;
      const node = unwrap(input);
      if (node.type === 'AwaitExpression') return isEnvHost(node.argument, depth + 1);
      if (node.type === 'ImportExpression')
        return node.source.type === 'Literal' && PROCESS_MODULES.has(String(node.source.value));
      if (node.type === 'MetaProperty')
        return node.meta.name === 'import' && node.property.name === 'meta';
      if (node.type === 'Identifier') {
        const imported = importOf(node);
        if (imported)
          return (
            PROCESS_MODULES.has(imported.source) &&
            (imported.member === '*' || imported.member === 'default')
          );
        if (ENV_HOSTS.has(node.name) && isUnshadowedGlobal(node, node.name)) return true;
        const declaration = declarationOf(node);
        return (
          declaration?.id.type === 'Identifier' &&
          declaration.init !== null &&
          isEnvHost(declaration.init as AnyNode, depth + 1)
        );
      }
      if (node.type !== 'MemberExpression' || !ENV_HOSTS.has(staticPropertyName(node) ?? ''))
        return false;
      const container = unwrap(node.object as AnyNode);
      return (
        container.type === 'Identifier' &&
        CONTAINER_GLOBALS.has(container.name) &&
        isUnshadowedGlobal(container, container.name)
      );
    };
    const isEnvBag = (input: AnyNode, depth = 0): boolean => {
      if (depth > 12) return false;
      const node = unwrap(input);
      if (node.type === 'MemberExpression') {
        if (staticPropertyName(node) === 'env' && isEnvHost(node.object as AnyNode)) return true;
        // Only a declared class field/parameter property establishes this.environment identity.
        if (node.object.type !== 'ThisExpression') return false;
        const key = staticPropertyName(node);
        let enclosing = parentOf(node);
        while (
          enclosing &&
          enclosing.type !== 'ClassDeclaration' &&
          enclosing.type !== 'ClassExpression'
        )
          enclosing = parentOf(enclosing);
        if (!enclosing || key === null) return false;
        return enclosing.body.body.some((member) => {
          if (member.type === 'PropertyDefinition' && keyName(member.key) === key)
            return (
              !!member.typeAnnotation &&
              isEnvironmentRecordType(member.typeAnnotation.typeAnnotation)
            );
          if (member.type !== 'MethodDefinition' || member.kind !== 'constructor') return false;
          return member.value.params.some(
            (parameter) =>
              parameter.type === 'TSParameterProperty' &&
              parameterInfo(parameter).name === key &&
              parameterInfo(parameter).type !== null &&
              isEnvironmentRecordType(parameterInfo(parameter).type as AnyNode),
          );
        });
      }
      if (node.type !== 'Identifier') return false;
      const imported = importOf(node);
      if (imported) return PROCESS_MODULES.has(imported.source) && imported.member === 'env';
      const declaration = declarationOf(node);
      if (declaration?.init) {
        if (declaration.id.type === 'Identifier') {
          const init = unwrap(declaration.init as AnyNode);
          if (init.type === 'ObjectExpression')
            return init.properties.some((property) =>
              property.type === 'SpreadElement'
                ? isEnvBag(property.argument, depth + 1)
                : property.type === 'Property' && isEnvDerived(property.value, depth + 1),
            );
          return isEnvBag(init, depth + 1);
        }
        if (declaration.id.type === 'ObjectPattern' && isEnvHost(declaration.init as AnyNode))
          return declaration.id.properties.some(
            (property) =>
              property.type === 'Property' &&
              keyName(property.key) === 'env' &&
              property.value.type === 'Identifier' &&
              property.value.name === node.name,
          );
      }
      const variable = resolveVariable(node.name, node);
      const definition = variable?.defs[0];
      const annotation = (
        definition?.name as unknown as { typeAnnotation?: { typeAnnotation: AnyNode } }
      )?.typeAnnotation;
      return (
        (annotation && isEnvironmentRecordType(annotation.typeAnnotation)) ||
        environmentIdentifier.test(node.name)
      );
    };
    const isEnvironmentBagRead = (node: ESTree.MemberExpression, depth = 0): boolean => {
      const key = staticPropertyName(node);
      return (
        (key === null ? node.computed : ENV_VARIABLE_KEY.test(key)) &&
        isEnvBag(node.object as AnyNode, depth + 1)
      );
    };
    const resolveFunction = (input: AnyNode): AnyNode | null => {
      const node = unwrap(input);
      if (node.type !== 'Identifier') return null;
      const variable = resolveVariable(node.name, node);
      if (
        !variable ||
        variable.defs.length !== 1 ||
        variable.references.some((reference) => reference.isWrite() && !reference.init)
      )
        return null;
      const definition = variable.defs[0];
      if (definition.node.type === 'FunctionDeclaration') return definition.node as AnyNode;
      if (definition.node.type !== 'VariableDeclarator') return null;
      const init = (definition.node as ESTree.VariableDeclarator).init;
      return init && isFunctionNode(unwrap(init as AnyNode)) ? unwrap(init as AnyNode) : null;
    };
    const isEnvDerived = (input: AnyNode, depth = 0): boolean => {
      if (depth > 12) return false;
      const node = unwrap(input);
      if (node.type === 'MemberExpression')
        return (
          isEnvironmentBagRead(node, depth + 1) || isEnvDerived(node.object as AnyNode, depth + 1)
        );
      if (node.type === 'Identifier') {
        const declaration = declarationOf(node);
        return (
          !!declaration?.init &&
          (declaration.id.type === 'ObjectPattern'
            ? isEnvBag(declaration.init as AnyNode, depth + 1)
            : isEnvDerived(declaration.init as AnyNode, depth + 1))
        );
      }
      if (node.type === 'LogicalExpression' || node.type === 'BinaryExpression')
        return isEnvDerived(node.left as AnyNode, depth + 1) || isEnvDerived(node.right, depth + 1);
      if (node.type === 'ConditionalExpression')
        return isEnvDerived(node.consequent, depth + 1) || isEnvDerived(node.alternate, depth + 1);
      if (node.type === 'CallExpression') {
        const callee = unwrap(node.callee as AnyNode);
        const imported = importOf(callee);
        if (callee.type === 'Identifier' && environmentReaders.has(imported?.member ?? callee.name))
          return true;
        if (callee.type === 'MemberExpression' && isEnvDerived(callee.object as AnyNode, depth + 1))
          return true;
        const target = resolveFunction(callee);
        if (!target) return false;
        const body = (target as ESTree.ArrowFunctionExpression).body;
        // A simple returned env expression is evidence; merely calling a parser is not.
        if (body.type !== 'BlockStatement') return isEnvDerived(body, depth + 1);
        return body.body.some(
          (statement) =>
            statement.type === 'ReturnStatement' &&
            statement.argument !== null &&
            isEnvDerived(statement.argument, depth + 1),
        );
      }
      return false;
    };

    /** Enclosing function `start` offsets, outermost first (maintained by the enter/exit visitors). */
    const functionStack: number[] = [];

    /** Mark every function enclosing the cursor; a module-scope read marks the module. */
    const markEnclosing = (): void => {
      if (functionStack.length === 0) {
        markedModule = true;
        return;
      }
      for (const start of functionStack) markedFunctions.add(start);
    };

    /** Innermost enclosing function `start`, or `-1` at module scope. */
    const currentOwner = (): number => functionStack[functionStack.length - 1] ?? -1;

    /** `{ name, typeText }` for one formal parameter; `name` is `null` for destructured params. */
    const parameterInfo = (parameter: AnyNode): { name: string | null; type: AnyNode | null } => {
      let target = parameter;
      if (target.type === 'TSParameterProperty')
        target = (target as { parameter: AnyNode }).parameter;
      if (target.type === 'AssignmentPattern')
        target = (target as ESTree.AssignmentPattern).left as AnyNode;
      if (target.type === 'RestElement') target = (target as { argument: AnyNode }).argument;
      const annotation = (target as { typeAnnotation?: { typeAnnotation?: AnyNode } | null })
        .typeAnnotation;
      const type = annotation?.typeAnnotation ?? null;
      const name = target.type === 'Identifier' ? (target as ESTree.BindingIdentifier).name : null;
      return { name, type };
    };

    /** The type *names* referenced anywhere inside a type annotation (`Readonly<Environment>` → both). */
    const typeNamesIn = (type: AnyNode): readonly string[] => {
      const names: string[] = [];
      const visit = (node: AnyNode | null | undefined, depth: number): void => {
        if (node === null || node === undefined || depth > 6) return;
        if (node.type === 'TSTypeReference') {
          const reference = node as ESTree.TSTypeReference;
          const name = qualifiedTypeName(reference.typeName as AnyNode);
          if (name !== null) names.push(name);
          const parameters = (reference as { typeArguments?: { params?: AnyNode[] } | null })
            .typeArguments;
          for (const parameter of parameters?.params ?? []) visit(parameter, depth + 1);
          return;
        }
        if (node.type === 'TSTypeOperator' || node.type === 'TSParenthesizedType') {
          visit((node as { typeAnnotation?: AnyNode }).typeAnnotation, depth + 1);
          return;
        }
        if (node.type === 'TSUnionType' || node.type === 'TSIntersectionType') {
          for (const member of (node as { types?: AnyNode[] }).types ?? [])
            visit(member, depth + 1);
        }
      };
      visit(type, 0);
      return names;
    };

    /** Optional string dictionaries are a config-shape heuristic; total header/translation maps are not. */
    const isEnvironmentRecordType = (type: AnyNode, depth = 0, optional = false): boolean => {
      if (depth > 12) return false;
      if (type.type === 'TSTypeAnnotation' || type.type === 'TSParenthesizedType') {
        return isEnvironmentRecordType(type.typeAnnotation, depth + 1, optional);
      }
      if (type.type === 'TSTypeLiteral' || type.type === 'TSInterfaceBody') {
        const members = type.type === 'TSTypeLiteral' ? type.members : type.body;
        return members.some(
          (member) =>
            member.type === 'TSIndexSignature' &&
            member.parameters[0]?.typeAnnotation?.typeAnnotation.type === 'TSStringKeyword' &&
            !!member.typeAnnotation &&
            isStringValueType(member.typeAnnotation.typeAnnotation, optional),
        );
      }
      if (type.type !== 'TSTypeReference') return false;
      const name = qualifiedTypeName(type.typeName);
      const args = type.typeArguments?.params ?? [];
      if (type.typeName.type === 'Identifier') {
        const variable = resolveVariable(type.typeName.name, type.typeName);
        if (variable && variable.defs.length > 0) {
          if (variable.defs.length !== 1) return false;
          const definition = variable.defs[0].node as AnyNode;
          if (definition.type === 'TSTypeAliasDeclaration')
            return isEnvironmentRecordType(definition.typeAnnotation, depth + 1, optional);
          if (definition.type === 'TSInterfaceDeclaration')
            return isEnvironmentRecordType(definition.body, depth + 1, optional);
          return false;
        }
      }
      if (name === 'NodeJS.ProcessEnv') return true;
      if (name === 'Readonly' || name === 'Partial') {
        return (
          !!args[0] && isEnvironmentRecordType(args[0], depth + 1, optional || name === 'Partial')
        );
      }
      return (
        name === 'Record' &&
        args.length === 2 &&
        args[0]?.type === 'TSStringKeyword' &&
        !!args[1] &&
        isStringValueType(args[1], optional)
      );
    };
    const isStringValueType = (type: AnyNode, optional: boolean): boolean => {
      if (type.type === 'TSStringKeyword') return optional;
      return (
        type.type === 'TSUnionType' &&
        type.types.some((member) => member.type === 'TSStringKeyword') &&
        (optional ||
          type.types.some(
            (member) => member.type === 'TSNullKeyword' || member.type === 'TSUndefinedKeyword',
          )) &&
        type.types.every((member) =>
          ['TSStringKeyword', 'TSNullKeyword', 'TSUndefinedKeyword'].includes(member.type),
        )
      );
    };

    /** Pass 1, rule 2 + 3: does this function take an environment record? */
    const takesEnvironmentParameter = (node: AnyNode): boolean => {
      const parameters = (node as { params?: AnyNode[] }).params ?? [];
      for (const parameter of parameters) {
        const { name, type } = parameterInfo(parameter);
        if (type !== null && isEnvironmentRecordType(type)) return true;
        if (
          type !== null &&
          typeNamesIn(type).some((typeName) => environmentTypeName.test(typeName))
        )
          return true;
        if (name === null || !environmentIdentifier.test(name)) continue;
        if (type === null || isEnvironmentRecordType(type)) return true;
      }
      return false;
    };

    /** `Effect.try(...)`, `E.Effect.gen(...)`, `Schema.filter(...)`, `x.pipe(...)`. */
    const isEffectHostCall = (call: AnyNode): boolean => {
      if (call.type !== 'CallExpression') return false;
      const callee = unwrap(call.callee as AnyNode);
      if (callee.type === 'Identifier') {
        const imported = importOf(callee);
        return imported !== null && /^effect(?:\/|$)/u.test(imported.source);
      }
      if (callee.type !== 'MemberExpression') return false;
      const object = unwrap(callee.object as AnyNode);
      if (object.type === 'Identifier') {
        const imported = importOf(object);
        return imported !== null && /^effect(?:\/|$)/u.test(imported.source);
      }
      if (object.type === 'MemberExpression') {
        const imported = importOf(unwrap(object.object as AnyNode));
        return (
          imported?.source === 'effect' &&
          imported.member === '*' &&
          EFFECT_NAMESPACES.has(staticPropertyName(object) ?? '')
        );
      }
      return staticPropertyName(callee) === 'pipe' && isEffectHostCall(object);
    };

    /**
     * `true` when any function enclosing `node` is an argument (directly, or through object /
     * array / spread positions) of an Effect combinator call — those throws are owned by
     * `effect-native/no-throw-in-effect-callback`.
     */
    const isInsideEffectCallback = (node: AnyNode): boolean => {
      const ancestors = context.sourceCode.getAncestors(node);
      for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        if (!isFunctionNode(ancestors[index] as AnyNode)) continue;
        let child: AnyNode = ancestors[index] as AnyNode;
        let cursor = index - 1;
        while (cursor >= 0) {
          const parent = ancestors[cursor] as AnyNode;
          if (parent.type === 'CallExpression') {
            const callee = (parent as ESTree.CallExpression).callee as AnyNode;
            const isCallee = callee.start === child.start && callee.end === child.end;
            if (!isCallee && isEffectHostCall(parent)) return true;
            break;
          }
          if (!ARGUMENT_WRAPPERS.has(parent.type)) break;
          child = parent;
          cursor -= 1;
        }
      }
      return false;
    };

    const recordFunctionName = (start: number, name: string | null): void => {
      if (name !== null && !functionNames.has(start)) functionNames.set(start, name);
    };

    return {
      // Environment reads: `<host>.env`, `environment['X']`, `env.PORT`.
      MemberExpression(node) {
        if (staticPropertyName(node) === 'env' && isEnvHost(node.object as AnyNode)) {
          markEnclosing();
          return;
        }
        if (isEnvironmentBagRead(node)) markEnclosing();
      },

      CallExpression(node) {
        if (isEnvDerived(node)) markEnclosing();
        calls.push({ owner: currentOwner(), node });
      },

      // Pass 1, rules 2 + 3, plus the name index used by helper propagation.
      FunctionDeclaration(node) {
        const start = (node as unknown as AnyNode).start;
        functionStack.push(start);
        const id = (node as { id?: ESTree.BindingIdentifier | null }).id ?? null;
        if (id !== null) {
          functionNodes.set(start, node as AnyNode);
          recordFunctionName(start, id.name);
        }
        if (takesEnvironmentParameter(node as unknown as AnyNode)) markedFunctions.add(start);
      },
      'FunctionDeclaration:exit'() {
        functionStack.pop();
      },
      FunctionExpression(node) {
        const start = (node as unknown as AnyNode).start;
        functionStack.push(start);
        if (takesEnvironmentParameter(node as unknown as AnyNode)) markedFunctions.add(start);
      },
      'FunctionExpression:exit'() {
        functionStack.pop();
      },
      ArrowFunctionExpression(node) {
        const start = (node as unknown as AnyNode).start;
        functionStack.push(start);
        if (takesEnvironmentParameter(node as unknown as AnyNode)) markedFunctions.add(start);
      },
      'ArrowFunctionExpression:exit'() {
        functionStack.pop();
      },

      // `const parseConfiguration = (environment: Environment) => …` — name the arrow.
      VariableDeclarator(node) {
        const init = (node.init ?? null) as AnyNode | null;
        const id = node.id as AnyNode;
        if (init === null || !isFunctionNode(init) || id.type !== 'Identifier') return;
        const name = (id as ESTree.BindingIdentifier).name;
        functionNodes.set(init.start, init);
        recordFunctionName(init.start, name);
      },

      ThrowStatement(node) {
        const target = node as unknown as AnyNode;
        throwRecords.push({
          node: target,
          chain: [...functionStack],
          insideEffectCallback: isInsideEffectCallback(target),
        });
      },

      'Program:exit'() {
        // Private helpers only, every reference a call from a marked parser, with a config-derived
        // argument at the initial hop. Module startup calls and exported/domain helpers do not qualify.
        if (options.followLocalHelpers) {
          for (let depth = 0; depth < options.maxHelperDepth; depth += 1) {
            const next: number[] = [];
            for (const [start, target] of functionNodes) {
              if (markedFunctions.has(start)) continue;
              let parent = parentOf(target);
              if (parent?.type === 'VariableDeclarator') parent = parentOf(parent);
              if (parent?.type === 'VariableDeclaration') parent = parentOf(parent);
              if (
                parent?.type === 'ExportNamedDeclaration' ||
                parent?.type === 'ExportDefaultDeclaration'
              )
                continue;
              const sites = calls.filter(
                (entry) => resolveFunction(entry.node.callee as AnyNode)?.start === start,
              );
              if (sites.length === 0 || sites.some((entry) => !markedFunctions.has(entry.owner)))
                continue;
              const name = functionNames.get(start);
              const variable = name ? resolveVariable(name, sites[0].node.callee as AnyNode) : null;
              if (
                !variable ||
                variable.references.some((reference) => {
                  if (reference.init) return false;
                  const identifier = reference.identifier as AnyNode;
                  return !sites.some((entry) => {
                    const callee = unwrap(entry.node.callee as AnyNode);
                    return callee.start === identifier.start;
                  });
                })
              )
                continue;
              if (
                !sites.every(
                  (entry) =>
                    helperMarked.has(entry.owner) ||
                    entry.node.arguments.some((argument) => isEnvDerived(argument as AnyNode)),
                )
              )
                continue;
              next.push(start);
            }
            for (const start of next) {
              markedFunctions.add(start);
              helperMarked.add(start);
            }
            if (next.length === 0) break;
          }
        }

        for (const record of throwRecords) {
          if (record.insideEffectCallback) continue;
          if (record.chain.length === 0) {
            if (markedModule)
              context.report({ node: record.node, messageId: 'throwInConfigurationParser' });
            continue;
          }
          const parser = record.chain.find(
            (start) => markedFunctions.has(start) && !helperMarked.has(start),
          );
          if (parser !== undefined) {
            context.report({ node: record.node, messageId: 'throwInConfigurationParser' });
            continue;
          }
          const helper = record.chain.find((start) => helperMarked.has(start));
          if (helper === undefined) continue;
          context.report({
            node: record.node,
            messageId: 'throwInConfigurationHelper',
            data: { helper: functionNames.get(helper) ?? 'a configuration helper' },
          });
        }
      },
    };
  },
});
