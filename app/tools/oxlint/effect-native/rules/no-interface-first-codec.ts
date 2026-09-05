/**
 * Audit finding: **A2** — "Make Schema the sole authority for contracts and domain models"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`). A2 counts "approximately 119
 * `Schema.Codec<Interface>`-style declarations" and states the target directly: "Derive types from
 * the Schema rather than annotating the Schema with a prior interface."
 *
 * What is detected
 * - `const X: Schema.Codec<Foo> = Schema.Struct({...})` — a variable declarator whose **own** type
 *   annotation is an Effect Schema codec type (`Schema.Codec`, `Schema.Schema`, `Schema.Top`,
 *   `Schema.Struct`, configurable via `codecTypes`) applied to a prior TypeScript type. The
 *   interface becomes a second authority the Schema must be kept in sync with.
 * - `Schema.Struct({...}) satisfies Schema.Codec<Foo>` (`checkSatisfies`),
 *   `Schema.Struct({...}) as Schema.Codec<Foo>` and the angle-bracket form
 *   `<Schema.Codec<Foo>>Schema.Struct({...})` (`checkAsExpressions`) — the same second authority,
 *   expressed as a check/cast instead of an annotation.
 * - `class Repo { private readonly rows: Schema.Codec<Row> = Schema.Struct({...}) }`
 *   (`checkClassProperties`) — a class property whose annotation is a codec type *and* whose
 *   initializer is a Schema construction. The initializer gate keeps the blessed
 *   `(schema: Schema.Codec<unknown>) => ...` / `readonly schema: Schema.Codec<unknown>` shapes clear.
 * - Aliased imports (`import { Schema as S } from "effect"`), submodule namespace imports
 *   (`import * as Schema from "effect/Schema"`), root barrel access (`import * as Effect from "effect"`
 *   then `Effect.Schema.Codec<Foo>`), bare **and aliased** type imports
 *   (`import type { Codec as SchemaCodec } from "effect/Schema"` then `const X: SchemaCodec<Foo> = ...`;
 *   the *imported* name decides, never the local alias), and Effect barrels in `reexportModules`.
 * - `.ts`, `.mts`, `.cts` and `.tsx` alike. The initializer may be a `.pipe(...)` chain, any other
 *   Effect v4 Schema instance method (`.annotate(...)`, `.check(...)`, ...), a point-free
 *   `pipe(schema, ...)` / `Function.pipe(schema, ...)` call resolved through the *import binding*
 *   rather than the spelling (`import { pipe as flow } from "effect"` counts), a plain function call
 *   or any other expression (`requireSchemaInitializer` narrows this).
 *
 * What is deliberately allowed
 * - **Recursive schemas** that contain a `Schema.suspend` call inside the annotated declarator
 *   (`allowSuspend`, default `true`). TypeScript genuinely cannot infer those, so the explicit
 *   annotation is load-bearing rather than a competing authority.
 * - **Widening / erasure annotations**: a bare `Schema.Top` or `Schema.Codec` with no type argument
 *   (`requireTypeArguments`), and `Schema.Codec<unknown>` / `<any>` / `<never>`
 *   (`ignoreTypeArguments`). Those do not encode a prior interface.
 * - **Already-derived annotations**, directly (`Schema.Codec<typeof Other.Type>`) or through
 *   scope-resolved same-file aliases (`allowDerivedTypeArguments`). Enclosing generic parameters
 *   are not prior interfaces either. Declarations without initializers require an annotation and
 *   are not competing schema constructions.
 * - **Non-declarator positions**: function parameters, return types, class property signatures,
 *   generic constraints, `Map<string, Schema.Codec<unknown>>` containers and array annotations.
 *   `(schema: Schema.Codec<unknown>) => ...` is ordinary Schema-generic code, not an authority
 *   conflict, and the audit's "Existing patterns to preserve" section blesses legitimate `satisfies`
 *   contract checks — only `satisfies <Schema codec type>` on a Schema value is reported.
 * - Anything outside `include`, anything matching `ignore`, and (with `ignoreTests`) test files.
 *
 * Known limitations (AST-only, no type checker):
 * - Imported aliases cannot be resolved: an imported schema-derived type may still report.
 *   Same-file derivations are followed only through direct aliases and generic applications;
 *   conditional/mapped types need type semantics and are deliberately not evaluated.
 * - A type-alias indirection evades detection: `type RowCodec = Schema.Codec<Row>;
 *   const x: RowCodec = Schema.Struct({...})` is not reported, because resolving `RowCodec` back to
 *   `Schema.Codec` needs the type graph. Zero occurrences in this repo.
 *
 * Reports are informational only; this rule never fixes or suggests.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import {
  collectEffectBindings,
  effectMember,
  type EffectBindings,
} from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

const SCHEMA_NAMESPACE = 'Schema';
const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_SCHEMA_MODULE = /^effect\/(?:.*\/)?Schema$/u;

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production `include` defaults instead of
 * forcing the fixture config to pass loosened options (which `run-on-repo.mts` reuses verbatim).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];

const DEFAULT_IGNORE: readonly string[] = [];

/** Schema type constructors that, used as a declaration annotation, re-assert a prior type. */
const DEFAULT_CODEC_TYPES = ['Codec', 'Schema', 'Top', 'Struct'];

/** Type arguments that widen instead of encoding a prior interface. */
const DEFAULT_IGNORE_TYPE_ARGUMENTS = ['unknown', 'any', 'never'];

/**
 * Barrels that re-export Effect namespaces verbatim (`export * as Schema from "effect/Schema"`), so
 * `Schema` imported from them *is* Effect's `Schema`. The Modern.js BFF client/edge barrels are how
 * every shared contract file in this repo reaches Schema.
 */
const DEFAULT_REEXPORT_MODULES = [
  '@modern-js/plugin-bff/effect-client',
  '@modern-js/plugin-bff/effect-edge',
  '@modern-js/plugin-bff/effect-*',
];

const SUSPEND_MEMBER = 'suspend';
const PIPE_MEMBER = 'pipe';

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly ignoreTests: boolean;
  readonly allowSuspend: boolean;
  readonly codecTypes: readonly string[];
  readonly ignoreTypeArguments: readonly string[];
  readonly requireTypeArguments: boolean;
  readonly allowDerivedTypeArguments: boolean;
  readonly requireSchemaInitializer: boolean;
  readonly checkSatisfies: boolean;
  readonly checkAsExpressions: boolean;
  readonly checkClassProperties: boolean;
  readonly reexportModules: readonly string[];
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
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
    allowSuspend: boolean(record.allowSuspend, true),
    codecTypes: stringArray(record.codecTypes, DEFAULT_CODEC_TYPES),
    ignoreTypeArguments: stringArray(record.ignoreTypeArguments, DEFAULT_IGNORE_TYPE_ARGUMENTS),
    requireTypeArguments: boolean(record.requireTypeArguments, true),
    allowDerivedTypeArguments: boolean(record.allowDerivedTypeArguments, true),
    requireSchemaInitializer: boolean(record.requireSchemaInitializer, false),
    checkSatisfies: boolean(record.checkSatisfies, true),
    checkAsExpressions: boolean(record.checkAsExpressions, true),
    checkClassProperties: boolean(record.checkClassProperties, true),
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function importedName(specifier: ESTree.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : specifier.imported.value;
}

interface SchemaLocals {
  /** Locals standing for Effect's `Schema` namespace (`Schema`, `S`, `import * as Schema from "effect/Schema"`). */
  readonly schema: ReadonlySet<string>;
  /** Locals standing for the whole Effect barrel (`import * as Effect from "effect"` → `Effect.Schema.Codec`). */
  readonly barrel: ReadonlySet<string>;
  /** Locals bound directly from `effect/Schema` (`import { Struct, suspend } from "effect/Schema"`). */
  readonly direct: ReadonlyMap<string, string>;
}

function collectSchemaLocals(
  program: ESTree.Program,
  bindings: EffectBindings,
  reexportModules: readonly string[],
): SchemaLocals {
  const schema = new Set<string>();
  const barrel = new Set<string>();
  const direct = new Map<string, string>();
  for (const [local, namespace] of bindings.namespaces) {
    if (namespace === SCHEMA_NAMESPACE) schema.add(local);
  }
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    const source = statement.source.value;
    if (EFFECT_SCHEMA_MODULE.test(source)) {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportSpecifier')
          direct.set(specifier.local.name, importedName(specifier));
        else if (specifier.type === 'ImportNamespaceSpecifier') schema.add(specifier.local.name);
      }
      continue;
    }
    const isEffectRoot = source === EFFECT_ROOT_MODULE;
    const isReexport = matchesGlobs(source, reexportModules);
    if (!isEffectRoot && !isReexport) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') barrel.add(specifier.local.name);
      else if (
        specifier.type === 'ImportSpecifier' &&
        importedName(specifier) === SCHEMA_NAMESPACE
      ) {
        schema.add(specifier.local.name);
      }
    }
  }
  return { schema, barrel, direct };
}

/** Flatten `Schema.Codec` / `Effect.Schema.Codec` / `Codec` into its dotted segments. */
function typeNameSegments(name: ESTree.TSTypeName): readonly string[] | null {
  if (name.type === 'Identifier') return [name.name];
  if (name.type === 'TSQualifiedName') {
    const left = typeNameSegments(name.left);
    return left === null ? null : [...left, name.right.name];
  }
  return null;
}

/** Non-computed `.pipe`, or computed `["pipe"]`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const property = node.property;
  if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
  return null;
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
 * `true` when the identifier still resolves to an `import` binding. Unresolved names fall back to
 * `true` because the module-level import declaration already proved the binding exists; only a local
 * shadow (parameter, `const`, catch clause, …) rejects the match.
 */
function resolvesToImport(
  context: Context,
  identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
): boolean {
  const variable = lookupVariable(context, identifier);
  if (variable === null) return true;
  if (variable.defs.length === 0) return true;
  return variable.defs.some((definition) => definition.type === 'ImportBinding');
}

interface Candidate {
  readonly node: ESTree.Node;
  readonly ownerStart: number;
  readonly ownerEnd: number;
  readonly messageId: 'annotation' | 'satisfies' | 'cast' | 'property';
  readonly name: string;
  readonly annotation: string;
  readonly type: string;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A2: never annotate a Schema value with a prior interface (`const X: Schema.Codec<Foo> = ' +
        'Schema.Struct(...)`). The interface becomes a competing authority; declare the Schema first and ' +
        'derive `type Foo = typeof X.Type`, or model the entity with `Schema.Class`/`Schema.TaggedClass`.',
    },
    messages: {
      annotation:
        'Schema `{{name}}` is annotated with a prior `{{annotation}}` interface, making `{{type}}` a second ' +
        'authority the Schema must be kept in sync with. Drop the annotation and derive the type instead: ' +
        '`export const {{name}} = Schema.Struct({ ... }); export type {{type}} = typeof {{name}}.Type;` — or ' +
        'model the entity as `Schema.Class`/`Schema.TaggedClass`/`Schema.TaggedError` and use its instance type.',
      satisfies:
        '`satisfies {{annotation}}` re-asserts the prior type `{{type}}` over Schema `{{name}}`, so the ' +
        'interface stays a second authority. Delete the `satisfies` clause and derive the type from the Schema: ' +
        '`type {{type}} = typeof {{name}}.Type` (or use `Schema.Class`/`Schema.TaggedClass`).',
      cast:
        "`as {{annotation}}` casts Schema `{{name}}` onto the prior type `{{type}}`, erasing the Schema's own " +
        'inferred `Type`/`Encoded` and keeping the interface as a second authority. Remove the cast and derive ' +
        '`type {{type}} = typeof {{name}}.Type` from the Schema instead.',
      property:
        'Class property `{{name}}` annotates its Schema with a prior `{{annotation}}` interface, making ' +
        '`{{type}}` a second authority. Declare the Schema at module scope without the annotation and derive ' +
        '`type {{type}} = typeof <schema>.Type` (or model the entity as `Schema.Class`/`Schema.TaggedClass`).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          ignoreTests: { type: 'boolean' },
          allowSuspend: { type: 'boolean' },
          codecTypes: { type: 'array', items: { type: 'string' } },
          ignoreTypeArguments: { type: 'array', items: { type: 'string' } },
          requireTypeArguments: { type: 'boolean' },
          allowDerivedTypeArguments: { type: 'boolean' },
          requireSchemaInitializer: { type: 'boolean' },
          checkSatisfies: { type: 'boolean' },
          checkAsExpressions: { type: 'boolean' },
          checkClassProperties: { type: 'boolean' },
          reexportModules: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: DEFAULT_INCLUDE,
        ignore: [...DEFAULT_IGNORE],
        ignoreTests: false,
        allowSuspend: true,
        codecTypes: DEFAULT_CODEC_TYPES,
        ignoreTypeArguments: DEFAULT_IGNORE_TYPE_ARGUMENTS,
        requireTypeArguments: true,
        allowDerivedTypeArguments: true,
        requireSchemaInitializer: false,
        checkSatisfies: true,
        checkAsExpressions: true,
        checkClassProperties: true,
        reexportModules: DEFAULT_REEXPORT_MODULES,
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
    const bindings = collectEffectBindings(program);
    const locals = collectSchemaLocals(program, bindings, options.reexportModules);
    if (locals.schema.size === 0 && locals.barrel.size === 0 && locals.direct.size === 0) return {};

    const codecTypeLocals = new Set<string>();
    const suspendLocals = new Set<string>();
    for (const [local, imported] of locals.direct) {
      if (options.codecTypes.includes(imported)) codecTypeLocals.add(local);
      if (imported === SUSPEND_MEMBER) suspendLocals.add(local);
    }

    const candidates: Candidate[] = [];
    const suspendSpans: Array<{ start: number; end: number }> = [];
    /** Declarator starts that already reported through their own annotation, to avoid double reports. */
    const annotatedOwners = new Set<number>();

    /** Strip type-level parentheses so `(Schema.Codec<Foo>)` behaves like the bare reference. */
    const unwrapType = (type: ESTree.TSType): ESTree.TSType => {
      let current = type;
      while (current.type === 'TSParenthesizedType') current = current.typeAnnotation;
      return current;
    };

    /** Strip value-level wrappers that never change what the expression *is*. */
    const unwrapExpression = (expression: ESTree.Node): ESTree.Node => {
      let current = expression;
      for (;;) {
        if (
          current.type === 'ParenthesizedExpression' ||
          current.type === 'ChainExpression' ||
          current.type === 'TSAsExpression' ||
          current.type === 'TSSatisfiesExpression' ||
          current.type === 'TSNonNullExpression' ||
          current.type === 'TSTypeAssertion' ||
          current.type === 'TSInstantiationExpression'
        ) {
          current = current.expression;
          continue;
        }
        return current;
      }
    };

    /** `Schema.X` / `S.X` / `Effect.Schema.X` / `Schema["X"]`, with the shared `effectMember` matcher first. */
    const schemaMemberName = (node: ESTree.MemberExpression): string | null => {
      const viaShared = effectMember(node, bindings);
      if (viaShared !== null && viaShared.namespace === SCHEMA_NAMESPACE) {
        if (node.object.type === 'Identifier' && !resolvesToImport(context, node.object))
          return null;
        return viaShared.member;
      }
      const member = memberName(node);
      if (member === null) return null;
      const object = node.object;
      if (object.type === 'Identifier') {
        if (!locals.schema.has(object.name)) return null;
        return resolvesToImport(context, object) ? member : null;
      }
      if (object.type !== 'MemberExpression') return null;
      if (memberName(object) !== SCHEMA_NAMESPACE) return null;
      if (object.object.type !== 'Identifier') return null;
      if (!locals.barrel.has(object.object.name)) return null;
      return resolvesToImport(context, object.object) ? member : null;
    };

    /**
     * Point-free `pipe`, resolved through the import binding rather than the source spelling:
     * `pipe(...)` and `flow(...)` (`import { pipe as flow } from "effect"`), plus namespaced
     * `Function.pipe(...)` / `Fn.pipe(...)` (`import { Function as Fn } from "effect"` or
     * `import * as Fn from "effect/Function"`). A locally *defined* `pipe` is rejected by scope.
     */
    const isPipeCallee = (callee: ESTree.Node): boolean => {
      if (callee.type === 'Identifier') {
        if (!resolvesToImport(context, callee)) return false;
        return bindings.namespaces.get(callee.name) === PIPE_MEMBER || callee.name === PIPE_MEMBER;
      }
      if (callee.type !== 'MemberExpression') return false;
      if (memberName(callee) !== PIPE_MEMBER) return false;
      const object = callee.object;
      if (object.type !== 'Identifier') return false;
      if (!bindings.namespaces.has(object.name)) return false;
      return resolvesToImport(context, object);
    };

    /**
     * Is this expression a Schema construction? Handles `Schema.Struct(...)`, member access,
     * `schema.pipe(Schema.optional)` method chains, point-free `pipe(schema, ...)` and bare
     * `Struct({...})` from `import { Struct } from "effect/Schema"`.
     */
    const isSchemaExpression = (expression: ESTree.Node, depth: number): boolean => {
      if (depth > 12) return false;
      const current = unwrapExpression(expression);
      if (current.type === 'Identifier') {
        return locals.direct.has(current.name) && resolvesToImport(context, current);
      }
      if (current.type === 'MemberExpression') return schemaMemberName(current) !== null;
      if (current.type !== 'CallExpression' && current.type !== 'NewExpression') return false;
      const callee = unwrapExpression(current.callee);
      // ANY instance-method chain, not just `.pipe`: Effect v4 Schemas carry `.annotate(...)`,
      // `.check(...)`, `.pipe(...)` and friends, so the receiver — never the method name — decides.
      if (callee.type === 'MemberExpression' && isSchemaExpression(callee.object, depth + 1))
        return true;
      if (isSchemaExpression(callee, depth + 1)) return true;
      if (isPipeCallee(callee)) {
        return current.arguments.some(
          (argument) =>
            argument.type !== 'SpreadElement' && isSchemaExpression(argument, depth + 1),
        );
      }
      return false;
    };

    /** Printed annotation, collapsed to one line and clipped so diagnostics stay readable. */
    const printed = (node: ESTree.Node): string => {
      const text = context.sourceCode.getText(node).replace(/\s+/gu, ' ').trim();
      return text.length > 80 ? `${text.slice(0, 77)}...` : text;
    };

    /** Follow same-file type aliases by scope, never by a file-wide name table. */
    const derivedOrGeneric = (type: ESTree.TSType, seen = new Set<ESTree.Node>()): boolean => {
      const current = unwrapType(type);
      if (seen.has(current) || seen.size > 24) return false;
      seen.add(current);
      if (options.allowDerivedTypeArguments && current.type === 'TSTypeQuery') return true;
      if (current.type !== 'TSTypeReference') return false;
      if (current.typeName.type === 'Identifier') {
        const name = current.typeName.name;
        const variable = lookupVariable(context, current.typeName);
        for (const definition of variable?.defs ?? []) {
          const declaration = definition.node as ESTree.Node;
          if (declaration.type === 'TSTypeParameter') return true;
          if (declaration.type === 'TSTypeAliasDeclaration') {
            return (
              options.allowDerivedTypeArguments &&
              derivedOrGeneric(declaration.typeAnnotation, seen)
            );
          }
        }
        // Some scope providers do not expose type-parameter definitions. Check only enclosing
        // binders; an unrelated generic elsewhere in the file must not exempt a prior interface.
        if (variable === null || variable.defs.length === 0) {
          let ancestor: ESTree.Node | null | undefined = current.parent;
          while (ancestor != null) {
            const parameters = (
              ancestor as { typeParameters?: ESTree.TSTypeParameterDeclaration | null }
            ).typeParameters;
            if (parameters?.params.some((parameter) => parameter.name.name === name)) return true;
            ancestor = ancestor.parent;
          }
        }
      }
      // Schema.Type<typeof S>, ReturnType<typeof factory>, etc. remain derived rather than
      // introducing a shape of their own. Mixed handwritten arguments are not waived.
      const arguments_ = current.typeArguments?.params ?? [];
      return (
        options.allowDerivedTypeArguments &&
        arguments_.length > 0 &&
        arguments_.every((argument) => derivedOrGeneric(argument, new Set(seen)))
      );
    };

    /**
     * When the annotation is an Effect Schema codec type applied to a prior type, return its
     * printed form and the printed first type argument. `null` means "not an authority conflict".
     */
    const codecAnnotation = (type: ESTree.TSType): { annotation: string; type: string } | null => {
      const reference = unwrapType(type);
      if (reference.type !== 'TSTypeReference') return null;
      const segments = typeNameSegments(reference.typeName);
      if (segments === null || segments.length === 0) return null;
      const member = segments[segments.length - 1] ?? '';
      if (segments.length === 1) {
        // A single segment is a *local* name (`Codec`, or `SchemaCodec` from
        // `import type { Codec as SchemaCodec } from "effect/Schema"`). `codecTypeLocals` is keyed by
        // local name and built from the *imported* name, so it must be consulted before — never after —
        // any test against the codec-type list, otherwise every alias escapes.
        if (!codecTypeLocals.has(segments[0] ?? '')) return null;
      } else if (segments.length === 2) {
        if (!options.codecTypes.includes(member)) return null;
        if (!locals.schema.has(segments[0] ?? '')) return null;
      } else if (segments.length === 3) {
        if (!options.codecTypes.includes(member)) return null;
        if (!locals.barrel.has(segments[0] ?? '') || segments[1] !== SCHEMA_NAMESPACE) return null;
      } else return null;

      const parameters = reference.typeArguments?.params ?? [];
      const first = parameters[0];
      if (first === undefined)
        return options.requireTypeArguments
          ? null
          : { annotation: printed(reference), type: member };
      const argument = context.sourceCode.getText(first).trim();
      if (options.ignoreTypeArguments.includes(argument)) return null;
      if (derivedOrGeneric(first)) return null;
      return { annotation: printed(reference), type: argument };
    };

    /** Nearest enclosing declarator/property name, for the diagnostic message. */
    const ownerOf = (node: ESTree.Node): { name: string; start: number; end: number } => {
      let current: ESTree.Node | null | undefined = node;
      for (let depth = 0; current !== null && current !== undefined && depth < 8; depth += 1) {
        if (current.type === 'VariableDeclarator') {
          const id = current.id;
          return {
            name: id.type === 'Identifier' ? id.name : 'this schema',
            start: current.start,
            end: current.end,
          };
        }
        if (current.type === 'PropertyDefinition' || current.type === 'Property') {
          const key = current.key;
          return {
            name: key.type === 'Identifier' ? key.name : 'this schema',
            start: current.start,
            end: current.end,
          };
        }
        current = current.parent;
      }
      return { name: 'this schema', start: node.start, end: node.end };
    };

    return {
      VariableDeclarator(node) {
        if (node.init === null || node.init === undefined) return;
        const id = node.id;
        if (id.type !== 'Identifier') return;
        const annotation = id.typeAnnotation;
        if (annotation === null || annotation === undefined) return;
        const match = codecAnnotation(annotation.typeAnnotation);
        if (match === null) return;
        if (options.requireSchemaInitializer) {
          if (node.init === null || node.init === undefined) return;
          if (!isSchemaExpression(node.init, 0)) return;
        }
        annotatedOwners.add(node.start);
        candidates.push({
          node: annotation.typeAnnotation,
          ownerStart: node.start,
          ownerEnd: node.end,
          messageId: 'annotation',
          name: id.name,
          annotation: match.annotation,
          type: match.type,
        });
      },
      TSSatisfiesExpression(node) {
        if (!options.checkSatisfies) return;
        const match = codecAnnotation(node.typeAnnotation);
        if (match === null) return;
        if (!isSchemaExpression(node.expression, 0)) return;
        const owner = ownerOf(node);
        if (annotatedOwners.has(owner.start)) return;
        candidates.push({
          node: node.typeAnnotation,
          ownerStart: owner.start,
          ownerEnd: owner.end,
          messageId: 'satisfies',
          name: owner.name,
          annotation: match.annotation,
          type: match.type,
        });
      },
      TSAsExpression(node) {
        if (!options.checkAsExpressions) return;
        const match = codecAnnotation(node.typeAnnotation);
        if (match === null) return;
        if (!isSchemaExpression(node.expression, 0)) return;
        const owner = ownerOf(node);
        if (annotatedOwners.has(owner.start)) return;
        candidates.push({
          node: node.typeAnnotation,
          ownerStart: owner.start,
          ownerEnd: owner.end,
          messageId: 'cast',
          name: owner.name,
          annotation: match.annotation,
          type: match.type,
        });
      },
      /** `<Schema.Codec<Foo>>Schema.Struct({...})` — the angle-bracket spelling of the same cast. */
      TSTypeAssertion(node) {
        if (!options.checkAsExpressions) return;
        const match = codecAnnotation(node.typeAnnotation);
        if (match === null) return;
        if (!isSchemaExpression(node.expression, 0)) return;
        const owner = ownerOf(node);
        if (annotatedOwners.has(owner.start)) return;
        candidates.push({
          node: node.typeAnnotation,
          ownerStart: owner.start,
          ownerEnd: owner.end,
          messageId: 'cast',
          name: owner.name,
          annotation: match.annotation,
          type: match.type,
        });
      },
      /**
       * `class Repo { private readonly rows: Schema.Codec<Row> = Schema.Struct({...}) }`. The Schema
       * initializer is mandatory here, so a bare `Schema.Codec<unknown>` field that is *assigned* a
       * caller-provided codec (the blessed generic shape) is never reported.
       */
      PropertyDefinition(node) {
        if (!options.checkClassProperties) return;
        const annotation = node.typeAnnotation;
        if (annotation === null || annotation === undefined) return;
        const value = node.value;
        if (value === null || value === undefined) return;
        if (!isSchemaExpression(value, 0)) return;
        const match = codecAnnotation(annotation.typeAnnotation);
        if (match === null) return;
        const key = node.key;
        const name =
          key.type === 'Identifier'
            ? key.name
            : key.type === 'PrivateIdentifier'
              ? `#${key.name}`
              : 'this schema';
        annotatedOwners.add(node.start);
        candidates.push({
          node: annotation.typeAnnotation,
          ownerStart: node.start,
          ownerEnd: node.end,
          messageId: 'property',
          name,
          annotation: match.annotation,
          type: match.type,
        });
      },
      MemberExpression(node) {
        if (!options.allowSuspend) return;
        if (schemaMemberName(node) !== SUSPEND_MEMBER) return;
        suspendSpans.push({ start: node.start, end: node.end });
      },
      Identifier(node) {
        if (!options.allowSuspend || suspendLocals.size === 0) return;
        if (!suspendLocals.has(node.name)) return;
        const parent = node.parent;
        if (parent === null || parent === undefined) return;
        if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier') return;
        if (parent.type === 'ImportNamespaceSpecifier' || parent.type === 'ExportSpecifier') return;
        if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
          return;
        if (!resolvesToImport(context, node)) return;
        suspendSpans.push({ start: node.start, end: node.end });
      },
      'Program:exit'() {
        for (const candidate of candidates) {
          const recursive = suspendSpans.some(
            (span) => span.start >= candidate.ownerStart && span.end <= candidate.ownerEnd,
          );
          if (recursive) continue;
          context.report({
            node: candidate.node,
            messageId: candidate.messageId,
            data: { name: candidate.name, annotation: candidate.annotation, type: candidate.type },
          });
        }
      },
    };
  },
});
