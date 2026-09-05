/**
 * Audit findings: **A2** — "Make Schema the sole authority for contracts and domain models"
 * ("Model absence and outcomes with `Option`, `Result`, `Schema.OptionFromNullOr`, or typed
 * failures as appropriate") and **B5** — "Adopt Effect's ADTs and temporal model consistently"
 * ("Highest-value targets are service outcomes, persistence absence, ...").
 * See `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`.
 *
 * The audit's own evidence lines for A2/B5 are exactly this shape:
 * `packages/core-runtime/src/auth/principal-management.ts:61`
 * (`loadPrincipal: (...) => Promise<PrincipalRecord | undefined>`) and
 * `packages/core-runtime/src/outbox/repository.ts:76`
 * (`claimNext: (...) => Effect.Effect<OutboxClaim | null, OutboxPersistenceError>`).
 * A service outcome that hides absence in `| undefined` / `| null` forces every caller to re-check
 * by hand; `Option`/`Result`/a typed `NotFound` failure makes absence matchable and exhaustive.
 *
 * What is detected
 * - Any **return type position** whose annotation is an asynchronous outcome wrapper
 *   (`Promise`, `PromiseLike`, or Effect's `Effect` type) whose **first type argument** is a union
 *   containing `undefined` or `null`:
 *   - `TSMethodSignature.returnType` — `interface Repo { load(): Promise<Row | undefined> }`
 *   - `TSFunctionType.returnType` — covers `TSPropertySignature` members
 *     (`readonly load: (...) => Promise<Row | undefined>`), `TSTypeAliasDeclaration`s of function
 *     types (`type Load = (...) => Effect.Effect<Row | null, E>`), class property annotations and
 *     callback parameter types.
 *   - `TSCallSignatureDeclaration` / `TSConstructSignatureDeclaration` return types.
 *   - `TSEmptyBodyFunctionExpression` — a class member with **no body**: `abstract load(): ...`,
 *     a method inside `declare class`, and an overload signature. These are type-level port
 *     declarations exactly like a `TSMethodSignature`, so they are checked unconditionally
 *     (not behind `includeAsyncFunctions`); otherwise the public half of a port could stay silent
 *     while only its private implementation reported.
 *   - Concrete implementations (`includeAsyncFunctions`, default `true`): `FunctionDeclaration`,
 *     `FunctionExpression` (so class/object methods), `ArrowFunctionExpression` and
 *     `TSDeclareFunction` return annotations — `async load(): Promise<Row | undefined> { ... }`.
 * - The Effect wrapper is resolved through the real import bindings (`shared/effect-imports.ts`):
 *   `Effect.Effect<...>`, aliased `import { Effect as Eff } from "effect"` → `Eff.Effect<...>`,
 *   submodule namespace imports `import * as Effect from "effect/Effect"` → `Effect.Effect<...>`,
 *   bare `import type { Effect } from "effect/Effect"` → `Effect<Row | null, E>`, and root barrel
 *   `import * as E from "effect"` → `E.Effect.Effect<...>`. A `Promise` that is locally shadowed by
 *   a same-file `type Promise = ...` alias is ignored.
 * - Type-level parentheses are unwrapped and nested unions flattened, so
 *   `Promise<(Row | undefined)>` and `Promise<A | (B | null)>` report.
 * - Same-file **alias indirection** (`resolveAliases`, default `true`), on both halves of the
 *   outcome, each following up to `aliasDepth` (default 3) hops:
 *   - the *type argument*: `type MaybeRow = Row | undefined;` used as `Promise<MaybeRow>`;
 *   - the *whole wrapper*: `type ClaimOutcome = Promise<Claim | undefined>;` or
 *     `type ClaimEffect = Effect.Effect<Claim | null, E>;` used directly as the return annotation.
 *     `apps/shell-super-app/src/api/auth-client.ts` already exports four such
 *     `export type XClientEffect = Effect.Effect<...>` outcome aliases, so naming the outcome must
 *     not be an escape hatch.
 * - `.ts`, `.mts`, `.cts` and `.tsx` alike; tests are included by default (`ignoreTests: false`)
 *   because test doubles that implement a nullable port keep the port nullable.
 *
 * What is deliberately allowed
 * - **Synchronous** helpers: `const parse = (s: string): string | undefined => ...`. B5 says
 *   explicitly "do not mechanically replace every native array or `undefined`" — only *outcomes*
 *   crossing an async service seam are reported, which is why the union must sit inside
 *   `Promise`/`Effect`.
 * - **Absence-only and void unions**: `Promise<void | undefined>`, `Promise<null | undefined>`,
 *   `Promise<never | undefined>`, `Promise<unknown | null>`. These carry no value to wrap in an
 *   `Option`, so there is nothing to model.
 * - **Nullable wrappers rather than nullable outcomes**: `Promise<Row> | undefined` and
 *   `Effect.Effect<Row, E> | null` — the absence is in the *reference to the effect*, not in the
 *   outcome, and is not the A2/B5 finding.
 * - Optional properties/parameters (`readonly id?: string`), nullable non-return annotations, and
 *   union type arguments in non-first positions (`Effect.Effect<Row, E | undefined>` is an error
 *   channel concern, not an absence concern).
 * - A `Promise`/`Effect` type argument that is already `Option`/`Result` shaped is untouched, since
 *   it never contains `undefined`/`null` at the top level.
 * - Anything outside `include`, anything matching `ignore`, and (with `ignoreTests`) test files —
 *   the escape hatch for framework loader signatures that are forced to be nullable. The audit's
 *   D tier blesses framework/driver-forced adapters. Function expressions explicitly annotated by,
 *   or `satisfies`-checked against, an imported type from those frameworks are excluded. Do not
 *   replace their Promise protocol merely to satisfy this rule.
 *
 * Known limitations (without type information):
 * - Beyond explicit framework type annotations, the rule cannot prove an external callback contract,
 *   nor see through **cross-file** type aliases — only same-file `type X = ...` declarations are resolved.
 * - **Generic** alias parameters are not substituted, so `type Outcome<A> = Promise<A | undefined>`
 *   used as `Outcome<Row>` is missed; the union lives on the alias's type parameter, and deciding
 *   whether `A` is instantiated with a value type needs a type checker.
 * - Alias chains longer than `aliasDepth` (default 3 hops) are not followed, on either half.
 * Reports are informational only; this rule never fixes or suggests.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings, type EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production `include` defaults.
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];
const DEFAULT_IGNORE: readonly string[] = [];

/** Global async outcome wrappers, matched by name (no import required). */
const DEFAULT_PROMISE_TYPES = ['Promise', 'PromiseLike'];

/** Effect's outcome type, matched only through real `effect` import bindings. */
const EFFECT_NAMESPACE = 'Effect';
const EFFECT_TYPE = 'Effect';
const EFFECT_ROOT_MODULE = 'effect';

const ABSENCE_TYPES = new Set(['TSNullKeyword', 'TSUndefinedKeyword']);
/** Members that carry no value worth wrapping in an `Option`. */
const VOID_LIKE_TYPES = new Set([
  'TSVoidKeyword',
  'TSNeverKeyword',
  'TSAnyKeyword',
  'TSUnknownKeyword',
]);

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly ignoreTests: boolean;
  readonly includeAsyncFunctions: boolean;
  readonly promiseTypes: readonly string[];
  readonly checkEffect: boolean;
  readonly resolveAliases: boolean;
  readonly aliasDepth: number;
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function integer(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function readOptions(context: Context): RuleOptions {
  const raw = context.options?.[0];
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    ignoreTests: boolean(record.ignoreTests, false),
    includeAsyncFunctions: boolean(record.includeAsyncFunctions, true),
    promiseTypes: stringArray(record.promiseTypes, DEFAULT_PROMISE_TYPES),
    checkEffect: boolean(record.checkEffect, true),
    resolveAliases: boolean(record.resolveAliases, true),
    aliasDepth: integer(record.aliasDepth, 3),
  };
}

function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Flatten `Schema.Codec` / `Effect.Effect` / `Effect` into its dotted segments. */
function typeNameSegments(name: ESTree.TSTypeName): readonly string[] | null {
  if (name.type === 'Identifier') return [name.name];
  if (name.type === 'TSQualifiedName') {
    const left = typeNameSegments(name.left);
    return left === null ? null : [...left, name.right.name];
  }
  return null;
}

/** Locals bound to the whole `effect` root barrel (`import * as E from "effect"` → `E.Effect.Effect`). */
function collectEffectBarrels(program: ESTree.Program): ReadonlySet<string> {
  const barrels = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (statement.source.value !== EFFECT_ROOT_MODULE) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') barrels.add(specifier.local.name);
    }
  }
  return barrels;
}

/** Resolve type bindings lexically; namespace-local aliases must not leak into other scopes. */
function lookupVariable(context: Context, node: ESTree.Node, name: string): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

interface Absence {
  /** Printed absence keywords, e.g. `undefined` or `null | undefined`. */
  readonly absence: string;
  /** Printed value members of the union, e.g. `PrincipalRecord`. */
  readonly value: string;
  /** Alias name when the union was reached through `type X = Row | undefined`. */
  readonly via: string | null;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A2/B5: service outcomes must model absence with `Option`/`Result` or a typed failure, not ' +
        '`Promise<T | undefined>` / `Effect.Effect<T | null, E>`. A nullable outcome forces every caller to ' +
        're-check by hand instead of matching on `Option.match` or catching a typed `NotFound`.',
    },
    messages: {
      nullableOutcome:
        'Review `{{wrapper}}<{{type}} | {{absence}}>` as a first-party service outcome (audit A2/B5). ' +
        'Prefer Option/Result in the success value, or an intentional typed failure when appropriate. ' +
        'Preserve Promise-based and nullable signatures required by external frameworks/drivers.',
      nullableAlias:
        'Outcome `{{wrapper}}<{{alias}}>` resolves to `{{type}} | {{absence}}` (audit A2/B5). ' +
        'Review Option/Result for owned service absence; preserve externally required adapter signatures.',
      nullableOutcomeAlias:
        'Outcome alias `{{alias}}` resolves to `{{wrapper}}<{{type}} | {{absence}}>` (audit A2/B5). ' +
        'Review Option/Result for owned service absence, without changing framework/driver-required signatures.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          ignoreTests: { type: 'boolean' },
          includeAsyncFunctions: { type: 'boolean' },
          promiseTypes: { type: 'array', items: { type: 'string' } },
          checkEffect: { type: 'boolean' },
          resolveAliases: { type: 'boolean' },
          aliasDepth: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: DEFAULT_INCLUDE,
        ignore: [...DEFAULT_IGNORE],
        ignoreTests: false,
        includeAsyncFunctions: true,
        promiseTypes: DEFAULT_PROMISE_TYPES,
        checkEffect: true,
        resolveAliases: true,
        aliasDepth: 3,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore)) return {};
    if (!matchesGlobs(path, options.include)) return {};
    if (options.ignoreTests && isTestFile(path)) return {};

    const program = context.sourceCode.ast;
    const bindings: EffectBindings = collectEffectBindings(program);
    const barrels = collectEffectBarrels(program);

    /** Strip type-level parentheses so `(Row | undefined)` behaves like the bare union. */
    const unwrapType = (type: ESTree.TSType): ESTree.TSType => {
      let current = type;
      while (current.type === 'TSParenthesizedType') current = current.typeAnnotation;
      return current;
    };

    const printed = (node: ESTree.Node): string => {
      const text = context.sourceCode.getText(node).replace(/\s+/gu, ' ').trim();
      return text.length > 60 ? `${text.slice(0, 57)}...` : text;
    };

    const rootVariable = (reference: ESTree.TSTypeReference): Variable | null => {
      let root = reference.typeName;
      while (root.type === 'TSQualifiedName') root = root.left;
      return root.type === 'Identifier' ? lookupVariable(context, root, root.name) : null;
    };

    const aliasTarget = (reference: ESTree.TSTypeReference): ESTree.TSType | null => {
      if (reference.typeName.type !== 'Identifier' || reference.typeArguments != null) return null;
      const variable = rootVariable(reference);
      const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
      if (
        definition?.node.type !== 'TSTypeAliasDeclaration' ||
        definition.node.typeParameters != null
      )
        return null;
      return definition.node.typeAnnotation;
    };

    /**
     * `Promise` / `PromiseLike` / `Effect.Effect` / `Eff.Effect` / `E.Effect.Effect` / bare `Effect`.
     * Returns the printed wrapper name, or `null` when the reference is not an async outcome wrapper.
     */
    const wrapperName = (reference: ESTree.TSTypeReference): string | null => {
      const segments = typeNameSegments(reference.typeName);
      if (segments === null || segments.length === 0) return null;
      const last = segments[segments.length - 1] ?? '';
      const variable = rootVariable(reference);
      const global = variable === null || variable.defs.length === 0;
      const imported =
        variable?.defs.some((definition) => definition.type === 'ImportBinding') === true;
      if (segments.length === 1) {
        const name = segments[0] ?? '';
        // A same-file `type Promise = ...` shadow means this is not the global promise.
        if (options.promiseTypes.includes(name)) return global ? name : null;
        if (!options.checkEffect || !imported) return null;
        return bindings.namespaces.get(name) === EFFECT_NAMESPACE ? name : null;
      }
      if (!options.checkEffect || !imported || last !== EFFECT_TYPE) return null;
      if (segments.length === 2) {
        const namespace = segments[0] ?? '';
        return bindings.namespaces.get(namespace) === EFFECT_NAMESPACE
          ? `${namespace}.${last}`
          : null;
      }
      if (segments.length === 3) {
        const barrel = segments[0] ?? '';
        if (!barrels.has(barrel) || segments[1] !== EFFECT_NAMESPACE) return null;
        return `${barrel}.${EFFECT_NAMESPACE}.${last}`;
      }
      return null;
    };

    /** Flatten nested unions/parentheses into their leaf members. */
    const flattenUnion = (type: ESTree.TSType, into: ESTree.TSType[]): void => {
      const current = unwrapType(type);
      if (current.type === 'TSUnionType') {
        for (const member of current.types) flattenUnion(member, into);
        return;
      }
      into.push(current);
    };

    /** Absence carried by a union type, or `null` when the union has no reportable absence. */
    const unionAbsence = (type: ESTree.TSType): Omit<Absence, 'via'> | null => {
      const current = unwrapType(type);
      if (current.type !== 'TSUnionType') return null;
      const members: ESTree.TSType[] = [];
      flattenUnion(current, members);
      const absent = members.filter((member) => ABSENCE_TYPES.has(member.type));
      if (absent.length === 0) return null;
      const values = members.filter((member) => !ABSENCE_TYPES.has(member.type));
      // `void | undefined`, `null | undefined`, `never | null`: nothing to wrap in an Option.
      if (values.length === 0) return null;
      if (values.every((member) => VOID_LIKE_TYPES.has(member.type))) return null;
      // any/unknown absorb the union; a value member does not make their absence meaningful.
      if (
        values.some(
          (member) => member.type === 'TSAnyKeyword' || member.type === 'TSUnknownKeyword',
        )
      )
        return null;
      const absenceNames = [
        ...new Set(
          absent.map((member) => (member.type === 'TSNullKeyword' ? 'null' : 'undefined')),
        ),
      ];
      return { absence: absenceNames.join(' | '), value: values.map(printed).join(' | ') };
    };

    /** Absence carried by the outcome type, following same-file aliases up to `aliasDepth` hops. */
    const outcomeAbsence = (type: ESTree.TSType): Absence | null => {
      const direct = unionAbsence(type);
      if (direct !== null) return { ...direct, via: null };
      if (!options.resolveAliases) return null;
      let current = unwrapType(type);
      const seen = new Set<string>();
      for (let depth = 0; depth < options.aliasDepth; depth += 1) {
        if (current.type !== 'TSTypeReference') return null;
        const segments = typeNameSegments(current.typeName);
        if (segments === null || segments.length !== 1) return null;
        const name = segments[0] ?? '';
        if (seen.has(name)) return null;
        seen.add(name);
        const target = aliasTarget(current);
        if (target === null) return null;
        const resolved = unionAbsence(target);
        if (resolved !== null) return { ...resolved, via: name };
        current = unwrapType(target);
      }
      return null;
    };

    /**
     * Resolve a return annotation to the async outcome wrapper it really denotes, following
     * same-file aliases of the *whole* wrapper (`type ClaimOutcome = Promise<Claim | undefined>`)
     * up to `aliasDepth` hops. Returns the printed wrapper name, its first type argument, and the
     * alias name written at the return position (or `null` when the wrapper was written directly).
     */
    const resolveWrapper = (
      annotation: ESTree.TSType,
    ): {
      readonly wrapper: string;
      readonly first: ESTree.TSType;
      readonly via: string | null;
    } | null => {
      let current = unwrapType(annotation);
      let via: string | null = null;
      const seen = new Set<string>();
      // One extra iteration for the annotation itself, then at most `aliasDepth` alias hops.
      for (let hop = 0; hop <= options.aliasDepth; hop += 1) {
        if (current.type !== 'TSTypeReference') return null;
        const wrapper = wrapperName(current);
        if (wrapper !== null) {
          const first = current.typeArguments?.params?.[0];
          return first === undefined ? null : { wrapper, first, via };
        }
        if (!options.resolveAliases) return null;
        const segments = typeNameSegments(current.typeName);
        if (segments === null || segments.length !== 1) return null;
        const name = segments[0] ?? '';
        if (seen.has(name)) return null;
        seen.add(name);
        const target = aliasTarget(current);
        if (target === null) return null;
        if (via === null) via = name;
        current = unwrapType(target);
      }
      return null;
    };

    /** An explicit imported adapter type owns its signature; do not ask callers to redesign it. */
    const externalType = (type: ESTree.TSType): boolean => {
      const current = unwrapType(type);
      if (current.type !== 'TSTypeReference') return false;
      const variable = rootVariable(current);
      return (
        variable?.defs.some(
          (definition) =>
            definition.type === 'ImportBinding' &&
            definition.parent?.type === 'ImportDeclaration' &&
            /^(?:react(?:\/|$)|@tanstack\/|@modern-js\/|(?:@playwright\/test|playwright)(?:\/|$)|drizzle-orm(?:\/|$)|node:)/u.test(
              definition.parent.source.value,
            ),
        ) === true
      );
    };

    const hasExternalAdapterType = (annotation: ESTree.TSTypeAnnotation): boolean => {
      const fn = annotation.parent;
      if (fn?.type !== 'ArrowFunctionExpression' && fn?.type !== 'FunctionExpression') return false;
      let current: ESTree.Node = fn;
      for (let depth = 0; depth < 8; depth += 1) {
        const container: ESTree.Node | null | undefined = current.parent;
        if (container?.type !== 'Property' && container?.type !== 'ObjectExpression') break;
        current = container;
      }
      const parent = current.parent;
      if (parent?.type === 'TSSatisfiesExpression') return externalType(parent.typeAnnotation);
      if (parent?.type !== 'VariableDeclarator' || parent.id.type !== 'Identifier') return false;
      return (
        parent.id.typeAnnotation !== null &&
        parent.id.typeAnnotation !== undefined &&
        externalType(parent.id.typeAnnotation.typeAnnotation)
      );
    };

    const reported = new Set<number>();

    /** Report when `annotation` is `Wrapper<Value | undefined, ...>`, directly or via an alias. */
    const checkReturnType = (annotation: ESTree.TSTypeAnnotation | null | undefined): void => {
      if (annotation === null || annotation === undefined) return;
      if (hasExternalAdapterType(annotation)) return;
      const anchor = unwrapType(annotation.typeAnnotation);
      if (anchor.type !== 'TSTypeReference') return;
      const outcome = resolveWrapper(anchor);
      if (outcome === null) return;
      const absence = outcomeAbsence(outcome.first);
      if (absence === null) return;
      if (reported.has(anchor.start)) return;
      reported.add(anchor.start);
      const messageId =
        outcome.via !== null
          ? 'nullableOutcomeAlias'
          : absence.via === null
            ? 'nullableOutcome'
            : 'nullableAlias';
      context.report({
        node: anchor,
        messageId,
        data: {
          wrapper: outcome.wrapper,
          type: absence.value,
          absence: absence.absence,
          alias: outcome.via ?? absence.via ?? '',
        },
      });
    };

    const visitors: Record<string, (node: never) => void> = {
      TSMethodSignature: (node: ESTree.TSMethodSignature) => checkReturnType(node.returnType),
      TSFunctionType: (node: ESTree.TSFunctionType) => checkReturnType(node.returnType),
      TSCallSignatureDeclaration: (node: ESTree.TSCallSignatureDeclaration) =>
        checkReturnType(node.returnType),
      TSConstructSignatureDeclaration: (node: ESTree.TSConstructSignatureDeclaration) =>
        checkReturnType(node.returnType),
      // A bodyless class member: `abstract load(): ...`, a `declare class` method, or an overload
      // signature. Type-level port declarations, so never gated behind `includeAsyncFunctions`.
      TSEmptyBodyFunctionExpression: (node: {
        readonly returnType?: ESTree.TSTypeAnnotation | null;
      }) => checkReturnType(node.returnType),
    } as Record<string, (node: never) => void>;

    if (options.includeAsyncFunctions) {
      const checkFunction = (node: {
        readonly returnType?: ESTree.TSTypeAnnotation | null;
      }): void => checkReturnType(node.returnType);
      visitors.FunctionDeclaration = checkFunction as (node: never) => void;
      visitors.FunctionExpression = checkFunction as (node: never) => void;
      visitors.ArrowFunctionExpression = checkFunction as (node: never) => void;
      visitors.TSDeclareFunction = checkFunction as (node: never) => void;
    }

    return visitors;
  },
});
