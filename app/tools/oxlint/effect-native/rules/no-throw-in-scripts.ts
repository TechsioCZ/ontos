/**
 * effect-native/no-throw-in-scripts
 *
 * Audit findings enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *   - **B3** "Convert consequential operational scripts into Effect programs" —
 *     "Approximately 79 of 103 scripts are primarily async/await; **hundreds of manual throws** and
 *     several independent argv parsers remain. […] Use scoped resources, shared Layers, **typed
 *     errors**, Schema decoders, and `effect/unstable/cli`. Keep one small process-exit adapter at
 *     the executable edge."
 *     Audit B3 script-family references (not individual throw locations): `scripts/migrate-contacts-authorization.mts:98`,
 *     `scripts/migrate-contacts-authorization.mts:291`, `scripts/postgres/bootstrap-runtime-role.mts:29`,
 *     `scripts/initialize-local-development.mts:652`, `scripts/check-ontos-module-contracts.mts:69`,
 *     `scripts/scaffolding/cli.mts:683`.
 *   - **A8** "Fix the generators before generating more code" — scaffolds and validators live in
 *     `scripts/` ("about 28k LOC outside current lint/typecheck coverage") and every `throw` they
 *     contain is a pattern that gets copied into generated MicroVerticals. "Bring `scripts/` and
 *     `tools/oxlint` under explicit TypeScript and anti-slop gates."
 *   - **A4** "Rebuild the error system around typed channels and contract-owned Problem Details" —
 *     "Define each expected failure as `Schema.TaggedError`. […] Preserve original failures or
 *     causes when translating between layers." A `throw` has no error channel at all: every distinct
 *     failure (missing argument, malformed contract, conflicting identity, unreachable database)
 *     collapses into one untyped defect that the caller can only re-discriminate with `instanceof`
 *     or string matching, and the surrounding `try`/`catch` plumbing grows to compensate.
 *
 * ## What is detected
 *
 * Every `ThrowStatement` in a script file (`scripts/**`, tests excluded). This rule is the **sole
 * owner** of throws under `scripts/`: `no-throw-in-effect-callback` (S1/A4) and
 * `no-throw-in-configuration-parser` (A3) both exclude `scripts/**` on purpose, so nothing here is
 * double-reported.
 *
 * Three variants, purely so the diagnostic can name the right Effect-native replacement:
 *   1. `throwError` — the thrown expression is `new Error(...)` / `new TypeError(...)` /
 *      `new RangeError(...)` / `new SyntaxError(...)` (and the remaining native error globals)
 *      where the constructor resolves to a **global**, not to an import or a local binding.
 *      Replacement: a `Schema.TaggedError` per failure reason.
 *   2. `rethrow` — the thrown expression is a reference to a `catch` clause parameter
 *      (`try { … } catch (error) { throw error; }`), resolved through the scope graph
 *      (`Definition.type === "CatchClause"`), including a destructured catch binding.
 *      Replacement: keep the failure in `E` (or the defect in `Cause`) instead of re-entering the
 *      exception channel; `Effect.tapErrorCause` / `Effect.catchTag` / `Exit.match` at the edge.
 *      Suppressed by `allowRethrow: true`.
 *   3. `throwOther` — everything else: `throw failure('local_contract_invalid', …)`,
 *      `throw configurationError()`, `throw result.error`, `throw someSentinel`, a thrown literal.
 *      Replacement: return the typed failure instead of throwing it.
 *
 * Robustness: the thrown expression is unwrapped through `(...)`, `as`, `satisfies`, `!`, `<T>`
 * and optional-chaining wrappers before it is classified, and constructor identity is resolved
 * through the scope graph so a local `class Error {}` or `import { Error } from "./errors.ts"`
 * is reported as `throwOther` rather than mislabelled as a native throw.
 *
 * ## What is deliberately allowed
 *
 *   - **Test files** — `scripts/tests/**`, `scripts/scaffolding/tests/**`, `*.test.mts`, `*.spec.ts`
 *     and friends never report. The audit blesses "deliberately malformed casts in tests" and the
 *     testing harness is B2's separate migration step, not B3's.
 *   - **Everything outside `scripts/`** — `apps/`, `verticals/`, `packages/`, `tools/` are owned by
 *     the S1/A3/A4 throw rules; this rule returns immediately for them.
 *   - **Generated code inside template literals** — scaffolds emit `throw` *text*
 *     (`scripts/scaffolding/<template>/scaffold.mts`); a string is not a `ThrowStatement`, so only the
 *     scaffold's own control flow is reported. A8 wants exactly that distinction.
 *   - **The audit's "Existing patterns to preserve" and D tier** are untouched by this rule: the
 *     single outer process/framework adapter seam, `Layer.orDie` at a deliberate startup root,
 *     correct Drizzle JSONB / HttpApi serialization, `JSON.stringify` in external test-fixture
 *     APIs, and native array operations contain no `throw`. Keeping "one small process-exit adapter
 *     at the executable edge" means setting `process.exitCode` from an `Exit`, not throwing.
 *   - **Escape hatches, off by default and never used by the production config:** `allowPaths`
 *     (globs), `allowRethrow` (skip variant 2), `allowInsideEffectTry` (skip throws lexically inside
 *     an `Effect.try` / `Effect.tryPromise` callback, where a typed failure channel does already
 *     exist at the boundary — the `catch`/`Cause` mapper still has to reconstruct the reason, so the
 *     default reports them).
 *
 * Scope lives in the rule (`scripts/**` minus tests, via `shared/paths.ts`), so `oxlint.config.ts`
 * only needs `'effect-native/no-throw-in-scripts': 'error'`.
 *
 * Report-only: no fixers, no suggestions.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import {
  globToRegExp,
  isScriptFile,
  isTestFile,
  matchesAny,
  normalisePath,
} from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets the fixtures exercise the real production defaults instead of forcing
 * the fixture config to pass loosened options (which `run-on-repo.mts` reuses verbatim).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

/** Native error globals. A `throw new X(...)` against one of these is the B3 "manual throw". */
const NATIVE_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'DOMException',
]);

/** `Effect.try` / `Effect.tryPromise` — the only combinators `allowInsideEffectTry` covers. */
const EFFECT_TRY_MEMBERS = new Set(['try', 'tryPromise']);

/** Wrappers that do not change the value of an expression. */
const TRANSPARENT_TYPES = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
  'ChainExpression',
]);

type AnyNode = ESTree.Node;

interface RuleOptions {
  readonly allowPaths: readonly string[];
  readonly allowRethrow: boolean;
  readonly allowInsideEffectTry: boolean;
}

const DEFAULTS: RuleOptions = {
  allowPaths: [],
  allowRethrow: false,
  allowInsideEffectTry: false,
};

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Partial<Record<keyof RuleOptions, unknown>>;
  const globs =
    Array.isArray(given.allowPaths) && given.allowPaths.every((entry) => typeof entry === 'string')
      ? (given.allowPaths as readonly string[])
      : DEFAULTS.allowPaths;
  return {
    allowPaths: globs,
    allowRethrow:
      typeof given.allowRethrow === 'boolean' ? given.allowRethrow : DEFAULTS.allowRethrow,
    allowInsideEffectTry:
      typeof given.allowInsideEffectTry === 'boolean'
        ? given.allowInsideEffectTry
        : DEFAULTS.allowInsideEffectTry,
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real script paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function parentOf(node: AnyNode): AnyNode | null {
  return (node as { parent?: AnyNode | null }).parent ?? null;
}

/** Strip `(...)`, `as`, `satisfies`, `!`, `<T>` and `a?.b` wrappers from an expression. */
function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (TRANSPARENT_TYPES.has(current.type)) {
    const inner = (current as { expression?: AnyNode }).expression;
    if (inner === undefined || inner === null) return current;
    current = inner;
  }
  return current;
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

/** `throw error;` where `error` is bound by a `catch (error)` / `catch ({ cause })` clause. */
function isCatchBinding(context: Context, node: AnyNode): boolean {
  if (node.type !== 'Identifier') return false;
  const variable = resolveVariable(context, (node as ESTree.IdentifierReference).name, node);
  if (variable === null) return false;
  if (variable.scope.type === 'catch') return true;
  return variable.defs.some((definition) => definition.type === 'CatchClause');
}

/** `new Error(...)` where `Error` is the global, not an import or a locally declared class. */
function nativeErrorName(context: Context, node: AnyNode): string | null {
  if (node.type !== 'NewExpression') return null;
  const callee = unwrap((node as ESTree.NewExpression).callee as AnyNode);
  if (callee.type !== 'Identifier') return null;
  const name = (callee as ESTree.IdentifierReference).name;
  if (!NATIVE_ERROR_NAMES.has(name)) return null;
  const variable = resolveVariable(context, name, callee);
  // Unresolved, or resolved only to an implicit global, means the real native constructor.
  if (variable === null) return name;
  return variable.defs.length === 0 ||
    variable.defs.every((definition) => definition.type === 'ImplicitGlobalVariable')
    ? name
    : null;
}

function staticMemberName(node: ESTree.MemberExpression): string | null {
  const property = node.property as AnyNode;
  if (!node.computed)
    return property.type === 'Identifier' ? (property as ESTree.IdentifierName).name : null;
  if (property.type !== 'Literal') return null;
  const value = (property as { value?: unknown }).value;
  return typeof value === 'string' ? value : null;
}

/** `Effect.try` / `Effect.tryPromise` where `Effect` really comes from `effect` / `effect/*`. */
function isEffectTryCallee(node: AnyNode, bindings: EffectBindings, context: Context): boolean {
  return ['Effect.try', 'Effect.tryPromise'].includes(provenance(context, node) ?? '');
}

/**
 * `true` when the throw sits lexically inside the arguments of `Effect.try(...)` /
 * `Effect.tryPromise(...)` — both the positional callback and the `{ try: … , catch: … }` form.
 */
function isInsideEffectTry(node: AnyNode, bindings: EffectBindings, context: Context): boolean {
  let child: AnyNode = node;
  let parent = parentOf(child);
  while (parent !== null) {
    if (parent.type === 'CallExpression') {
      const call = parent as ESTree.CallExpression;
      if (
        (call.arguments as readonly AnyNode[]).includes(child) &&
        isEffectTryCallee(call.callee as AnyNode, bindings, context)
      ) {
        return true;
      }
    }
    child = parent;
    parent = parentOf(child);
  }
  return false;
}

/** A short, human-readable rendering of the thrown expression for the diagnostic text. */
function describeThrown(node: AnyNode): string {
  if (node.type === 'NewExpression') {
    const callee = unwrap((node as ESTree.NewExpression).callee as AnyNode);
    if (callee.type === 'Identifier')
      return `new ${(callee as ESTree.IdentifierReference).name}(...)`;
    if (callee.type === 'MemberExpression') {
      const name = staticMemberName(callee as ESTree.MemberExpression);
      if (name !== null) return `new ...${name}(...)`;
    }
    return 'new ...(...)';
  }
  if (node.type === 'CallExpression') {
    const callee = unwrap((node as ESTree.CallExpression).callee as AnyNode);
    if (callee.type === 'Identifier') return `${(callee as ESTree.IdentifierReference).name}(...)`;
    if (callee.type === 'MemberExpression') {
      const name = staticMemberName(callee as ESTree.MemberExpression);
      if (name !== null) return `...${name}(...)`;
    }
    return 'a call result';
  }
  if (node.type === 'Identifier') return (node as ESTree.IdentifierReference).name;
  if (node.type === 'MemberExpression') {
    const name = staticMemberName(node as ESTree.MemberExpression);
    return name === null ? 'a property' : `...${name}`;
  }
  if (node.type === 'Literal') return 'a literal';
  return 'this value';
}

/** Effect-native rule: scripts fail through typed Effect errors, never through `throw`. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B3/A8/A4: operational scripts must fail through typed Effect errors. Every throw statement under scripts/** (tests excluded) is reported — native error throws, catch-clause rethrows and thrown sentinels alike — because thrown failures lack an Effect error channel. Script segments include workspace-local scripts; classification is syntactic, not proof that a throw is reachable or uncaught.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#b3-convert-consequential-operational-scripts-into-effect-programs',
    },
    messages: {
      throwError:
        'Audit B3/A4: `throw {{thrown}}` in a script has no error channel — every distinct failure collapses into one untyped defect and callers can only re-discriminate it with instanceof or string matching. Declare this failure as a `Schema.TaggedError` and return it (`yield* new ModuleContractInvalid({ label, cause })` inside `Effect.gen`, or `Effect.fail(...)`), then let the single process-exit adapter at the executable edge map typed failures to exit codes.',
      rethrow:
        "Audit B3/A4: rethrowing `{{thrown}}` re-enters the exception channel and drops the original failure's type, so the caller needs another try/catch to recover it. Keep the failure in `E` (`Effect.catchTag` / `Effect.mapError` preserving the cause) or the defect in `Cause` (`Effect.tapErrorCause`), and decide the exit code from the `Exit` at the executable edge instead of re-throwing.",
      throwOther:
        "Audit B3/A4: `throw {{thrown}}` makes this failure invisible to the type system — the script's failure vocabulary lives only in try/catch plumbing. Model it as a `Schema.TaggedError` and return it (`Effect.fail(new ScriptStepFailed({ reason, cause }))` / `yield* new ScriptStepFailed({...})`) so the typed failure reaches the executable edge and becomes an exit code there.",
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
              'Globs of script files exempted from this rule, matched against the repo-relative path (default: none).',
          },
          allowRethrow: {
            type: 'boolean',
            description:
              'Do not report `throw error;` where `error` is a catch-clause binding (default: false — a rethrow still drops the typed failure).',
          },
          allowInsideEffectTry: {
            type: 'boolean',
            description:
              'Do not report throws lexically inside an `Effect.try` / `Effect.tryPromise` callback (default: false — the catch mapper still has to reconstruct the reason).',
          },
        },
      },
    ],
    defaultOptions: [{ allowPaths: [], allowRethrow: false, allowInsideEffectTry: false }],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    const path = scriptScope(context.filename);
    if (!inScriptScope(path)) return {};
    if (options.allowPaths.some((glob) => globToRegExp(glob).test(path))) return {};

    let bindings: EffectBindings | null = null;

    return {
      Program(node) {
        bindings = collectEffectBindings(node);
      },
      ThrowStatement(node) {
        const statement = node as unknown as AnyNode;
        const thrown = unwrap((node as ESTree.ThrowStatement).argument as AnyNode);
        if (
          options.allowInsideEffectTry &&
          bindings !== null &&
          bindings.importsEffect &&
          isInsideEffectTry(statement, bindings, context)
        ) {
          return;
        }
        const data = { thrown: describeThrown(thrown) };
        if (isCatchBinding(context, thrown)) {
          if (options.allowRethrow) return;
          context.report({ node: statement, messageId: 'rethrow', data });
          return;
        }
        const native = nativeErrorName(context, thrown);
        if (native !== null) {
          context.report({ node: statement, messageId: 'throwError', data });
          return;
        }
        context.report({ node: statement, messageId: 'throwOther', data });
      },
    };
  },
});

/** Bounded, lexical provenance only; no type checker or interprocedural/data-flow inference. */
type Syntax = ESTree.Node & Record<string, any>;
function syntax(node: unknown): Syntax | null {
  let n = node as Syntax | null;
  while (
    n &&
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'TSTypeAssertion',
      'TSInstantiationExpression',
      'ParenthesizedExpression',
      'ChainExpression',
      'AwaitExpression',
    ].includes(n.type)
  )
    n = n.expression ?? n.argument;
  return n;
}
function lexicalVariable(context: Context, node: Syntax): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope) {
    const v = scope.set.get(node.name);
    if (v) return v;
    scope = scope.upper;
  }
  return null;
}
function literalText(node: unknown): string | null {
  const n = syntax(node);
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'TemplateLiteral' && n.expressions.length === 0)
    return n.quasis[0]?.value.cooked ?? null;
  return null;
}
function propertyText(node: unknown): string | null {
  const n = node as Syntax;
  const key = syntax(n.property ?? n.key);
  return !n.computed && key?.type === 'Identifier' ? key.name : literalText(key);
}
function moduleIdentity(source: string): string {
  if (/^(?:node:)?(?:process|console|util|module)$/.test(source))
    return source.replace(/^node:/, '');
  if (source === 'effect/Effect') return 'Effect';
  if (source === 'effect/ManagedRuntime') return 'ManagedRuntime';
  return source;
}
function bindingPath(pattern: Syntax, name: string): string[] | null {
  if (pattern.type === 'Identifier') return pattern.name === name ? [] : null;
  if (pattern.type === 'AssignmentPattern') return bindingPath(pattern.left, name);
  if (pattern.type !== 'ObjectPattern') return null;
  for (const p of pattern.properties) {
    if (p.type !== 'Property') continue;
    const key = propertyText(p),
      tail = bindingPath(p.value, name);
    if (key !== null && tail !== null) return [key, ...tail];
  }
  return null;
}
function provenance(context: Context, node: unknown, seen = new Set<Variable>()): string | null {
  const n = syntax(node);
  if (!n) return null;
  if (n.type === 'Identifier') {
    const v = lexicalVariable(context, n);
    if (!v || v.defs.length === 0)
      return [
        'process',
        'console',
        'Bun',
        'globalThis',
        'global',
        'window',
        'self',
        'require',
        'Array',
        'Set',
      ].includes(n.name)
        ? n.name
        : null;
    if (seen.has(v) || v.defs.length !== 1) return null;
    const next = new Set(seen);
    next.add(v);
    const def = v.defs[0] as any;
    if (def.type === 'ImportBinding') {
      const spec = def.node as Syntax;
      const decl = (def.parent ?? spec.parent) as Syntax;
      if (decl.importKind === 'type' || spec.importKind === 'type') return null;
      const source = literalText(decl.source);
      if (!source) return null;
      const base = moduleIdentity(source);
      if (spec.type === 'ImportNamespaceSpecifier' || spec.type === 'ImportDefaultSpecifier')
        return base;
      const name = spec.imported?.name ?? spec.imported?.value;
      if (name === 'default') return base;
      if (base === 'effect') return name;
      return `${base}.${name}`;
    }
    if (def.type !== 'Variable' || def.node.type !== 'VariableDeclarator') return null;
    // A declaration is not a reaching-definition analysis: reassigned aliases are unknown.
    if (v.references.some((r: any) => r.init !== true && r.isWrite())) return null;
    const d = def.node as Syntax;
    const base = provenance(context, d.init, next),
      path = bindingPath(d.id, n.name);
    return base !== null && path !== null ? [base, ...path].join('.') : null;
  }
  if (n.type === 'MemberExpression') {
    const base = provenance(context, n.object, seen),
      key = propertyText(n);
    if (base === null || key === null) return null;
    if (
      ['globalThis', 'global', 'window', 'self'].includes(base) &&
      ['process', 'console', 'Bun'].includes(key)
    )
      return key;
    if (['process', 'console', 'util', 'module'].includes(base) && key === 'default') return base;
    if (base === 'effect') return key;
    return `${base}.${key}`;
  }
  if (n.type === 'ImportExpression') {
    const text = literalText(n.source);
    return text === null ? null : moduleIdentity(text);
  }
  if (n.type === 'CallExpression') {
    const callee = provenance(context, n.callee, seen);
    if (callee === 'require') {
      const text = literalText(n.arguments[0]);
      return text === null ? null : moduleIdentity(text);
    }
    if (callee === 'module.createRequire') return 'require';
    if (callee === 'ManagedRuntime.make') return 'Runtime';
  }
  return null;
}
/** Only value references, never property names, bindings or TS-only identifiers. */
function valueReference(context: Context, node: unknown): boolean {
  const n = node as Syntax,
    p = n.parent as Syntax | undefined;
  if (!p) return false;
  if (p.type.startsWith('Import') || p.type === 'ExportSpecifier') return false;
  if (p.type === 'MemberExpression' && p.property === n && !p.computed) return false;
  if (
    [
      'Property',
      'PropertyDefinition',
      'MethodDefinition',
      'TSPropertySignature',
      'TSMethodSignature',
    ].includes(p.type) &&
    p.key === n &&
    !p.computed &&
    !(p.shorthand && p.value === n)
  )
    return false;
  if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(p.type)) return false;
  let child: Syntax = n;
  let parent: Syntax | null = p;
  while (parent) {
    if (
      parent.type.startsWith('TS') &&
      !(
        [
          'TSAsExpression',
          'TSSatisfiesExpression',
          'TSNonNullExpression',
          'TSTypeAssertion',
          'TSInstantiationExpression',
        ].includes(parent.type) && parent.expression === child
      )
    )
      return false;
    if (
      parent.type.endsWith('Statement') ||
      parent.type.endsWith('Declaration') ||
      parent.type.includes('Function')
    )
      break;
    child = parent;
    parent = parent.parent as Syntax | null;
  }
  const v = lexicalVariable(context, n);
  return (
    !v ||
    v.references.some(
      (r: any) =>
        r.identifier === n &&
        r.isRead() &&
        (typeof r.isValueReference !== 'function' || r.isValueReference()),
    )
  );
}
/** Strip fixture scaffolding first; do not renormalise a relative script path around inner markers. */
function scriptScope(filename: string): string {
  const unified = filename.replaceAll('\\', '/');
  const fixture = unified.match(
    /(?:^|\/)tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\/(.*)$/u,
  );
  if (fixture) return fixture[1];
  if (!unified.startsWith('/') && !/^[A-Za-z]:\//u.test(unified))
    return unified.replace(/^\.\//, '');
  const match = unified.match(/(?:^|\/)((?:apps|packages|verticals|scripts|tools)\/.*)$/u);
  return match?.[1] ?? unified;
}
function inScriptScope(path: string): boolean {
  return (
    /(?:^|\/)scripts\//u.test(path) &&
    !/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec|test-d|spec-d)\.[cm]?[jt]sx?$/u.test(path)
  );
}
