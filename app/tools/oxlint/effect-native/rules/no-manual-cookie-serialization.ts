/**
 * Audit finding: **C1** — "Remove remaining hand-owned serialization"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`). C1 names cookie construction explicitly and
 * prescribes "Effect HTTP Cookies" as the replacement, while the "Existing patterns to preserve"
 * section blesses cookie *parsing* ("Cookie parsing already uses better-auth and Effect HTTP
 * helpers") — so this rule targets the *write* side only.
 *
 * Concrete evidence the rule exists for:
 * - `apps/shell-super-app/api/auth/impersonation-service.ts:263` — `'__Secure-'` prefix concatenated
 *   into a cookie name by hand.
 * - `apps/shell-super-app/api/auth/impersonation-service.ts:265` — `Path=/; HttpOnly; SameSite=Lax…`
 *   attribute string assembled in a template literal.
 * - `apps/shell-super-app/api/auth/impersonation-service.ts:269` / `:403` — `Max-Age` / `Expires`
 *   glued on by hand for clearing and persistence cookies.
 * - `apps/shell-super-app/api/auth/service.ts:334`–`:340` — the same hand-built clearing cookies.
 *
 * What is detected (production files under `paths`, tests excluded by default)
 * 1. **Cookie attribute text** in a `StringLiteral` or a `TemplateLiteral` quasi: a `Path=`,
 *    `Domain=`, `Max-Age=`, `Expires=`, `SameSite=` or `Priority=` attribute at the start of the
 *    fragment or after a `;`, or a bare `HttpOnly` / `Secure` / `Partitioned` flag that occupies a
 *    whole `;`-delimited segment. Also a string starting with the `__Secure-` / `__Host-` cookie
 *    name prefix, which encodes an attribute contract into a name by hand.
 * 2. **Writing a `set-cookie` header directly**: `headers.append('set-cookie', x)` /
 *    `.set(…)` / `.setHeader(…)` (header name matched case-insensitively), unless `x` is produced by
 *    a call into an Effect HTTP cookie binding (`Cookies.*` / `HttpServerResponse.*`, tracked through
 *    aliases and `effect/http` namespace imports).
 * 3. **A `Set-Cookie` property in a headers object literal** whose value is hand-built — a string,
 *    a template literal, a `+` concatenation, or an array/conditional of those.
 * Raw string contracts are not serialization evidence: better-auth produces string headers and
 * Cookies.fromSetCookie explicitly accepts them. Legacy contract options are accepted for config
 * compatibility but do not enable type-only diagnostics; a type alone never proves hand-building.

 *
 * A match from (1) nested inside a reported (2)/(3) — or inside an already-reported template
 * literal — is suppressed so each hand-built cookie is reported once, at the outermost node.
 *
 * What is deliberately allowed
 * - **Parsing** — `parseCookies(headers.get('cookie') ?? '')`, `Cookies.fromSetCookie(headers)`,
 *   `headers.get('set-cookie')`: reading is blessed by the audit, only writing is reported.
 * - Every call into `Cookies` / `HttpServerResponse` (`HttpServerResponse.setCookie(…)`,
 *   `HttpServerResponse.mergeCookies(Cookies.fromSetCookie(…))`), including aliased and namespace
 *   imports (`import * as Cookies from "effect/http/Cookies"`).
 * - An immutable local `for...of` forwarding native `Headers.getSetCookie()` values unchanged into
 *   a native Effect-to-Web response adapter. This preserves repeated same-name cookies with
 *   different paths; it does not construct cookies or transform serialized values.
 * - Test files (`ignoreTestFiles: true` by default) — the audit's D tier keeps hand-written cookie
 *   strings inside test fixtures and assertions.
 * - Anything outside `paths`, matching `allowPaths`, or matching `exclude` (generated output).
 *
 * Static limits: semicolon-delimited cookie text is lexical (prose can still resemble it).
 * Opaque property values are not proof of hand-building. Type-only string contracts cannot identify
 * the producer. Dynamic header names and cross-file ownership are not inferred. No fixer/suggestion.
 */
import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { unwrap as unwrapExpression, staticString, keyName, walk } from '../shared/ast.ts';
import { isUnshadowedGlobal, lookupVariable } from '../shared/bindings.ts';
import { collectEffectBindings, type EffectBindings } from '../shared/effect-imports.ts';
import { optionRecord } from '../shared/options.ts';
import { stringArray } from '../shared/options.ts';
import { isTestFile, matchesGlobs, scopePath } from '../shared/paths.ts';

const DEFAULT_PATHS = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];

/** Generated output that is never hand-edited (and is git-ignored, so normally never linted). */
const DEFAULT_EXCLUDE = ['**/dist/**', '**/.output/**', '**/node_modules/**', '**/*.d.ts'];

/** Effect HTTP namespaces that own cookie serialization. A call into these is the target shape. */
const DEFAULT_COOKIE_NAMESPACES = ['Cookies', 'Cookie', 'HttpServerResponse', 'HttpServerRespondable'];

const DEFAULT_CONTRACT_NAMES = ['setCookieHeaders', 'setCookieHeader', 'cookieHeaders'];

/** Methods that write a header value (`Headers`, node `ServerResponse`, Effect response builders). */
const HEADER_WRITERS = new Set(['append', 'set', 'setHeader', 'setHeaders', 'add', 'put', 'writeHead']);

const SET_COOKIE_HEADER = 'set-cookie';

/**
 * A cookie attribute at the start of a fragment or right after a `;`. Attribute names are matched
 * case-sensitively (the codebase and the RFC 6265 examples use canonical casing), which keeps
 * `Cache-Control: max-age=…` and query strings out of the rule.
 */
const COOKIE_ATTRIBUTE =
  /;\s*(?:(?:Path|Domain|Max-Age|Expires|SameSite|Priority)\s*=|(?:HttpOnly|Secure|Partitioned)\s*(?:;|$))/iu;

/** `__Secure-` / `__Host-` cookie name prefixes carry an attribute contract in the name. */
const COOKIE_NAME_PREFIX = /^__(?:Secure|Host)-/u;

type LocalIdentifier = Extract<ESTree.Node, { type: 'Identifier' }>;

interface RuleOptions {
  readonly paths: readonly string[];
  readonly allowPaths: readonly string[];
  readonly exclude: readonly string[];
  readonly ignoreTestFiles: boolean;
  readonly cookieNamespaces: readonly string[];
  readonly flagCookieStringContracts: boolean;
  readonly contractNames: readonly string[];
}

function readOptions(context: Context): RuleOptions {
  const record = optionRecord(context.options?.[0]);
  return {
    paths: stringArray(record.paths, DEFAULT_PATHS),
    allowPaths: stringArray(record.allowPaths, []),
    exclude: stringArray(record.exclude, DEFAULT_EXCLUDE),
    ignoreTestFiles: record.ignoreTestFiles !== false,
    cookieNamespaces: stringArray(record.cookieNamespaces, DEFAULT_COOKIE_NAMESPACES),
    flagCookieStringContracts: record.flagCookieStringContracts === true,
    contractNames: stringArray(record.contractNames, DEFAULT_CONTRACT_NAMES),
  };
}

/** Preserve the rule's nullable, unlimited-depth expression unwrapping. */
function unwrap(node: ESTree.Node | null | undefined): ESTree.Node | null {
  return unwrapExpression(node);
}

/** Non-computed `.foo`, or computed `["foo"]`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const property = unwrap(node.property);
  return literalString(property);
}

function literalString(node: ESTree.Node | null | undefined): string | null {
  return staticString(node, {
    unwrap: {},
    templates: true,
    rawTemplates: true,
    singleQuasi: false,
  });
}

function isCookieText(text: string): boolean {
  return COOKIE_ATTRIBUTE.test(text) || COOKIE_NAME_PREFIX.test(text);
}

/** Every static fragment of a template literal (`cooked`, falling back to `raw`). */
function templateFragments(node: ESTree.TemplateLiteral): readonly string[] {
  return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw);
}

function templateHasCookieText(node: ESTree.TemplateLiteral): boolean {
  return templateFragments(node).some(isCookieText);
}

/** `Cookies.fromSetCookie` / `HttpServerResponse.setCookie` — an Effect HTTP cookie namespace member. */
function isCookieNamespaceMember(
  context: Context,
  node: ESTree.Node | null,
  bindings: EffectBindings,
  namespaces: readonly string[],
): boolean {
  const target = unwrap(node);
  if (target === null || target.type !== 'MemberExpression') return false;
  const object = unwrap(target.object);
  if (object === null || object.type !== 'Identifier') return false;
  const mapped = bindings.namespaces.get(object.name);
  if (mapped === undefined || !namespaces.includes(mapped)) return false;
  let scope: Scope | null = context.sourceCode.getScope(object);
  while (scope) {
    const variable = scope.set.get(object.name);
    if (variable)
      return variable.defs.some(
        (def) =>
          def.type === 'ImportBinding' &&
          def.parent?.type === 'ImportDeclaration' &&
          def.parent.importKind !== 'type' &&
          (def.node.type !== 'ImportSpecifier' || def.node.importKind !== 'type'),
      );
    scope = scope.upper;
  }
  return false;
}

/**
 * `true` when the expression is (or contains) a call into an Effect HTTP cookie namespace, so the
 * serialization is owned by `Cookies` / `HttpServerResponse` rather than written by hand.
 */
function isCookieOwnedValue(
  context: Context,
  node: ESTree.Node | null,
  bindings: EffectBindings,
  namespaces: readonly string[],
  depth = 0,
): boolean {
  const target = unwrap(node);
  if (target === null || depth > 6) return false;
  switch (target.type) {
    case 'CallExpression': {
      // An unrelated wrapper can replace its argument; merely containing Cookies is not ownership.
      return isCookieOwnedValue(context, target.callee, bindings, namespaces, depth + 1);
    }
    case 'MemberExpression':
      // `Cookies.toSetCookieHeaders(…)[0]` / `HttpServerResponse.setCookie(…).headers`.
      return (
        isCookieNamespaceMember(context, target, bindings, namespaces) ||
        isCookieOwnedValue(context, target.object, bindings, namespaces, depth + 1)
      );
    default:
      return isOwnedComposite(target, (child) => isCookieOwnedValue(context, child, bindings, namespaces, depth + 1));
  }
}

function isOwnedComposite(target: ESTree.Node, owned: (node: ESTree.Node | null) => boolean): boolean {
  switch (target.type) {
    case 'LogicalExpression':
      return owned(target.left) && (literalString(target.right) === '' || owned(target.right));
    case 'AwaitExpression':
    case 'YieldExpression':
      return owned(target.argument);
    case 'ConditionalExpression':
      return owned(target.consequent) && owned(target.alternate);
    case 'ArrayExpression':
      return (
        target.elements.length > 0 &&
        target.elements.every((element) => element !== null && element.type !== 'SpreadElement' && owned(element))
      );
    default:
      return false;
  }
}

/** A value assembled by hand: string, template, `+` concatenation, or an array/conditional of those. */
function isHandBuiltValue(node: ESTree.Node | null, depth = 0): boolean {
  const target = unwrap(node);
  if (target === null || depth > 6) return false;
  switch (target.type) {
    case 'Literal':
      return typeof target.value === 'string';
    case 'TemplateLiteral':
      return true;
    case 'BinaryExpression':
      return isHandBuiltConcatenation(target, depth);
    case 'ConditionalExpression':
      return isHandBuiltValue(target.consequent, depth + 1) || isHandBuiltValue(target.alternate, depth + 1);
    case 'ArrayExpression':
      return target.elements.some(
        (element) => element !== null && element.type !== 'SpreadElement' && isHandBuiltValue(element, depth + 1),
      );
    default:
      return false;
  }
}

function isHandBuiltConcatenation(
  target: ESTree.BinaryExpression | ESTree.PrivateInExpression,
  depth: number,
): boolean {
  return (
    target.operator === '+' && (isHandBuiltValue(target.left, depth + 1) || isHandBuiltValue(target.right, depth + 1))
  );
}

function propertyKeyName(node: ESTree.Node): string | null {
  if (node.type !== 'Property' && node.type !== 'TSPropertySignature' && node.type !== 'PropertyDefinition')
    return null;
  return keyName(
    node.key,
    node.computed,
    node.computed ? { unwrap: {}, templates: true, rawTemplates: true } : { templates: false },
  );
}

/** The header name a header-writing call targets, plus the argument holding the written value. */
function headerWrite(
  context: Context,
  node: ESTree.CallExpression,
): { name: string; value: ESTree.Node | null } | null {
  const callee = unwrap(node.callee);
  if (callee === null || callee.type !== 'MemberExpression') return null;
  const method = memberName(callee);
  if (method === null || !HEADER_WRITERS.has(method)) return null;
  return cookieHeaderArgument(context, node.arguments);
}

function cookieHeaderArgument(
  context: Context,
  args: ESTree.CallExpression['arguments'],
): { name: string; value: ESTree.Node | null } | null {
  for (const [index, argument] of args.entries()) {
    if (argument.type === 'SpreadElement') continue;
    const name = constantString(context, argument);
    if (name === null || name.toLowerCase() !== SET_COOKIE_HEADER) continue;
    const next = args[index + 1];
    if (next === undefined || next.type === 'SpreadElement') return null;
    return { name, value: next };
  }
  return null;
}

/** Static local constants only; names and mutable assignments are not header identity. */
function constantString(context: Context, input: ESTree.Node, depth = 0): string | null {
  if (depth > 12) return null;
  const literal = literalString(input);
  if (literal !== null) return literal;
  const node = unwrap(input);
  if (node?.type !== 'Identifier') return null;
  const variable = lookupVariable(context, node);
  for (const def of variable?.defs ?? []) {
    const initializer = constantInitializer(def);
    if (initializer !== null) return constantString(context, initializer, depth + 1);
  }
  return null;
}

function constantInitializer(def: Variable['defs'][number]): ESTree.Node | null {
  if (def.type !== 'Variable' || def.node.type !== 'VariableDeclarator') return null;
  if (def.node.parent?.type !== 'VariableDeclaration' || def.node.parent.kind !== 'const') return null;
  return def.node.init ?? null;
}

/** Reading an existing cookie name does not construct a cookie or its attribute contract. */
function inspectsCookiePrefix(node: ESTree.Node): boolean {
  const parent = node.parent;
  if (parent?.type === 'CallExpression' && parent.arguments[0] === node) {
    const callee = unwrap(parent.callee);
    return callee?.type === 'MemberExpression' && memberName(callee) === 'startsWith';
  }
  return parent?.type === 'MemberExpression' && parent.object === node && memberName(parent) === 'length';
}

/** Only exact local constants whose every value use is inspection qualify; escaped values stay blocked. */
function isReadOnlyCookiePrefix(context: Context, node: ESTree.Node): boolean {
  if (inspectsCookiePrefix(node)) return true;
  const declaration = node.parent;
  if (declaration?.type !== 'VariableDeclarator' || declaration.init !== node || declaration.id.type !== 'Identifier') {
    return false;
  }
  if (
    declaration.parent?.type !== 'VariableDeclaration' ||
    declaration.parent.kind !== 'const' ||
    declaration.parent.parent?.type === 'ExportNamedDeclaration'
  )
    return false;
  const variable = lookupVariable(context, declaration.id);
  if (variable === null || variable.references.some((reference) => reference.isWrite() && !reference.init))
    return false;
  const reads = variable.references.filter((reference) => reference.isRead());
  return reads.length > 0 && reads.every((reference) => inspectsCookiePrefix(reference.identifier));
}

/** No name-only/type-only proof: the value must have one immutable local declaration. */
function localConstant(context: Context, node: LocalIdentifier): ESTree.VariableDeclarator | null {
  const variable = lookupVariable(context, node);
  if (variable?.defs.length !== 1 || variable.references.some((reference) => reference.isWrite() && !reference.init))
    return null;
  const definition = variable.defs[0];
  if (
    definition?.type !== 'Variable' ||
    definition.node.type !== 'VariableDeclarator' ||
    definition.node.id.type !== 'Identifier' ||
    definition.node.parent?.type !== 'VariableDeclaration' ||
    definition.node.parent.kind !== 'const' ||
    definition.node.parent.parent?.type === 'ExportNamedDeclaration'
  )
    return null;
  return definition.node;
}

/** Forwarding uses direct native methods, not computed, optional or extracted callbacks. */
function directMember(node: ESTree.Node | null | undefined, name: string): ESTree.MemberExpression | null {
  return node?.type === 'MemberExpression' &&
    !node.computed &&
    !node.optional &&
    node.property.type === 'Identifier' &&
    node.property.name === name
    ? node
    : null;
}

function directCall(member: ESTree.MemberExpression): ESTree.CallExpression | null {
  const call = member.parent;
  return call?.type === 'CallExpression' && call.callee === member && !call.optional ? call : null;
}

function nativeGlobalObject(context: Context, node: ESTree.Node): boolean {
  return ['globalThis', 'self', 'window'].some((name) => isUnshadowedGlobal(context, node, name));
}

function isNonReferenceKey(node: ESTree.Node): boolean {
  const parent = node.parent;
  return (
    (parent?.type === 'MemberExpression' && !parent.computed && parent.property === node) ||
    (parent?.type === 'Property' && !parent.computed && parent.key === node && parent.value !== node)
  );
}

/** Constructor aliases/escapes and prototype replacement invalidate native method provenance. */
function stableNativeHeaders(context: Context): boolean {
  let stable = true;
  walk(context.sourceCode.ast, context.sourceCode.visitorKeys, (node) => {
    if (node.type === 'Identifier' && !isNonReferenceKey(node) && isUnshadowedGlobal(context, node, 'Headers')) {
      const parent = node.parent;
      if (
        !(parent?.type === 'NewExpression' && parent.callee === node) &&
        parent?.type !== 'TSTypeReference' &&
        parent?.type !== 'TSTypeQuery'
      )
        stable = false;
    }
    if (
      node.type === 'MemberExpression' &&
      nativeGlobalObject(context, node.object) &&
      (node.computed ? constantString(context, node.property) : memberName(node)) === 'Headers'
    )
      stable = false;
    if (
      node.type === 'Identifier' &&
      !isNonReferenceKey(node) &&
      nativeGlobalObject(context, node) &&
      (node.parent?.type === 'VariableDeclarator' || node.parent?.type === 'AssignmentExpression')
    )
      stable = false;
    // A different instance/alias can still replace the shared native prototype method.
    if (node.type === 'MemberExpression' && memberName(node) === 'getSetCookie' && directCall(node) === null)
      stable = false;
    if (node.type === 'Property' && propertyKeyName(node) === 'getSetCookie') stable = false;
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      ['defineProperty', 'defineProperties', 'assign', 'set'].includes(memberName(node.callee) ?? '') &&
      (node.arguments.some((argument) => constantString(context, argument) === 'getSetCookie') ||
        (node.arguments[0] !== undefined && nativeGlobalObject(context, node.arguments[0])))
    )
      stable = false;
  });
  return stable;
}

/** Exact native response import and non-escaping namespace binding, including aliased imports. */
function nativeResponseMember(context: Context, node: ESTree.Node, name: string): Variable | null {
  const member = directMember(node, name);
  if (member?.object.type !== 'Identifier') return null;
  const variable = lookupVariable(context, member.object);
  if (variable?.defs.length !== 1) return null;
  const definition = variable.defs[0];
  if (
    definition?.type !== 'ImportBinding' ||
    definition.parent?.type !== 'ImportDeclaration' ||
    definition.parent.importKind === 'type'
  )
    return null;
  const specifier = definition.node;
  const source = definition.parent.source.value;
  const native =
    (source === 'effect/http' &&
      specifier.type === 'ImportSpecifier' &&
      specifier.importKind !== 'type' &&
      keyName(specifier.imported, false) === 'HttpServerResponse') ||
    (source === 'effect/http/HttpServerResponse' && specifier.type === 'ImportNamespaceSpecifier');
  if (!native) return null;
  return variable.references.every((reference) => {
    if (!reference.isRead() || reference.isWrite()) return false;
    const access = reference.identifier.parent;
    if (
      access?.type !== 'MemberExpression' ||
      access.object !== reference.identifier ||
      access.computed ||
      access.optional
    )
      return false;
    if (directCall(access) !== null) return true;
    const call = access.parent;
    return (
      directMember(access, 'toWeb') !== null &&
      call?.type === 'CallExpression' &&
      directMember(call.callee, 'pipe') !== null &&
      call.arguments.length === 1 &&
      call.arguments[0] === access
    );
  })
    ? variable
    : null;
}

/** The source Headers may enter only the real Effect response options, not an opaque producer. */
function nativeHeaderOptions(context: Context, node: LocalIdentifier): ESTree.CallExpression | null {
  const property = node.parent;
  const options = property?.parent;
  const call = options?.parent;
  if (
    property?.type !== 'Property' ||
    property.value !== node ||
    property.computed ||
    property.kind !== 'init' ||
    keyName(property.key, false) !== 'headers' ||
    options?.type !== 'ObjectExpression' ||
    options.properties.some((entry) => entry.type !== 'Property' || entry.computed || entry.kind !== 'init') ||
    call?.type !== 'CallExpression' ||
    call.optional
  )
    return null;
  const index = directMember(call.callee, 'raw') !== null ? 1 : 0;
  const method = index === 1 ? 'raw' : 'empty';
  return call.arguments[index] === options && nativeResponseMember(context, call.callee, method) !== null ? call : null;
}

function stableHeaderSource(context: Context, source: LocalIdentifier): boolean {
  const declaration = localConstant(context, source);
  const initializer = declaration?.init;
  if (
    initializer?.type !== 'NewExpression' ||
    !isUnshadowedGlobal(context, initializer.callee, 'Headers') ||
    initializer.arguments.length !== 1 ||
    initializer.arguments[0]?.type === 'SpreadElement'
  )
    return false;
  return lookupVariable(context, source)!.references.every((reference) => {
    if (!reference.isRead()) return reference.init;
    const identifier = reference.identifier;
    if (nativeHeaderOptions(context, identifier) !== null) return true;
    const member = identifier.parent;
    if (
      member?.type !== 'MemberExpression' ||
      member.object !== identifier ||
      member.computed ||
      member.optional ||
      member.property.type !== 'Identifier' ||
      !['getSetCookie', 'get', 'has', 'delete', 'set', 'append'].includes(member.property.name)
    )
      return false;
    return directCall(member) !== null;
  });
}

/** The receiving response is the native adapter of these same Headers, with no opaque escapes. */
function nativeForwardTarget(context: Context, write: ESTree.CallExpression, source: LocalIdentifier): boolean {
  const writer = directMember(write.callee, 'append');
  const headers = directMember(writer?.object, 'headers');
  if (headers?.object.type !== 'Identifier') return false;
  const target = headers.object;
  const initializer = localConstant(context, target)?.init;
  if (initializer?.type !== 'CallExpression' || initializer.optional || initializer.arguments.length !== 1)
    return false;
  const pipe = directMember(initializer.callee, 'pipe');
  const toWeb = initializer.arguments[0];
  if (pipe?.object.type !== 'CallExpression' || toWeb?.type !== 'MemberExpression') return false;
  const namespace = nativeResponseMember(context, toWeb, 'toWeb');
  const options = pipe.object.arguments.find((argument) => argument.type === 'ObjectExpression');
  if (namespace === null || options?.type !== 'ObjectExpression') return false;
  const sourceVariable = lookupVariable(context, source);
  const inputs = options.properties.filter(
    (property) => property.type === 'Property' && keyName(property.key, property.computed) === 'headers',
  );
  const input = inputs.length === 1 && inputs[0]?.type === 'Property' ? inputs[0].value : null;
  if (
    input?.type !== 'Identifier' ||
    lookupVariable(context, input) !== sourceVariable ||
    nativeHeaderOptions(context, input) !== pipe.object
  )
    return false;
  const method = directMember(pipe.object.callee, 'raw') !== null ? 'raw' : 'empty';
  if (nativeResponseMember(context, pipe.object.callee, method) !== namespace) return false;
  return lookupVariable(context, target)!.references.every((reference) => {
    if (!reference.isRead()) return reference.init;
    const identifier = reference.identifier;
    const parent = identifier.parent;
    if (parent?.type === 'ReturnStatement' && parent.argument === identifier) return true;
    const access = directMember(parent, 'headers');
    const member = access?.parent;
    if (access?.object !== identifier || member?.type !== 'MemberExpression') return false;
    if (directMember(member, 'append') !== null && directCall(member) === write) return true;
    const call = directMember(member, 'delete') !== null ? directCall(member) : null;
    const argument = call?.arguments[0];
    return (
      call?.arguments.length === 1 &&
      argument?.type !== 'SpreadElement' &&
      argument !== undefined &&
      constantString(context, argument)?.toLowerCase() === SET_COOKIE_HEADER
    );
  });
}

/** Only the actual static header name or its immutable literal constant, never a disguised name. */
function nativeCookieHeader(context: Context, node: ESTree.Node): boolean {
  const value = node.type === 'Identifier' ? localConstant(context, node)?.init : node;
  return (
    value?.type === 'Literal' && typeof value.value === 'string' && value.value.toLowerCase() === SET_COOKIE_HEADER
  );
}

/** One const loop binding, one append, one native array; no transformations or extra cookie uses. */
function isNativeCookieForward(context: Context, write: ESTree.CallExpression): boolean {
  if (write.optional || write.arguments.length !== 2 || directMember(write.callee, 'append') === null) return false;
  const name = write.arguments[0];
  if (name === undefined || !nativeCookieHeader(context, name)) return false;
  const cookie = write.arguments[1];
  const statement = write.parent;
  const body = statement?.parent;
  const loop = body?.parent;
  if (
    cookie?.type !== 'Identifier' ||
    statement?.type !== 'ExpressionStatement' ||
    body?.type !== 'BlockStatement' ||
    body.body.length !== 1 ||
    loop?.type !== 'ForOfStatement' ||
    loop.body !== body ||
    loop.await
  )
    return false;
  const declaration = localConstant(context, cookie);
  if (declaration?.parent !== loop.left || loop.left.type !== 'VariableDeclaration') return false;
  const variable = lookupVariable(context, cookie)!;
  if (
    variable.references.filter((reference) => reference.isRead()).some((reference) => reference.identifier !== cookie)
  )
    return false;
  const getter = loop.right;
  if (getter.type !== 'CallExpression' || getter.optional || getter.arguments.length !== 0) return false;
  const member = directMember(getter.callee, 'getSetCookie');
  return (
    member?.object.type === 'Identifier' &&
    stableHeaderSource(context, member.object) &&
    nativeForwardTarget(context, write, member.object)
  );
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit C1 (remove remaining hand-owned serialization: cookie construction): do not build ' +
        '`Set-Cookie` strings, `__Secure-`/`__Host-` names or cookie attribute lists by hand, and do not ' +
        'infer serialization from a string[] type alone. Build cookies with `Cookies` / ' +
        '`HttpServerResponse.setCookie(s)` from `effect/http`. Cookie *parsing* stays as it is.',
    },
    messages: {
      cookieAttributeString:
        'Hand-built cookie string ({{fragment}}). Build cookies with `Cookies` / ' +
        '`HttpServerResponse.setCookie(s)` from `effect/http` — e.g. ' +
        "`yield* HttpServerResponse.setCookie('session_token', token, { httpOnly: true, path: '/', sameSite: 'lax', maxAge })` " +
        '— so attributes, `Expires`/`Max-Age` and escaping are encoded once instead of per call site.',
      cookieNamePrefix:
        'Hand-built `{{fragment}}` cookie name prefix. The prefix encodes a `Secure`/`Path`/`Domain` ' +
        'contract: build the cookie with `Cookies.makeCookie` / `HttpServerResponse.setCookie(name, value, ' +
        "{ secure: true, path: '/' })` from `effect/http` and let the cookie module own the prefix " +
        'and its attribute requirements.',
      setCookieHeaderWrite:
        "`{{method}}('{{header}}', …)` writes a serialized cookie header by hand. Merge an Effect cookie " +
        'value into the response instead — `HttpServerResponse.setCookie(response, name, value, options)` or ' +
        '`HttpServerResponse.mergeCookies(response, cookies)` from `effect/http` — so serialization ' +
        'happens in one place.',
      setCookieHeaderProperty:
        "`'{{header}}'` in a headers object is a hand-built cookie string. Return the cookie through " +
        '`HttpServerResponse.setCookie(s)` / `Cookies` from `effect/http` and let the HTTP layer ' +
        'serialize the header, instead of writing the attribute list into a headers literal.',
      cookieStringContract:
        '`{{name}}` carries serialized `Set-Cookie` strings across a contract, which forces hand-built cookie ' +
        'strings at the producer. Carry a `Cookies` value (`effect/http`) and apply it with ' +
        '`HttpServerResponse.mergeCookies` / `setCookie(s)` at the HTTP boundary instead of `string[]`.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
          allowPaths: { type: 'array', items: { type: 'string' } },
          exclude: { type: 'array', items: { type: 'string' } },
          ignoreTestFiles: { type: 'boolean' },
          cookieNamespaces: { type: 'array', items: { type: 'string' } },
          flagCookieStringContracts: { type: 'boolean' },
          contractNames: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        paths: DEFAULT_PATHS,
        allowPaths: [],
        exclude: DEFAULT_EXCLUDE,
        ignoreTestFiles: true,
        cookieNamespaces: DEFAULT_COOKIE_NAMESPACES,
        flagCookieStringContracts: false,
        contractNames: DEFAULT_CONTRACT_NAMES,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.paths)) return {};
    if (matchesGlobs(path, options.allowPaths)) return {};
    if (matchesGlobs(path, options.exclude)) return {};
    if (options.ignoreTestFiles && isTestFile(path)) return {};

    const bindings = collectEffectBindings(context.sourceCode.ast);
    const reported = new Set<ESTree.Node>();
    let nativeHeadersStable: boolean | undefined;

    /**
     * `true` when an enclosing node already reports this hand-built cookie: the `set-cookie`
     * header write, the `Set-Cookie` headers property, or an outer template literal that itself
     * carries cookie attribute text. Keeps one diagnostic per hand-built cookie.
     */
    const isCoveredByOuterReport = (node: ESTree.Node): boolean => {
      let current: ESTree.Node | null = node.parent ?? null;
      while (current !== null) {
        if (current.type === 'TemplateLiteral' && templateHasCookieText(current)) return true;
        if (reported.has(current)) return true;

        current = current.parent ?? null;
      }
      return false;
    };

    const reportCookieText = (node: ESTree.Node, text: string): void => {
      if (isCoveredByOuterReport(node)) return;
      const prefix = COOKIE_NAME_PREFIX.exec(text)?.[0];
      if (prefix !== undefined) {
        if (isReadOnlyCookiePrefix(context, node)) return;
        context.report({
          node,
          messageId: 'cookieNamePrefix',
          data: { fragment: prefix },
        });
        return;
      }
      const fragment = COOKIE_ATTRIBUTE.exec(text)?.[0].replace(/^;\s*/u, '').trim() ?? text;
      context.report({
        node,
        messageId: 'cookieAttributeString',
        data: { fragment },
      });
    };

    return {
      Literal(node) {
        if (typeof node.value !== 'string' || node.parent?.type === 'TSLiteralType') return;
        if (!isCookieText(node.value)) return;
        reportCookieText(node, node.value);
      },
      TemplateLiteral(node) {
        const fragment = templateFragments(node).find(isCookieText);
        if (fragment === undefined) return;
        reportCookieText(node, fragment);
      },
      CallExpression(node) {
        const write = headerWrite(context, node);
        if (write === null) return;
        if (isCookieOwnedValue(context, write.value, bindings, options.cookieNamespaces)) return;
        if (isNativeCookieForward(context, node)) {
          nativeHeadersStable ??= stableNativeHeaders(context);
          if (nativeHeadersStable) return;
        }
        const callee = unwrap(node.callee);
        const method = callee !== null && callee.type === 'MemberExpression' ? memberName(callee) : null;
        reported.add(node);
        context.report({
          node,
          messageId: 'setCookieHeaderWrite',
          data: { header: write.name, method: method ?? 'set' },
        });
      },
      Property(node) {
        const name = propertyKeyName(node);
        if (name === null || name.toLowerCase() !== SET_COOKIE_HEADER) return;
        if (isCookieOwnedValue(context, node.value, bindings, options.cookieNamespaces)) return;
        if (!isHandBuiltValue(node.value)) return;
        reported.add(node);
        context.report({
          node,
          messageId: 'setCookieHeaderProperty',
          data: { header: name },
        });
      },
    };
  },
});
