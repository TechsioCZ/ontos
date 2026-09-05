/**
 * effect-native/no-hand-built-http-server-in-tests
 *
 * Audit findings: **B2** (“Build one Effect-aware testing harness” — *“hand-built HTTP servers … three
 * copies of `node:http` bridging”*) and **A1** (“Establish one process-level Layer and ManagedRuntime
 * composition model”) of `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`.
 *
 * A test that boots a real `node:http` listener to exercise an HttpApi handler owns a second,
 * untyped composition root: a socket, a port, a lifecycle, and a hand-written request/response
 * bridge that no Layer supervises. The Effect-native replacement is an injected
 * `HttpApiClient`/`HttpClient` provided by an in-memory test `Layer` from the shared
 * `itEffect`/`itLayer` harness — no port, no socket, no teardown race.
 *
 * ## What this detects (inside test files only)
 *
 * - **Value imports of a server module** — `import { createServer } from "node:http"`,
 *   `import http from "node:http"`, `import * as https from "node:https"`, `import "node:net"`;
 *   one report per specifier (`serverModules`, glob-matched, so `http`, `node:http2`, … are covered).
 * - **Dynamic imports** — `await import("node:http")`, including a template literal with no
 *   substitutions.
 * - **Server factory calls** resolved back to such an import — `createServer(handler)`,
 *   `http.createServer(...)`, `http?.createServer(...)`, `http["createServer"](...)`,
 *   `http2.createSecureServer(...)` (`serverFactories`).
 * - **`.listen(...)` on a binding initialised from a server factory** —
 *   `const server = createServer(h); server.listen(0, "127.0.0.1", resolve)`, including
 *   `let server; server = createServer(h)` reassignment, optional chaining and computed access.
 *   Chained `createServer(h).listen(0)` reports once, on the factory call.
 * - **Global `fetch` / `globalThis.fetch` calls**, only when `includeFetch` is enabled (default
 *   `false`): the in-memory client makes the ambient fetch unnecessary, but the audit does not list
 *   ambient `fetch` in tests as a driver, so it stays opt-in.
 *
 * Namespace, default, aliased (`import { createServer as make } from "node:http"`) and shadowed
 * bindings are resolved through `context.sourceCode.getScope`, so a local
 * `const createServer = () => ...` test double is never reported.
 *
 * ## What is deliberately allowed
 *
 * - **Type-only imports** — `import type { IncomingHttpHeaders } from "node:http"` and inline
 *   `import { type IncomingMessage } from "node:http"`. Typing a fixture’s headers is not a server;
 *   `verticals/contacts/tests/support/node-http.ts` is exactly this and must stay silent.
 * - **e2e / Playwright specs** (`ignorePaths`): D-tier Promise adapters forced by browser drivers,
 *   which legitimately talk to a real server the driver owns.
 * - **The shared harness itself** and any other path listed in `allowPaths`, so one repository-owned
 *   in-memory adapter may exist in one place if the harness ever needs it.
 * - **Non-test files.** Production and `scripts/` code is out of scope here; the D-tier “Node process
 *   entrypoint” adapters (`scripts/proof-workerd-ssr.mts`) are explicitly blessed by the audit.
 * - Named client/utility imports (`request`, `Agent`, `isIP`) do not construct servers.
 * - Anything that only *looks* like a server: `net.isIP(...)`, `new Server()` from a first-party
 *   module, `app.listen(...)` on a value that is not a tracked factory result.
 *
 * Report-only: no fixer, no suggestion. Existing violations are the intended output.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope } from '@oxlint/plugins';

import { globToRegExp, isTestFile, matchesAny, normalisePath } from '../shared/paths.ts';

const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

/** Node modules whose value exports can boot a listening socket. */
const DEFAULT_SERVER_MODULES: readonly string[] = [
  'node:http',
  'http',
  'node:https',
  'https',
  'node:net',
  'net',
  'node:http2',
  'http2',
];

/** Exported factories that return a listening-capable server object. */
const DEFAULT_SERVER_FACTORIES: readonly string[] = ['createServer', 'createSecureServer'];

/** D-tier: browser drivers legitimately drive a real server they own. */
const DEFAULT_IGNORE_PATHS: readonly string[] = [
  '**/tests/e2e/**',
  '**/*.e2e.*',
  '**/e2e/**',
  '**/playwright/**',
];

interface RuleOptions {
  readonly serverModules?: readonly string[];
  readonly serverFactories?: readonly string[];
  readonly includeFetch?: boolean;
  readonly testPaths?: readonly string[];
  readonly ignorePaths?: readonly string[];
  readonly allowPaths?: readonly string[];
}

interface ResolvedOptions {
  readonly serverModules: readonly string[];
  readonly serverFactories: readonly string[];
  readonly includeFetch: boolean;
  readonly testPaths: readonly string[];
  readonly ignorePaths: readonly string[];
  readonly allowPaths: readonly string[];
}

interface Report {
  readonly node: ESTree.Node;
  readonly messageId: string;
  readonly data: Record<string, string>;
}

function readOptions(context: Context): ResolvedOptions {
  const raw = (context.options[0] ?? {}) as RuleOptions;
  return {
    serverModules: raw.serverModules ?? DEFAULT_SERVER_MODULES,
    serverFactories: raw.serverFactories ?? DEFAULT_SERVER_FACTORIES,
    includeFetch: raw.includeFetch ?? false,
    testPaths: raw.testPaths ?? [],
    ignorePaths: raw.ignorePaths ?? DEFAULT_IGNORE_PATHS,
    allowPaths: raw.allowPaths ?? [],
  };
}

/** Static string key of a member/property node, or `null` when it is dynamic. */
function staticKey(node: ESTree.Node, computed: boolean): string | null {
  if (!computed && node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

/** The literal module specifier of a `import(...)` argument, when it is statically known. */
function literalSource(node: ESTree.Node): string | null {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** Strip `(expr)` / `expr!` / `expr as T` wrappers oxc keeps in the tree. */
function unwrap(node: ESTree.Node): ESTree.Node {
  let current = node;
  for (;;) {
    if (
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSInstantiationExpression' ||
      current.type === 'TSTypeAssertion'
    ) {
      current = current.expression as ESTree.Node;
      continue;
    }
    if (current.type === 'ChainExpression') {
      current = current.expression as ESTree.Node;
      continue;
    }
    return current;
  }
}

/** `true` when the identifier resolves to no declaration at all, i.e. it is the platform global. */
function isAmbientGlobal(context: Context, node: ESTree.Node, name: string): boolean {
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined && variable.defs.length > 0) return false;
    scope = scope.upper;
  }
  return true;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B2 + A1: tests must not hand-build a node:http/https/net/http2 server to exercise ' +
        'HttpApi handlers. Exercise the API through an injected HttpApiClient/HttpClient provided ' +
        'by an in-memory test Layer from the shared itEffect/itLayer harness. Local scope/import provenance only; no interprocedural or object-field inference.',
    },
    messages: {
      serverModuleImport:
        'Do not import "{{source}}" for its values in a test. Exercise the HttpApi through an ' +
        'injected HttpApiClient/HttpClient provided by an in-memory test Layer from the shared ' +
        'harness; keep only `import type` from node:http for fixture typings.',
      dynamicServerModuleImport:
        'Do not dynamically import "{{source}}" in a test. Exercise the HttpApi through an injected ' +
        'HttpApiClient/HttpClient provided by an in-memory test Layer from the shared harness.',
      serverFactoryCall:
        'Do not hand-build a node:http server in tests ({{name}}). Exercise the HttpApi through an ' +
        'injected HttpApiClient/HttpClient provided by an in-memory test Layer from the shared ' +
        'harness, so there is no port, socket or teardown race to own.',
      serverListen:
        'Do not bind a real socket in a test ("{{name}}.listen"). Provide the handler through an ' +
        'in-memory test Layer and drive it with an injected HttpApiClient/HttpClient from the shared ' +
        'harness instead of listening on a port.',
      ambientFetch:
        'Do not drive a test through ambient fetch. Yield an injected HttpApiClient/HttpClient from ' +
        'the shared in-memory test Layer so requests stay typed and the transport stays substitutable.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          serverModules: { type: 'array', items: { type: 'string' } },
          serverFactories: { type: 'array', items: { type: 'string' } },
          includeFetch: { type: 'boolean' },
          testPaths: { type: 'array', items: { type: 'string' } },
          ignorePaths: { type: 'array', items: { type: 'string' } },
          allowPaths: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        serverModules: [...DEFAULT_SERVER_MODULES],
        serverFactories: [...DEFAULT_SERVER_FACTORIES],
        includeFetch: false,
        testPaths: [],
        ignorePaths: [...DEFAULT_IGNORE_PATHS],
        allowPaths: [],
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const filename = normalisePath(context.filename).replace(FIXTURE_PREFIX, '');
    if (matchesAny(filename, options.allowPaths) || matchesAny(filename, options.ignorePaths))
      return {};
    if (!isTestFile(filename) && !matchesAny(filename, options.testPaths)) return {};

    const modulePatterns = options.serverModules.map(globToRegExp);
    const isServerModule = (source: string): boolean =>
      modulePatterns.some((pattern) => pattern.test(source));

    type Variable = Scope['variables'][number];
    function variable(node: Extract<ESTree.Node, { type: 'Identifier' }>): Variable | undefined {
      let scope: Scope | null = context.sourceCode.getScope(node);
      while (scope !== null) {
        const found = scope.set.get(node.name);
        if (found !== undefined) return found;
        scope = scope.upper;
      }
      return undefined;
    }
    const writes = new Map<Variable, ESTree.Node[]>();
    const calls: Array<ESTree.CallExpression | ESTree.NewExpression> = [];
    const reports: Report[] = [];
    const factoryNames = new Set([
      ...options.serverFactories,
      'Server',
      'Http2Server',
      'Http2SecureServer',
    ]);
    // Provenance is local and scope-resolved, not type inference. Unknown writes invalidate
    // aliases; object fields, function returns and cross-file re-exports are not followed.
    function origin(input: ESTree.Node, seen = new Set<ESTree.Node>()): string | null {
      const node = unwrap(input);
      if (seen.has(node)) return null;
      const next = new Set(seen).add(node);
      if (node.type === 'AwaitExpression') return origin(node.argument as ESTree.Node, next);
      if (node.type === 'Identifier') {
        const binding = variable(node);
        if (binding === undefined || binding.defs.length === 0) {
          return node.name === 'require' ? 'require' : null;
        }
        const values: string[] = [];
        for (const def of binding.defs) {
          if (def.type === 'ImportBinding') {
            const spec = def.node;
            const declaration = def.parent;
            if (declaration?.type !== 'ImportDeclaration' || declaration.importKind === 'type')
              return null;
            if (spec.type === 'ImportSpecifier' && spec.importKind === 'type') return null;
            const source = declaration.source.value;
            const name = spec.type === 'ImportSpecifier' ? staticKey(spec.imported, false) : '*';
            if (source === 'node:module' || source === 'module')
              return name === 'createRequire' ? 'createRequire' : name === '*' ? 'module' : null;
            if (!isServerModule(source)) return null;
            return name === '*'
              ? 'namespace'
              : name !== null && factoryNames.has(name)
                ? 'factory'
                : null;
          }
          if (def.type !== 'Variable' || def.node.type !== 'VariableDeclarator') return null;
          if (def.node.init === null) continue;
          let value = origin(def.node.init as ESTree.Node, next);
          if (def.node.id.type === 'ObjectPattern') {
            const property = def.node.id.properties.find(
              (p) =>
                p.type === 'Property' &&
                p.value.type === 'Identifier' &&
                p.value.name === node.name,
            );
            if (property?.type !== 'Property') return null;
            const key = staticKey(property.key as ESTree.Node, property.computed);
            value =
              value === 'namespace' && key !== null && factoryNames.has(key) ? 'factory' : null;
          }
          if (value === null) return null;
          values.push(value);
        }
        for (const write of writes.get(binding) ?? []) {
          const value = origin(write, next);
          if (value === null) return null;
          values.push(value);
        }
        return values.length > 0 && values.every((value) => value === values[0])
          ? values[0]!
          : null;
      }
      if (node.type === 'MemberExpression') {
        const owner = origin(node.object as ESTree.Node, next);
        const key = staticKey(node.property as ESTree.Node, node.computed);
        if (owner === 'namespace' && key !== null && factoryNames.has(key)) return 'factory';
        if (owner === 'module' && key === 'createRequire') return 'createRequire';
        return null;
      }
      if (node.type === 'ImportExpression') {
        const source = literalSource(node.source as ESTree.Node);
        return source !== null && isServerModule(source) ? 'namespace' : null;
      }
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        const callee = origin(node.callee as ESTree.Node, next);
        if (callee === 'factory') return 'server';
        if (callee === 'createRequire') return 'require';
        if (callee === 'require' && node.arguments[0] !== undefined) {
          const source = literalSource(unwrap(node.arguments[0] as ESTree.Node));
          return source !== null && isServerModule(source) ? 'namespace' : null;
        }
      }
      return null;
    }
    function exported(node: ESTree.ExportNamedDeclaration | ESTree.ExportAllDeclaration): void {
      if (node.source === null || node.exportKind === 'type' || !isServerModule(node.source.value))
        return;
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.specifiers.every((spec) => spec.exportKind === 'type')
      )
        return;
      reports.push({ node, messageId: 'serverModuleImport', data: { source: node.source.value } });
    }
    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type' || !isServerModule(node.source.value)) return;
        if (node.specifiers.length === 0)
          reports.push({
            node,
            messageId: 'serverModuleImport',
            data: { source: node.source.value },
          });
        for (const spec of node.specifiers) {
          if (
            spec.type === 'ImportSpecifier' &&
            (spec.importKind === 'type' || !factoryNames.has(staticKey(spec.imported, false) ?? ''))
          )
            continue;
          reports.push({
            node: spec,
            messageId: 'serverModuleImport',
            data: { source: node.source.value },
          });
        }
      },
      ExportNamedDeclaration: exported,
      ExportAllDeclaration: exported,
      ImportExpression(node) {
        const source = literalSource(node.source as ESTree.Node);
        if (source !== null && isServerModule(source))
          reports.push({ node, messageId: 'dynamicServerModuleImport', data: { source } });
      },
      AssignmentExpression(node) {
        if (node.left.type !== 'Identifier') return;
        const binding = variable(node.left);
        if (binding === undefined) return;
        const values = writes.get(binding) ?? [];
        values.push(node.operator === '=' ? (node.right as ESTree.Node) : node);
        writes.set(binding, values);
      },
      CallExpression(node) {
        calls.push(node);
      },
      NewExpression(node) {
        calls.push(node);
      },
      'Program:exit'() {
        for (const node of calls) {
          const callee = unwrap(node.callee as ESTree.Node);
          const identity = origin(callee);
          if (identity === 'factory') {
            reports.push({
              node,
              messageId: 'serverFactoryCall',
              data: { name: context.sourceCode.getText(callee) },
            });
            continue;
          }
          if (identity === 'require' && node.arguments[0] !== undefined) {
            const source = literalSource(unwrap(node.arguments[0] as ESTree.Node));
            if (source !== null && isServerModule(source))
              reports.push({ node, messageId: 'dynamicServerModuleImport', data: { source } });
          }
          if (callee.type === 'MemberExpression') {
            const member = staticKey(callee.property as ESTree.Node, callee.computed);
            const object = unwrap(callee.object as ESTree.Node);
            if (
              member === 'listen' &&
              object.type === 'Identifier' &&
              origin(object) === 'server'
            ) {
              reports.push({ node, messageId: 'serverListen', data: { name: object.name } });
            }
            if (
              options.includeFetch &&
              member === 'fetch' &&
              object.type === 'Identifier' &&
              ['globalThis', 'global'].includes(object.name) &&
              isAmbientGlobal(context, object, object.name)
            ) {
              reports.push({ node, messageId: 'ambientFetch', data: {} });
            }
          } else if (
            options.includeFetch &&
            callee.type === 'Identifier' &&
            callee.name === 'fetch' &&
            isAmbientGlobal(context, callee, 'fetch')
          ) {
            reports.push({ node, messageId: 'ambientFetch', data: {} });
          }
        }
        for (const report of reports.sort((a, b) => a.node.start - b.node.start))
          context.report(report);
      },
    };
  },
});
