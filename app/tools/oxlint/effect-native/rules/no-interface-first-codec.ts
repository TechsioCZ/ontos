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
import type { Context, ESTree } from '@oxlint/plugins';

import {
  memberName,
  typeNameSegments,
  unwrapNode as unwrapExpression,
} from '../shared/ast.ts';
import { lookupVariable, resolvesToImport } from '../shared/bindings.ts';
import {
  collectEffectBindings,
  effectMember,
} from '../shared/effect-imports.ts';
import { collectSchemaLocals } from '../shared/imports.ts';
import { optionRecord } from '../shared/options.ts';
import { booleanOption as boolean, stringArray } from '../shared/options.ts';
import { isTestFile, scopePath, matchesGlobs } from '../shared/paths.ts';
import { isNonReferencePosition } from '../shared/reference-positions.ts';

const SCHEMA_NAMESPACE = 'Schema';

const DEFAULT_INCLUDE = [
  'apps/**',
  'verticals/**',
  'packages/**',
  'scripts/**',
];

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

function readOptions(context: Context) {
  const record = optionRecord(context.options?.[0]);
  return {
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    ignoreTests: boolean(record.ignoreTests, false),
    allowSuspend: boolean(record.allowSuspend, true),
    codecTypes: stringArray(record.codecTypes, DEFAULT_CODEC_TYPES),
    ignoreTypeArguments: stringArray(
      record.ignoreTypeArguments,
      DEFAULT_IGNORE_TYPE_ARGUMENTS
    ),
    requireTypeArguments: boolean(record.requireTypeArguments, true),
    allowDerivedTypeArguments: boolean(record.allowDerivedTypeArguments, true),
    requireSchemaInitializer: boolean(record.requireSchemaInitializer, false),
    checkSatisfies: boolean(record.checkSatisfies, true),
    checkAsExpressions: boolean(record.checkAsExpressions, true),
    checkClassProperties: boolean(record.checkClassProperties, true),
    reexportModules: stringArray(
      record.reexportModules,
      DEFAULT_REEXPORT_MODULES
    ),
  };
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
    const locals = collectSchemaLocals(
      program,
      bindings,
      options.reexportModules
    );
    if (
      locals.schema.size === 0 &&
      locals.barrel.size === 0 &&
      locals.direct.size === 0
    )
      return {};

    const codecTypeLocals = new Set(
      [...locals.direct]
        .filter(([, imported]) => options.codecTypes.includes(imported))
        .map(([local]) => local)
    );
    const suspendLocals = new Set(
      [...locals.direct]
        .filter(([, imported]) => imported === SUSPEND_MEMBER)
        .map(([local]) => local)
    );

    const candidates: Candidate[] = [];
    const suspendSpans: Array<{ start: number; end: number }> = [];
    /** Declarator starts that already reported through their own annotation, to avoid double reports. */
    const annotatedOwners = new Set<number>();

    /** Strip type-level parentheses so `(Schema.Codec<Foo>)` behaves like the bare reference. */
    const unwrapType = (type: ESTree.TSType): ESTree.TSType => {
      let current = type;
      while (current.type === 'TSParenthesizedType')
        current = current.typeAnnotation;
      return current;
    };

    /** `Schema.X` / `S.X` / `Effect.Schema.X` / `Schema["X"]`, with the shared `effectMember` matcher first. */
    const schemaMemberName = (node: ESTree.MemberExpression): string | null => {
      const viaShared = effectMember(node, bindings);
      if (viaShared !== null && viaShared.namespace === SCHEMA_NAMESPACE) {
        if (
          node.object.type === 'Identifier' &&
          !resolvesToImport(context, node.object)
        )
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
      return barrelMemberName(object, member);
    };

    const barrelMemberName = (
      object: ESTree.Node,
      member: string
    ): string | null => {
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
        return (
          bindings.namespaces.get(callee.name) === PIPE_MEMBER ||
          callee.name === PIPE_MEMBER
        );
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
    const isSchemaExpression = (
      expression: ESTree.Node,
      depth: number
    ): boolean => {
      if (depth > 12) return false;
      const current = unwrapExpression(expression);
      if (current.type === 'Identifier') {
        return (
          locals.direct.has(current.name) && resolvesToImport(context, current)
        );
      }
      if (current.type === 'MemberExpression')
        return schemaMemberName(current) !== null;
      if (current.type !== 'CallExpression' && current.type !== 'NewExpression')
        return false;
      return isSchemaCall(current, depth);
    };

    const isSchemaCall = (
      current: ESTree.CallExpression | ESTree.NewExpression,
      depth: number
    ): boolean => {
      const callee = unwrapExpression(current.callee);
      // ANY instance-method chain, not just `.pipe`: Effect v4 Schemas carry `.annotate(...)`,
      // `.check(...)`, `.pipe(...)` and friends, so the receiver — never the method name — decides.
      if (
        callee.type === 'MemberExpression' &&
        isSchemaExpression(callee.object, depth + 1)
      )
        return true;
      if (isSchemaExpression(callee, depth + 1)) return true;
      if (isPipeCallee(callee)) {
        return current.arguments.some(
          (argument) =>
            argument.type !== 'SpreadElement' &&
            isSchemaExpression(argument, depth + 1)
        );
      }
      return false;
    };

    /** Printed annotation, collapsed to one line and clipped so diagnostics stay readable. */
    const printed = (node: ESTree.Node): string => {
      const text = context.sourceCode
        .getText(node)
        .replace(/\s+/gu, ' ')
        .trim();
      return text.length > 80 ? `${text.slice(0, 77)}...` : text;
    };

    /** Follow same-file type aliases by scope, never by a file-wide name table. */
    const derivedOrGeneric = (
      type: ESTree.TSType,
      seen = new Set<ESTree.Node>()
    ): boolean => {
      const current = unwrapType(type);
      if (seen.has(current) || seen.size > 24) return false;
      seen.add(current);
      if (options.allowDerivedTypeArguments && current.type === 'TSTypeQuery')
        return true;
      if (current.type !== 'TSTypeReference') return false;
      const named = namedDerivation(current, seen);
      if (named !== null) return named;
      return derivedArguments(current, seen);
    };

    const derivedArguments = (
      current: ESTree.TSTypeReference,
      seen: Set<ESTree.Node>
    ): boolean => {
      // Schema.Type<typeof S>, ReturnType<typeof factory>, etc. remain derived rather than
      // introducing a shape of their own. Mixed handwritten arguments are not waived.
      const arguments_ = current.typeArguments?.params ?? [];
      return (
        options.allowDerivedTypeArguments &&
        arguments_.length > 0 &&
        arguments_.every((argument) =>
          derivedOrGeneric(argument, new Set(seen))
        )
      );
    };

    const enclosingParameter = (
      current: ESTree.Node,
      name: string
    ): boolean => {
      let ancestor = current.parent;
      while (ancestor != null) {
        const parameters = (
          ancestor as {
            typeParameters?: ESTree.TSTypeParameterDeclaration | null;
          }
        ).typeParameters;
        if (
          parameters?.params.some((parameter) => parameter.name.name === name)
        )
          return true;
        ancestor = ancestor.parent;
      }
      return false;
    };

    const namedDerivation = (
      current: ESTree.TSTypeReference,
      seen: Set<ESTree.Node>
    ): boolean | null => {
      if (current.typeName.type !== 'Identifier') return null;
      const variable = lookupVariable(context, current.typeName);
      if (variable === null)
        return enclosingParameter(current, current.typeName.name) ? true : null;
      for (const definition of variable.defs) {
        const declaration = definition.node as ESTree.Node;
        if (declaration.type === 'TSTypeParameter') return true;
        if (declaration.type === 'TSTypeAliasDeclaration') {
          return (
            options.allowDerivedTypeArguments &&
            derivedOrGeneric(declaration.typeAnnotation, seen)
          );
        }
      }
      if (variable.defs.length > 0) return null;
      return enclosingParameter(current, current.typeName.name) ? true : null;
    };

    const isCodecName = (segments: readonly string[]): boolean => {
      const root = segments[0] ?? '';
      if (segments.length === 1) return codecTypeLocals.has(root);
      const member = segments.at(-1) ?? '';
      if (!options.codecTypes.includes(member)) return false;
      if (segments.length === 2) return locals.schema.has(root);
      return (
        segments.length === 3 &&
        locals.barrel.has(root) &&
        segments[1] === SCHEMA_NAMESPACE
      );
    };

    /**
     * When the annotation is an Effect Schema codec type applied to a prior type, return its
     * printed form and the printed first type argument. `null` means "not an authority conflict".
     */
    const codecAnnotation = (
      type: ESTree.TSType
    ): { annotation: string; type: string } | null => {
      const reference = unwrapType(type);
      if (reference.type !== 'TSTypeReference') return null;
      const segments = typeNameSegments(reference.typeName);
      if (segments === null || segments.length === 0) return null;
      const member = segments[segments.length - 1] ?? '';
      if (!isCodecName(segments)) return null;

      return codecArguments(reference, member);
    };

    const codecArguments = (
      reference: ESTree.TSTypeReference,
      member: string
    ): { annotation: string; type: string } | null => {
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
    const ownerOf = (
      node: ESTree.Node
    ): { name: string; start: number; end: number } => {
      let current: ESTree.Node | null | undefined = node;
      for (
        let depth = 0;
        current !== null && current !== undefined && depth < 8;
        depth += 1
      ) {
        if (current.type === 'VariableDeclarator') {
          const id = current.id;
          return {
            name: id.type === 'Identifier' ? id.name : 'this schema',
            start: current.start,
            end: current.end,
          };
        }
        if (
          current.type === 'PropertyDefinition' ||
          current.type === 'Property'
        ) {
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

    const collectExpressionCandidate = (
      node:
        | ESTree.TSSatisfiesExpression
        | ESTree.TSAsExpression
        | ESTree.TSTypeAssertion,
      messageId: 'satisfies' | 'cast'
    ): void => {
      const match = codecAnnotation(node.typeAnnotation);
      if (match === null || !isSchemaExpression(node.expression, 0)) return;
      const owner = ownerOf(node);
      if (annotatedOwners.has(owner.start)) return;
      candidates.push({
        node: node.typeAnnotation,
        ownerStart: owner.start,
        ownerEnd: owner.end,
        messageId,
        name: owner.name,
        annotation: match.annotation,
        type: match.type,
      });
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
        if (
          options.requireSchemaInitializer &&
          !isSchemaExpression(node.init, 0)
        )
          return;
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
        if (options.checkSatisfies)
          collectExpressionCandidate(node, 'satisfies');
      },
      TSAsExpression(node) {
        if (options.checkAsExpressions)
          collectExpressionCandidate(node, 'cast');
      },
      TSTypeAssertion(node) {
        if (options.checkAsExpressions)
          collectExpressionCandidate(node, 'cast');
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
        if (isNonReferencePosition(node, { keyParents: new Set() })) return;
        if (!resolvesToImport(context, node)) return;
        suspendSpans.push({ start: node.start, end: node.end });
      },
      'Program:exit'() {
        for (const candidate of candidates) {
          const recursive = suspendSpans.some(
            (span) =>
              span.start >= candidate.ownerStart &&
              span.end <= candidate.ownerEnd
          );
          if (recursive) continue;
          context.report({
            node: candidate.node,
            messageId: candidate.messageId,
            data: {
              name: candidate.name,
              annotation: candidate.annotation,
              type: candidate.type,
            },
          });
        }
      },
    };
  },
});
