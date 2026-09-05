/**
 * effect-native/no-hand-rolled-tagged-union
 *
 * Audit findings: **A2** ("Make Schema the sole authority for contracts and domain models"),
 * **B5** ("Adopt Effect's ADTs and temporal model consistently") and **C2** ("Replace raw Option,
 * Exit, and `_tag` inspection") of `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`.
 *
 * A2 records "approximately 119 `Schema.Codec<Interface>`-style declarations" and names
 * `packages/shared-contracts/src/gateway-context.ts`, `apps/shell-super-app/shared/api.ts`
 * (21 hand-written `Problem` interfaces) and
 * `verticals/contacts/src/services/customer-contact-persistence.service.ts` (`LookupResult` /
 * `LifecycleResult`) as the load-bearing examples: a discriminated union is declared as a plain
 * TypeScript interface / type alias carrying a literal `_tag`, and a Schema is then annotated to
 * match it. That makes the hand-written type a second authority, and it forces the `_tag ===`
 * comparisons and non-exhaustive switches counted by A4/C2. B5 adds that absence and outcomes
 * belong to `Option` / `Result` rather than a bespoke `{ _tag: 'found' } | { _tag: 'not_found' }`.
 *
 * ## What this detects
 *
 * A `TSPropertySignature` whose key is one of `discriminantKeys` (default `_tag`) and whose
 * annotation is a string-literal type, or a union of string-literal types, when the enclosing
 * object type is the body of a `TSInterfaceDeclaration` or the annotation of a
 * `TSTypeAliasDeclaration`. The declaration is reached through *transparent* type structure only:
 *
 * - `interface P extends ProblemDetails { readonly _tag: 'P' }`;
 * - `type R = Readonly<{ readonly _tag: 'found'; value: V }> | Readonly<{ readonly _tag: 'gone' }>`
 *   — unions, intersections, parentheses, `readonly` operators, array types and the transparent
 *   generic wrappers in `wrapperTypes` (`Readonly`, `ReadonlyArray`, `Array`, `NonNullable`, plus
 *   Effect's `Simplify`/`Mutable` when the qualifier really is an `effect` import binding);
 * - nested object types reached through an enclosing property signature (`includeNestedTypes`),
 *   e.g. `interface Envelope { readonly outcome: { readonly _tag: 'ok' } | { readonly _tag: 'err' } }`;
 * - string-literal *unions* as the tag (`readonly _tag: 'draft' | 'live'`), which is a closed
 *   vocabulary that belongs to `Schema.Literal` / `Schema.TaggedStruct`;
 * - tuple element positions (`readonly [{ readonly _tag: 'left' }, …]`, named/optional/rest members),
 *   which are exactly as transparent as the array types already walked;
 * - the heritage spelling of a transparent wrapper,
 *   `interface H extends Readonly<{ readonly _tag: 'H' }> {}`, which is the same declaration as
 *   `type H = Readonly<{ readonly _tag: 'H' }>`;
 * - a *no-substitution template literal* as the tag (`` readonly _tag: `Found` ``): that is the same
 *   TypeScript type as `'Found'`, so the quote style must not change the verdict;
 * - `.ts`, `.mts` and `.tsx` alike, and test files as well as source (the audit's `_tag` findings
 *   include the test-side duplication) unless `ignoreTests` is set.
 *
 * It also detects the **class** spelling of the same second authority (`includeClassFields`,
 * default on): a `PropertyDefinition` / `TSAbstractPropertyDefinition` keyed `_tag` whose initialiser
 * is a string literal (`= 'X'`, `= 'X' as const`, `` = `X` ``) or whose annotation is a string-literal
 * type (`abstract readonly _tag: 'X'`), inside a class whose base is *not* resolved through an
 * `effect` import binding. `packages/core-runtime/src/actions/runtime.ts` declares
 * `class TransactionBridgeFailure { readonly _tag = 'TransactionBridgeFailure' }` beside interfaces
 * this rule already reports in the same file; the recommended replacement (Schema.TaggedClass /
 * Data.TaggedError) is the same one the message names.
 *
 * ## What is deliberately allowed
 *
 * - Anything reached through a *non*-transparent type reference — most importantly the audit's own
 *   Effect-native narrowing idiom `Extract<ContactsProblem, { readonly _tag: 'ContactsInternalProblem' }>`
 *   (and `Exclude`/`Omit`/`Pick`/`Schema.Codec<…>`/`Schema.Schema.Type<…>`): the object type there is
 *   a *query against* an existing union, not a second declaration of it. `TSConditionalType`,
 *   `TSInferType`, `TSMappedType`, function/constructor types, generic parameter constraints and
 *   defaults, variable annotations and value positions are all outside the walk and never report.
 * - `readonly _tag: string` (and any non-literal annotation such as a bare type reference or a
 *   template-literal type): that is a structural constraint, not a declared tagged-union member.
 * - Value-position object literals (`{ _tag: 'ShellRateLimitedProblem', status: 429 }`) — those are
 *   constructions of an existing contract and are covered by other findings, not by this rule.
 * - Schema-first declarations, which contain no `_tag` property signature at all:
 *   `class P extends Schema.TaggedError<P>()('P', { … }) {}`,
 *   `const P = Schema.TaggedStruct('P', { … })`, `type P = Schema.Schema.Type<typeof P>`. A class
 *   whose base resolves through a tracked `effect` binding (`Schema.TaggedError`, `Data.TaggedClass`,
 *   `Schema.Class`, a bare `TaggedError` imported from `effect/Data`) never reports, even if it
 *   redeclares `_tag`; a same-named *local* helper base stays in scope.
 * - *Derived* template tags with substitutions (`` readonly _tag: `contacts/${string}` ``) and
 *   `typeof`-sourced tags: the literal set still lives wherever it was produced.
 * - Ambient declarations and `.d.ts` / `.d.mts` / `.d.cts` contracts. They describe another
 *   authority, not a runtime definition we can replace with Schema. Plain first-party namespaces
 *   still report. This narrows the earlier specification's ambient probes to A2's owned models.
 * - Anything outside `include` (`apps/**`, `verticals/**`, `packages/**`, `scripts/**`) or matching
 *   `ignore`.
 *
 * Report-only: no fixer, no suggestion. Existing violations are the intended output.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree } from '@oxlint/plugins';

import { collectEffectBindings } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production `include` defaults instead of
 * forcing the fixture config to pass loosened options (which `run-on-repo.mts` reuses).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_DISCRIMINANT_KEYS: readonly string[] = ['_tag'];

const DEFAULT_INCLUDE: readonly string[] = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];

const DEFAULT_IGNORE: readonly string[] = [];

/**
 * Generic type references that are *transparent*: `Wrapper<{ _tag: 'x' }>` still declares the tagged
 * shape rather than querying an existing one. Everything not listed here (`Extract`, `Exclude`,
 * `Omit`, `Pick`, `Schema.Codec`, …) stops the walk, which is what keeps the audit-blessed
 * `Extract<Problem, { readonly _tag: '…' }>` narrowing quiet.
 */
const DEFAULT_WRAPPER_TYPES: readonly string[] = [
  'Readonly',
  'ReadonlyArray',
  'Array',
  'NonNullable',
  'Simplify',
  'Mutable',
];

/** Depth guard for the ancestor walk; real type nesting never approaches this. */
const MAX_ANCESTOR_DEPTH = 64;

interface RuleOptions {
  readonly discriminantKeys: readonly string[];
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly ignoreTests: boolean;
  readonly wrapperTypes: readonly string[];
  readonly includeNestedTypes: boolean;
  readonly includeClassFields: boolean;
  readonly ignoreAmbient: boolean;
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
    discriminantKeys: stringArray(record.discriminantKeys, DEFAULT_DISCRIMINANT_KEYS),
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    ignoreTests: record.ignoreTests === true,
    wrapperTypes: stringArray(record.wrapperTypes, DEFAULT_WRAPPER_TYPES),
    includeNestedTypes: record.includeNestedTypes !== false,
    includeClassFields: record.includeClassFields !== false,
    ignoreAmbient: record.ignoreAmbient !== false,
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Static string name of a property-signature key (`_tag`, `"_tag"`, `["_tag"]`). */
function propertyKeyName(node: ESTree.TSPropertySignature): string | null {
  const key = node.key;
  if (key.type === 'Identifier') return node.computed ? null : key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

/**
 * The cooked text of a template literal that has *no* substitutions — `` `Found` `` is exactly the
 * same TypeScript type as `'Found'`, so swapping the quote style must not defeat the rule. A
 * template with substitutions (`` `contacts/${string}` ``) is a *derived* tag and returns `null`.
 */
function noSubstitutionTemplate(
  quasis: readonly ESTree.TemplateElement[],
  substitutions: number,
): string | null {
  if (substitutions !== 0 || quasis.length !== 1) return null;
  const only = quasis[0];
  if (only === undefined) return null;
  return only.value.cooked ?? only.value.raw;
}

/**
 * The string literals a tag annotation declares: `'found'` → `["found"]`,
 * `'draft' | 'live'` → `["draft", "live"]`, `` `found` `` → `["found"]`. `null` for anything that is
 * not a closed set of string literals (`string`, a type reference, a *substituting* template-literal
 * type, a generic parameter, …).
 */
function tagLiterals(type: ESTree.Node): readonly string[] | null {
  if (type.type === 'TSParenthesizedType') return tagLiterals(type.typeAnnotation);
  if (type.type === 'TSLiteralType') {
    const literal = type.literal;
    if (literal.type === 'Literal')
      return typeof literal.value === 'string' ? [literal.value] : null;
    // oxc parses a no-substitution template in type position as a `TemplateLiteral` literal.
    if (literal.type === 'TemplateLiteral') {
      const cooked = noSubstitutionTemplate(literal.quasis, literal.expressions.length);
      return cooked === null ? null : [cooked];
    }
    return null;
  }
  // Belt and braces: some parses spell the same thing as a zero-substitution template-literal type.
  if (type.type === 'TSTemplateLiteralType') {
    const cooked = noSubstitutionTemplate(type.quasis, type.types.length);
    return cooked === null ? null : [cooked];
  }
  if (type.type === 'TSUnionType') {
    const values: string[] = [];
    for (const member of type.types) {
      const nested = tagLiterals(member);
      if (nested === null) return null;
      values.push(...nested);
    }
    return values.length > 0 ? values : null;
  }
  return null;
}

/** `Readonly` → `{ name: "Readonly", qualifier: null }`; `Types.Simplify` → `{ …, qualifier: "Types" }`. */
function referenceName(
  node: ESTree.TSTypeReference,
): { name: string; qualifier: string | null } | null {
  const typeName = node.typeName;
  if (typeName.type === 'Identifier') return { name: typeName.name, qualifier: null };
  if (typeName.type !== 'TSQualifiedName') return null;
  let root: ESTree.Node = typeName.left;
  while (root.type === 'TSQualifiedName') root = root.left;
  if (root.type !== 'Identifier') return null;
  return { name: typeName.right.name, qualifier: root.name };
}

/**
 * `true` for `Readonly<…>`-style wrappers that do not change the fact that the inner object type is
 * *declared* here. A qualified wrapper (`Types.Simplify<…>`) is only transparent when its qualifier
 * is a tracked `effect` / `effect/*` namespace binding, so a same-named local helper stays opaque.
 */
function isTransparentWrapper(
  node: ESTree.TSTypeReference,
  options: RuleOptions,
  bindings: EffectBindings,
): boolean {
  const reference = referenceName(node);
  if (reference === null) return false;
  if (!options.wrapperTypes.includes(reference.name)) return false;
  return reference.qualifier === null || bindings.namespaces.has(reference.qualifier);
}

/**
 * `interface P extends Readonly<{ readonly _tag: 'P' }> {}` is the heritage spelling of
 * `type P = Readonly<{ readonly _tag: 'P' }>` and must behave identically. A heritage clause carries
 * an *expression* rather than a type name, so resolve `Readonly` / `Types.Simplify` from it.
 */
function isTransparentHeritage(
  node: ESTree.TSInterfaceHeritage,
  options: RuleOptions,
  bindings: EffectBindings,
): boolean {
  const resolved = expressionReferenceName(node.expression);
  if (resolved === null) return false;
  if (!options.wrapperTypes.includes(resolved.name)) return false;
  return resolved.qualifier === null || bindings.namespaces.has(resolved.qualifier);
}

/** `Readonly` / `Types.Simplify` written as an expression (heritage clauses, `extends` bases). */
function expressionReferenceName(
  node: ESTree.Node,
): { name: string; qualifier: string | null } | null {
  if (node.type === 'Identifier') return { name: node.name, qualifier: null };
  if (node.type !== 'MemberExpression' || node.computed) return null;
  if (node.property.type !== 'Identifier') return null;
  let root: ESTree.Node = node.object;
  while (root.type === 'MemberExpression') root = root.object;
  if (root.type !== 'Identifier') return null;
  return { name: node.property.name, qualifier: root.name };
}

/**
 * Walk from the property signature outwards through transparent type structure only. Returns the
 * name of the owning `interface` / `type` declaration when the tag is *declared* there, otherwise
 * `null` (the signature belongs to a query, a conditional, a generic constraint, a function
 * signature, a value annotation, … and must not report).
 */
function owningDeclaration(
  signature: ESTree.TSPropertySignature,
  options: RuleOptions,
  bindings: EffectBindings,
): string | null {
  let previous: ESTree.Node = signature;
  let current: ESTree.Node | null | undefined = signature.parent;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    if (current === null || current === undefined) return null;
    switch (current.type) {
      case 'TSInterfaceDeclaration':
        // Either the interface body itself, or an `extends Readonly<{ … }>` heritage clause that the
        // `TSTypeParameterInstantiation` arm below already proved transparent.
        if (current.body === previous) return current.id.name;
        return previous.type === 'TSInterfaceHeritage' ? current.id.name : null;
      case 'TSTypeAliasDeclaration':
        return current.typeAnnotation === previous ? current.id.name : null;
      case 'TSInterfaceBody':
      case 'TSTypeLiteral':
      case 'TSUnionType':
      case 'TSIntersectionType':
      case 'TSParenthesizedType':
      case 'TSArrayType':
      case 'TSTupleType':
      case 'TSNamedTupleMember':
      case 'TSOptionalType':
      case 'TSRestType':
      case 'TSInterfaceHeritage':
      case 'TSTypeReference':
        break;
      case 'TSTypeOperator':
        if (current.operator !== 'readonly') return null;
        break;
      case 'TSTypeAnnotation':
        if (current.typeAnnotation !== previous) return null;
        break;
      case 'TSPropertySignature':
        if (!options.includeNestedTypes) return null;
        break;
      case 'TSTypeParameterInstantiation': {
        const owner = current.parent;
        if (owner === null || owner === undefined) return null;
        if (owner.type === 'TSTypeReference') {
          if (!isTransparentWrapper(owner, options, bindings)) return null;
          break;
        }
        if (owner.type === 'TSInterfaceHeritage') {
          if (!isTransparentHeritage(owner, options, bindings)) return null;
          break;
        }
        return null;
      }
      default:
        return null;
    }
    previous = current;
    current = current.parent;
  }
  return null;
}

/** Static string name of a class member key (`_tag`, `"_tag"`), or `null` for computed/private keys. */
function classKeyName(node: ESTree.PropertyDefinition): string | null {
  if (node.computed) return null;
  const key = node.key;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

/**
 * The tag a class *field initialiser* declares: `= 'X'`, `= 'X' as const`, `` = `X` ``.
 * `null` when the initialiser is anything else (a parameter, a computed value, a call, …).
 */
function initialiserTag(node: ESTree.Node): string | null {
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression')
    return initialiserTag(node.expression);
  if (node.type === 'ParenthesizedExpression' || node.type === 'TSNonNullExpression')
    return initialiserTag(node.expression);
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null;
  if (node.type === 'TemplateLiteral')
    return noSubstitutionTemplate(node.quasis, node.expressions.length);
  return null;
}

/** The enclosing `class` of a class member, or `null`. */
function enclosingClass(node: ESTree.PropertyDefinition): ESTree.Class | null {
  const body = node.parent;
  if (body === null || body === undefined || body.type !== 'ClassBody') return null;
  const owner = body.parent;
  if (owner === null || owner === undefined) return null;
  if (owner.type !== 'ClassDeclaration' && owner.type !== 'ClassExpression') return null;
  return owner;
}

/**
 * `true` when the class already derives its discriminant from Effect — `class P extends
 * Schema.TaggedError<P>()('P', { … })`, `class P extends Data.TaggedClass('P')<{ … }>`,
 * `class P extends Schema.Class<P>()('P', { … })`. Those generate `_tag` themselves and are the
 * *blessed* form; only a base resolved through a tracked `effect` / `effect/*` binding counts, so a
 * same-named local helper class stays in scope.
 */
function derivesFromEffectBase(node: ESTree.Class, bindings: EffectBindings): boolean {
  let base: ESTree.Node | null | undefined = node.superClass;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    if (base === null || base === undefined) return false;
    if (base.type === 'CallExpression' || base.type === 'NewExpression') {
      base = base.callee;
      continue;
    }
    if (
      base.type === 'TSInstantiationExpression' ||
      base.type === 'ParenthesizedExpression' ||
      base.type === 'TSNonNullExpression' ||
      base.type === 'TSAsExpression'
    ) {
      base = base.expression;
      continue;
    }
    const resolved = expressionReferenceName(base);
    if (resolved === null) return false;
    // `Schema.TaggedError` / `Data.TaggedClass` (qualifier is the binding) or a bare
    // `TaggedError` imported straight from `effect/Data` (the name itself is the binding).
    const owner = resolved.qualifier ?? resolved.name;
    return bindings.namespaces.has(owner);
  }
  return false;
}

/** Ambient contracts describe externally owned values; A2 cannot replace them with runtime schemas. */
function isAmbient(node: ESTree.Node): boolean {
  let current: ESTree.Node | null | undefined = node;
  while (current != null && current.type !== 'Program') {
    if ((current as { declare?: boolean }).declare === true) return true;
    if (current.type === 'TSModuleDeclaration') {
      if (
        current.kind === 'global' ||
        (current.id.type === 'Literal' && typeof current.id.value === 'string')
      )
        return true;
    }
    current = current.parent;
  }
  return false;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A2 + B5 + C2: a discriminated union must be declared once, by Schema. A TypeScript ' +
        'interface or type alias carrying a literal `_tag` is a second authority beside the Schema that ' +
        'is annotated to match it; declare it with Schema.TaggedStruct/TaggedError/TaggedClass and derive ' +
        'the type, and model absence with Option and outcomes with Result or typed failures.',
    },
    messages: {
      handRolledTag:
        'Hand-written tagged union member `{{key}}: {{tag}}` in `{{owner}}` is a second authority beside ' +
        'Schema. Declare this case with Schema.TaggedStruct / Schema.TaggedError / Schema.TaggedClass and ' +
        'derive the TypeScript type from it (`Schema.Schema.Type<typeof …>`) instead of annotating a Schema ' +
        'to match a prior interface; model absence with Option and outcomes with Result or typed failures, ' +
        'and narrow with Effect.catchTag(s) or exhaustive Match instead of comparing `{{key}}`.',
      handRolledClassTag:
        'Hand-written tagged union member `{{key}} = {{tag}}` on class `{{owner}}` is a second authority ' +
        'beside Schema: the class declares the discriminant itself instead of deriving it. Extend ' +
        'Schema.TaggedError / Schema.TaggedClass (or Data.TaggedError for a non-serialised failure) so the ' +
        'tag and its payload come from one Schema, and narrow with Effect.catchTag(s) or exhaustive Match ' +
        'instead of comparing `{{key}}`.',
      handRolledTagUnion:
        'Hand-written tagged union member `{{key}}: {{tag}}` in `{{owner}}` declares a closed vocabulary ' +
        'outside Schema. Own it with Schema.Literal inside a Schema.TaggedStruct / Schema.TaggedError / ' +
        'Schema.TaggedClass and derive the TypeScript type from that Schema; model absence with Option and ' +
        'outcomes with Result or typed failures, and branch with exhaustive Match instead of comparing ' +
        '`{{key}}`.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          discriminantKeys: { type: 'array', items: { type: 'string' } },
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          ignoreTests: { type: 'boolean' },
          wrapperTypes: { type: 'array', items: { type: 'string' } },
          includeNestedTypes: { type: 'boolean' },
          includeClassFields: { type: 'boolean' },
          ignoreAmbient: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        discriminantKeys: [...DEFAULT_DISCRIMINANT_KEYS],
        include: [...DEFAULT_INCLUDE],
        ignore: [...DEFAULT_IGNORE],
        ignoreTests: false,
        wrapperTypes: [...DEFAULT_WRAPPER_TYPES],
        includeNestedTypes: true,
        includeClassFields: true,
        ignoreAmbient: true,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore)) return {};
    if (!matchesGlobs(path, options.include)) return {};
    if (options.ignoreTests && isTestFile(path)) return {};
    if (options.discriminantKeys.length === 0) return {};
    if (options.ignoreAmbient && /\.d\.[cm]?ts$/u.test(path)) return {};

    let bindings: EffectBindings = { namespaces: new Map<string, string>(), importsEffect: false };

    function reportClassField(node: ESTree.PropertyDefinition): void {
      if (!options.includeClassFields || (options.ignoreAmbient && isAmbient(node))) return;
      const key = classKeyName(node);
      if (key === null || !options.discriminantKeys.includes(key)) return;
      const annotation = node.typeAnnotation;
      const literals =
        annotation === null || annotation === undefined
          ? ((): readonly string[] | null => {
              if (node.value === null || node.value === undefined) return null;
              const tag = initialiserTag(node.value);
              return tag === null ? null : [tag];
            })()
          : tagLiterals(annotation.typeAnnotation);
      if (literals === null) return;
      const owner = enclosingClass(node);
      if (owner === null) return;
      // A Schema/Data-derived class already owns `_tag`; only hand-rolled bases report.
      if (derivesFromEffectBase(owner, bindings)) return;
      context.report({
        node,
        messageId: 'handRolledClassTag',
        data: {
          key,
          owner: owner.id?.name ?? '(anonymous class)',
          tag: literals.map((literal) => `'${literal}'`).join(' | '),
        },
      });
    }

    return {
      Program(node) {
        bindings = collectEffectBindings(node);
      },

      // `class P { readonly _tag = 'P' }` is the class spelling of the same second authority; the
      // rule's own message points at Schema.TaggedClass, so it is in scope.
      PropertyDefinition: reportClassField,
      // `abstract class P { abstract readonly _tag: 'P' }` — same node shape, separate visitor key.
      TSAbstractPropertyDefinition: reportClassField,

      TSPropertySignature(node) {
        if (options.ignoreAmbient && isAmbient(node)) return;
        const key = propertyKeyName(node);
        if (key === null || !options.discriminantKeys.includes(key)) return;
        const annotation = node.typeAnnotation;
        if (annotation === null || annotation === undefined) return;
        const literals = tagLiterals(annotation.typeAnnotation);
        if (literals === null) return;
        const owner = owningDeclaration(node, options, bindings);
        if (owner === null) return;
        context.report({
          node,
          messageId: literals.length > 1 ? 'handRolledTagUnion' : 'handRolledTag',
          data: {
            key,
            owner,
            tag: literals.map((literal) => `'${literal}'`).join(' | '),
          },
        });
      },
    };
  },
});
