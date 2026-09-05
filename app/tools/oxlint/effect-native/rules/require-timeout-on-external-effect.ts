/**
 * effect-native/require-timeout-on-external-effect
 *
 * Audit finding: **B1** — "Make workers and independent reads declaratively concurrent" of
 * `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`: *"database and SpiceDB operations lack
 * consistent typed timeout/retry policy … Use `Stream`, `Schedule`, bounded `Effect.forEach`/
 * `Effect.all`, typed retry schedules, explicit timeouts, and interruption-aware worker scopes."*
 *
 * It also serves **A5** (the persistence seam owns the typed failure taxonomy that a retry `while`
 * predicate needs) and **A9** (browser calls that never time out leave the UI hanging). Today exactly
 * the ARES HttpClient adapter exemplifies explicit Effect policies. A Promise bridge alone cannot
 * establish externalness, absence of adapter-level bounds, or cancellation behavior.
 *
 * ## What is detected
 *
 * A **site** is a syntactic Promise-bridge candidate or proven HTTP request:
 *
 * 1. **Promise bridges** — a call whose callee resolves to `Effect.tryPromise`, `Effect.promise` or
 *    `Effect.tryMapPromise` (`promiseBridges`). Resolution goes through real import bindings
 *    (`shared/effect-imports.ts`), so `import { Effect as Eff } from "effect"` → `Eff.tryPromise`,
 *    `import * as Effect from "effect/Effect"` → `Effect.tryPromise`, `import * as E from "effect"` →
 *    `E.Effect.tryPromise`, and `import { tryPromise } from "effect/Effect"` → bare `tryPromise(...)`
 *    all count. Optional calls (`Effect?.tryPromise(...)`) and computed members
 *    (`Effect["tryPromise"]`) are handled.
 * 2. **`HttpClient` requests** — `.execute` / `.get` / `.post` / `.put` / `.patch` / `.del` / `.head`
 *    / `.options` (`httpMethods`) on a binding that this file proves is an `HttpClient`: a
 *    `const http = yield* HttpClient.HttpClient`, a `HttpClient.make(...)` /
 *    `FetchHttpClient.make(...)` initialiser, or a parameter/binding annotated
 *    `HttpClient.HttpClient`. Direct `HttpClient.get(...)` namespace calls count too.
 *    `HttpClientRequest.get(url)` (request *construction*) deliberately does not — only the
 *    `HttpClient` namespace and proven client bindings are treated as request execution.
 *
 * A site is **satisfied** when a timeout/retry policy is visibly applied to it in the same function
 * frame. The rule walks the ancestor chain out of the site, stopping at the first function boundary,
 * and collects:
 *
 * - the sibling arguments of every enclosing `pipe(...)` / `x.pipe(...)` chain;
 * - a data-first policy wrapper (`Effect.timeout(site, "3 seconds")`).
 *
 * A collected node counts as a policy when it is a call whose `effectMember` is `Effect.timeout`,
 * `timeoutOption`, `timeoutOrElse`, `timeoutFail`, `retry` or `retryOrElse`; a same-file identifier
 * initialised with such a call (`const withDatabasePolicy = Effect.timeout("5 seconds")`); or any
 * identifier/member whose name matches `policyHelperPattern` (default `(Policy|Timeout|Retry)$`) —
 * the explicit escape hatch for a shared, imported policy combinator.
 *
 * Policies cross generators and known effect-returning callbacks (flatMap/forEach/catch),
 * not callbacks returning dormant Effect values or forked/cached lifetimes. Only later pipe
 * operators can bound newly added work. Effect.fn trailing operators count. D-tier finalizers
 * and server-local static import adapters are exempt; browser imports remain candidates.
 *
 * With the defaults (`requireTimeout: true`, `requireRetry: false`) any one of the six members
 * satisfies a site. `requireRetry: true` demands a retry member as well (and a timeout member too
 * unless `requireTimeout` is turned off).
 *
 * ## What is deliberately allowed
 *
 * - **The blessed ARES shape** — `httpClient.execute(request).pipe(Effect.timeout(ARES_REQUEST_TIMEOUT),
 *   …)` and `requestSubject(…).pipe(Effect.retry({ schedule, while: isRetryable }))`. The audit's
 *   "Existing patterns to preserve" section names ARES as the reference adapter; it must stay silent.
 * - **Shared policy combinators** — `…​.pipe(withDatabasePolicy)` where the helper is named for what it
 *   is (`policyHelperPattern`) or is a same-file `Effect.timeout`/`Effect.retry` partial application.
 *   A port that centralises its policy once is exactly the B1 target, so it is not re-reported at
 *   every caller.
 * - **Ports, when you say so** — `portFiles` + `trustPorts: true` lets a repository declare "policy
 *   lives in these files, callers inherit it". Off by default: nothing is trusted implicitly.
 * - **Tests** (`includeTests`, default `false`) — B2 owns the test harness, and `TestClock`-driven
 *   tests deliberately run unbounded effects.
 * - **`scripts/`** (`includeScripts`, default `false`) — B3 owns script migration, and the audit's
 *   D tier blesses "Node process entrypoints".
 * - **Non-Effect lookalikes** — an `Effect`/`HttpClient` identifier that is not an `effect` import,
 *   a local `Promise` helper, `HttpClientRequest.get(...)`, `.get(...)` on any binding this file has
 *   not proven to be an `HttpClient`.
 * - Anything outside `include` (`apps/**`, `verticals/**`, `packages/**`), anything in `ignore`
 *   (`dist`, `build`, `.output`, `node_modules`, `*.d.ts`, `*.config.ts`, `tools/**`).
 *
 * Known limitation (accepted, and the reason this is report-only): without type information the rule
 * cannot see a timeout installed by a caller several frames up, nor one carried by a `Layer` that
 * wraps the client. `policyHelperPattern`, `crossEffectGen` and `portFiles`/`trustPorts` are the
 * declared escape hatches. No fixer, no suggestion — nothing in `apps/`, `verticals/`, `packages/`
 * or `scripts/` is edited to satisfy this rule.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree } from '@oxlint/plugins';

import { globToRegExp, isScriptFile, isTestFile, normalisePath } from '../shared/paths.ts';

/** Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`. */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**'];
const DEFAULT_IGNORE = [
  '**/dist/**',
  '**/build/**',
  '**/.output/**',
  '**/node_modules/**',
  'tools/**',
  '**/*.d.ts',
  '**/*.config.ts',
  '**/*.config.mts',
  '**/module-federation.config.ts',
];
const DEFAULT_PORT_FILES: readonly string[] = [];
const DEFAULT_POLICY_HELPER_PATTERN = '(Policy|Timeout|Retry)$';
/** `Effect.*` members that bridge a Promise into the Effect runtime: unbounded unless told otherwise. */
const DEFAULT_PROMISE_BRIDGES = ['promise', 'tryPromise', 'tryMapPromise'];
/** `HttpClient` request-execution members (Effect v4 `effect/unstable/http`). */
const DEFAULT_HTTP_METHODS = ['execute', 'get', 'post', 'put', 'patch', 'del', 'head', 'options'];

const EFFECT_NAMESPACE = 'Effect';
const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_SUBMODULE = 'effect/Effect';
const HTTP_CLIENT_NAMESPACE = 'HttpClient';
/** Namespaces whose `make`/`layer` produce an `HttpClient` value. */
const HTTP_CLIENT_FACTORY_NAMESPACES = new Set(['HttpClient', 'FetchHttpClient']);

const TIMEOUT_MEMBERS = new Set(['timeout', 'timeoutOption', 'timeoutOrElse', 'timeoutFail']);
const RETRY_MEMBERS = new Set(['retry', 'retryOrElse']);
/** `Effect.gen(function* () { … })` — the one function boundary a policy legitimately spans. */
const EFFECT_PROGRAM_WRAPPERS = new Set(['gen', 'fn', 'fnUntraced']);

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

interface Policy {
  timeout: boolean;
  retry: boolean;
}

interface RuleOptions {
  readonly requireTimeout: boolean;
  readonly requireRetry: boolean;
  readonly portFiles: readonly string[];
  readonly trustPorts: boolean;
  readonly policyHelperPattern: string;
  readonly includeTests: boolean;
  readonly includeScripts: boolean;
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly promiseBridges: readonly string[];
  readonly httpMethods: readonly string[];
  readonly crossEffectGen: boolean;
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readOptions(context: Context): RuleOptions {
  const raw = context.options?.[0];
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    requireTimeout: boolean(record.requireTimeout, true),
    requireRetry: boolean(record.requireRetry, false),
    portFiles: stringArray(record.portFiles, DEFAULT_PORT_FILES),
    trustPorts: boolean(record.trustPorts, false),
    policyHelperPattern: text(record.policyHelperPattern, DEFAULT_POLICY_HELPER_PATTERN),
    includeTests: boolean(record.includeTests, false),
    includeScripts: boolean(record.includeScripts, false),
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    promiseBridges: stringArray(record.promiseBridges, DEFAULT_PROMISE_BRIDGES),
    httpMethods: stringArray(record.httpMethods, DEFAULT_HTTP_METHODS),
    crossEffectGen: boolean(record.crossEffectGen, true),
  };
}

function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function isScriptPath(path: string): boolean {
  return isScriptFile(path) || path.includes('/scripts/');
}

// Resolve lexical value bindings, not identifier spellings. Only immutable local aliases are
// followed; arbitrary object mutation, re-export contents and dynamic keys need type/data-flow analysis.
function lexicalVariable(context: Context, node: Extract<ESTree.Node, { type: 'Identifier' }>) {
  let scope: import('@oxlint/plugins').Scope | null = context.sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(node.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}
function staticString(node: ESTree.Node): string | null {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? null;
  return null;
}
function identityUnwrap(node: ESTree.Node): ESTree.Node {
  let current = node;
  for (;;) {
    if (current.type === 'SequenceExpression') {
      const last = current.expressions.at(-1);
      if (last === undefined) return current;
      current = last;
    } else if (
      [
        'ChainExpression',
        'ParenthesizedExpression',
        'TSAsExpression',
        'TSTypeAssertion',
        'TSNonNullExpression',
        'TSSatisfiesExpression',
        'TSInstantiationExpression',
      ].includes(current.type)
    ) {
      current = (current as unknown as { expression: ESTree.Node }).expression;
    } else return current;
  }
}
function bindingPath(
  context: Context,
  expression: ESTree.Node,
  extraModules: readonly string[] = [],
  seen = new Set<unknown>(),
): readonly string[] | null {
  const node = identityUnwrap(expression);
  if (node.type === 'MemberExpression') {
    const key =
      !node.computed && node.property.type === 'Identifier'
        ? node.property.name
        : staticString(node.property);
    const root = bindingPath(context, node.object, extraModules, seen);
    return root !== null && key !== null ? [...root, key] : null;
  }
  if (node.type !== 'Identifier') return null;
  const variable = lexicalVariable(context, node);
  if (variable === null || seen.has(variable)) return null;
  seen.add(variable);
  if (variable.defs.length !== 1) return null;
  const definition = variable.defs[0];
  if (definition === undefined) return null;
  if (definition.type === 'ImportBinding') {
    const specifier = definition.node as
      | ESTree.ImportSpecifier
      | ESTree.ImportNamespaceSpecifier
      | ESTree.ImportDefaultSpecifier;
    const declaration = definition.parent as ESTree.ImportDeclaration;
    if (declaration?.type !== 'ImportDeclaration' || declaration.importKind === 'type') return null;
    if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') return null;
    const source = declaration.source.value;
    if (source !== 'effect' && !source.startsWith('effect/') && !extraModules.includes(source))
      return null;
    const last = source.split('/').at(-1) ?? '';
    const base = source.startsWith('effect/') && /^[A-Z]/u.test(last) ? [last] : [];
    if (specifier.type === 'ImportNamespaceSpecifier') return base;
    if (specifier.type !== 'ImportSpecifier') return null;
    const imported =
      specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
    return [...base, imported];
  }
  if (definition.type !== 'Variable') return null;
  const declaration = definition.node as ESTree.VariableDeclarator;
  const parent = definition.parent as ESTree.VariableDeclaration;
  if (parent?.kind !== 'const' || declaration.init === null) return null;
  const base = bindingPath(context, declaration.init, extraModules, seen);
  if (base === null) return null;
  if (declaration.id.type === 'Identifier') return base;
  if (declaration.id.type !== 'ObjectPattern') return null;
  for (const property of declaration.id.properties) {
    if (
      property.type === 'RestElement' ||
      property.value.type !== 'Identifier' ||
      property.value.name !== node.name
    )
      continue;
    const key =
      !property.computed && property.key.type === 'Identifier'
        ? property.key.name
        : staticString(property.key);
    return key === null ? null : [...base, key];
  }
  return null;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B1 (with A5/A9): syntactic review of Promise bridges and proven HttpClient calls. ' +
        'Externalness and caller/adapter policies cannot be proven by this AST-only rule. `Effect.tryPromise`/' +
        '`Effect.promise` bridges and proven `HttpClient` requests; external I/O and caller bounds are not inferred. ' +
        'Bound them with `Effect.timeout`/`Effect.timeoutOrElse` and, for transient typed failures, ' +
        '`Effect.retry({ schedule, while })` at the port, so callers inherit the policy instead of ' +
        'each one re-deriving it.',
    },
    messages: {
      unboundedPromiseBridge:
        'Promise bridge `{{callee}}` has no visible Effect timeout/retry policy (audit B1). ' +
        'Syntax cannot prove whether the work is external or already bounded; for external I/O, use ' +
        '`Effect.timeout`/`Effect.timeoutOrElse` and, for transient typed failures, ' +
        '`Effect.retry({ schedule, while })` at the port so callers inherit the policy. ' +
        'Promise cancellation still depends on its adapter honoring interruption.',
      unboundedHttpCall:
        'HTTP call `{{callee}}` has no visible Effect timeout/retry policy (audit B1). Follow the ARES ' +
        'adapter: `httpClient.execute(request).pipe(Effect.timeout(REQUEST_TIMEOUT), ' +
        'Effect.retry({ schedule, while: isRetryable }))`, and keep the policy on the port so every ' +
        'caller inherits it.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          requireTimeout: { type: 'boolean' },
          requireRetry: { type: 'boolean' },
          portFiles: { type: 'array', items: { type: 'string' } },
          trustPorts: { type: 'boolean' },
          policyHelperPattern: { type: 'string' },
          includeTests: { type: 'boolean' },
          includeScripts: { type: 'boolean' },
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          promiseBridges: { type: 'array', items: { type: 'string' } },
          httpMethods: { type: 'array', items: { type: 'string' } },
          crossEffectGen: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        requireTimeout: true,
        requireRetry: false,
        portFiles: [...DEFAULT_PORT_FILES],
        trustPorts: false,
        policyHelperPattern: DEFAULT_POLICY_HELPER_PATTERN,
        includeTests: false,
        includeScripts: false,
        include: [...DEFAULT_INCLUDE],
        ignore: [...DEFAULT_IGNORE],
        promiseBridges: DEFAULT_PROMISE_BRIDGES,
        httpMethods: DEFAULT_HTTP_METHODS,
        crossEffectGen: true,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    if (!options.requireTimeout && !options.requireRetry) return {};
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore) || (!options.includeTests && isTestFile(path)))
      return {};
    const script = isScriptPath(path);
    if (script ? !options.includeScripts : !matchesGlobs(path, options.include)) return {};
    if (options.trustPorts && matchesGlobs(path, options.portFiles)) return {};
    let policyHelper: RegExp;
    try {
      policyHelper = new RegExp(options.policyHelperPattern, 'u');
    } catch {
      policyHelper = new RegExp(DEFAULT_POLICY_HELPER_PATTERN, 'u');
    }
    const effectMemberOf = (node: ESTree.Node): string | null => {
      const identity = bindingPath(context, node);
      return identity?.length === 2 && identity[0] === 'Effect' ? (identity[1] ?? null) : null;
    };
    const memberKey = (node: ESTree.MemberExpression): string | null =>
      !node.computed && node.property.type === 'Identifier'
        ? node.property.name
        : staticString(node.property);
    const effectCallee = (call: ESTree.CallExpression): string | null => {
      const callee = identityUnwrap(call.callee);
      if (callee.type === 'CallExpression' && effectMemberOf(callee.callee) === 'fn') return 'fn';
      return effectMemberOf(callee);
    };
    const policyOf = (value: ESTree.Node, seen = new Set<unknown>()): Policy | null => {
      const node = identityUnwrap(value);
      if (node.type === 'CallExpression') {
        const member = effectMemberOf(node.callee);
        if (member !== null && TIMEOUT_MEMBERS.has(member)) return { timeout: true, retry: false };
        if (member !== null && RETRY_MEMBERS.has(member)) return { timeout: false, retry: true };
        // Shared policy helpers are explicitly trusted only through real imports.
        return policyOf(node.callee, seen);
      }
      if (node.type !== 'Identifier') return null;
      const variable = lexicalVariable(context, node);
      if (variable === null || seen.has(variable) || variable.defs.length !== 1) return null;
      seen.add(variable);
      const def = variable.defs[0];
      if (def?.type === 'ImportBinding') {
        const declaration = def.parent as ESTree.ImportDeclaration;
        const specifier = def.node as ESTree.ImportSpecifier;
        if (declaration.importKind === 'type' || specifier.importKind === 'type') return null;
        const imported =
          specifier.type === 'ImportSpecifier'
            ? specifier.imported.type === 'Identifier'
              ? specifier.imported.name
              : specifier.imported.value
            : node.name;
        return policyHelper.test(imported) ? { timeout: true, retry: true } : null;
      }
      if (def?.type !== 'Variable' || (def.parent as ESTree.VariableDeclaration)?.kind !== 'const')
        return null;
      const init = (def.node as ESTree.VariableDeclarator).init;
      return init === null ? null : policyOf(init, seen);
    };
    const pipeKind = (call: ESTree.CallExpression): 'function' | 'member' | null => {
      const callee = identityUnwrap(call.callee);
      const identity = bindingPath(context, callee)?.join('.');
      if (identity === 'pipe' || identity === 'Function.pipe') return 'function';
      return callee.type === 'MemberExpression' && memberKey(callee) === 'pipe' ? 'member' : null;
    };
    const outerExpression = (node: ESTree.Node): ESTree.Node => {
      let current = node;
      while (
        current.parent !== null &&
        current.parent !== undefined &&
        identityUnwrap(current.parent) === current
      )
        current = current.parent;
      return current;
    };
    // Only callbacks evaluated as Effects belong to an outer policy. Effect.map/sync/succeed
    // may return a dormant Effect value; forked/cached work has a separate lifetime.
    const effectCallbacks = new Set([
      'flatMap',
      'andThen',
      'tap',
      'catch',
      'catchAll',
      'catchTag',
      'catchCause',
      'forEach',
      'filter',
      'partition',
      'suspend',
      'acquireUseRelease',
    ]);
    const finalizerArgument = (call: ESTree.CallExpression, child: ESTree.Node): boolean => {
      const member = effectCallee(call),
        index = call.arguments.indexOf(child as ESTree.Argument);
      return (
        (member === 'acquireRelease' && index === 1) ||
        (member === 'acquireUseRelease' && index === 2) ||
        (member === 'addFinalizer' && index === 0) ||
        (['ensuring', 'onExit', 'onInterrupt'].includes(member ?? '') &&
          index === call.arguments.length - 1)
      );
    };
    const inspectAncestors = (site: ESTree.Node): { policy: Policy; finalizer: boolean } => {
      const policy: Policy = { timeout: false, retry: false };
      const merge = (value: ESTree.Node): void => {
        const found = policyOf(value);
        if (found !== null) {
          policy.timeout ||= found.timeout;
          policy.retry ||= found.retry;
        }
      };
      let child = site,
        current = site.parent;
      while (current !== null && current !== undefined) {
        if (FUNCTION_TYPES.has(current.type)) {
          const outer = outerExpression(current),
            owner = outer.parent;
          if (owner?.type !== 'CallExpression') break;
          if (finalizerArgument(owner, outer)) return { policy, finalizer: true };
          const member = effectCallee(owner);
          if (
            !(
              member !== null &&
              (effectCallbacks.has(member) ||
                (options.crossEffectGen && EFFECT_PROGRAM_WRAPPERS.has(member)))
            )
          )
            break;
        } else if (current.type === 'CallExpression') {
          const kind = pipeKind(current),
            index = current.arguments.indexOf(child as ESTree.Argument);
          const member = effectCallee(current);
          if (finalizerArgument(current, child)) return { policy, finalizer: true };
          if (kind !== null) {
            // A timeout BEFORE flatMap does not bound work added by that flatMap.
            for (
              let i = Math.max(index + 1, kind === 'function' ? 1 : 0);
              i < current.arguments.length;
              i++
            ) {
              const argument = current.arguments[i];
              if (argument !== undefined) merge(argument);
            }
          } else if (member === 'fn' || member === 'fnUntraced') {
            for (const argument of current.arguments.slice(index + 1)) merge(argument);
          } else if (
            member !== null &&
            (TIMEOUT_MEMBERS.has(member) || RETRY_MEMBERS.has(member))
          ) {
            if (index === 0 && current.arguments.length >= 2) merge(current);
          } else if (
            member === null ||
            [
              'map',
              'sync',
              'succeed',
              'as',
              'forkChild',
              'forkScoped',
              'forkDaemon',
              'cached',
            ].includes(member)
          ) {
            // Native Array.map builds the Effect collection; do not infer arbitrary helpers.
            const callee = identityUnwrap(current.callee);
            if (!(callee.type === 'MemberExpression' && memberKey(callee) === 'map' && index >= 0))
              break;
          }
        }
        child = current;
        current = current.parent;
      }
      return { policy, finalizer: false };
    };
    const satisfied = (policy: Policy): boolean =>
      options.requireRetry
        ? policy.retry && (!options.requireTimeout || policy.timeout)
        : policy.timeout || policy.retry;
    const isHttpClient = (value: ESTree.Node, seen = new Set<unknown>()): boolean => {
      const node = identityUnwrap(value);
      if (bindingPath(context, node)?.join('.') === 'HttpClient') return true;
      if (node.type !== 'Identifier') return false;
      const variable = lexicalVariable(context, node);
      if (variable === null || seen.has(variable) || variable.defs.length !== 1) return false;
      seen.add(variable);
      const def = variable.defs[0];
      if (def === undefined) return false;
      const binding = def.name;
      if (binding?.type === 'Identifier') {
        const annotation = binding.typeAnnotation?.typeAnnotation;
        if (
          annotation?.type === 'TSTypeReference' &&
          annotation.typeName.type === 'TSQualifiedName'
        ) {
          const name = annotation.typeName;
          if (name.left.type === 'Identifier' && name.right.name === 'HttpClient') {
            const imported = lexicalVariable(context, name.left)?.defs[0];
            if (imported?.type === 'ImportBinding') {
              const source = (imported.parent as ESTree.ImportDeclaration).source.value;
              const specifier = imported.node as ESTree.ImportSpecifier;
              if (
                source.startsWith('effect/') &&
                ((specifier.type === 'ImportSpecifier' &&
                  specifier.imported.type === 'Identifier' &&
                  specifier.imported.name === 'HttpClient') ||
                  source.endsWith('/HttpClient'))
              )
                return true;
            }
          }
        }
      }
      if (def.type !== 'Variable' || (def.parent as ESTree.VariableDeclaration)?.kind !== 'const')
        return false;
      const init = (def.node as ESTree.VariableDeclarator).init;
      if (init === null) return false;
      const actual = identityUnwrap(init);
      if (actual.type === 'YieldExpression' && actual.delegate && actual.argument !== null)
        return bindingPath(context, actual.argument)?.join('.') === 'HttpClient.HttpClient';
      if (actual.type === 'CallExpression') {
        const identity = bindingPath(context, actual.callee)?.join('.');
        return identity === 'HttpClient.make' || identity === 'FetchHttpClient.make';
      }
      return isHttpClient(actual, seen);
    };
    const localImport = (call: ESTree.CallExpression): boolean => {
      // D-tier server module-loading adapters, not browser chunk/network imports. This is a
      // boundary exemption, not a claim that imported modules cannot perform async work.
      if (!/(?:^packages\/core-runtime\/|\/api\/|\/server\/)/u.test(path)) return false;
      let thunk = call.arguments[0];
      if (thunk === undefined) return false;
      thunk = identityUnwrap(thunk) as ESTree.Argument;
      if (thunk.type === 'ObjectExpression') {
        const property = thunk.properties.find(
          (p) =>
            p.type === 'Property' &&
            ((!p.computed && p.key.type === 'Identifier' && p.key.name === 'try') ||
              staticString(p.key) === 'try'),
        );
        if (property?.type !== 'Property') return false;
        thunk = property.value as ESTree.Argument;
      }
      if (thunk.type !== 'ArrowFunctionExpression' && thunk.type !== 'FunctionExpression')
        return false;
      if (thunk.body === null) return false;
      let body: ESTree.Node = thunk.body;
      if (body.type === 'BlockStatement') {
        if (
          body.body.length !== 1 ||
          body.body[0]?.type !== 'ReturnStatement' ||
          body.body[0].argument === null
        )
          return false;
        body = body.body[0].argument;
      }
      body = identityUnwrap(body);
      if (body.type === 'AwaitExpression') body = identityUnwrap(body.argument);
      return (
        body.type === 'ImportExpression' && /^\.{1,2}\//u.test(staticString(body.source) ?? '')
      );
    };
    const report = (
      node: ESTree.Node,
      messageId: 'unboundedPromiseBridge' | 'unboundedHttpCall',
    ): void => {
      const found = inspectAncestors(node);
      if (found.finalizer || satisfied(found.policy)) return;
      context.report({
        node,
        messageId,
        data: {
          callee: context.sourceCode.getText(node.type === 'CallExpression' ? node.callee : node),
        },
      });
    };
    return {
      CallExpression(node) {
        const callee = identityUnwrap(node.callee),
          member = effectMemberOf(callee);
        if (member !== null && options.promiseBridges.includes(member)) {
          if (!localImport(node)) report(node, 'unboundedPromiseBridge');
          return;
        }
        if (
          callee.type === 'MemberExpression' &&
          options.httpMethods.includes(memberKey(callee) ?? '') &&
          isHttpClient(callee.object)
        )
          report(node, 'unboundedHttpCall');
      },
      MemberExpression(node) {
        if (!options.promiseBridges.includes(effectMemberOf(node) ?? '')) return;
        const outer = outerExpression(node),
          parent = outer.parent;
        if (
          parent?.type === 'CallExpression' &&
          parent.arguments.includes(outer as ESTree.Argument)
        )
          report(node, 'unboundedPromiseBridge');
      },
      Identifier(node) {
        if (!options.promiseBridges.includes(effectMemberOf(node) ?? '')) return;
        const outer = outerExpression(node),
          parent = outer.parent;
        if (
          parent?.type === 'CallExpression' &&
          parent.arguments.includes(outer as ESTree.Argument)
        )
          report(node, 'unboundedPromiseBridge');
      },
    };
  },
});
