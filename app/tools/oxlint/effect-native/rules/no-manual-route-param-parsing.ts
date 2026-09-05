/**
 * Audit findings: **A9** — "Preserve typed Effects through the frontend" (target: "Schema-driven
 * route/search parameters through `Schema.standardSchemaV1`" and "Form codecs derived from payload
 * Schemas") and **A2** — "Make Schema the sole authority for contracts and domain models"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`). A9 lists "repeated manual route/form parsing"
 * as part of the ~40-seam frontend cluster; A2 requires route/search/form models to be derived from a
 * Schema rather than re-parsed and re-validated by hand at every route module.
 *
 * What is detected (inside `routeGlobs`, production files only)
 * - `new URLSearchParams(...)` and `new FormData(...)` (`manualConstructors`) when the constructor is
 *   the unshadowed global — including `globalThis.URLSearchParams` / `window.FormData` / `self.*`, and
 *   through a local alias of the global (`const Params = URLSearchParams; new Params(search)`).
 *   Both hand-roll a route input codec: search state and form payloads must come from a Schema.
 * - Untyped router hooks (`untypedHooks`, default `useParams` / `useSearch` / `useLoaderData`) called
 *   with `{ strict: false }`, which opts out of the router's typed params entirely. Aliased imports
 *   (`import { useParams as useRouteParams }`) and module-object calls (`import * as Router` →
 *   `Router.useParams(...)`) are tracked, and the options object is resolved through a local binding
 *   (`const untyped = { strict: false } as const; useParams(untyped)`), through `...spread` of such a
 *   binding, and through a `strict` value that is itself a `false`-valued const. With
 *   `flagStrictFalseOnly: false` every call to those hooks is reported, not only the `strict: false`
 *   ones.
 * - `searchParams` taken off a URL value (`flagUrlSearchParams`), where a "URL value" is
 *   `new URL(...)`, the non-throwing `URL.parse(...)` static, either of those reached through a
 *   `?:`/`||`/`??` branch, or a local binding initialised/assigned (including a parameter default) from
 *   one — possibly via a chain of local aliases. Both the member read
 *   (`new URL(request.url).searchParams`, `url["searchParams"]`) and the destructuring
 *   (`const { searchParams } = new URL(request.url)`, `const { searchParams: alias } = url`) are
 *   reported. Optional chaining, computed access, parentheses, `as` casts and `!` are all seen through.
 *
 * What is deliberately allowed
 * - Everything outside `routeGlobs` (API clients, services, scripts) and every test file: the audit's
 *   D tier keeps test-only and framework-forced shapes, and this rule targets route modules.
 * - Typed router usage: `useParams({ from: '/$lang/contacts/customers/$id' })`,
 *   `validateSearch: Schema.standardSchemaV1(...)`, `Route.useSearch()`.
 * - `new URL(...)` used for link/base-URL construction — only a `searchParams` read is a parse.
 * - Locally declared/imported `URLSearchParams`, `FormData`, `URL` or hook names (a shadow is not the
 *   global browser API), `searchParams` properties on unrelated objects, `#searchParams` private
 *   fields, and every type-only position (`import type`, `declare`, type annotations).
 *
 * Narrower than the earlier spec: empty FormData/URLSearchParams and searchParams mutation or
 * serialization construct output; they are not manual input parsing. Router hook identity is
 * restricted to routerModules. A9 does not justify banning native multipart transport containers.
 * No type inference or cross-file flow: alias reads may remain conservatively reported.
 * Report-only; no fixer or suggestion.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production `routeGlobs` defaults instead of
 * forcing the fixture config to pass loosened options (which `run-on-repo.mts` reuses).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

/** Route modules: the frontend seam A9 names. Nested `routes/` directories are covered too. */
const DEFAULT_ROUTE_GLOBS = [
  'apps/*/src/routes/**',
  'verticals/*/src/routes/**',
  'apps/*/src/**/routes/**',
  'verticals/*/src/**/routes/**',
];

const DEFAULT_EXCLUDE: readonly string[] = [];

const DEFAULT_UNTYPED_HOOKS = ['useParams', 'useSearch', 'useLoaderData'];

const DEFAULT_MANUAL_CONSTRUCTORS = ['URLSearchParams', 'FormData'];
const DEFAULT_ROUTER_MODULES = [
  '@modern-js/plugin-tanstack/runtime',
  '@tanstack/react-router',
  '@tanstack/solid-router',
];
const OUTPUT_METHODS = new Set(['set', 'append', 'delete', 'sort', 'toString']);

/** Objects that expose the browser globals as members (`globalThis.URLSearchParams`). */
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self']);

const URL_CONSTRUCTOR = 'URL';
const SEARCH_PARAMS = 'searchParams';

/** Static factories that return a `URL` — `URL.parse` is the non-throwing constructor. */
const URL_STATIC_FACTORIES = new Set(['parse']);

/** Alias hops followed when resolving a binding to a global / options object. Guards cyclic writes. */
const MAX_ALIAS_DEPTH = 6;

interface RuleOptions {
  readonly routeGlobs: readonly string[];
  readonly exclude: readonly string[];
  readonly untypedHooks: readonly string[];
  readonly routerModules: readonly string[];
  readonly manualConstructors: readonly string[];
  readonly flagStrictFalseOnly: boolean;
  readonly flagUrlSearchParams: boolean;
  readonly allowTestFiles: boolean;
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function readOptions(context: Context): RuleOptions {
  const raw = context.options?.[0];
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    routeGlobs: stringArray(record.routeGlobs, DEFAULT_ROUTE_GLOBS),
    exclude: stringArray(record.exclude, DEFAULT_EXCLUDE),
    untypedHooks: stringArray(record.untypedHooks, DEFAULT_UNTYPED_HOOKS),
    routerModules: stringArray(record.routerModules, DEFAULT_ROUTER_MODULES),
    manualConstructors: stringArray(record.manualConstructors, DEFAULT_MANUAL_CONSTRUCTORS),
    flagStrictFalseOnly: record.flagStrictFalseOnly !== false,
    flagUrlSearchParams: record.flagUrlSearchParams !== false,
    allowTestFiles: record.allowTestFiles === true,
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** See through parentheses, `as`/`satisfies` casts, `!` and optional-chain wrappers. */
function unwrap(node: ESTree.Node | null | undefined): ESTree.Node | null {
  let current: ESTree.Node | null = node ?? null;
  for (;;) {
    if (current === null) return null;
    if (current.type === 'ParenthesizedExpression') current = current.expression;
    else if (current.type === 'TSAsExpression') current = current.expression;
    else if (current.type === 'TSSatisfiesExpression') current = current.expression;
    else if (current.type === 'TSNonNullExpression') current = current.expression;
    else if (current.type === 'ChainExpression') current = current.expression;
    else return current;
  }
}

/** Non-computed `.searchParams`, or computed `["searchParams"]`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const property = unwrap(node.property);
  if (property !== null && property.type === 'Literal' && typeof property.value === 'string')
    return property.value;
  return null;
}

/** The static name of an object/pattern key: `key`, `"key"` — never a computed one. */
function propertyKeyName(property: Extract<ESTree.Node, { type: 'Property' }>): string | null {
  if (property.computed) return null;
  const key = property.key;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

function importedName(specifier: ESTree.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : specifier.imported.value;
}

function lookupVariable(
  context: Context,
  identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/**
 * Every expression a binding is initialised or assigned with: `const x = <init>`, later `x = <expr>`,
 * and parameter defaults (`(url = new URL(...)) => ...`, which the scope model records as a write).
 */
function collectWrites(variable: Variable): readonly ESTree.Node[] {
  const writes: ESTree.Node[] = [];
  for (const definition of variable.defs) {
    if (definition.type !== 'Variable') continue;
    const declarator = definition.node;
    if (
      declarator.type === 'VariableDeclarator' &&
      declarator.init !== null &&
      declarator.init !== undefined
    ) {
      writes.push(declarator.init);
    }
  }
  for (const reference of variable.references) {
    const write = reference.writeExpr;
    if (write !== null && write !== undefined) writes.push(write);
  }
  return writes;
}

function writesOf(
  context: Context,
  identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
): readonly ESTree.Node[] {
  const variable = lookupVariable(context, identifier);
  if (variable === null) return [];
  // Options/constructor aliases must have a stable value; an earlier false/global assignment
  // does not prove the value used by a later call.
  if (variable.references.some((reference) => reference.isWrite() && !reference.init)) return [];
  return collectWrites(variable);
}

/**
 * `true` when the name still refers to the ambient global: unresolved, or resolved to a binding with
 * no declaration (the implicit global scope). Any real declaration — `const`, class, function,
 * parameter, catch clause or `import` — means this is not the browser API and must not be reported.
 */
function isUnshadowedGlobal(
  context: Context,
  identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
): boolean {
  const variable = lookupVariable(context, identifier);
  if (variable === null) return true;
  return variable.defs.length === 0;
}

/** `Foo` / `globalThis.Foo` → `"Foo"`, only when `Foo` (or the global object) is unshadowed. */
function directGlobalName(context: Context, node: ESTree.Node | null): string | null {
  const target = unwrap(node);
  if (target === null) return null;
  if (target.type === 'Identifier') return isUnshadowedGlobal(context, target) ? target.name : null;
  if (target.type !== 'MemberExpression') return null;
  const name = memberName(target);
  if (name === null) return null;
  const object = unwrap(target.object);
  if (object === null || object.type !== 'Identifier') return null;
  if (!GLOBAL_OBJECTS.has(object.name)) return null;
  return isUnshadowedGlobal(context, object) ? name : null;
}

/**
 * The browser global an expression denotes, following local aliases of the constructor itself
 * (`const Params = URLSearchParams` / `const Form = globalThis.FormData`) so a one-line rebinding does
 * not defeat the check.
 */
function globalName(context: Context, node: ESTree.Node | null, depth = 0): string | null {
  const direct = directGlobalName(context, node);
  if (direct !== null) return direct;
  if (depth >= MAX_ALIAS_DEPTH) return null;
  const target = unwrap(node);
  if (target === null || target.type !== 'Identifier') return null;
  for (const write of writesOf(context, target)) {
    const resolved = globalName(context, write, depth + 1);
    if (resolved !== null) return resolved;
  }
  return null;
}

/** `new Foo(...)`, `new globalThis.Foo(...)`, `new AliasOfFoo(...)` → `"Foo"`. */
function globalConstructorName(context: Context, node: ESTree.NewExpression): string | null {
  return globalName(context, node.callee);
}

/**
 * An expression that yields a `URL`: `new URL(...)`, `URL.parse(...)` (the non-throwing static), or
 * either of those chosen by a `?:` / `||` / `??` branch.
 */
function isUrlExpression(context: Context, node: ESTree.Node | null, depth = 0): boolean {
  const target = unwrap(node);
  if (target === null || depth >= MAX_ALIAS_DEPTH) return false;
  if (target.type === 'NewExpression')
    return globalConstructorName(context, target) === URL_CONSTRUCTOR;
  if (target.type === 'CallExpression') {
    const callee = unwrap(target.callee);
    if (callee === null || callee.type !== 'MemberExpression') return false;
    const name = memberName(callee);
    if (name === null || !URL_STATIC_FACTORIES.has(name)) return false;
    return globalName(context, callee.object) === URL_CONSTRUCTOR;
  }
  if (target.type === 'ConditionalExpression') {
    return (
      isUrlExpression(context, target.consequent, depth + 1) ||
      isUrlExpression(context, target.alternate, depth + 1)
    );
  }
  if (target.type === 'LogicalExpression') {
    return (
      isUrlExpression(context, target.left, depth + 1) ||
      isUrlExpression(context, target.right, depth + 1)
    );
  }
  return false;
}

/** `true` when the binding was ever written with a URL expression, directly or through an alias. */
function isUrlBinding(
  context: Context,
  identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
  seen: Set<Variable> = new Set(),
): boolean {
  const variable = lookupVariable(context, identifier);
  if (variable === null || seen.has(variable)) return false;
  if (seen.size >= MAX_ALIAS_DEPTH) return false;
  seen.add(variable);
  for (const write of collectWrites(variable)) {
    if (isUrlExpression(context, write)) return true;
    const target = unwrap(write);
    if (target !== null && target.type === 'Identifier' && isUrlBinding(context, target, seen))
      return true;
  }
  return false;
}

/** Any expression whose value is a `URL`: a URL expression, or a binding holding one. */
function isUrlSource(context: Context, node: ESTree.Node | null): boolean {
  const target = unwrap(node);
  if (target === null) return false;
  if (isUrlExpression(context, target)) return true;
  return target.type === 'Identifier' && isUrlBinding(context, target);
}

/** Resolve an expression to the object literal it denotes, following local `const` bindings. */
function resolveObject(
  context: Context,
  node: ESTree.Node | null,
  depth = 0,
): ESTree.ObjectExpression | null {
  const target = unwrap(node);
  if (target === null || depth >= MAX_ALIAS_DEPTH) return null;
  if (target.type === 'ObjectExpression') return target;
  if (target.type !== 'Identifier') return null;
  for (const write of writesOf(context, target)) {
    const resolved = resolveObject(context, write, depth + 1);
    if (resolved !== null) return resolved;
  }
  return null;
}

/** `false`, or a binding whose value is `false` (`const strict = false; useParams({ strict })`). */
function isFalseValue(context: Context, node: ESTree.Node | null, depth = 0): boolean {
  const target = unwrap(node);
  if (target === null || depth >= MAX_ALIAS_DEPTH) return false;
  if (target.type === 'Literal') return target.value === false;
  if (target.type !== 'Identifier') return false;
  return writesOf(context, target).some((write) => isFalseValue(context, write, depth + 1));
}

/**
 * `{ strict: false }` as the hook's first argument — as a literal, through a binding
 * (`const untyped = { strict: false } as const`) or spread in from one.
 */
function strictValue(context: Context, node: ESTree.Node | null, depth = 0): boolean | undefined {
  const object = resolveObject(context, node, depth);
  if (object === null || depth >= MAX_ALIAS_DEPTH) return undefined;
  let value: boolean | undefined;
  for (const property of object.properties) {
    if (property.type === 'SpreadElement') {
      // Unknown later spreads may overwrite strict; never infer false through them.
      const spread = resolveObject(context, property.argument, depth + 1);
      if (spread === null) value = undefined;
      else if (
        spread.properties.some(
          (entry) =>
            entry.type === 'SpreadElement' ||
            (entry.type === 'Property' && propertyKeyName(entry) === 'strict'),
        )
      ) {
        value = strictValue(context, spread, depth + 1);
      }
    } else if (property.type === 'Property') {
      if (property.computed) value = undefined;
      else if (propertyKeyName(property) === 'strict') {
        value = isFalseValue(context, property.value) ? false : undefined;
      }
    }
  }
  return value;
}

/** A mutation or serialization is output construction, not an input read. */
function isOutputUse(context: Context, node: ESTree.Node, seen: Set<number> = new Set()): boolean {
  let current = node;
  while (
    current.parent != null &&
    unwrap(current.parent)?.start === node.start &&
    unwrap(current.parent)?.end === node.end
  )
    current = current.parent;
  const parent = current.parent;
  if (
    parent?.type === 'VariableDeclarator' &&
    parent.init?.start === current.start &&
    parent.id.type === 'Identifier'
  ) {
    return isOutputBinding(context, parent.id, seen);
  }
  if (parent?.type !== 'MemberExpression' || parent.object.start !== current.start) return false;
  const method = memberName(parent);
  if (method === null || !OUTPUT_METHODS.has(method)) return false;
  const call = parent.parent;
  return call?.type === 'CallExpression' && call.callee.start === parent.start;
}

function isOutputBinding(
  context: Context,
  identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
  seen: Set<number> = new Set(),
): boolean {
  const variable = lookupVariable(context, identifier);
  if (variable === null || seen.has(identifier.start) || seen.size > MAX_ALIAS_DEPTH) return false;
  seen.add(identifier.start);
  return variable.references
    .filter((reference) => reference.isRead())
    .every((reference) => isOutputUse(context, reference.identifier, new Set(seen)));
}

interface HookBindings {
  /** local name → imported hook name, e.g. `useRouteParams` → `useParams`. */
  readonly locals: ReadonlyMap<string, string>;
  /** locals bound to a whole module object (`import * as Router` / `import Router`). */
  readonly moduleObjects: ReadonlySet<string>;
}

function collectHookBindings(
  program: ESTree.Program,
  hooks: readonly string[],
  modules: readonly string[],
): HookBindings {
  const locals = new Map<string, string>();
  const moduleObjects = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (statement.importKind === 'type' || !matchesGlobs(statement.source.value, modules)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier') {
        if (specifier.importKind === 'type') continue;
        const imported = importedName(specifier);
        if (hooks.includes(imported)) locals.set(specifier.local.name, imported);
      } else moduleObjects.add(specifier.local.name);
    }
  }
  return { locals, moduleObjects };
}

/** `true` when the identifier still resolves to the `import` binding (not a local shadow). */
function resolvesToImport(
  context: Context,
  identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
): boolean {
  const variable = lookupVariable(context, identifier);
  if (variable === null) return true;
  if (variable.defs.length === 0) return true;
  return variable.defs.some((definition) => definition.type === 'ImportBinding');
}

/** The hook name a call expression targets, or `null`. Handles aliases and `Router.useParams(...)`. */
function hookCallName(
  context: Context,
  node: ESTree.CallExpression,
  bindings: HookBindings,
  hooks: readonly string[],
): string | null {
  const callee = unwrap(node.callee);
  if (callee === null) return null;
  if (callee.type === 'Identifier') {
    const imported = bindings.locals.get(callee.name);
    if (imported === undefined) return null;
    return resolvesToImport(context, callee) ? imported : null;
  }
  if (callee.type !== 'MemberExpression') return null;
  const name = memberName(callee);
  if (name === null || !hooks.includes(name)) return null;
  const object = unwrap(callee.object);
  if (object === null || object.type !== 'Identifier') return null;
  if (!bindings.moduleObjects.has(object.name)) return null;
  return resolvesToImport(context, object) ? name : null;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A9/A2: route modules must not parse route, search or form input by hand. Declare params and ' +
        'search as a Schema (`Schema.standardSchemaV1`) and derive form codecs from the payload Schema instead ' +
        'of `new URLSearchParams` / `new FormData` / `useParams({ strict: false })` / `new URL(...).searchParams`.',
    },
    messages: {
      manualSearchParsing:
        '`new {{constructor}}(...)` parses route search state by hand in a route module. Route input is parsed by ' +
        'hand: declare params/search as a Schema (`Schema.Struct` + `Schema.standardSchemaV1` for ' +
        '`validateSearch`/`params.parse`) and read the decoded value from the route instead of re-parsing and ' +
        're-validating the query string here.',
      manualFormParsing:
        '`new {{constructor}}(...)` reads form fields by hand in a route module. Route input is parsed by hand: ' +
        'derive the form codec from the payload Schema (`Schema.Struct` for the request body, decoded once) so ' +
        'field names, coercion and validation come from the contract rather than string lookups.',
      untypedRouteHook:
        "`{{hook}}({ strict: false })` discards the router's typed route input. Route input is parsed by hand: " +
        'declare params/search as a Schema (`Schema.Struct` + `Schema.standardSchemaV1` for ' +
        "`validateSearch`/`params.parse`) and call `{{hook}}({ from: '<route id>' })` so the decoded, typed value " +
        'flows from the route definition.',
      untypedRouteHookCall:
        '`{{hook}}(...)` is used without a Schema-declared route contract. Route input is parsed by hand: declare ' +
        'params/search as a Schema (`Schema.Struct` + `Schema.standardSchemaV1` for `validateSearch`/`params.parse`) ' +
        'and read the decoded value from the route definition.',
      rawUrlSearchParams:
        '`URL.searchParams` reads the query string by hand in a route module. Route input is parsed by ' +
        'hand: declare search as a Schema (`Schema.Struct` + `Schema.standardSchemaV1` for `validateSearch`) and ' +
        "decode the loader's search input through it instead of `get`/`getAll` plus manual coercion.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          routeGlobs: { type: 'array', items: { type: 'string' } },
          exclude: { type: 'array', items: { type: 'string' } },
          untypedHooks: { type: 'array', items: { type: 'string' } },
          routerModules: { type: 'array', items: { type: 'string' } },
          manualConstructors: { type: 'array', items: { type: 'string' } },
          flagStrictFalseOnly: { type: 'boolean' },
          flagUrlSearchParams: { type: 'boolean' },
          allowTestFiles: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        routeGlobs: [...DEFAULT_ROUTE_GLOBS],
        exclude: [...DEFAULT_EXCLUDE],
        untypedHooks: [...DEFAULT_UNTYPED_HOOKS],
        routerModules: [...DEFAULT_ROUTER_MODULES],
        manualConstructors: [...DEFAULT_MANUAL_CONSTRUCTORS],
        flagStrictFalseOnly: true,
        flagUrlSearchParams: true,
        allowTestFiles: false,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.exclude)) return {};
    if (!matchesGlobs(path, options.routeGlobs)) return {};
    if (!options.allowTestFiles && isTestFile(path)) return {};

    const bindings = collectHookBindings(
      context.sourceCode.ast,
      options.untypedHooks,
      options.routerModules,
    );

    /** `const { searchParams } = <url>` / `const { searchParams: alias } = <url>`. */
    const reportDestructuredSearchParams = (
      pattern: Extract<ESTree.Node, { type: 'ObjectPattern' }>,
    ): void => {
      for (const property of pattern.properties) {
        if (property.type !== 'Property') continue;
        if (propertyKeyName(property) !== SEARCH_PARAMS) continue;
        if (property.value.type === 'Identifier' && isOutputBinding(context, property.value))
          continue;
        context.report({ node: property, messageId: 'rawUrlSearchParams' });
      }
    };

    return {
      NewExpression(node) {
        const name = globalConstructorName(context, node);
        if (name === null || !options.manualConstructors.includes(name)) return;
        // Empty multipart/search containers carry outgoing data; they parse no route input.
        if (node.arguments.length === 0) return;
        const input = unwrap(node.arguments[0]);
        if (
          name === 'URLSearchParams' &&
          (input?.type === 'ObjectExpression' || input?.type === 'ArrayExpression')
        )
          return;
        context.report({
          node,
          messageId: name === 'FormData' ? 'manualFormParsing' : 'manualSearchParsing',
          data: { constructor: name },
        });
      },
      CallExpression(node) {
        const hook = hookCallName(context, node, bindings, options.untypedHooks);
        if (hook === null) return;
        const strictFalse = strictValue(context, node.arguments[0] ?? null) === false;
        if (options.flagStrictFalseOnly && !strictFalse) return;
        context.report({
          node,
          messageId: strictFalse ? 'untypedRouteHook' : 'untypedRouteHookCall',
          data: { hook },
        });
      },
      MemberExpression(node) {
        if (!options.flagUrlSearchParams) return;
        if (memberName(node) !== SEARCH_PARAMS || isOutputUse(context, node)) return;
        if (isUrlSource(context, node.object))
          context.report({ node, messageId: 'rawUrlSearchParams' });
      },
      VariableDeclarator(node) {
        if (!options.flagUrlSearchParams) return;
        if (node.id.type !== 'ObjectPattern') return;
        if (!isUrlSource(context, node.init ?? null)) return;
        reportDestructuredSearchParams(node.id);
      },
      AssignmentExpression(node) {
        if (!options.flagUrlSearchParams) return;
        const left = unwrap(node.left);
        if (left === null || left.type !== 'ObjectPattern') return;
        if (!isUrlSource(context, node.right)) return;
        reportDestructuredSearchParams(left);
      },
    };
  },
});
