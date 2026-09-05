/**
 * effect-native/no-per-operation-http-api-client
 *
 * Audit findings: A9 ("Preserve typed Effects through the frontend"), A1 ("Establish one
 * process-level Layer and ManagedRuntime composition model") and A8 ("Fix the generators before
 * generating more code") in `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`.
 *
 * What is detected
 * ----------------
 * 1. **Constructor sites.** A call that builds an HttpApi client and happens *inside a function*:
 *    - an identifier bound by `import { makeEffectHttpApiClient } from "..."` (`constructorNames`,
 *      matched on the *imported* name so `import { makeEffectHttpApiClient as makeClient }` still
 *      matches), the namespace form `import * as bff from "…"; bff.makeEffectHttpApiClient(...)`, and
 *      module-level rebindings of either (`const buildClient = makeEffectHttpApiClient`,
 *      `const { make } = HttpApiClient`);
 *    - an Effect namespace member in `constructorMembers` (`HttpApiClient.make` / `makeWith`),
 *      resolved through real import bindings, including `import { make } from
 *      "effect/unstable/httpapi/HttpApiClient"`, aliased namespaces and literal computed access
 *      (`HttpApiClient["make"]`);
 *    - a member in `accessorMembers` (`HttpApiClient.group` / `endpoint`). Those take an *already
 *      built* `httpClient`, so they do not rebuild the transport — they get their own message, but
 *      deriving a typed accessor per operation is still per-operation wiring.
 *    Only `Effect.gen` generator bodies are walked through (`transparentMembers`): `Effect.fn` /
 *    `Effect.fnUntraced` return a *function*, so a client built inside one is rebuilt per call and is
 *    a genuine operation boundary.
 * 2. **Factory calls.** Module-level functions containing a constructor site become "client
 *    factories" (`createShellAuthenticationClient`, `makeClient`,
 *    `executeCustomerListWithAuthorization`, ...). Every scope-resolved call to such a factory that
 *    itself sits inside a function is reported — the ~24 `signIn`/`switchTenant`/... operations of
 *    `apps/shell-super-app/src/api/auth-client.ts:172` and the Contacts client helpers of
 *    `verticals/contacts/src/api/contacts-client.ts:63`. The factory set closes transitively, but only
 *    through functions that *return the client directly*, never through operation wrappers such as
 *    `createClient(o).pipe(Effect.flatMap(...))`, so one per-operation client does not taint every UI
 *    call site of the operation.
 *
 * Why: A1/A9 ask for long-lived typed clients. Constructing an accessor does not itself prove a new
 * transport, lost connection reuse, or lost cancellation; the injected HttpClient may be shared.
 * The diagnostic is about repeated typed client wiring, not unobservable transport semantics.
 * Named constructor identity is restricted to effectReexportModules; unrelated imports with the
 * same name are not evidence of HttpApi construction.
 *
 * What is deliberately allowed
 * ----------------------------
 * - **Module-level construction.** `const client = HttpApiClient.make(api, ...)`, or construction
 *   inside a module-level `Effect.gen` program: built once for the module, which is the target shape.
 * - **Layer / memoised construction that outlives the operation.** A construction lexically inside an
 *   argument of `Layer.effect` / `Layer.sync` / `Layer.unwrap` / `Layer.suspend` / `Effect.cached` /
 *   `Effect.cachedWithTTL` / `Effect.cachedInvalidateWithTTL` (`layerConstructorMembers`) **when that
 *   call's value escapes to module level** — it is the Layer/memo itself, or it is returned directly by
 *   a layer factory (`const makeClientLayer = (baseUrl) => Layer.effect(...)`). A `Layer.effect(...)`
 *   built and `Effect.provide`d *inside* an operation rebuilds the client, the Layer and the layer
 *   graph on every call, so it is reported: the shield follows the value's lifetime, not lexical nesting.
 * - **Module-level effect factories consumed by a Layer.** `const makeClientLive = (baseUrl) =>
 *   Effect.gen(function* () { ... HttpApiClient.make ... })` whose result is passed to a blessed
 *   `Layer.*` call anywhere in the module (the repository's dominant Live-layer idiom, e.g.
 *   `packages/core-runtime/src/permissions/service.ts:207`). The client is built once per Layer build.
 *   Such a function is still registered as a client factory, so calling it from an operation elsewhere
 *   in the file is reported.
 * - **The runtime modules that own the client** (`clientModuleFiles`). Empty by default: the browser
 *   `ManagedRuntime` seam that audit A9 asks for does not exist in this checkout yet, and a guessed
 *   glob is not an escape hatch. Point it at the runtime module once that module lands.
 * - **Tests and scripts** (`includeTests: false`, scripts are never in scope): fixtures and scaffold
 *   templates legitimately build throwaway clients (audit D tier).
 * - Anything outside `include` (`apps/**`, `verticals/**`, `packages/**`).
 *
 * Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings, effectMember } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { isScriptFile, isTestFile, matchesAny, normalisePath } from '../shared/paths.ts';

const DEFAULT_INCLUDE: readonly string[] = ['apps/**', 'verticals/**', 'packages/**'];
/** No browser runtime module exists yet (audit A9 lists it as a target); configure when it lands. */
const DEFAULT_CLIENT_MODULE_FILES: readonly string[] = [];
const DEFAULT_CONSTRUCTOR_NAMES: readonly string[] = ['makeEffectHttpApiClient'];
const DEFAULT_CONSTRUCTOR_MEMBERS: readonly string[] = [
  'HttpApiClient.make',
  'HttpApiClient.makeWith',
];
/** Derive a typed accessor from an already-injected `httpClient`: no transport is rebuilt. */
const DEFAULT_ACCESSOR_MEMBERS: readonly string[] = [
  'HttpApiClient.group',
  'HttpApiClient.endpoint',
];
const DEFAULT_LAYER_CONSTRUCTOR_MEMBERS: readonly string[] = [
  'Layer.effect',
  'Layer.sync',
  'Layer.unwrap',
  'Layer.suspend',
  'Effect.cached',
  'Effect.cachedWithTTL',
  'Effect.cachedInvalidateWithTTL',
];
/** `Effect.fn`/`Effect.fnUntraced` are NOT transparent: they return a function, so the body re-runs. */
const DEFAULT_TRANSPARENT_MEMBERS: readonly string[] = ['Effect.gen'];
/** Modules that re-export the `effect` namespaces verbatim (Modern.js BFF client). */
const DEFAULT_EFFECT_REEXPORT_MODULES: readonly string[] = ['@modern-js/plugin-bff/effect-client'];
/** Call wrappers that do not change which binding an effect/function is stored under. */
const NAME_WRAPPER_MEMBERS: ReadonlySet<string> = new Set([
  'Effect.gen',
  'Effect.fn',
  'Effect.fnUntraced',
]);

const EFFECT_MODULE = /^effect(?:\/.*)?$/u;
const FUNCTION_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);
const EXPRESSION_WRAPPERS = new Set([
  'ChainExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSInstantiationExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
]);

type SiteKind = 'accessor' | 'constructor';

interface ResolvedOptions {
  readonly include: readonly string[];
  readonly clientModuleFiles: readonly string[];
  readonly constructorNames: ReadonlySet<string>;
  readonly constructorMembers: ReadonlySet<string>;
  readonly accessorMembers: ReadonlySet<string>;
  readonly layerConstructorMembers: ReadonlySet<string>;
  readonly transparentMembers: ReadonlySet<string>;
  readonly effectReexportModules: readonly string[];
  readonly includeTests: boolean;
}

function readStringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function resolveOptions(context: Context): ResolvedOptions {
  const raw = context.options?.[0];
  const option: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    accessorMembers: new Set(readStringArray(option.accessorMembers, DEFAULT_ACCESSOR_MEMBERS)),
    clientModuleFiles: readStringArray(option.clientModuleFiles, DEFAULT_CLIENT_MODULE_FILES),
    constructorMembers: new Set(
      readStringArray(option.constructorMembers, DEFAULT_CONSTRUCTOR_MEMBERS),
    ),
    constructorNames: new Set(readStringArray(option.constructorNames, DEFAULT_CONSTRUCTOR_NAMES)),
    effectReexportModules: readStringArray(
      option.effectReexportModules,
      DEFAULT_EFFECT_REEXPORT_MODULES,
    ),
    include: readStringArray(option.include, DEFAULT_INCLUDE),
    includeTests: option.includeTests === true,
    layerConstructorMembers: new Set(
      readStringArray(option.layerConstructorMembers, DEFAULT_LAYER_CONSTRUCTOR_MEMBERS),
    ),
    transparentMembers: new Set(
      readStringArray(option.transparentMembers, DEFAULT_TRANSPARENT_MEMBERS),
    ),
  };
}

function parentOf(node: ESTree.Node): ESTree.Node | null {
  return (node as unknown as { parent?: ESTree.Node | null }).parent ?? null;
}

function sameNode(
  left: ESTree.Node | null | undefined,
  right: ESTree.Node | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return left.type === right.type && left.start === right.start && left.end === right.end;
}

/** Strip the wrappers that sit between an expression and its semantic parent. */
function unwrap(node: ESTree.Node): ESTree.Node {
  let current = node;
  while (EXPRESSION_WRAPPERS.has(current.type)) {
    const inner = (current as unknown as { expression?: ESTree.Node }).expression;
    if (inner === undefined) return current;
    current = inner;
  }
  return current;
}

function isFunctionNode(node: ESTree.Node): boolean {
  return FUNCTION_TYPES.has(node.type);
}

function importedName(specifier: ESTree.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : specifier.imported.value;
}

function lastSegment(module: string): string {
  return module.split('/').at(-1) ?? module;
}

interface NamedImport {
  readonly imported: string;
  readonly source: string;
}

interface ModuleImports {
  /** local name → `{ imported, source }` for every value `import { x as y }` in the file. */
  readonly named: ReadonlyMap<string, NamedImport>;
  /** locals bound by `import * as ns from "..."`. */
  readonly namespaces: ReadonlyMap<string, string>;
}

function collectModuleImports(program: ESTree.Program): ModuleImports {
  const named = new Map<string, NamedImport>();
  const namespaces = new Map<string, string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue;
    const source = statement.source.value;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier') {
        if (specifier.importKind === 'type') continue;
        named.set(specifier.local.name, { imported: importedName(specifier), source });
      } else if (specifier.type === 'ImportNamespaceSpecifier') {
        namespaces.set(specifier.local.name, source);
      }
    }
  }
  return { named, namespaces };
}

/**
 * `effect`/`effect/*` bindings plus the namespaces re-exported by `effectReexportModules`
 * (`import { Effect, makeEffectHttpApiClient } from "@modern-js/plugin-bff/effect-client"`), so
 * `Effect.gen`, `Layer.effect` and `HttpApiClient.make` resolve in BFF client modules too.
 */
function mergedBindings(program: ESTree.Program, options: ResolvedOptions): EffectBindings {
  const base = collectEffectBindings(program);
  const namespaces = new Map(base.namespaces);
  let extra = false;
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue;
    if (!options.effectReexportModules.includes(statement.source.value)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') continue;
      namespaces.set(specifier.local.name, importedName(specifier));
      extra = true;
    }
  }
  return { importsEffect: base.importsEffect || extra, namespaces };
}

/** `HttpApiClient.make` / `HttpApiClient["make"]` → `{ object, property }`. */
function memberParts(node: ESTree.Node): { object: string; property: string } | null {
  if (node.type !== 'MemberExpression') return null;
  const member = node as unknown as {
    object: ESTree.Node;
    property: ESTree.Node;
    computed: boolean;
  };
  if (member.object.type !== 'Identifier') return null;
  const object = (member.object as unknown as { name: string }).name;
  if (!member.computed && member.property.type === 'Identifier') {
    return { object, property: (member.property as unknown as { name: string }).name };
  }
  if (member.computed && member.property.type === 'Literal') {
    const value = (member.property as unknown as { value: unknown }).value;
    if (typeof value === 'string') return { object, property: value };
  }
  return null;
}

/** Static key of an object-pattern property: `{ make }`, `{ make: alias }`, `{ "make": alias }`. */
function propertyKeyName(key: ESTree.Node): string | null {
  if (key.type === 'Identifier') return (key as unknown as { name: string }).name;
  if (key.type !== 'Literal') return null;
  const value = (key as unknown as { value: unknown }).value;
  return typeof value === 'string' ? value : null;
}

/** `Layer.effect` → `"Layer.effect"` when the object is a tracked Effect namespace binding. */
function namespaceMemberString(node: ESTree.Node, bindings: EffectBindings): string | null {
  const matched = effectMember(node, bindings);
  if (matched !== null) return `${matched.namespace}.${matched.member}`;
  // `effectMember` bails on computed access; a literal string key is just as static.
  const parts = memberParts(node);
  if (parts === null) return null;
  const namespace = bindings.namespaces.get(parts.object);
  return namespace === undefined ? null : `${namespace}.${parts.property}`;
}

function lookupVariable(context: Context, identifier: ESTree.Node): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(identifier);
  const name = (identifier as unknown as { name?: string }).name;
  if (name === undefined) return null;
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A9/A1/A8: disallow building an HttpApi client (makeEffectHttpApiClient / ' +
        'HttpApiClient.make) inside an operation function, or calling a module-level client factory ' +
        'from one. Construct the client once from the injected HttpClient and reuse it.',
    },
    messages: {
      clientPerOperation:
        '`{{callee}}` builds a fresh HttpApi client for one operation (audit A9/A1: ' +
        '`apps/shell-super-app/src/api/auth-client.ts:172`, `verticals/contacts/src/api/contacts-client.ts:63`). ' +
        'Construct it once from the injected `HttpClient` — ' +
        '`Layer.effect(ClientTag, Effect.gen(function* () { const http = yield* HttpClient.HttpClient; ' +
        'return yield* HttpApiClient.make(api, { httpClient: http }) }))` — yield that service in the ' +
        'operation, and set per-request headers with `HttpClient.mapRequest` instead of rebuilding the ' +
        'typed client. Rebuilding typed client wiring need not rebuild the underlying transport; ' +
        'keep transport lifetime and per-request policy explicit.',
      accessorPerOperation:
        '`{{callee}}` derives an HttpApi accessor inside an operation (audit A9/A1). It reuses the ' +
        '`httpClient` you pass in, so no transport is rebuilt, but the derivation, its Schema wiring and ' +
        'its error channel are rebuilt on every call. Derive it once — at module level, or in the ' +
        '`Layer.effect` that publishes the client service — and yield that service in the operation.',
      clientFactoryPerOperation:
        '`{{callee}}(...)` builds a fresh HttpApi client for this operation (audit A9/A1/A8: ~24 operations in ' +
        '`apps/shell-super-app/src/api/auth-client.ts` and the generated `verticals/contacts` clients each call a ' +
        'client factory). Expose the client as a `Context.Service` provided by a `Layer.effect` over the ' +
        'injected `HttpClient` (or a single browser `ManagedRuntime` module instance) and yield it here; ' +
        'per-request headers belong in `HttpClient.mapRequest` on that shared client, not in a new one. ' +
        'If the factory must stay a function, memoise it so it outlives the operation ' +
        '(`Effect.cached` / `Effect.cachedWithTTL` / `Effect.cachedInvalidateWithTTL`) or hand its effect to ' +
        '`Layer.effect` at module level.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          clientModuleFiles: { type: 'array', items: { type: 'string' } },
          constructorNames: { type: 'array', items: { type: 'string' } },
          constructorMembers: { type: 'array', items: { type: 'string' } },
          accessorMembers: { type: 'array', items: { type: 'string' } },
          layerConstructorMembers: { type: 'array', items: { type: 'string' } },
          transparentMembers: { type: 'array', items: { type: 'string' } },
          effectReexportModules: { type: 'array', items: { type: 'string' } },
          includeTests: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        accessorMembers: [...DEFAULT_ACCESSOR_MEMBERS],
        clientModuleFiles: [...DEFAULT_CLIENT_MODULE_FILES],
        constructorMembers: [...DEFAULT_CONSTRUCTOR_MEMBERS],
        constructorNames: [...DEFAULT_CONSTRUCTOR_NAMES],
        effectReexportModules: [...DEFAULT_EFFECT_REEXPORT_MODULES],
        include: [...DEFAULT_INCLUDE],
        includeTests: false,
        layerConstructorMembers: [...DEFAULT_LAYER_CONSTRUCTOR_MEMBERS],
        transparentMembers: [...DEFAULT_TRANSPARENT_MEMBERS],
      },
    ],
  },
  createOnce(context) {
    let options: ResolvedOptions | null = null;
    let bindings: EffectBindings | null = null;
    let imports: ModuleImports | null = null;
    let aliases: Map<string, { text: string; kind: SiteKind }> = new Map();
    let constructorSites: Array<{ node: ESTree.Node; text: string; kind: SiteKind }> = [];
    let identifierCalls: Array<{ node: ESTree.Node; identifier: ESTree.Node; name: string }> = [];
    let layerCalls: Array<{ node: ESTree.Node; args: readonly ESTree.Node[] }> = [];

    /** `"Layer.effect"` for a callee, resolved through real import bindings. */
    function memberOf(node: ESTree.Node): string | null {
      const effects = bindings;
      if (effects === null) return null;
      const parts = memberParts(node);
      if (
        parts !== null &&
        node.type === 'MemberExpression' &&
        bindingKind(node.object) !== 'import'
      )
        return null;
      return namespaceMemberString(node, effects);
    }

    /** The call is `Effect.gen(fn)` / `Effect.fn("name")(fn)` for one of `members`. */
    function isWrapperCall(call: ESTree.CallExpression, members: ReadonlySet<string>): boolean {
      const callee = unwrap(call.callee as unknown as ESTree.Node);
      const direct = memberOf(callee);
      if (direct !== null) return members.has(direct);
      if (callee.type !== 'CallExpression') return false;
      const curried = memberOf(
        unwrap((callee as unknown as ESTree.CallExpression).callee as unknown as ESTree.Node),
      );
      return curried !== null && members.has(curried);
    }

    /** A function whose body is inlined into the effect it is passed to (`Effect.gen`). */
    function isTransparentFunction(fn: ESTree.Node): boolean {
      const resolved = options;
      if (resolved === null) return false;
      const parent = parentOf(fn);
      if (parent === null || parent.type !== 'CallExpression') return false;
      const call = parent as unknown as ESTree.CallExpression;
      if (sameNode(unwrap(call.callee as unknown as ESTree.Node), fn)) return false;
      return isWrapperCall(call, resolved.transparentMembers);
    }

    /** Nearest enclosing function, walking through `Effect.gen` generator bodies. */
    function nearestRealFunction(node: ESTree.Node): ESTree.Node | null {
      let current: ESTree.Node | null = parentOf(node);
      while (current !== null && current.type !== 'Program') {
        if (isFunctionNode(current) && !isTransparentFunction(current)) return current;
        current = parentOf(current);
      }
      return null;
    }

    function hasFunctionAncestor(node: ESTree.Node): boolean {
      return nearestRealFunction(node) !== null;
    }

    /** The node's value *is* the result of `fn` (a `return`, or an arrow's expression body). */
    function isDirectResultOf(node: ESTree.Node, fn: ESTree.Node): boolean {
      let current: ESTree.Node = node;
      let parent = parentOf(current);
      while (parent !== null && EXPRESSION_WRAPPERS.has(parent.type)) {
        current = parent;
        parent = parentOf(current);
      }
      if (parent === null) return false;
      if (parent.type === 'ReturnStatement') return true;
      if (fn.type !== 'ArrowFunctionExpression') return false;
      return sameNode(unwrap((fn as unknown as { body: ESTree.Node }).body), unwrap(current));
    }

    /**
     * The value produced here survives every enclosing function — it is returned all the way out to
     * module level (a Layer/memo constant, or a layer factory's return value), instead of being
     * consumed inside an operation.
     */
    function resultEscapesToModuleLevel(node: ESTree.Node): boolean {
      let current: ESTree.Node = node;
      for (let guard = 0; guard < 64; guard += 1) {
        const fn = nearestRealFunction(current);
        if (fn === null) return true;
        if (!isDirectResultOf(current, fn)) return false;
        current = fn;
      }
      return false;
    }

    /**
     * `true` when the node sits in an argument of a `Layer.effect`/`Effect.cached`-style call whose
     * own value escapes to module level — the audit's blessed "construct the client once while
     * building the Layer" shape. A `Layer.effect(...)` consumed by `Effect.provide` inside an
     * operation is *not* blessed: it rebuilds the client and the layer graph per call.
     */
    function isInsideBlessedLayerConstruction(node: ESTree.Node): boolean {
      const resolved = options;
      if (resolved === null) return false;
      let current: ESTree.Node = node;
      let parent = parentOf(current);
      while (parent !== null && parent.type !== 'Program') {
        if (parent.type === 'CallExpression') {
          const call = parent as unknown as ESTree.CallExpression;
          if (!sameNode(unwrap(call.callee as unknown as ESTree.Node), current)) {
            const member = memberOf(unwrap(call.callee as unknown as ESTree.Node));
            if (
              member !== null &&
              resolved.layerConstructorMembers.has(member) &&
              resultEscapesToModuleLevel(parent)
            ) {
              return true;
            }
          }
        }
        current = parent;
        parent = parentOf(current);
      }
      return false;
    }

    /** The binding this function is stored under, when that is a module-level name. */
    function moduleFunctionName(fn: ESTree.Node): string | null {
      if (fn.type === 'FunctionDeclaration') {
        const id = (fn as unknown as { id?: { name?: string } | null }).id;
        return id?.name ?? null;
      }
      let current: ESTree.Node = fn;
      let parent = parentOf(current);
      for (let guard = 0; guard < 16 && parent !== null; guard += 1) {
        if (EXPRESSION_WRAPPERS.has(parent.type)) {
          current = parent;
          parent = parentOf(current);
          continue;
        }
        // `export const op = Effect.fn("op")(function* () { ... })` still binds `op`.
        if (
          parent.type === 'CallExpression' &&
          !sameNode(
            unwrap((parent as unknown as ESTree.CallExpression).callee as unknown as ESTree.Node),
            current,
          ) &&
          isWrapperCall(parent as unknown as ESTree.CallExpression, NAME_WRAPPER_MEMBERS)
        ) {
          current = parent;
          parent = parentOf(current);
          continue;
        }
        break;
      }
      if (parent === null || parent.type !== 'VariableDeclarator') return null;
      const id = (parent as unknown as { id?: ESTree.Node }).id;
      if (id === undefined || id.type !== 'Identifier') return null;
      return (id as unknown as { name: string }).name;
    }

    /** Name of the outermost enclosing function when it is declared at module level. */
    function outermostModuleFunctionName(node: ESTree.Node): string | null {
      let outermost: ESTree.Node | null = null;
      let current: ESTree.Node | null = parentOf(node);
      while (current !== null && current.type !== 'Program') {
        if (isFunctionNode(current)) outermost = current;
        current = parentOf(current);
      }
      return outermost === null ? null : moduleFunctionName(outermost);
    }

    /**
     * Name of the module-level function that *returns* this call directly — i.e. the call's value is
     * the function's result, not something piped into an operation. Used to close the factory set
     * transitively without tainting operation wrappers such as
     * `createClient(o).pipe(Effect.flatMap(...))`.
     */
    function returnedFactoryName(node: ESTree.Node): string | null {
      const fn = nearestRealFunction(node);
      if (fn === null) return null;
      if (!isDirectResultOf(node, fn)) return null;
      const outermost = outermostModuleFunctionName(node);
      if (outermost === null) return null;
      return moduleFunctionName(fn) === outermost ? outermost : null;
    }

    /** How the identifier is bound at its use site: import, module-level value, or shadowed. */
    function bindingKind(identifier: ESTree.Node): 'import' | 'module' | 'other' | 'unresolved' {
      const variable = lookupVariable(context, identifier);
      if (variable === null) return 'unresolved';
      if (variable.defs.length === 0) return 'other';
      if (variable.defs.some((definition) => definition.type === 'ImportBinding')) return 'import';
      const declared = variable.defs.some(
        (definition) => definition.type === 'Variable' || definition.type === 'FunctionName',
      );
      if (!declared) return 'other';
      const scopeType = variable.scope.type;
      return scopeType === 'module' || scopeType === 'global' ? 'module' : 'other';
    }

    /** The identifier still resolves to a module-level `const`/`function` declaration in this file. */
    function resolvesToModuleFunction(identifier: ESTree.Node): boolean {
      const kind = bindingKind(identifier);
      return kind === 'module' || kind === 'unresolved';
    }

    function classifyMember(text: string): SiteKind | null {
      const resolved = options;
      if (resolved === null) return null;
      if (resolved.constructorMembers.has(text)) return 'constructor';
      if (resolved.accessorMembers.has(text)) return 'accessor';
      return null;
    }

    /** `import { make } from "effect/unstable/httpapi/HttpApiClient"` and friends. */
    function classifyNamedImport(entry: NamedImport): SiteKind | null {
      const resolved = options;
      if (resolved === null) return null;
      if (
        resolved.constructorNames.has(entry.imported) &&
        resolved.effectReexportModules.includes(entry.source)
      )
        return 'constructor';
      if (!EFFECT_MODULE.test(entry.source)) return null;
      return classifyMember(`${lastSegment(entry.source)}.${entry.imported}`);
    }

    /** `bff.makeEffectHttpApiClient` / `HttpApiClient.make` / `HttpApiClient["make"]`. */
    function classifyMemberCallee(callee: ESTree.Node): { text: string; kind: SiteKind } | null {
      const resolved = options;
      const moduleImports = imports;
      if (resolved === null || moduleImports === null) return null;
      const member = memberOf(callee);
      if (member !== null) {
        const kind = classifyMember(member);
        if (kind !== null) return { kind, text: member };
      }
      const parts = memberParts(callee);
      if (parts === null) return null;
      const source = moduleImports.namespaces.get(parts.object);
      if (source === undefined || !resolved.effectReexportModules.includes(source)) return null;
      if (callee.type !== 'MemberExpression' || bindingKind(callee.object) !== 'import')
        return null;
      if (!resolved.constructorNames.has(parts.property)) return null;
      return { kind: 'constructor', text: `${parts.object}.${parts.property}` };
    }

    /**
     * Module-level rebindings of a constructor: `const buildClient = makeEffectHttpApiClient`,
     * `const { makeEffectHttpApiClient: build } = bff`, `const { make } = HttpApiClient`.
     */
    function collectAliases(
      program: ESTree.Program,
    ): Map<string, { text: string; kind: SiteKind }> {
      const resolved = options;
      const effects = bindings;
      const moduleImports = imports;
      const found = new Map<string, { text: string; kind: SiteKind }>();
      if (resolved === null || effects === null || moduleImports === null) return found;
      for (const statement of program.body) {
        const declaration =
          statement.type === 'ExportNamedDeclaration'
            ? ((statement as unknown as { declaration?: ESTree.Node | null }).declaration ?? null)
            : statement;
        if (declaration === null || declaration.type !== 'VariableDeclaration') continue;
        for (const declarator of (declaration as unknown as { declarations: ESTree.Node[] })
          .declarations) {
          const entry = declarator as unknown as { id: ESTree.Node; init?: ESTree.Node | null };
          if (entry.init === undefined || entry.init === null) continue;
          const init = unwrap(entry.init);
          if (entry.id.type === 'Identifier') {
            const local = (entry.id as unknown as { name: string }).name;
            if (init.type === 'Identifier') {
              const named = moduleImports.named.get((init as unknown as { name: string }).name);
              const kind = named === undefined ? null : classifyNamedImport(named);
              if (kind !== null) found.set(local, { kind, text: local });
              continue;
            }
            const memberSite = classifyMemberCallee(init);
            if (memberSite !== null) found.set(local, { kind: memberSite.kind, text: local });
            continue;
          }
          if (entry.id.type !== 'ObjectPattern' || init.type !== 'Identifier') continue;
          const objectName = (init as unknown as { name: string }).name;
          const namespace = effects.namespaces.get(objectName);
          const source = moduleImports.namespaces.get(objectName);
          const isImportedNamespace =
            source !== undefined && resolved.effectReexportModules.includes(source);
          if (namespace === undefined && !isImportedNamespace) continue;
          for (const property of (entry.id as unknown as { properties: ESTree.Node[] })
            .properties) {
            if (property.type !== 'Property') continue;
            const pair = property as unknown as {
              key: ESTree.Node;
              value: ESTree.Node;
              computed: boolean;
            };
            if (pair.computed || pair.value.type !== 'Identifier') continue;
            const key = propertyKeyName(pair.key);
            if (key === null) continue;
            const local = (pair.value as unknown as { name: string }).name;
            if (namespace !== undefined) {
              const kind = classifyMember(`${namespace}.${key}`);
              if (kind !== null) found.set(local, { kind, text: local });
              continue;
            }
            if (resolved.constructorNames.has(key))
              found.set(local, { kind: 'constructor', text: local });
          }
        }
      }
      return found;
    }

    /** `makeEffectHttpApiClient(...)` / `bff.makeEffectHttpApiClient(...)` / `HttpApiClient.make(...)`. */
    function constructorSite(callee: ESTree.Node): { text: string; kind: SiteKind } | null {
      const moduleImports = imports;
      if (options === null || bindings === null || moduleImports === null) return null;
      if (callee.type === 'Identifier') {
        const local = (callee as unknown as { name: string }).name;
        const kindOfBinding = bindingKind(callee);
        const named = moduleImports.named.get(local);
        if (named !== undefined) {
          const kind = classifyNamedImport(named);
          if (kind === null) return null;
          return kindOfBinding === 'import' || kindOfBinding === 'unresolved'
            ? { kind, text: local }
            : null;
        }
        const alias = aliases.get(local);
        if (alias === undefined) return null;
        return kindOfBinding === 'module' || kindOfBinding === 'unresolved' ? alias : null;
      }
      return classifyMemberCallee(callee);
    }

    function withinRange(node: ESTree.Node, range: { start: number; end: number }): boolean {
      return node.start >= range.start && node.end <= range.end;
    }

    return {
      before() {
        options = resolveOptions(context);
        aliases = new Map();
        constructorSites = [];
        identifierCalls = [];
        layerCalls = [];
        const path = normalisePath(context.filename).replace(
          /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u,
          '',
        );
        if (!options.includeTests && isTestFile(path)) return false;
        if (isScriptFile(path)) return false;
        if (!matchesAny(path, options.include)) return false;
        if (matchesAny(path, options.clientModuleFiles)) return false;
        const program = context.sourceCode.ast;
        bindings = mergedBindings(program, options);
        imports = collectModuleImports(program);
        aliases = collectAliases(program);
        return true;
      },
      after() {
        bindings = null;
        imports = null;
        aliases = new Map();
        constructorSites = [];
        identifierCalls = [];
        layerCalls = [];
      },
      CallExpression(node) {
        if (options === null) return;
        const callee = unwrap(node.callee as unknown as ESTree.Node);
        const site = constructorSite(callee);
        if (site !== null) {
          constructorSites.push({
            kind: site.kind,
            node: node as unknown as ESTree.Node,
            text: site.text,
          });
          return;
        }
        const member = memberOf(callee);
        if (member !== null && options.layerConstructorMembers.has(member)) {
          layerCalls.push({
            args: (node as unknown as { arguments: ESTree.Node[] }).arguments,
            node: node as unknown as ESTree.Node,
          });
          return;
        }
        if (callee.type !== 'Identifier') return;
        identifierCalls.push({
          identifier: callee,
          name: (callee as unknown as { name: string }).name,
          node: node as unknown as ESTree.Node,
        });
      },
      'Program:exit'() {
        if (options === null || bindings === null) return;
        const factories = new Set<string>();
        const reports: Array<{ node: ESTree.Node; messageId: string; callee: string }> = [];
        const constructorSpans = new Set<string>();

        // Module-level effect factories handed to a blessed `Layer.*`/`Effect.cached*` call build the
        // client once per Layer build — the audit's target shape, even though the construction is not
        // lexically nested inside the Layer call.
        const layerConsumed = new Set<string>();
        const blessedArgumentRanges: Array<{ start: number; end: number }> = [];
        for (const layerCall of layerCalls) {
          if (!resultEscapesToModuleLevel(layerCall.node)) continue;
          for (const argument of layerCall.args) {
            blessedArgumentRanges.push({ end: argument.end, start: argument.start });
            const value = unwrap(argument);
            if (value.type === 'Identifier' && resolvesToModuleFunction(value)) {
              layerConsumed.add((value as unknown as { name: string }).name);
            }
          }
        }
        for (const call of identifierCalls) {
          if (!blessedArgumentRanges.some((range) => withinRange(call.node, range))) continue;
          if (!resolvesToModuleFunction(call.identifier)) continue;
          layerConsumed.add(call.name);
        }

        for (const site of constructorSites) {
          constructorSpans.add(`${site.node.start}:${site.node.end}`);
          if (!hasFunctionAncestor(site.node)) continue;
          const owner = outermostModuleFunctionName(site.node);
          const blessed =
            isInsideBlessedLayerConstruction(site.node) ||
            (owner !== null && layerConsumed.has(owner));
          // A blessed construction still marks its function as a client factory: calling it from an
          // operation elsewhere in the file is a fresh client per call.
          if (owner !== null) factories.add(owner);
          if (blessed) continue;
          reports.push({
            callee: site.text,
            messageId: site.kind === 'accessor' ? 'accessorPerOperation' : 'clientPerOperation',
            node: site.node,
          });
        }

        const candidates = identifierCalls.filter(
          (call) =>
            !constructorSpans.has(`${call.node.start}:${call.node.end}`) &&
            hasFunctionAncestor(call.node) &&
            !isInsideBlessedLayerConstruction(call.node) &&
            resolvesToModuleFunction(call.identifier),
        );

        let changed = true;
        while (changed) {
          changed = false;
          for (const call of candidates) {
            if (!factories.has(call.name)) continue;
            const promoted = returnedFactoryName(call.node);
            if (promoted === null || promoted === call.name || factories.has(promoted)) continue;
            factories.add(promoted);
            changed = true;
          }
        }

        for (const call of candidates) {
          if (!factories.has(call.name)) continue;
          reports.push({
            callee: call.name,
            messageId: 'clientFactoryPerOperation',
            node: call.node,
          });
        }

        for (const report of reports) {
          context.report({
            data: { callee: report.callee },
            messageId: report.messageId,
            node: report.node as never,
          });
        }
      },
    };
  },
});
