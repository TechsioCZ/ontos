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
 *    aliases and `effect/unstable/http` namespace imports).
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
 *   imports (`import * as Cookies from "effect/unstable/http/Cookies"`).
 * - Test files (`ignoreTestFiles: true` by default) — the audit's D tier keeps hand-written cookie
 *   strings inside test fixtures and assertions.
 * - Anything outside `paths`, matching `allowPaths`, or matching `exclude` (generated output).
 *
 * Static limits: semicolon-delimited cookie text is lexical (prose can still resemble it).
 * Opaque property values are not proof of hand-building. Type-only string contracts cannot identify
 * the producer. Dynamic header names and cross-file ownership are not inferred. No fixer/suggestion.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope } from '@oxlint/plugins';

import { collectEffectBindings, type EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production defaults instead of forcing the
 * fixture config to pass loosened options (which `run-on-repo.mts` reuses).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_PATHS = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];

/** Generated output that is never hand-edited (and is git-ignored, so normally never linted). */
const DEFAULT_EXCLUDE = ['**/dist/**', '**/.output/**', '**/node_modules/**', '**/*.d.ts'];

/** Effect HTTP namespaces that own cookie serialization. A call into these is the target shape. */
const DEFAULT_COOKIE_NAMESPACES = [
  'Cookies',
  'Cookie',
  'HttpServerResponse',
  'HttpServerRespondable',
];

const DEFAULT_CONTRACT_NAMES = ['setCookieHeaders', 'setCookieHeader', 'cookieHeaders'];

/** Methods that write a header value (`Headers`, node `ServerResponse`, Effect response builders). */
const HEADER_WRITERS = new Set([
  'append',
  'set',
  'setHeader',
  'setHeaders',
  'add',
  'put',
  'writeHead',
]);

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

const STRING_ARRAY_TYPES = new Set(['Array', 'ReadonlyArray']);

interface RuleOptions {
  readonly paths: readonly string[];
  readonly allowPaths: readonly string[];
  readonly exclude: readonly string[];
  readonly ignoreTestFiles: boolean;
  readonly cookieNamespaces: readonly string[];
  readonly flagCookieStringContracts: boolean;
  readonly contractNames: readonly string[];
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
    paths: stringArray(record.paths, DEFAULT_PATHS),
    allowPaths: stringArray(record.allowPaths, []),
    exclude: stringArray(record.exclude, DEFAULT_EXCLUDE),
    ignoreTestFiles: record.ignoreTestFiles !== false,
    cookieNamespaces: stringArray(record.cookieNamespaces, DEFAULT_COOKIE_NAMESPACES),
    flagCookieStringContracts: record.flagCookieStringContracts === true,
    contractNames: stringArray(record.contractNames, DEFAULT_CONTRACT_NAMES),
  };
}

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
    else if (current.type === 'TSTypeAssertion' || current.type === 'TSInstantiationExpression')
      current = current.expression;
    else if (current.type === 'ChainExpression') current = current.expression;
    else return current;
  }
}

/** Non-computed `.foo`, or computed `["foo"]`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const property = unwrap(node.property);
  return literalString(property);
}

function literalString(node: ESTree.Node | null | undefined): string | null {
  const target = unwrap(node);
  if (target === null) return null;
  if (target.type === 'Literal' && typeof target.value === 'string') return target.value;
  if (target.type === 'TemplateLiteral' && target.expressions.length === 0) {
    return target.quasis[0]?.value.cooked ?? target.quasis[0]?.value.raw ?? null;
  }
  return null;
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
    case 'LogicalExpression':
      return (
        isCookieOwnedValue(context, target.left, bindings, namespaces, depth + 1) &&
        (literalString(target.right) === '' ||
          isCookieOwnedValue(context, target.right, bindings, namespaces, depth + 1))
      );
    case 'AwaitExpression':
    case 'YieldExpression':
      return isCookieOwnedValue(context, target.argument, bindings, namespaces, depth + 1);
    case 'ConditionalExpression':
      return (
        isCookieOwnedValue(context, target.consequent, bindings, namespaces, depth + 1) &&
        isCookieOwnedValue(context, target.alternate, bindings, namespaces, depth + 1)
      );
    case 'ArrayExpression':
      return (
        target.elements.length > 0 &&
        target.elements.every(
          (element) =>
            element !== null &&
            element.type !== 'SpreadElement' &&
            isCookieOwnedValue(context, element, bindings, namespaces, depth + 1),
        )
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
      return (
        target.operator === '+' &&
        (isHandBuiltValue(target.left, depth + 1) || isHandBuiltValue(target.right, depth + 1))
      );
    case 'ConditionalExpression':
      return (
        isHandBuiltValue(target.consequent, depth + 1) ||
        isHandBuiltValue(target.alternate, depth + 1)
      );
    case 'ArrayExpression':
      return target.elements.some(
        (element) =>
          element !== null &&
          element.type !== 'SpreadElement' &&
          isHandBuiltValue(element, depth + 1),
      );
    default:
      return false;
  }
}

function propertyKeyName(node: ESTree.Node): string | null {
  if (
    node.type !== 'Property' &&
    node.type !== 'TSPropertySignature' &&
    node.type !== 'PropertyDefinition'
  )
    return null;
  if (node.computed) {
    const key = unwrap(node.key);
    return literalString(key);
  }
  const key = node.key;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
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
  for (const [index, argument] of node.arguments.entries()) {
    if (argument.type === 'SpreadElement') continue;
    const name = constantString(context, argument);
    if (name === null || name.toLowerCase() !== SET_COOKIE_HEADER) continue;
    const next = node.arguments[index + 1];
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
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (variable) {
      for (const def of variable.defs) {
        if (def.type !== 'Variable' || def.node.type !== 'VariableDeclarator' || !def.node.init)
          continue;
        if (def.node.parent?.type === 'VariableDeclaration' && def.node.parent.kind === 'const')
          return constantString(context, def.node.init, depth + 1);
      }
      return null;
    }
    scope = scope.upper;
  }
  return null;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit C1 (remove remaining hand-owned serialization: cookie construction): do not build ' +
        '`Set-Cookie` strings, `__Secure-`/`__Host-` names or cookie attribute lists by hand, and do not ' +
        'infer serialization from a string[] type alone. Build cookies with `Cookies` / ' +
        '`HttpServerResponse.setCookie(s)` from `effect/unstable/http`. Cookie *parsing* stays as it is.',
    },
    messages: {
      cookieAttributeString:
        'Hand-built cookie string ({{fragment}}). Build cookies with `Cookies` / ' +
        '`HttpServerResponse.setCookie(s)` from `effect/unstable/http` — e.g. ' +
        "`yield* HttpServerResponse.setCookie('session_token', token, { httpOnly: true, path: '/', sameSite: 'lax', maxAge })` " +
        '— so attributes, `Expires`/`Max-Age` and escaping are encoded once instead of per call site.',
      cookieNamePrefix:
        'Hand-built `{{fragment}}` cookie name prefix. The prefix encodes a `Secure`/`Path`/`Domain` ' +
        'contract: build the cookie with `Cookies.makeCookie` / `HttpServerResponse.setCookie(name, value, ' +
        "{ secure: true, path: '/' })` from `effect/unstable/http` and let the cookie module own the prefix " +
        'and its attribute requirements.',
      setCookieHeaderWrite:
        "`{{method}}('{{header}}', …)` writes a serialized cookie header by hand. Merge an Effect cookie " +
        'value into the response instead — `HttpServerResponse.setCookie(response, name, value, options)` or ' +
        '`HttpServerResponse.mergeCookies(response, cookies)` from `effect/unstable/http` — so serialization ' +
        'happens in one place.',
      setCookieHeaderProperty:
        "`'{{header}}'` in a headers object is a hand-built cookie string. Return the cookie through " +
        '`HttpServerResponse.setCookie(s)` / `Cookies` from `effect/unstable/http` and let the HTTP layer ' +
        'serialize the header, instead of writing the attribute list into a headers literal.',
      cookieStringContract:
        '`{{name}}` carries serialized `Set-Cookie` strings across a contract, which forces hand-built cookie ' +
        'strings at the producer. Carry a `Cookies` value (`effect/unstable/http`) and apply it with ' +
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
        context.report({ node, messageId: 'cookieNamePrefix', data: { fragment: prefix } });
        return;
      }
      const fragment = COOKIE_ATTRIBUTE.exec(text)?.[0].replace(/^;\s*/u, '').trim() ?? text;
      context.report({ node, messageId: 'cookieAttributeString', data: { fragment } });
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
        const callee = unwrap(node.callee);
        const method =
          callee !== null && callee.type === 'MemberExpression' ? memberName(callee) : null;
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
        context.report({ node, messageId: 'setCookieHeaderProperty', data: { header: name } });
      },
    };
  },
});
