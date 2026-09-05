/**
 * Audit findings: **B5** — "Adopt Effect's ADTs and temporal model consistently" ("Closed
 * vocabularies and timestamps are repeatedly re-declared", "Highest-value targets are service
 * outcomes, persistence absence, closed status vocabularies, …") and **A2** — "Make Schema the sole
 * authority for contracts and domain models" ("Derive types from the Schema rather than annotating
 * the Schema with a prior interface"), both in
 * `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`.
 *
 * `export type ActionAuditProfile = 'minimal' | 'sensitive' | 'standard'`
 * (`packages/core-runtime/src/actions/definition.ts:21`) is a *second* authority for a vocabulary
 * that `packages/core-runtime/src/modules/manifest.ts:61` already owns as
 * `Schema.Literals(['minimal', 'sensitive', 'standard'])`. The two drift independently. Aliases like
 * `OutboxFailureStatus`, `ModuleStateDecision` and the route-local `UnavailableReason` copies have no
 * owning codec or runtime array to decode/iterate. Match can exhaust TypeScript literal unions,
 * but that alone does not provide a shared runtime vocabulary, so consumers re-type the same
 * strings by hand.
 *
 * The Effect-native form owns the vocabulary once and derives the type from it:
 *
 *     export const OutboxFailureStatus = Schema.Literals(['dead', 'pending']);
 *     export type OutboxFailureStatus = typeof OutboxFailureStatus.Type;
 *
 * What is detected
 * - A `TSTypeAliasDeclaration` **without type parameters** whose right-hand side is a `TSUnionType`
 *   made up exclusively of string-literal members, with at least `minMembers` (default 2) of them.
 * - "String-literal member" covers `'a'`, `"a"`, a `TSLiteralType` wrapping an expression-free
 *   template literal (`` `a` ``), and a `TSTemplateLiteralType` with no interpolations. Parenthesised
 *   members (`('a') | ('b')`) and nested unions are unwrapped first.
 * - `null` / `undefined` members are treated as noise (`ignoreNullishMembers`, default true), so
 *   `type Status = 'dead' | 'pending' | null` still reports: the Effect-native form is
 *   `Schema.NullOr(Schema.Literals([...]))`.
 * - Reported on the alias **name**, once per alias, in `.ts`, `.mts`, `.cts` and `.tsx` alike, in
 *   every configured scope (`apps/**`, `verticals/**`, `packages/**`, `scripts/**`), tests included
 *   (`ignoreTests` default false) — a hand-rolled test vocabulary is the same drift risk.
 * - A `TSEnumDeclaration` (`enum`/`const enum`) whose members **all** have string-literal
 *   initializers and number at least `minMembers` (`includeEnums`, default true). `type` -> `enum` is
 *   otherwise a free rewrite of the very same closed vocabulary, and the audit's report-only,
 *   no-suppressions policy means an evasion that cheap must be closed.
 * - When the same file already declares a *module-level* `const <Name> = Schema.Literals([...])` (or `Schema.Literal`)
 *   for the same vocabulary name, a sharper message is used: that is literally the B5 duplication.
 *   The `Schema` namespace is resolved through the shared `effect-imports` binding tracker, so
 *   aliased (`import { Schema as S }`) and submodule namespace (`import * as Schema from
 *   "effect/Schema"`) imports are recognised, and an unrelated local `Schema` object is not.
 *
 * What is deliberately allowed
 * - The blessed derivation itself: `type X = typeof XSchema.Type` (a `TSTypeQuery`, not a union) and
 *   `type Locale = (typeof LOCALES)[number]` (a `TSIndexedAccessType`). Neither is a union node.
 * - Unions that are not closed string vocabularies: tagged-error unions
 *   (`type ActionCoreError = ActionPolicyError | ActionCollectorError`), `'a' | number`,
 *   `'a' | (string & {})` autocomplete idioms, template types with interpolations
 *   (`` type Route = `/${string}` ``) — the audit's "do not mechanically replace every native
 *   `undefined`" caveat means a union that is not a closed vocabulary is not this finding.
 * - Generic aliases (`type Keys<T> = …`): the members are not a fixed vocabulary.
 * - Ambient declarations — `declare type …`, anything nested at any depth inside a `declare module` /
 *   `declare global` / `declare namespace` / `module 'name'` block, and `.d.ts` / `.d.mts` / `.d.cts`
 *   files (`ignoreAmbient`, default true). These describe code someone else owns (Module-Federation
 *   `@mf-types`, framework augmentation); they cannot be replaced by a codec. A *non*-ambient
 *   `namespace Foo { export type Status = 'a' | 'b' }` is our own code and is **not** exempt: oxc
 *   gives a plain namespace the same `TSModuleDeclaration` node as `declare module`, so only the
 *   `declare`/`global` flags (and a string module name) are treated as ambient — otherwise a single
 *   `namespace` keyword would silence this rule forever under the no-suppressions policy.
 * - Numeric and mixed `enum`s: their runtime values are not the vocabulary, so `Schema.Literals` is
 *   not the mechanical replacement.
 * - A function-local `const X = Schema.Literals([...])` never counts as the *owner* of a module-level
 *   alias: `type X = typeof X.Type` would not compile against a binding that is out of scope. Such
 *   aliases still report, with the generic message.
 * - Single-member aliases by default (`minMembers` 2): `type Kind = 'customer'` is a name, not a
 *   vocabulary. Set `minMembers: 1` to include them.
 * - `allowedNames` and `ignore` path globs: narrow, explicit escape hatches, both empty by default.
 *
 * Known limitation: with no type information this is a purely syntactic judgement. An alias whose
 * members are spelled through another alias (`type A = B | 'c'`) is not resolved and not reported.
 *
 * Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree } from '@oxlint/plugins';

import {
  collectEffectBindings,
  effectMember,
  type EffectBindings,
} from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production defaults instead of forcing the
 * fixture config to pass loosened options (which `run-on-repo.mts` reuses against the real repo).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

/** A2/B5 apply everywhere first-party TypeScript is authored. */
const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];

/** No blessed literal-union alias exists in the audit, so nothing is ignored by path by default. */
const DEFAULT_IGNORE: readonly string[] = [];

const DEFAULT_MIN_MEMBERS = 2;

const SCHEMA_NAMESPACE = 'Schema';

const SCHEMA_LITERAL_MEMBERS = new Set(['Literals', 'Literal']);

const DECLARATION_FILE = /\.d\.[cm]?ts$/u;

interface RuleOptions {
  readonly minMembers: number;
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly ignoreTests: boolean;
  readonly ignoreAmbient: boolean;
  readonly ignoreNullishMembers: boolean;
  readonly includeEnums: boolean;
  readonly allowedNames: readonly string[];
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : fallback;
}

function readOptions(context: Context): RuleOptions {
  const raw = context.options?.[0];
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    minMembers: positiveInteger(record.minMembers, DEFAULT_MIN_MEMBERS),
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    ignoreTests: boolean(record.ignoreTests, false),
    ignoreAmbient: boolean(record.ignoreAmbient, true),
    ignoreNullishMembers: boolean(record.ignoreNullishMembers, true),
    includeEnums: boolean(record.includeEnums, true),
    allowedNames: stringArray(record.allowedNames, []),
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

type AnyNode = Record<string, unknown> & { readonly type: string };

function asNode(value: unknown): AnyNode | null {
  return typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
    ? (value as AnyNode)
    : null;
}

/** Strip `TSParenthesizedType` wrappers (`('a') | ('b')`). */
function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (current.type === 'TSParenthesizedType') {
    const inner = asNode(current.typeAnnotation);
    if (inner === null) return current;
    current = inner;
  }
  return current;
}

/** The literal text of a string-literal type member, or `null` when the member is not one. */
function stringLiteralMember(node: AnyNode): string | null {
  if (node.type === 'TSLiteralType') {
    const literal = asNode(node.literal);
    if (literal === null) return null;
    if (literal.type === 'Literal' || literal.type === 'StringLiteral') {
      return typeof literal.value === 'string' ? literal.value : null;
    }
    // `` type A = `abc` `` — a template literal with no interpolation is a closed literal.
    if (literal.type === 'TemplateLiteral') {
      const expressions = Array.isArray(literal.expressions) ? literal.expressions : [];
      if (expressions.length > 0) return null;
      const quasis = Array.isArray(literal.quasis) ? literal.quasis : [];
      const cooked = asNode(quasis[0])?.value;
      const raw =
        typeof cooked === 'object' && cooked !== null
          ? (cooked as { raw?: unknown }).raw
          : undefined;
      return typeof raw === 'string' ? raw : '';
    }
    return null;
  }
  // Some parsers surface a bare `` `abc` `` type as TSTemplateLiteralType instead.
  if (node.type === 'TSTemplateLiteralType') {
    const types = Array.isArray(node.types) ? node.types : [];
    if (types.length > 0) return null;
    const quasis = Array.isArray(node.quasis) ? node.quasis : [];
    const cooked = asNode(quasis[0])?.value;
    const raw =
      typeof cooked === 'object' && cooked !== null ? (cooked as { raw?: unknown }).raw : undefined;
    return typeof raw === 'string' ? raw : '';
  }
  return null;
}

function isNullish(node: AnyNode): boolean {
  if (node.type === 'TSNullKeyword' || node.type === 'TSUndefinedKeyword') return true;
  // `null` also appears as `TSLiteralType { literal: NullLiteral }` in some shapes.
  if (node.type !== 'TSLiteralType') return false;
  const literal = asNode(node.literal);
  return (
    literal !== null &&
    (literal.type === 'NullLiteral' || (literal.type === 'Literal' && literal.value === null))
  );
}

interface UnionAnalysis {
  readonly literals: readonly string[];
  /** `true` when every non-nullish member is a string literal. */
  readonly closed: boolean;
}

/** Flatten nested/parenthesised unions and classify every member, in source order. */
function analyseUnion(node: AnyNode, ignoreNullishMembers: boolean): UnionAnalysis {
  const literals: string[] = [];
  let closed = true;
  const visit = (value: AnyNode): void => {
    const current = unwrap(value);
    if (current.type === 'TSUnionType') {
      const types = Array.isArray(current.types) ? current.types : [];
      for (const member of types) {
        const child = asNode(member);
        if (child === null) closed = false;
        else visit(child);
      }
      return;
    }
    if (isNullish(current)) {
      if (!ignoreNullishMembers) closed = false;
      return;
    }
    const literal = stringLiteralMember(current);
    if (literal === null) closed = false;
    else literals.push(literal);
  };
  visit(node);
  return { literals, closed };
}

/**
 * `true` for an *ambient* module container. oxc emits `TSModuleDeclaration` for a first-party
 * `namespace Foo {}` exactly as it does for `declare module` / `declare global` /
 * `declare namespace`, and `TSGlobalDeclaration` is only a typings-level alias whose runtime `type`
 * is also `"TSModuleDeclaration"`. The discriminators are the `declare` / `global` flags, `kind`,
 * and a string-literal module name (`module 'virtual:x'`, which is ambient by construction).
 */
function isAmbientModule(node: AnyNode): boolean {
  if (node.declare === true || node.global === true || node.kind === 'global') return true;
  const id = asNode(node.id);
  if (id === null) return false;
  return id.type === 'StringLiteral' || (id.type === 'Literal' && typeof id.value === 'string');
}

/**
 * `true` when the alias is itself `declare type …`, or sits — at any nesting depth — inside an
 * ambient container. A plain `namespace Foo { export type X = 'a' | 'b' }` is first-party code we
 * own, so it is **not** ambient and still reports; the walk continues past it so that a plain
 * namespace nested inside a `declare module` is still recognised as ambient.
 */
function isAmbient(node: ESTree.Node): boolean {
  if ((node as unknown as AnyNode).declare === true) return true;
  let current: unknown = (node as unknown as { parent?: unknown }).parent;
  while (current !== null && current !== undefined) {
    const parent = asNode(current);
    if (parent === null) return false;
    if (parent.type === 'Program') return false;
    if (parent.type === 'TSModuleDeclaration' && isAmbientModule(parent)) return true;
    current = parent.parent;
  }
  return false;
}

/**
 * Names bound **at module scope** to `Schema.Literals([...])` / `Schema.Literal(...)`, where
 * `Schema` really is the `effect` Schema namespace (aliases and submodule namespace imports
 * included).
 *
 * Only `program.body` (and the declaration of a top-level `export`) is scanned on purpose: the
 * sharper `duplicatesSchemaLiterals` message tells the author to write
 * `type X = typeof Owner.Type`, which only compiles when `Owner` is visible where the alias is
 * declared. A function-local `const AuditProfile = Schema.Literals([...])` is not, so such a binding
 * must not claim ownership — those aliases fall back to the generic message.
 */
function collectSchemaLiteralNames(
  program: ESTree.Program,
  bindings: EffectBindings,
): ReadonlySet<string> {
  const names = new Set<string>();
  if (!bindings.importsEffect) return names;
  const addDeclarator = (value: unknown): void => {
    const declarator = asNode(value);
    if (declarator === null || declarator.type !== 'VariableDeclarator') return;
    const id = asNode(declarator.id);
    const init = asNode(declarator.init);
    if (id?.type !== 'Identifier' || typeof id.name !== 'string' || init?.type !== 'CallExpression')
      return;
    const callee = asNode(init.callee);
    if (callee === null) return;
    const member = effectMember(callee as unknown as ESTree.Node, bindings);
    if (
      member !== null &&
      member.namespace === SCHEMA_NAMESPACE &&
      SCHEMA_LITERAL_MEMBERS.has(member.member)
    ) {
      names.add(id.name);
    }
  };
  for (const statement of program.body) {
    const node = asNode(statement);
    if (node === null) continue;
    const declaration = node.type === 'ExportNamedDeclaration' ? asNode(node.declaration) : node;
    if (declaration === null || declaration.type !== 'VariableDeclaration') continue;
    const declarators = Array.isArray(declaration.declarations) ? declaration.declarations : [];
    for (const entry of declarators) addDeclarator(entry);
  }
  return names;
}

/**
 * The string values of an `enum` whose every member has a string-literal initializer, or `null` when
 * it is not an all-string enum. `enum Direction { Up, Down }` (implicit numeric) and mixed enums are
 * *not* this finding: their runtime values are not the vocabulary, so `Schema.Literals` is not the
 * mechanical replacement.
 */
function stringEnumMembers(node: AnyNode): readonly string[] | null {
  const body = asNode(node.body);
  const rawMembers = Array.isArray(node.members)
    ? node.members
    : body !== null && Array.isArray(body.members)
      ? body.members
      : null;
  if (rawMembers === null || rawMembers.length === 0) return null;
  const values: string[] = [];
  for (const entry of rawMembers) {
    const member = asNode(entry);
    if (member === null) return null;
    const initializer = asNode(member.initializer);
    if (initializer === null) return null;
    if (initializer.type === 'Literal' || initializer.type === 'StringLiteral') {
      if (typeof initializer.value !== 'string') return null;
      values.push(initializer.value);
      continue;
    }
    if (initializer.type === 'TemplateLiteral') {
      const expressions = Array.isArray(initializer.expressions) ? initializer.expressions : [];
      if (expressions.length > 0) return null;
      const quasis = Array.isArray(initializer.quasis) ? initializer.quasis : [];
      const cooked = asNode(quasis[0])?.value;
      const raw =
        typeof cooked === 'object' && cooked !== null
          ? (cooked as { raw?: unknown }).raw
          : undefined;
      values.push(typeof raw === 'string' ? raw : '');
      continue;
    }
    return null;
  }
  return values;
}

/** Candidate const names that would own the same vocabulary as an alias called `name`. */
function schemaOwnerCandidates(name: string): readonly string[] {
  return [name, `${name}Schema`, `${name}Literals`, `${name}s`, name.replace(/Schema$/u, '')];
}

function preview(literals: readonly string[]): string {
  const shown = literals.slice(0, 4).map((literal) => `'${literal}'`);
  return literals.length > shown.length ? `${shown.join(', ')}, …` : shown.join(', ');
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B5 + A2: disallow TypeScript-only string-literal union aliases. A closed vocabulary must be ' +
        'owned once as `Schema.Literals([...])` with the type derived from it (`typeof X.Type`), so it can ' +
        'decode transport and persistence values and feed exhaustive `Match`, instead of being re-declared ' +
        'as a type alias that has no codec and drifts from the Schema that already owns it.',
    },
    messages: {
      literalUnionAlias:
        '`{{name}}` re-declares a closed vocabulary ({{count}} string literals: {{members}}) as a TS-only ' +
        'union without an owning runtime vocabulary (audit B5: ' +
        '`packages/core-runtime/src/actions/definition.ts:21`; A2: derive types from the Schema). Own it as ' +
        '`export const {{name}} = Schema.Literals([{{members}}])` and derive ' +
        '`export type {{name}} = typeof {{name}}.Type`.',
      literalEnum:
        '`{{name}}` declares a closed vocabulary ({{count}} string members: {{members}}) as a TypeScript ' +
        '`enum` outside the shared Schema vocabulary (audit B5). Prefer a Schema-owned vocabulary, ' +
        'or use Schema.Enum when an external enum contract must be preserved. Own a new vocabulary as ' +
        '`export const {{name}} = Schema.Literals([{{members}}])` and derive ' +
        '`export type {{name}} = typeof {{name}}.Type`.',
      duplicatesSchemaLiterals:
        '`{{name}}` re-declares a closed vocabulary ({{count}} string literals: {{members}}) that ' +
        '`{{owner}}` already owns as `Schema.Literals` in this file — exactly the B5 duplication ' +
        '(`packages/core-runtime/src/actions/definition.ts:21` vs ' +
        '`packages/core-runtime/src/modules/manifest.ts:61`). Delete the alias body and derive it: ' +
        '`export type {{name}} = typeof {{owner}}.Type`.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          minMembers: { type: 'integer', minimum: 1 },
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          ignoreTests: { type: 'boolean' },
          ignoreAmbient: { type: 'boolean' },
          ignoreNullishMembers: { type: 'boolean' },
          includeEnums: { type: 'boolean' },
          allowedNames: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        minMembers: DEFAULT_MIN_MEMBERS,
        include: DEFAULT_INCLUDE,
        ignore: [...DEFAULT_IGNORE],
        ignoreTests: false,
        ignoreAmbient: true,
        ignoreNullishMembers: true,
        includeEnums: true,
        allowedNames: [],
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.include)) return {};
    if (matchesGlobs(path, options.ignore)) return {};
    if (options.ignoreTests && isTestFile(path)) return {};
    if (options.ignoreAmbient && DECLARATION_FILE.test(path)) return {};

    const program = context.sourceCode.ast;
    const bindings = collectEffectBindings(program);
    let schemaOwners: ReadonlySet<string> | null = null;

    return {
      TSTypeAliasDeclaration(node) {
        const raw = node as unknown as AnyNode;
        if (raw.typeParameters !== null && raw.typeParameters !== undefined) return;
        if (options.ignoreAmbient && isAmbient(node)) return;

        const id = asNode(raw.id);
        const name = id?.type === 'Identifier' && typeof id.name === 'string' ? id.name : null;
        if (name === null || options.allowedNames.includes(name)) return;

        const annotation = asNode(raw.typeAnnotation);
        if (annotation === null) return;
        const union = unwrap(annotation);
        if (union.type !== 'TSUnionType') return;

        const { literals, closed } = analyseUnion(union, options.ignoreNullishMembers);
        if (!closed || literals.length < options.minMembers) return;

        schemaOwners ??= collectSchemaLiteralNames(program, bindings);
        const owner = schemaOwnerCandidates(name).find(
          (candidate) => candidate !== '' && (schemaOwners as ReadonlySet<string>).has(candidate),
        );

        context.report({
          node: (id ?? raw) as unknown as ESTree.Node,
          messageId: owner === undefined ? 'literalUnionAlias' : 'duplicatesSchemaLiterals',
          data: {
            name,
            count: String(literals.length),
            members: preview(literals),
            owner: owner ?? '',
          },
        });
      },

      TSEnumDeclaration(node) {
        if (!options.includeEnums) return;
        const raw = node as unknown as AnyNode;
        if (options.ignoreAmbient && isAmbient(node)) return;

        const id = asNode(raw.id);
        const name = id?.type === 'Identifier' && typeof id.name === 'string' ? id.name : null;
        if (name === null || options.allowedNames.includes(name)) return;

        const values = stringEnumMembers(raw);
        if (values === null || values.length < options.minMembers) return;

        context.report({
          node: (id ?? raw) as unknown as ESTree.Node,
          messageId: 'literalEnum',
          data: { name, count: String(values.length), members: preview(values) },
        });
      },
    };
  },
});
