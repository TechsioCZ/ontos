/**
 * effect-native/no-duplicate-literal-vocabulary
 *
 * Audit finding: **B5** — "Adopt Effect's ADTs and temporal model consistently"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`). B5 states the problem verbatim: "Closed
 * vocabularies and timestamps are repeatedly re-declared", and names "closed status vocabularies"
 * among the highest-value targets. Its evidence list includes
 * `packages/core-runtime/src/auth/principal-administration-reads.ts` and
 * `apps/shell-super-app/api/modules/shell-resources.ts`; the shell's `shared/api.ts` inlines the
 * same principal / API-key status sets several times over, and `packages/core-runtime/src/modules/
 * manifest.ts` repeats module vocabularies that can drift independently.
 *
 * A closed vocabulary is a contract. Written out twice it is two contracts: adding `suspended` to
 * one `Schema.Literals([...])` and not to its twin silently splits validation between the request
 * payload and the response, and nothing — not the compiler, not a test — connects the two sites.
 *
 * ## What this detects
 *
 * Per file, every `Schema.Literals([...])` call whose argument array is a literal list of constant
 * strings is collected and keyed by its *sorted, de-duplicated* member set. Quoted literals and
 * no-substitution template literals (`` `plan` ``) are the same member — spelling the list with
 * backticks is not a different vocabulary. When one key occurs more than once in a file, every
 * occurrence except the canonical one is reported. The canonical occurrence is, in order: a call
 * built from a shared `const` array (`Schema.Literals(PRINCIPAL_STATUSES)`, an authority that is
 * never itself reported and makes every inline copy of that set a violation), then the first call
 * bound to a name (`const PrincipalStatus = Schema.Literals([...])`), then simply the first
 * occurrence in the file. Member *order* is irrelevant: `['a','b']` and `['b','a']` are the same
 * vocabulary.
 *
 * Resolution of `Schema` is lexical but thorough:
 *
 * - named imports and aliases — `import { Schema } from "effect"`, `import { Schema as S } from "effect"`;
 * - submodule namespace imports — `import * as Schema from "effect/Schema"` (any `effect/**\/Schema`);
 * - bare member imports — `import { Literals } from "effect/Schema"` then `Literals([...])`;
 * - root barrel access — `import * as Effect from "effect"` then `Effect.Schema.Literals([...])`;
 * - the Effect re-export barrels in `reexportModules`
 *   (`@modern-js/plugin-bff/effect-client`, `@modern-js/plugin-bff/effect-edge`), which the shell's
 *   `shared/api.ts` and every Contacts client import `Schema` from — the audit's own B5 example file;
 * - optional chaining (`Schema?.Literals?.([...])`) and computed access (`Schema['Literals'](...)`);
 * - one hop of local `const` aliasing — `const Literals = Schema.Literals` or `const Sch = Schema`,
 *   then `Literals([...])` / `Sch.Literals([...])`;
 * - `as const` / `satisfies` / non-null wrappers around the member array;
 * - `.ts`, `.mts` and `.tsx` alike, in source, scripts and tests (`ignoreTests` opts tests out).
 *
 * A local shadow of the imported name (a parameter or `const` called `Schema`) resolves through
 * scope and is not matched.
 *
 * ## What is deliberately allowed
 *
 * - **The target pattern itself**: one named `Schema.Literals` const referenced everywhere else
 *   (`const PrincipalStatus = Schema.Literals([...]); Schema.Struct({ a: PrincipalStatus, b: PrincipalStatus })`).
 *   A single occurrence never reports, however many places reference the constant.
 * - **Vocabularies built from a shared array constant** — `Schema.Literals(ACTION_PROVISIONING_INTENTS)`,
 *   however many times. The constant is the single authority, so such calls never report; they only
 *   become the named owner an inline re-spelling of the same member set is reported against.
 * - **Single-member sets** (`minMembers`, default 2). `Schema.Literals(['revoked'])` and
 *   `Schema.Literal('active')` are discriminant tags on individual union branches, not vocabularies;
 *   treating repeated branch tags as duplication would flag correct `Schema.Union` modelling.
 * - **Strict subsets** such as the mutable-status subset `['active','disabled']` of
 *   `['active','disabled','revoked']`. Narrowing the accepted set for one endpoint is legitimate
 *   domain modelling, so subsets stay silent unless `reportSubsets` is enabled.
 * - **TypeScript literal union aliases** (`type Status = 'active' | 'disabled'`). Those belong to
 *   the sibling `no-literal-union-type-alias` finding, not here, and are never collected.
 * - **Cross-file duplication.** The rule is deliberately per-file: it has no module resolution and
 *   would otherwise guess at which of two packages owns a vocabulary.
 * - Anything outside `include` (`apps/**`, `verticals/**`, `packages/**`, `scripts/**`) or matching
 *   `ignore`, and no audit "Existing patterns to preserve" / D-tier item is touched — this rule
 *   never looks at `Effect.runPromise` seams, `Layer.orDie` roots, JSON serialization or casts.
 *
 * Known limitations, all inherent to a lexical rule:
 *
 * - Two genuinely distinct vocabularies that happen to share a member set in one file
 *   (`['active','disabled']` for principals and for feature flags) are indistinguishable without
 *   types. That is the intended trade — the audit wants the set named once and referenced.
 * - Duplication *across* files is invisible (no module resolution).
 * - Alias chains longer than `MAX_ALIAS_HOPS`, aliases re-bound through `let`, object destructuring
 *   (`const { Literals } = Schema`) or a factory smuggled through a function parameter or property
 *   are not followed; the vocabulary is then simply not collected.
 *
 * Report-only: no fixer, no suggestion. Existing violations are the intended output.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
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

const DEFAULT_INCLUDE: readonly string[] = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];

const DEFAULT_IGNORE: readonly string[] = [];

/** Schema constructors that take an inline array of string literals as a closed vocabulary. */
const DEFAULT_FACTORIES: readonly string[] = ['Literals'];

/** Barrels that re-export Effect namespaces verbatim; `Schema` from them is Effect's `Schema`. */
const DEFAULT_REEXPORT_MODULES: readonly string[] = [
  '@modern-js/plugin-bff/effect-client',
  '@modern-js/plugin-bff/effect-edge',
];

/** Below this, a literal set is a union-branch discriminant rather than a vocabulary. */
const DEFAULT_MIN_MEMBERS = 2;

/** Depth guard for the "is this call bound to a name?" ancestor walk. */
const MAX_NAME_DEPTH = 8;

/** Hops allowed when following `const` aliases (`const Literals = Schema.Literals`). */
const MAX_ALIAS_HOPS = 2;

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly ignoreTests: boolean;
  readonly reportSubsets: boolean;
  readonly minMembers: number;
  readonly factories: readonly string[];
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
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    ignoreTests: boolean(record.ignoreTests, false),
    reportSubsets: boolean(record.reportSubsets, false),
    minMembers: positiveInteger(record.minMembers, DEFAULT_MIN_MEMBERS),
    factories: stringArray(record.factories, DEFAULT_FACTORIES),
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
  /** Locals standing for the whole Effect barrel (`import * as Effect from "effect"` → `Effect.Schema.Literals`). */
  readonly barrel: ReadonlySet<string>;
  /** Locals bound directly from `effect/Schema` (`import { Literals } from "effect/Schema"`). */
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

/** Non-computed `.Literals`, or computed `["Literals"]`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const property = node.property;
  return property.type === 'Literal' && typeof property.value === 'string' ? property.value : null;
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

/** Strip transparent expression wrappers (`as const`, `satisfies …`, `!`, `(…)`). */
function unwrap(node: ESTree.Node): ESTree.Node {
  let current = node;
  for (let depth = 0; depth < MAX_NAME_DEPTH; depth += 1) {
    if (current.type === 'TSAsExpression' || current.type === 'TSSatisfiesExpression') {
      current = current.expression;
      continue;
    }
    if (current.type === 'TSNonNullExpression' || current.type === 'ChainExpression') {
      current = current.expression;
      continue;
    }
    if (current.type === 'TSInstantiationExpression') {
      current = current.expression;
      continue;
    }
    return current;
  }
  return current;
}

/**
 * The initialiser of a `const` binding for this identifier, or `null` when the name is not a
 * single-definition `const` (a `let`, a parameter, an import, a re-assigned binding, …). One hop of
 * purely local data flow — enough to see through `const Literals = Schema.Literals`.
 */
function constInitializer(
  context: Context,
  identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
): ESTree.Node | null {
  const variable = lookupVariable(context, identifier);
  if (variable === null || variable.defs.length !== 1) return null;
  const definition = variable.defs[0];
  if (definition === undefined || definition.type !== 'Variable') return null;
  const declarator = definition.node;
  if (declarator.type !== 'VariableDeclarator' || declarator.init === null) return null;
  if (declarator.id.type !== 'Identifier') return null;
  const declaration = definition.parent;
  if (
    declaration === null ||
    declaration.type !== 'VariableDeclaration' ||
    declaration.kind !== 'const'
  ) {
    return null;
  }
  return unwrap(declarator.init);
}

/** `true` when this expression denotes Effect's `Schema` namespace (possibly through a const alias). */
function isSchemaNamespace(
  node: ESTree.Node,
  context: Context,
  locals: SchemaLocals,
  hops: number,
): boolean {
  // `Schema.Literals([...])` / `S.Literals([...])` / `Schema['Literals']([...])`.
  if (node.type === 'Identifier') {
    if (locals.schema.has(node.name)) return resolvesToImport(context, node);
    if (hops <= 0) return false;
    // `const Sch = Schema; Sch.Literals([...])`.
    const init = constInitializer(context, node);
    return init === null ? false : isSchemaNamespace(init, context, locals, hops - 1);
  }
  // `Effect.Schema.Literals([...])` through a root barrel namespace import.
  if (node.type === 'MemberExpression') {
    if (memberName(node) !== SCHEMA_NAMESPACE) return false;
    const root = unwrap(node.object);
    if (root.type !== 'Identifier' || !locals.barrel.has(root.name)) return false;
    return resolvesToImport(context, root);
  }
  return false;
}

/**
 * The Schema vocabulary factory this callee denotes (`"Literals"`), or `null` when it is not a
 * tracked Effect `Schema` member.
 */
function factoryOf(
  node: ESTree.Node,
  context: Context,
  locals: SchemaLocals,
  factories: readonly string[],
  hops: number,
): string | null {
  const callee = unwrap(node);
  if (callee.type === 'Identifier') {
    // `Literals([...])` from `import { Literals } from "effect/Schema"`.
    const exported = locals.direct.get(callee.name);
    if (exported !== undefined) {
      if (!factories.includes(exported)) return null;
      return resolvesToImport(context, callee) ? exported : null;
    }
    if (hops <= 0) return null;
    // `const Literals = Schema.Literals; Literals([...])`.
    const init = constInitializer(context, callee);
    return init === null ? null : factoryOf(init, context, locals, factories, hops - 1);
  }
  if (callee.type !== 'MemberExpression') return null;
  const member = memberName(callee);
  if (member === null || !factories.includes(member)) return null;
  return isSchemaNamespace(unwrap(callee.object), context, locals, hops) ? member : null;
}

function vocabularyFactory(
  call: ESTree.CallExpression,
  context: Context,
  locals: SchemaLocals,
  factories: readonly string[],
): string | null {
  return factoryOf(call.callee, context, locals, factories, MAX_ALIAS_HOPS);
}

/**
 * The constant string an element denotes: a quoted string literal, or a no-substitution template
 * literal (`` `plan` ``, which is the same member written differently). `null` for anything computed.
 */
function constantString(node: ESTree.Node): string | null {
  const value = unwrap(node);
  if (value.type === 'Literal') return typeof value.value === 'string' ? value.value : null;
  if (value.type !== 'TemplateLiteral' || value.expressions.length !== 0) return null;
  const quasi = value.quasis[0];
  if (quasi === undefined || value.quasis.length !== 1) return null;
  return quasi.value.cooked;
}

/**
 * The string members of an inline array argument, or `null` when the argument is not a literal list
 * of strings (an identifier, a spread, a computed value, a mixed array, …).
 */
function inlineStringMembers(argument: ESTree.Node): readonly string[] | null {
  const array = unwrap(argument);
  if (array.type !== 'ArrayExpression') return null;
  const members: string[] = [];
  for (const element of array.elements) {
    if (element === null) return null;
    const value = constantString(element);
    if (value === null) return null;
    members.push(value);
  }
  return members;
}

/**
 * A vocabulary passed as a `const` array constant (`Schema.Literals(PRINCIPAL_STATUSES)`). Such a
 * call never reports — the file already has one authority for the member list — but it makes that
 * constant the named owner every inline copy of the same set should be built from.
 */
function constantVocabulary(
  context: Context,
  argument: ESTree.Node,
): { readonly name: string; readonly members: readonly string[] } | null {
  const node = unwrap(argument);
  if (node.type !== 'Identifier') return null;
  const init = constInitializer(context, node);
  if (init === null) return null;
  const members = inlineStringMembers(init);
  return members === null ? null : { name: node.name, members };
}

/** The name this call is bound to (`const PrincipalStatus = Schema.Literals([...])`), else `null`. */
function boundName(call: ESTree.CallExpression): string | null {
  let previous: ESTree.Node = call;
  let current: ESTree.Node | null | undefined = call.parent;
  for (let depth = 0; depth < MAX_NAME_DEPTH; depth += 1) {
    if (current === null || current === undefined) return null;
    switch (current.type) {
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSInstantiationExpression':
      case 'ChainExpression':
        break;
      case 'VariableDeclarator':
        if (current.init !== previous) return null;
        return current.id.type === 'Identifier' ? current.id.name : null;
      case 'PropertyDefinition':
        if (current.value !== previous) return null;
        return current.key.type === 'Identifier' && !current.computed ? current.key.name : null;
      default:
        return null;
    }
    previous = current;
    current = current.parent;
  }
  return null;
}

interface Occurrence {
  readonly node: ESTree.CallExpression;
  readonly name: string | null;
  readonly line: number;
  /** Built from a shared `const` array: an authority for the member list, never itself a copy. */
  readonly authority: boolean;
}

interface Group {
  readonly members: readonly string[];
  readonly occurrences: Occurrence[];
}

function formatMembers(members: readonly string[]): string {
  return members.map((member) => `'${member}'`).join(' | ');
}

/** Sorted, de-duplicated member list — the vocabulary identity, independent of written order. */
function vocabularyKey(members: readonly string[]): readonly string[] {
  return [...new Set(members)].sort();
}

function isStrictSubset(inner: readonly string[], outer: readonly string[]): boolean {
  if (inner.length >= outer.length) return false;
  const set = new Set(outer);
  return inner.every((member) => set.has(member));
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B5: a closed literal vocabulary must be declared once. Re-inlining the same ' +
        '`Schema.Literals([...])` member set inside one file creates two contracts that drift ' +
        'independently; bind it to a named Schema (and brand it where it identifies a domain value) ' +
        'and reference that constant from every Schema.Struct field.',
    },
    messages: {
      duplicateOfNamed:
        'Literal vocabulary {{members}} is declared {{count}} times in this file — it is already bound to ' +
        '`{{owner}}` (line {{ownerLine}}). Reference `{{owner}}` here instead of re-inlining the member ' +
        'list: a `Schema.Literals` const is the single authority for a closed vocabulary, and derive the ' +
        'TypeScript type with `typeof {{owner}}.Type` rather than repeating the members in a union alias.',
      duplicateAnonymous:
        'Literal vocabulary {{members}} is declared {{count}} times in this file (first at line ' +
        '{{ownerLine}}). Declare it once — `const Vocabulary = Schema.Literals([{{memberList}}])` — and ' +
        'reference that constant from every field, deriving the type with `typeof Vocabulary.Type`. Two ' +
        'inline copies are two contracts: adding a member to one and not the other splits validation ' +
        'silently.',
      duplicateOfConstant:
        'Literal vocabulary {{members}} is re-inlined here although this file already owns the member ' +
        'list as `{{owner}}` (line {{ownerLine}}) — {{count}} declarations of one closed vocabulary. ' +
        'Build this schema from that constant (`Schema.Literals({{owner}})`), or better bind it once — ' +
        '`const Vocabulary = Schema.Literals({{owner}})` — and reference `Vocabulary` from every field, ' +
        'deriving the type with `typeof Vocabulary.Type`.',
      subsetVocabulary:
        'Literal vocabulary {{members}} is a strict subset of {{supersetMembers}} declared at line ' +
        '{{ownerLine}} in this file. Derive the narrowed set from the owning vocabulary (a named ' +
        '`Schema.Literals` const per accepted set, or `Schema.Union` over shared branch schemas) so a ' +
        'member added to the wider vocabulary cannot be forgotten here.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          ignoreTests: { type: 'boolean' },
          reportSubsets: { type: 'boolean' },
          minMembers: { type: 'integer', minimum: 1 },
          factories: { type: 'array', items: { type: 'string' } },
          reexportModules: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: [...DEFAULT_INCLUDE],
        ignore: [...DEFAULT_IGNORE],
        ignoreTests: false,
        reportSubsets: false,
        minMembers: DEFAULT_MIN_MEMBERS,
        factories: [...DEFAULT_FACTORIES],
        reexportModules: [...DEFAULT_REEXPORT_MODULES],
      },
    ],
  },
  createOnce(context) {
    let options: RuleOptions | null = null;
    let locals: SchemaLocals | null = null;
    let groups: Map<string, Group> = new Map<string, Group>();

    return {
      before() {
        const resolved = readOptions(context);
        options = resolved;
        groups = new Map<string, Group>();
        locals = null;
        if (resolved.factories.length === 0) return false;
        const path = scopePath(context.filename);
        if (matchesGlobs(path, resolved.ignore)) return false;
        if (!matchesGlobs(path, resolved.include)) return false;
        if (resolved.ignoreTests && isTestFile(path)) return false;
        const program = context.sourceCode.ast;
        const bindings = collectEffectBindings(program);
        const schemaLocals = collectSchemaLocals(program, bindings, resolved.reexportModules);
        if (
          schemaLocals.schema.size === 0 &&
          schemaLocals.barrel.size === 0 &&
          schemaLocals.direct.size === 0
        ) {
          return false;
        }
        locals = schemaLocals;
        return true;
      },

      after() {
        locals = null;
        groups = new Map<string, Group>();
      },

      CallExpression(node) {
        const resolved = options;
        const schemaLocals = locals;
        if (resolved === null || schemaLocals === null) return;
        const argument = node.arguments[0];
        if (argument === undefined || argument.type === 'SpreadElement') return;
        if (vocabularyFactory(node, context, schemaLocals, resolved.factories) === null) return;
        const inline = inlineStringMembers(argument);
        const constant = inline === null ? constantVocabulary(context, argument) : null;
        const written = inline ?? constant?.members ?? null;
        if (written === null) return;
        const members = vocabularyKey(written);
        if (members.length < resolved.minMembers) return;
        const key = JSON.stringify(members);
        const existing = groups.get(key);
        const occurrence: Occurrence = {
          node,
          name: constant === null ? boundName(node) : constant.name,
          line: context.sourceCode.getLoc(node).start.line,
          authority: constant !== null,
        };
        if (existing === undefined) groups.set(key, { members, occurrences: [occurrence] });
        else existing.occurrences.push(occurrence);
      },

      'Program:exit'() {
        const resolved = options;
        if (resolved === null || groups.size === 0) return;
        const all = [...groups.values()];
        const reported = new Set<ESTree.CallExpression>();

        for (const group of all) {
          // Calls built from a shared constant are authorities, never copies to report.
          const copies = group.occurrences.filter((occurrence) => !occurrence.authority);
          if (copies.length === 0) continue;
          const authority = group.occurrences.find((occurrence) => occurrence.authority);
          const named = copies.find((occurrence) => occurrence.name !== null);
          const canonical = authority ?? named ?? copies[0];
          if (canonical === undefined) continue;
          const members = formatMembers(group.members);
          for (const occurrence of copies) {
            if (occurrence === canonical) continue;
            reported.add(occurrence.node);
            context.report({
              node: occurrence.node,
              messageId:
                authority !== undefined
                  ? 'duplicateOfConstant'
                  : canonical.name === null
                    ? 'duplicateAnonymous'
                    : 'duplicateOfNamed',
              data: {
                members,
                memberList: members.replaceAll(' | ', ', '),
                count: String(group.occurrences.length),
                owner: canonical.name ?? 'the first declaration',
                ownerLine: String(canonical.line),
              },
            });
          }
        }

        if (!resolved.reportSubsets) return;
        for (const group of all) {
          const superset = all.find((other) => isStrictSubset(group.members, other.members));
          if (superset === undefined) continue;
          const owner = superset.occurrences[0];
          if (owner === undefined) continue;
          for (const occurrence of group.occurrences) {
            if (occurrence.authority) continue;
            if (reported.has(occurrence.node)) continue;
            reported.add(occurrence.node);
            context.report({
              node: occurrence.node,
              messageId: 'subsetVocabulary',
              data: {
                members: formatMembers(group.members),
                supersetMembers: formatMembers(superset.members),
                ownerLine: String(owner.line),
              },
            });
          }
        }
      },
    };
  },
});
