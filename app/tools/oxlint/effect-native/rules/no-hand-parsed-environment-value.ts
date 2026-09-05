/**
 * effect-native/no-hand-parsed-environment-value
 *
 * Audit findings enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *   - **A3** "Replace ambient configuration with Config, ConfigProvider, and Redacted" —
 *     "Configuration currently combines `process.env`, per-module dotenv loading, `trim`, `new URL`,
 *     number/range checks, `JSON.parse`, synchronous Schema decoding, and throws"; scale is
 *     "approximately 80–110 hand-parsed configuration sites depending on how shared helpers are
 *     counted". Every one of those sites re-implements `Config.string` / `Config.integer` /
 *     `Config.url` / `Config.boolean` / `Config.schema` with its own ad hoc error vocabulary.
 *   - Secondarily **A7** ("shared Schemas for topology/composition documents"): the
 *     `JSON.parse(environment[...])` shape is the environment-side half of that cluster, and
 *     **A8** (generators/scripts), because `scripts/**` reproduces the same parsing by hand.
 *
 * `no-ambient-process-env` reports the *read* of the ambient environment. This rule reports the
 * *parsing*, which is the part that survives dependency injection: a helper that takes an injected
 * `environment: Record<string, string | undefined>` (or a `readEnvironment(name)` reader) is
 * invisible to that rule while still owning a hand-written string→value codec.
 *
 * ## What is detected
 *
 * An expression is an **environment read** when it is:
 *   - a member access on the ambient environment bag — `process.env.X`, `process.env["X"]`,
 *     `import.meta.env.MODE`, `globalThis.process.env.X`, `Bun.env.X`, `Deno.env.get("X")` — with
 *     the host resolved through the scope chain, so a shadowed local `process` never counts;
 *   - a member access on an identifier whose name matches `environmentIdentifiers`
 *     (`env`, `environment`, `processEnv`, `fileEnvironment`, `environmentVariables`,
 *     `buildEnvironment` by default) **using a SCREAMING_SNAKE key** (`environment['DATABASE_URL']`,
 *     `env.NODE_ENV`) or **any computed non-literal key** (`environment[name]`) — the SCREAMING
 *     restriction is what keeps `env.mode`-style enum/namespace objects out;
 *   - a call to a name in `environmentReaders` (`readEnvironment('X')`,
 *     `getBuildConfigEnvironment('X')`, `envValue('X')`), including as a method
 *     (`options.readEnvironment('X')`);
 *   - an identifier whose declarator resolves (through real scope analysis, not name matching) to an
 *     environment-derived initialiser — including `const { DATABASE_URL } = process.env`.
 *
 * That read is **environment-derived** through `??` / `||` defaults, through template literals that
 * interpolate it, and through the shape-preserving string ops `trim`/`toLowerCase`/`toUpperCase`/
 * `replace`/`replaceAll`/`split`/`normalize`/`slice`, so a chain such as
 * `environment['SPICEDB_INSECURE']?.trim().toLowerCase() !== 'true'` is tracked end to end.
 *
 * On an environment-derived subject the **outermost** of these parse operations is reported once
 * (an enclosing reportable operation always wins, so `Number(env.PORT?.trim())` yields exactly one
 * diagnostic):
 *   - string surgery: `.trim() .trimStart() .trimEnd() .split() .toLowerCase() .toUpperCase()
 *     .normalize() .replace() .replaceAll() .slice() .startsWith() .endsWith() .includes()
 *     .match() .matchAll()`;
 *   - coercion: `Number(...)`, `parseInt/parseFloat(...)`, `Number.parseInt/parseFloat(...)`,
 *     `Boolean(...)`, `BigInt(...)`, `decodeURIComponent/decodeURI(...)` (unshadowed globals only);
 *   - `JSON.parse(...)`;
 *   - structured construction: `new URL(...)`, `new Date(...)`;
 *   - a comparison (`=== !== == != < <= > >=`) against a string/number/bigint literal — the hand
 *     written `=== 'true'` boolean codec and the `!== 'production'` mode check;
 *   - a comparison involving `<environment value>.length` — the hand written "required" check.
 *
 * ## What is deliberately allowed
 *
 *   - Parsing anything that is not environment-derived: `input.name.trim()`, `JSON.parse(body)`,
 *     `new URL(request.url)`, `new Date(row.createdAt)`. The subject must resolve to the
 *     environment.
 *   - D tier "line-preserving `.env` rewriting where comments and ordering must survive": this rule
 *     never looks at `.env` file *contents*, only at values read out of an environment bag. A
 *     rewriter that splits the lines of a file it just read from disk is untouched.
 *   - Enum/namespace objects that merely happen to be called `env`: only SCREAMING_SNAKE (or
 *     computed) keys count, so `env.mode`, `Environment.Production` and `environment.toString()`
 *     never report.
 *   - Presence checks that are not parses: `value === undefined`, `value === null`, `value !== other`
 *     — `undefined`/`null` comparisons carry no vocabulary to move into a `Config`.
 *   - Reads that are only *passed on* (`Config.string`, `ConfigProvider.fromJson`,
 *     `Schema.decodeUnknown(...)(environment['X'])`, `loadDotenv({ processEnv: bag })`) — decoding
 *     through Effect is the target state, not the defect.
 *   - `allowPaths` (empty by default) for a ratified carve-out, and `ignoreTestFiles` (`false` by
 *     default, because B2 wants tests configured from `ConfigProvider.fromMap`).
 *
 * Scope lives in the rule (`includePaths` defaults to `apps/**`, `verticals/**`, `packages/**`,
 * `scripts/**`, tests included), so `oxlint.config.ts` only needs
 * `'effect-native/no-hand-parsed-environment-value': 'error'`.
 *
 * Report-only: no fixers, no suggestions.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the production `includePaths` defaults instead of
 * forcing the fixture config (which `run-on-repo.mts` reuses verbatim) to loosen the scope.
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE_PATHS: readonly string[] = [
  'apps/**',
  'verticals/**',
  'packages/**',
  'scripts/**',
];

const DEFAULT_ENVIRONMENT_IDENTIFIERS =
  '^(env|environment|processEnv|fileEnvironment|environmentVariables|buildEnvironment)$';

const DEFAULT_ENVIRONMENT_READERS: readonly string[] = [
  'readEnvironment',
  'getBuildConfigEnvironment',
  'envValue',
];

/** Wrappers that never change the value: `(x)`, `x as T`, `x satisfies T`, `x!`, `x?.y` chains. */
const TRANSPARENT = new Set([
  'ChainExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
]);

/** Runtime globals that own an `env` bag. */
const ENV_HOSTS = new Set(['process', 'Bun', 'Deno']);

/** Objects exposing those hosts as members (`globalThis.process.env`). */
const CONTAINER_GLOBALS = new Set(['globalThis', 'global', 'window', 'self']);

/** String ops that keep the value environment-derived (`env.X.trim().toLowerCase()`). */
const DERIVING_STRING_OPS = new Set([
  'trim',
  'trimStart',
  'trimEnd',
  'toLowerCase',
  'toUpperCase',
  'normalize',
  'replace',
  'replaceAll',
  'split',
  'slice',
  'substring',
  'substr',
  'at',
  'charAt',
  'padStart',
  'padEnd',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
]);

/** Member calls that are themselves a hand-written parse of the environment value. */
const MEMBER_PARSE_OPS = new Set([
  'trim',
  'trimStart',
  'trimEnd',
  'split',
  'toLowerCase',
  'toUpperCase',
  'normalize',
  'replace',
  'replaceAll',
  'slice',
  'substring',
  'substr',
  'at',
  'charAt',
  'padStart',
  'padEnd',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'startsWith',
  'endsWith',
  'includes',
  'indexOf',
  'lastIndexOf',
  'match',
  'matchAll',
]);

/** Bare global coercions. */
const GLOBAL_COERCIONS = new Set([
  'Number',
  'parseInt',
  'parseFloat',
  'Boolean',
  'BigInt',
  'decodeURIComponent',
  'decodeURI',
]);

/** `<namespace>.<member>(value)` coercions/parsers. */
const NAMESPACED_PARSERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['Number', new Set(['parseInt', 'parseFloat'])],
  ['JSON', new Set(['parse'])],
  ['Date', new Set(['parse'])],
  ['URL', new Set(['parse', 'canParse'])],
]);

/** Constructors that turn an environment string into a structured value. */
const STRUCTURED_CONSTRUCTORS = new Set(['URL', 'Date']);

const COMPARISON_OPERATORS = new Set(['===', '!==', '==', '!=', '<', '<=', '>', '>=']);

const SCREAMING_KEY = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

/** Recursion budget for the declarator/`??`/string-op walk. */
const MAX_DEPTH = 8;

/** Ancestor-walk budget when checking whether an enclosing parse already reports. */
const MAX_ANCESTORS = 64;

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly ignoreTestFiles: boolean;
  readonly includePaths: readonly string[];
  readonly environmentIdentifiers: string;
  readonly environmentReaders: readonly string[];
}

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function readOptions(raw: unknown): RuleOptions {
  const given: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const includePaths = stringList(given.includePaths, DEFAULT_INCLUDE_PATHS);
  const identifiers = given.environmentIdentifiers;
  return {
    allowPaths: stringList(given.allowPaths, []),
    ignoreTestFiles: given.ignoreTestFiles === true,
    includePaths: includePaths.length > 0 ? includePaths : DEFAULT_INCLUDE_PATHS,
    environmentIdentifiers:
      typeof identifiers === 'string' && identifiers.length > 0
        ? identifiers
        : DEFAULT_ENVIRONMENT_IDENTIFIERS,
    environmentReaders: stringList(given.environmentReaders, DEFAULT_ENVIRONMENT_READERS),
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function unwrap(node: AnyNode | null | undefined): AnyNode | null {
  let current: AnyNode | null = node ?? null;
  for (let guard = 0; guard < 16; guard += 1) {
    if (current === null || !TRANSPARENT.has(current.type)) return current;
    current = ((current as { expression?: AnyNode }).expression ?? null) as AnyNode | null;
  }
  return current;
}

/** `a.b` / `a["b"]` → `"b"`; a dynamic or non-string key → `null`. */
function staticKey(node: ESTree.MemberExpression): string | null {
  const property = unwrap(node.property as AnyNode) as AnyNode;
  if (property.type === 'TemplateLiteral' && property.expressions.length === 0)
    return property.quasis[0]?.value.cooked ?? null;
  if (!node.computed)
    return property.type === 'Identifier' ? (property as ESTree.IdentifierName).name : null;
  if (property.type !== 'Literal') return null;
  const value = (property as { value?: unknown }).value;
  return typeof value === 'string' ? value : null;
}

function identifierName(node: AnyNode | null): string | null {
  return node !== null && node.type === 'Identifier'
    ? (node as ESTree.IdentifierReference).name
    : null;
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

/** `true` when `node` is the real global `name` — not a local, parameter, class or import binding. */
function isUnshadowedGlobal(context: Context, node: AnyNode, name: string): boolean {
  if (identifierName(node) !== name) return false;
  const variable = resolveVariable(context, name, node);
  return variable === null || variable.defs.length === 0;
}

/** The single `const`/`let` declarator an identifier reference resolves to, if any. */
function declaratorOf(context: Context, node: AnyNode): ESTree.VariableDeclarator | null {
  const name = identifierName(node);
  if (name === null) return null;
  const variable = resolveVariable(context, name, node);
  if (
    variable === null ||
    variable.defs.length !== 1 ||
    variable.references.some((reference) => reference.isWrite() && !reference.init)
  )
    return null;
  for (const definition of variable.defs) {
    if (definition.type !== 'Variable') continue;
    const declaration = definition.node as AnyNode;
    if (declaration.type === 'VariableDeclarator') return declaration as ESTree.VariableDeclarator;
  }
  return null;
}

function isStringOrNumberLiteral(node: AnyNode | null): boolean {
  if (node === null || node.type !== 'Literal') return false;
  const value = (node as { value?: unknown }).value;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint';
}

function spanOf(node: AnyNode): string {
  const span = node as unknown as { start: number; end: number };
  return `${node.type}@${span.start}:${span.end}`;
}

function parentOf(node: AnyNode): AnyNode | null {
  return ((node as { parent?: AnyNode | null }).parent ?? null) as AnyNode | null;
}

/** Effect-native rule: environment values are declared as `Config`, never parsed by hand. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A3 (with A7/A8): hand parsing of an environment-derived value — `trim`/`split`/`toLowerCase`, ' +
        "`Number`/`parseInt`/`Boolean`, `JSON.parse`, `new URL`/`new Date`, `=== 'true'` and `.length` checks " +
        'on `process.env`, `import.meta.env`, an injected `environment` record or a `readEnvironment(...)` ' +
        'helper — re-implements `Config.string`/`integer`/`url`/`boolean`/`schema` with an ad hoc error ' +
        'vocabulary and hides the requirement from the root ConfigProvider. Syntax-only: injected record/reader names are configurable heuristics; bounded local aliases are tracked, not arbitrary cross-module flow.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#a3-replace-ambient-configuration-with-config-configprovider-and-redacted',
    },
    messages: {
      envStringSurgery:
        'Audit A3: `.{{operation}}()` hand parses an environment value, re-implementing a codec that `Config` ' +
        "already owns. Declare the variable as `Config.string('NAME')` (add `Config.map`/`Schema.Trim` or a " +
        '`Schema.Literal` refinement through `Config.schema` for the shape you need) and read it with ' +
        '`yield* AppConfig`, so the single root `ConfigProvider` fails with a typed `ConfigError` instead of ' +
        'this local string surgery.',
      envCoercion:
        'Audit A3: `{{operation}}(...)` coerces an environment string by hand and may yield `NaN`/`false` ' +
        "or fails synchronously on malformed input. Declare it as `Config.integer('NAME')` / `Config.number` / `Config.boolean` " +
        '(compose defaults with `Config.withDefault`, ranges with `Config.validate` or a `Schema` refinement ' +
        'through `Config.schema`) and let the root ConfigProvider report a typed `ConfigError`.',
      envJsonParse:
        'Audit A3/A7: `JSON.parse(...)` decodes a JSON-valued environment variable by hand, producing `unknown` ' +
        'plus a `SyntaxError` that no typed channel owns. Use `Config.schema(Schema.fromJsonString(<Schema>), ' +
        "'NAME')` — for key material `Schema.Redacted` — so the document Schema is the only authority and the " +
        'failure arrives as a typed `ConfigError`.',
      envStructuredParse:
        'Audit A3: `{{operation}}(...)` parses or validates an environment string by hand, so ' +
        "malformation is not handled by the declared configuration codec. Use `Config.url('NAME')` (or " +
        "`Config.schema(Schema.DateTimeUtc, 'NAME')` for instants) and keep the validation rules in the " +
        'configuration Schema rather than in a local `try`/`throw`.',
      envLiteralComparison:
        'Audit A3: comparing an environment value against the literal `{{literal}}` hand rolls a closed ' +
        "configuration vocabulary. Declare it as `Config.boolean('NAME')` for on/off flags or " +
        "`Config.schema(Schema.Literals([...]), 'NAME')` for a closed set, so the accepted values live in one " +
        'Schema and an unexpected value fails startup with a typed `ConfigError` instead of falling through ' +
        'this branch.',
      envLengthCheck:
        "Audit A3: a `.length` check on an environment value hand rolls the 'required'/'non-empty' rule that " +
        "`Config` already enforces. Declare it as `Config.string('NAME')` (with `Config.withDefault` when it is " +
        'optional, `Schema.NonEmptyString`/`Schema.minLength` through `Config.schema` when it has a shape) so ' +
        'the missing-value failure is one typed `ConfigError` rather than a local guard and error literal.',
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
              'Globs of files allowed to hand parse environment values, e.g. a ratified bootstrap carve-out (default: none).',
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
          environmentIdentifiers: {
            type: 'string',
            description:
              'Regular expression for identifiers holding an environment record; member reads on them count as environment reads when the key is SCREAMING_SNAKE or computed.',
          },
          environmentReaders: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Function names whose result is an environment value (e.g. readEnvironment, getBuildConfigEnvironment, envValue).',
          },
        },
      },
    ],
    defaultOptions: [
      {
        allowPaths: [],
        ignoreTestFiles: false,
        includePaths: [...DEFAULT_INCLUDE_PATHS],
        environmentIdentifiers: DEFAULT_ENVIRONMENT_IDENTIFIERS,
        environmentReaders: [...DEFAULT_ENVIRONMENT_READERS],
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.includePaths)) return {};
    if (matchesGlobs(path, options.allowPaths)) return {};
    if (options.ignoreTestFiles && isTestFile(`/${path}`)) return {};

    let environmentIdentifier: RegExp;
    try {
      environmentIdentifier = new RegExp(options.environmentIdentifiers, 'u');
    } catch {
      environmentIdentifier = new RegExp(DEFAULT_ENVIRONMENT_IDENTIFIERS, 'u');
    }
    const readers = new Set(options.environmentReaders);

    const importOf = (node: AnyNode): { source: string; member: string } | null => {
      const name = identifierName(node);
      if (!name) return null;
      const variable = resolveVariable(context, name, node);
      const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
      if (definition?.type !== 'ImportBinding') return null;
      const specifier = definition.node as ESTree.ImportSpecifier;
      const declaration = parentOf(specifier as AnyNode) as ESTree.ImportDeclaration;
      if (
        declaration?.type !== 'ImportDeclaration' ||
        declaration.importKind === 'type' ||
        specifier.importKind === 'type'
      )
        return null;
      return {
        source: declaration.source.value,
        member:
          specifier.type === 'ImportSpecifier'
            ? specifier.imported.type === 'Identifier'
              ? specifier.imported.name
              : specifier.imported.value
            : 'default',
      };
    };
    const processModule = (source: string) => source === 'process' || source === 'node:process';
    const staticString = (node: AnyNode | null): string | null => {
      const value = unwrap(node);
      if (value?.type === 'Literal' && typeof value.value === 'string') return value.value;
      if (value?.type === 'TemplateLiteral' && value.expressions.length === 0)
        return value.quasis[0]?.value.cooked ?? null;
      return null;
    };
    const isEnvHost = (node: AnyNode | null, depth = 0): boolean => {
      const host = unwrap(node);
      if (!host || depth > MAX_DEPTH) return false;
      if (host.type === 'AwaitExpression') return isEnvHost(host.argument, depth + 1);
      if (host.type === 'ImportExpression') return processModule(staticString(host.source) ?? '');
      if (host.type === 'MetaProperty')
        return host.meta.name === 'import' && host.property.name === 'meta';
      const name = identifierName(host);
      if (name) {
        const imported = importOf(host);
        if (imported) return processModule(imported.source) && imported.member === 'default';
        if (ENV_HOSTS.has(name) && isUnshadowedGlobal(context, host, name)) return true;
        const declaration = declaratorOf(context, host);
        return (
          declaration?.id.type === 'Identifier' && isEnvHost(declaration.init as AnyNode, depth + 1)
        );
      }
      if (host.type !== 'MemberExpression' || !ENV_HOSTS.has(staticKey(host) ?? '')) return false;
      const owner = unwrap(host.object as AnyNode);
      const ownerName = identifierName(owner);
      return (
        ownerName !== null &&
        CONTAINER_GLOBALS.has(ownerName) &&
        isUnshadowedGlobal(context, owner as AnyNode, ownerName)
      );
    };
    /** Only statically known local aliases are followed; arbitrary returned records are unknown. */
    const isAmbientEnvBag = (node: AnyNode | null, depth = 0): boolean => {
      const bag = unwrap(node);
      if (!bag || depth > MAX_DEPTH) return false;
      if (bag.type === 'MemberExpression')
        return staticKey(bag) === 'env' && isEnvHost(bag.object as AnyNode);
      if (bag.type !== 'Identifier') return false;
      const imported = importOf(bag);
      if (imported) return processModule(imported.source) && imported.member === 'env';
      const declaration = declaratorOf(context, bag);
      if (!declaration) return false;
      if (declaration.id.type === 'Identifier')
        return isAmbientEnvBag(declaration.init as AnyNode, depth + 1);
      if (declaration.id.type !== 'ObjectPattern' || !isEnvHost(declaration.init as AnyNode))
        return false;
      return declaration.id.properties.some(
        (property) =>
          property.type === 'Property' &&
          (property.computed
            ? staticString(property.key)
            : (identifierName(property.key) ?? staticString(property.key))) === 'env' &&
          identifierName(property.value) === bag.name,
      );
    };
    const isLiteralObject = (node: AnyNode | null, depth = 0): boolean => {
      const value = unwrap(node);
      if (!value || depth > MAX_DEPTH) return false;
      if (value.type === 'Literal') return true;
      if (value.type !== 'ObjectExpression') return false;
      return value.properties.every(
        (property) =>
          property.type === 'Property' &&
          !property.method &&
          (!property.computed || staticString(property.key) !== null) &&
          isLiteralObject(property.value, depth + 1),
      );
    };
    /** Named injected records are a documented heuristic, rebutted by local literal tables. */
    const isEnvironmentRecord = (node: AnyNode | null, depth: number): boolean => {
      const record = unwrap(node);
      if (!record || depth > MAX_DEPTH) return false;
      if (isAmbientEnvBag(record)) return true;
      const name = identifierName(record);
      if (!name) return false;
      const declaration = declaratorOf(context, record);
      if (declaration?.init && isLiteralObject(declaration.init as AnyNode)) return false;
      if (environmentIdentifier.test(name) && !importOf(record)) return true;
      return (
        declaration?.id.type === 'Identifier' &&
        isEnvironmentRecord(declaration.init as AnyNode, depth + 1)
      );
    };
    const isReader = (node: AnyNode, depth = 0): boolean => {
      if (depth > MAX_DEPTH) return false;
      const imported = importOf(node);
      if (imported) return readers.has(imported.member);
      const name = identifierName(node);
      if (name === null) return false;
      const declaration = declaratorOf(context, node);
      if (declaration?.init && unwrap(declaration.init as AnyNode)?.type === 'Identifier')
        return isReader(unwrap(declaration.init as AnyNode) as AnyNode, depth + 1);
      return readers.has(name);
    };
    const isLiteralValue = (node: AnyNode | null, depth = 0): boolean => {
      const value = unwrap(node);
      if (!value || depth > MAX_DEPTH) return false;
      if (isStringOrNumberLiteral(value) || staticString(value) !== null) return true;
      const declaration = declaratorOf(context, value);
      return (
        declaration?.id.type === 'Identifier' &&
        (parentOf(declaration) as ESTree.VariableDeclaration)?.kind === 'const' &&
        isLiteralValue(declaration.init as AnyNode, depth + 1)
      );
    };

    /** A read of a single environment variable. */
    const isEnvironmentRead = (node: AnyNode | null, depth: number): boolean => {
      const read = unwrap(node);
      if (read === null || depth > MAX_DEPTH) return false;

      if (read.type === 'MemberExpression') {
        const member = read as ESTree.MemberExpression;
        const object = member.object as AnyNode;
        // `process.env.DATABASE_URL` — the ambient bag has no non-configuration members.
        if (isAmbientEnvBag(object)) return true;
        if (!isEnvironmentRecord(object, depth)) return false;
        if (member.computed) {
          const property = unwrap(member.property as AnyNode);
          if (property === null) return false;
          const literalKey = staticString(property);
          if (literalKey !== null) return SCREAMING_KEY.test(literalKey);
          if (property.type !== 'Literal') return true; // `environment[name]`
          const value = (property as { value?: unknown }).value;
          return typeof value === 'string' && SCREAMING_KEY.test(value);
        }
        const key = staticKey(member);
        return key !== null && SCREAMING_KEY.test(key);
      }

      if (read.type === 'CallExpression') {
        const callee = unwrap((read as ESTree.CallExpression).callee as AnyNode);
        if (callee === null) return false;
        const calleeName = identifierName(callee);
        if (calleeName !== null) return isReader(callee);
        if (callee.type !== 'MemberExpression') return false;
        const key = staticKey(callee as ESTree.MemberExpression);
        if (key === null) return false;
        if (readers.has(key)) return true;
        // `Deno.env.get('X')`, `process.env.get?.('X')`.
        return (
          key === 'get' && isAmbientEnvBag((callee as ESTree.MemberExpression).object as AnyNode)
        );
      }

      if (read.type === 'Identifier') {
        const declarator = declaratorOf(context, read);
        if (declarator === null) return false;
        const target = declarator.id as AnyNode;
        // `const { DATABASE_URL } = process.env`.
        if (target.type === 'ObjectPattern' || target.type === 'ArrayPattern') {
          return isEnvironmentRecord(declarator.init as AnyNode | null, depth + 1);
        }
        return isEnvironmentDerived(declarator.init as AnyNode | null, depth + 1);
      }

      return false;
    };

    /** An environment read, possibly defaulted, interpolated or passed through a string op. */
    function isEnvironmentDerived(node: AnyNode | null, depth: number): boolean {
      const value = unwrap(node);
      if (value === null || depth > MAX_DEPTH) return false;
      if (isEnvironmentRead(value, depth)) return true;

      if (value.type === 'LogicalExpression') {
        const logical = value as ESTree.LogicalExpression;
        if (logical.operator !== '??' && logical.operator !== '||') return false;
        return (
          isEnvironmentDerived(logical.left as AnyNode, depth + 1) ||
          isEnvironmentDerived(logical.right as AnyNode, depth + 1)
        );
      }

      if (value.type === 'ConditionalExpression')
        return (
          isEnvironmentDerived(value.consequent, depth + 1) ||
          isEnvironmentDerived(value.alternate, depth + 1)
        );

      if (value.type === 'TemplateLiteral') {
        const template = value as ESTree.TemplateLiteral;
        return template.expressions.some((expression) =>
          isEnvironmentDerived(expression as AnyNode, depth + 1),
        );
      }

      if (value.type === 'CallExpression') {
        const callee = unwrap((value as ESTree.CallExpression).callee as AnyNode);
        if (callee === null || callee.type !== 'MemberExpression') return false;
        const key = staticKey(callee as ESTree.MemberExpression);
        if (key === null || !DERIVING_STRING_OPS.has(key)) return false;
        return isEnvironmentDerived(
          (callee as ESTree.MemberExpression).object as AnyNode,
          depth + 1,
        );
      }

      return false;
    }

    /** `<environment value>.length`, the hand written required/non-empty check. */
    const isEnvironmentLength = (node: AnyNode | null): boolean => {
      const member = unwrap(node);
      if (member === null || member.type !== 'MemberExpression') return false;
      if (staticKey(member as ESTree.MemberExpression) !== 'length') return false;
      return isEnvironmentDerived((member as ESTree.MemberExpression).object as AnyNode, 0);
    };

    const reportable = new Map<
      string,
      { readonly messageId: string; readonly data: Record<string, string> } | null
    >();

    /** The diagnostic `node` would raise on its own, or `null` when it is not a hand parse. */
    const classify = (
      node: AnyNode,
    ): { readonly messageId: string; readonly data: Record<string, string> } | null => {
      const cached = reportable.get(spanOf(node));
      if (cached !== undefined) return cached;
      const verdict = computeClassification(node);
      reportable.set(spanOf(node), verdict);
      return verdict;
    };

    function computeClassification(
      node: AnyNode,
    ): { readonly messageId: string; readonly data: Record<string, string> } | null {
      if (node.type === 'CallExpression') {
        const call = node as ESTree.CallExpression;
        const callee = unwrap(call.callee as AnyNode);
        if (callee === null) return null;
        const firstArgument = (call.arguments[0] as AnyNode | undefined) ?? null;

        if (callee.type === 'MemberExpression') {
          const member = callee as ESTree.MemberExpression;
          const key = staticKey(member);
          if (key === null) return null;
          const owner = unwrap(member.object as AnyNode);
          const ownerName = identifierName(owner);
          // `JSON.parse(...)` / `Number.parseInt(...)`.
          const namespaced = ownerName === null ? undefined : NAMESPACED_PARSERS.get(ownerName);
          if (
            namespaced !== undefined &&
            namespaced.has(key) &&
            isUnshadowedGlobal(context, owner as AnyNode, ownerName as string) &&
            firstArgument !== null &&
            firstArgument.type !== 'SpreadElement' &&
            isEnvironmentDerived(firstArgument, 0)
          ) {
            return ownerName === 'JSON'
              ? { messageId: 'envJsonParse', data: { operation: `${ownerName}.${key}` } }
              : {
                  messageId:
                    ownerName === 'URL' || ownerName === 'Date'
                      ? 'envStructuredParse'
                      : 'envCoercion',
                  data: { operation: `${ownerName}.${key}` },
                };
          }
          // `environment['X'].trim()`, `env.MODE.split(',')`.
          if (!MEMBER_PARSE_OPS.has(key)) return null;
          return isEnvironmentDerived(member.object as AnyNode, 0)
            ? { messageId: 'envStringSurgery', data: { operation: key } }
            : null;
        }

        const calleeName = identifierName(callee);
        if (calleeName === null || !GLOBAL_COERCIONS.has(calleeName)) return null;
        if (!isUnshadowedGlobal(context, callee, calleeName)) return null;
        if (firstArgument === null || firstArgument.type === 'SpreadElement') return null;
        return isEnvironmentDerived(firstArgument, 0)
          ? { messageId: 'envCoercion', data: { operation: calleeName } }
          : null;
      }

      if (node.type === 'NewExpression') {
        const construction = node as ESTree.NewExpression;
        const callee = unwrap(construction.callee as AnyNode);
        const calleeName = identifierName(callee);
        if (calleeName === null || !STRUCTURED_CONSTRUCTORS.has(calleeName)) return null;
        if (!isUnshadowedGlobal(context, callee as AnyNode, calleeName)) return null;
        const firstArgument = (construction.arguments[0] as AnyNode | undefined) ?? null;
        if (firstArgument === null || firstArgument.type === 'SpreadElement') return null;
        return isEnvironmentDerived(firstArgument, 0)
          ? { messageId: 'envStructuredParse', data: { operation: calleeName } }
          : null;
      }

      if (node.type === 'UnaryExpression') {
        if (node.operator === '!' && isEnvironmentLength(node.argument))
          return { messageId: 'envLengthCheck', data: { operation: 'length' } };
        if (
          (node.operator === '+' || node.operator === '-') &&
          isEnvironmentDerived(node.argument, 0)
        )
          return { messageId: 'envCoercion', data: { operation: node.operator } };
      }
      if (node.type === 'SwitchStatement' && isEnvironmentDerived(node.discriminant, 0)) {
        const branch = node.cases.find((entry) => isLiteralValue(entry.test));
        if (branch?.test)
          return {
            messageId: 'envLiteralComparison',
            data: { literal: context.sourceCode.getText(branch.test) },
          };
      }
      if (node.type === 'BinaryExpression') {
        const comparison = node as ESTree.BinaryExpression;
        if (!COMPARISON_OPERATORS.has(comparison.operator)) return null;
        const left = comparison.left as AnyNode;
        const right = comparison.right as AnyNode;
        if (isEnvironmentLength(left) || isEnvironmentLength(right)) {
          return { messageId: 'envLengthCheck', data: { operation: 'length' } };
        }
        const leftValue = unwrap(left);
        const rightValue = unwrap(right);
        let literal: AnyNode | null = null;
        if (isLiteralValue(rightValue) && isEnvironmentDerived(left, 0)) literal = rightValue;
        else if (isLiteralValue(leftValue) && isEnvironmentDerived(right, 0)) literal = leftValue;
        if (literal === null) return null;
        const raw = (literal as { raw?: string | null }).raw;
        return {
          messageId: 'envLiteralComparison',
          data: { literal: raw ?? String((literal as { value?: unknown }).value) },
        };
      }

      return null;
    }

    /** Only the outermost hand parse reports; an enclosing parse always wins. */
    const hasReportableAncestor = (node: AnyNode): boolean => {
      let current = parentOf(node);
      for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
        if (current === null || current.type === 'Program') return false;
        if (
          classify(current) !== null &&
          (current.type !== 'SwitchStatement' || node.end <= current.discriminant.end)
        )
          return true;
        if (
          ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(
            current.type,
          )
        )
          return false;
        current = parentOf(current);
      }
      return false;
    };

    const inspect = (node: AnyNode): void => {
      const verdict = classify(node);
      if (verdict === null) return;
      if (hasReportableAncestor(node)) return;
      context.report({ node: node as never, messageId: verdict.messageId, data: verdict.data });
    };

    return {
      UnaryExpression: inspect,
      SwitchStatement: inspect,
      BinaryExpression(node) {
        inspect(node as unknown as AnyNode);
      },
      CallExpression(node) {
        inspect(node as unknown as AnyNode);
      },
      NewExpression(node) {
        inspect(node as unknown as AnyNode);
      },
    };
  },
});
