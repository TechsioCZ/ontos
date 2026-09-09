/**
 * effect-native/no-raw-effect-adt-tag-check
 *
 * Audit findings: **C2** — "Replace raw Option, Exit, and `_tag` inspection" — and **B5** — "Adopt
 * Effect's ADTs and temporal model consistently" (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`).
 * C2 asks for `Option.match`, `Option.isSome`, `Exit.match`, `Exit.isFailure`, `Effect.catchTag(s)`
 * and exhaustive `Match` instead of hand-written tag equality; A4 counts these among the "roughly 113
 * manual `_tag` comparisons" behind the error-model rebuild (Action/Read/Outbox runtimes and the
 * impersonation service).
 *
 * What is detected
 * - Any equality comparison (`===`, `!==`, `==`, `!=`) whose one side reads an ADT `_tag` and whose
 *   other side is one of the built-in Effect ADT tag literals (`Some`, `None`, `Success`, `Failure`,
 *   `Left`, `Right` — configurable through `adtTags`).
 * - Both operand orders (`exit._tag === 'Failure'` and `'Failure' === exit._tag`).
 * - `_tag` reached through optional chaining (`failure?._tag`), non-null assertions (`failure!._tag`),
 *   `as`/`satisfies`/parenthesised wrappers, computed access (`exit['_tag']`), and arbitrarily deep
 *   receivers (`state.value.inner._tag`). Tag literals may be plain strings or expressionless
 *   template literals.
 * - **Indirect tag reads.** Laundering the tag through a local binding is the same check: a
 *   destructured `const { _tag } = option`, a renamed `const { _tag: kind } = option` (including
 *   nested patterns and defaulted properties), and an alias `const exitTag = exit._tag` all report,
 *   resolved through `context.sourceCode.getScope` rather than by name. `prefer-match-over-tag-switch`
 *   already treats exactly these three spellings as must-report for `switch` discriminants; for a
 *   binary comparison over an ADT tag this rule is the sole authority, so the hole is closed here.
 * - Every in-scope file (`include`, default `apps/**`, `verticals/**`, `packages/**`, `scripts/**`),
 *   `.ts`, `.mts` and `.tsx` alike. Tests are in scope by default: the audit's B2 harness work depends
 *   on tests reading `Exit` through combinators too (`ignoreTests: true` opts out).
 *
 * Effect linkage (`requireEffectImport`, default true) accepts every static spelling of "this module
 * is wired to Effect": an `import`/`import type` from `effect` or `effect/*`, a re-export
 * (`export { Option } from 'effect'`, `export type { Exit } from 'effect'`, `export * from 'effect'`),
 * a statically-sourced dynamic `import('effect')` anywhere in the file, or any of the configured
 * `reexportModules` barrels. Import-only scanning let a file whose only link to Effect was a
 * re-export or a dynamic import slip through entirely.
 *
 * What is deliberately allowed
 * - Domain error tags (`error._tag === 'ActionTransactionError'`) — those are the A4 `catchTag`/`Match`
 *   concern, not this rule; only the ADT tag vocabulary in `adtTags` is reported.
 * - `switch (exit._tag) { case 'Failure': ... }` — switch exhaustiveness is a separate concern
 *   (`prefer-match-over-tag-switch`); this rule never reports `SwitchStatement` discriminants.
 * - `Match.when({ _tag: 'Some' }, ...)` and any other object-literal pattern: those are already the
 *   Effect-native form, and they are never `BinaryExpression`s.
 * - Combinator-based inspection (`Option.isSome`, `Exit.isFailure`, `Result.match`, ...).
 * - A tag literal hidden behind a constant (`option._tag === SOME`) is left to
 *   `no-manual-tag-comparison`, which already reports that shape through its dynamic-tag message.
 * - Files with no static link to `effect` at all while `requireEffectImport` is true: a
 *   `_tag === 'Success'` there is not evidence of an Effect ADT.
 * - Anything matched by `ignore`, and anything outside `include` (e.g. `tools/**`, `dist/**`).
 *
 * Mutable aliases with later writes are not traced: this rule has no control-flow analysis.
 * Effect linkage plus an ADT literal is lexical evidence, not proof of the receiver type.
 * Report-only: no fixers, no suggestions.
 */
import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree, Variable } from '@oxlint/plugins';

import { asNamedMember, staticString, unwrapNode } from '../shared/ast.ts';
import { resolveVariable } from '../shared/bindings.ts';
import { collectEffectBindings } from '../shared/effect-imports.ts';
import { optionRecord } from '../shared/options.ts';
import { stringArray } from '../shared/options.ts';
import { isTestFile, scopePath, matchesGlobs } from '../shared/paths.ts';

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];

const DEFAULT_IGNORE: readonly string[] = [];

/** Tag literals owned by Effect's built-in ADTs: `Option`, `Exit`, `Result`, `Either`. */
const DEFAULT_ADT_TAGS = ['Some', 'None', 'Success', 'Failure', 'Left', 'Right'];

/** Barrels that re-export Effect namespaces verbatim (the Modern.js BFF edge barrel). */
const DEFAULT_REEXPORT_MODULES = ['@modern-js/plugin-bff/effect-edge'];

const EFFECT_MODULE = /^effect(?:\/.*)?$/u;

const EQUALITY_OPERATORS = new Set(['===', '!==', '==', '!=']);

const TAG_PROPERTY = '_tag';

/** Depth guards; real expressions and destructuring patterns never approach these. */
const MAX_UNWRAP_DEPTH = 64;
const MAX_PATTERN_DEPTH = 12;

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly adtTags: readonly string[];
  readonly requireEffectImport: boolean;
  readonly ignoreTests: boolean;
  readonly reexportModules: readonly string[];
}

function readOptions(context: Context): RuleOptions {
  const record = optionRecord(context.options?.[0]);
  return {
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    adtTags: stringArray(record.adtTags, DEFAULT_ADT_TAGS),
    requireEffectImport: record.requireEffectImport !== false,
    ignoreTests: record.ignoreTests === true,
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
  };
}

/** Keep this rule's original transparent wrappers and bounded traversal. */
function unwrap(node: ESTree.Node): ESTree.Node {
  return unwrapNode(node, { maxDepth: MAX_UNWRAP_DEPTH });
}

function asTagMember(node: ESTree.Node): ESTree.MemberExpression | null {
  return asNamedMember(node, TAG_PROPERTY, asStringLiteral, {
    maxDepth: MAX_UNWRAP_DEPTH,
  });
}

function asStringLiteral(node: ESTree.Node): string | null {
  return staticString(node, {
    unwrap: { maxDepth: MAX_UNWRAP_DEPTH },
    templates: true,
    rawTemplates: true,
    singleQuasi: true,
  });
}

/** Best-effort human name for an expression, used only to pick the message's ADT vocabulary. */
function directExpressionName(node: ESTree.Node): string | null {
  if (node.type === 'Identifier') return node.name;
  if (node.type !== 'MemberExpression' || node.computed) return null;
  return node.property.type === 'Identifier' ? node.property.name : null;
}

function expressionName(node: ESTree.Node): string | null {
  const object = unwrap(node);
  if (object.type === 'CallExpression') return directExpressionName(unwrap(object.callee));
  if (object.type === 'AwaitExpression') return expressionName(object.argument);
  return directExpressionName(object);
}

/** Best-effort receiver name (`cleanupExit._tag` → `cleanupExit`, `a.b.failure._tag` → `failure`). */
function receiverName(member: ESTree.MemberExpression): string | null {
  return expressionName(member.object);
}

/** Static property name of an object-pattern key: `_tag` and `'_tag'` both yield `"_tag"`. */
function patternKeyName(property: { key: ESTree.Node; computed: boolean }): string | null {
  if (!property.computed) {
    const key = property.key;
    if (key.type === 'Identifier') return key.name;
    if (key.type === 'Literal') return typeof key.value === 'string' ? key.value : null;
    return null;
  }
  return asStringLiteral(property.key);
}

/**
 * `true` when `pattern` binds `name` from a `_tag` property: `const { _tag } = x`,
 * `const { _tag: kind } = x`, `const { _tag = 'None' } = x`, `const { inner: { _tag } } = x`.
 */
function patternBindsTag(pattern: ESTree.Node, name: string, depth: number): boolean {
  if (depth > MAX_PATTERN_DEPTH) return false;
  if (pattern.type === 'AssignmentPattern') return patternBindsTag(pattern.left, name, depth + 1);
  if (pattern.type !== 'ObjectPattern') return false;
  return pattern.properties.some((property) => propertyBindsTag(property, name, depth));
}

function propertyBindsTag(property: ESTree.Node, name: string, depth: number): boolean {
  if (property.type !== 'Property') return false;
  const key = patternKeyName(property);
  let value: ESTree.Node = property.value;
  while (value.type === 'AssignmentPattern') value = value.left;
  if (key === TAG_PROPERTY && value.type === 'Identifier' && value.name === name) return true;
  return value.type === 'ObjectPattern' && patternBindsTag(value, name, depth + 1);
}

function aliasDeclarator(variable: Variable | null): ESTree.VariableDeclarator | null {
  if (variable === null || variable.defs.length !== 1) return null;
  if (variable.references.some((reference) => reference.isWrite() && !reference.init)) return null;
  const definition = variable.defs[0];
  if (definition === undefined || definition.type !== 'Variable') return null;
  return definition.node.type === 'VariableDeclarator' ? definition.node : null;
}

/**
 * A `_tag` read laundered through a local binding, resolved through the scope chain:
 * `const { _tag } = option; _tag === 'None'` and `const t = exit._tag; t === 'Failure'`.
 * Returns the receiver name (for the message's ADT vocabulary) or `null` when the identifier is not
 * a tag alias — a parameter, an import, a redeclared name, or any other local.
 */
function aliasedTagRead(context: Context, node: ESTree.Node): { receiver: string | null } | null {
  const expression = unwrap(node);
  if (expression.type !== 'Identifier') return null;
  const declarator = aliasDeclarator(resolveVariable(context, expression.name, expression));
  if (declarator === null) return null;
  const initialiser = declarator.init;
  if (initialiser == null) return null;

  if (declarator.id.type === 'Identifier') {
    if (declarator.id.name !== expression.name) return null;
    const member = asTagMember(initialiser);
    return member === null ? null : { receiver: receiverName(member) ?? expression.name };
  }
  if (!patternBindsTag(declarator.id, expression.name, 0)) return null;
  return { receiver: expressionName(initialiser) ?? expression.name };
}

const OPTION_COMBINATORS =
  '`Option.match(value, { onNone, onSome })`, `Option.isSome`/`Option.isNone`, or `Option.getOrElse`';
const EXIT_COMBINATORS =
  '`Exit.match(exit, { onFailure, onSuccess })`, `Exit.isFailure`/`Exit.isSuccess`, or ' +
  '`Cause.findErrorOption(exit.cause).pipe(Option.match({ onNone, onSome }))` when the failure matters';
const RESULT_COMBINATORS = '`Result.match(result, { onFailure, onSuccess })` or `Result.isSuccess`/`Result.isFailure`';
const EITHER_COMBINATORS = '`Either.match(value, { onLeft, onRight })` or `Either.isLeft`/`Either.isRight`';

/** Name the ADT from the tag, disambiguating the shared `Success`/`Failure` vocabulary by receiver. */
function describeAdt(tag: string, receiver: string | null): { adt: string; combinators: string } {
  if (tag === 'Some' || tag === 'None') return { adt: 'Option', combinators: OPTION_COMBINATORS };
  if (tag === 'Left' || tag === 'Right') return { adt: 'Either', combinators: EITHER_COMBINATORS };
  const name = receiver?.toLowerCase() ?? '';
  if (name.includes('exit')) return { adt: 'Exit', combinators: EXIT_COMBINATORS };
  if (name.includes('result')) return { adt: 'Result', combinators: RESULT_COMBINATORS };
  return {
    adt: 'Exit/Result',
    combinators: `${EXIT_COMBINATORS}, or ${RESULT_COMBINATORS}`,
  };
}

function isEffectSource(source: string, reexportModules: readonly string[]): boolean {
  return EFFECT_MODULE.test(source) || reexportModules.includes(source);
}

/**
 * Every *statically declared* link to Effect: `import`/`import type`, and re-exports
 * (`export { Option } from 'effect'`, `export type { Exit } from 'effect'`, `export * from 'effect'`).
 * Dynamic `import('effect')` is picked up by the `ImportExpression` visitor, because it can appear
 * anywhere in the file rather than only in the module body.
 */
function hasStaticEffectLinkage(program: ESTree.Program, reexportModules: readonly string[]): boolean {
  if (collectEffectBindings(program).importsEffect) return true;
  return program.body.some((statement) => statementLinksEffect(statement, reexportModules));
}

function statementLinksEffect(statement: ESTree.Node, reexportModules: readonly string[]): boolean {
  if (statement.type === 'ImportDeclaration') {
    return reexportModules.includes(statement.source.value);
  }
  if (statement.type === 'ExportAllDeclaration') {
    return isEffectSource(statement.source.value, reexportModules);
  }
  if (statement.type !== 'ExportNamedDeclaration') return false;
  const source = statement.source;
  return source != null && isEffectSource(source.value, reexportModules);
}

interface PendingReport {
  readonly node: ESTree.Node;
  readonly messageId: 'rawAdtTagCheck' | 'aliasedAdtTagCheck';
  readonly data: Record<string, string>;
}

/** Audit C2/B5: inspect Option/Exit/Result through combinators, never by raw ADT `_tag` literal. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        "Audit C2 (and B5, A4): disallow raw `_tag === 'Some' | 'None' | 'Success' | 'Failure' | 'Left' | " +
        "'Right'` inspection of Effect's built-in ADTs, including a tag laundered through a destructured " +
        'or aliased local. Use `Option.match`/`isSome`, `Exit.match`/`isFailure`, `Result.match`, ' +
        '`Either.match` or exhaustive `Match` so the ADT stays opaque and narrowing stays exhaustive.',
    },
    messages: {
      rawAdtTagCheck:
        "Raw `_tag {{operator}} '{{tag}}'` inspection of an Effect {{adt}} value (audit C2 / B5). Use " +
        "{{combinators}} instead of reading the tag by hand, so narrowing stays exhaustive and the ADT's " +
        'representation stays opaque.',
      aliasedAdtTagCheck:
        '`{{binding}}` is an Effect {{adt}} `_tag` read through a local binding, and `{{binding}} ' +
        "{{operator}} '{{tag}}'` is the same raw tag inspection audit C2 / B5 removes — destructuring or " +
        'aliasing the tag does not make it Effect-native. Use {{combinators}}.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          adtTags: { type: 'array', items: { type: 'string' } },
          requireEffectImport: { type: 'boolean' },
          ignoreTests: { type: 'boolean' },
          reexportModules: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: DEFAULT_INCLUDE,
        ignore: [...DEFAULT_IGNORE],
        adtTags: DEFAULT_ADT_TAGS,
        requireEffectImport: true,
        ignoreTests: false,
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
    if (options.adtTags.length === 0) return {};

    const tags = new Set(options.adtTags);
    let hasEffectLinkage =
      !options.requireEffectImport || hasStaticEffectLinkage(context.sourceCode.ast, options.reexportModules);
    // Reports are buffered so a dynamic `import('effect')` appearing *after* a comparison still
    // counts as Effect linkage; the buffer is flushed in source order at `Program:exit`.
    const pending: PendingReport[] = [];

    return {
      ImportExpression(node) {
        if (hasEffectLinkage) return;
        const source = asStringLiteral(node.source);
        if (source !== null && isEffectSource(source, options.reexportModules)) hasEffectLinkage = true;
      },

      BinaryExpression(node) {
        if (!EQUALITY_OPERATORS.has(node.operator)) return;
        if ((node.left as ESTree.Node).type === 'PrivateIdentifier') return;

        // One side must read an ADT `_tag` (directly or through a local binding), the other must
        // be a statically known ADT tag literal.
        const sides = [
          [node.left, node.right],
          [node.right, node.left],
        ] as const;
        for (const [tagSide, literalSide] of sides) {
          const tag = asStringLiteral(literalSide);
          if (tag === null || !tags.has(tag)) continue;

          const member = asTagMember(tagSide);
          if (member !== null) {
            const direct = describeAdt(tag, receiverName(member));
            pending.push({
              node,
              messageId: 'rawAdtTagCheck',
              data: {
                operator: node.operator,
                tag,
                adt: direct.adt,
                combinators: direct.combinators,
              },
            });
            return;
          }

          const alias = aliasedTagRead(context, tagSide);
          if (alias === null) continue;
          const binding = unwrap(tagSide);
          const indirect = describeAdt(tag, alias.receiver);
          pending.push({
            node,
            messageId: 'aliasedAdtTagCheck',
            data: {
              operator: node.operator,
              tag,
              adt: indirect.adt,
              combinators: indirect.combinators,
              binding: binding.type === 'Identifier' ? binding.name : TAG_PROPERTY,
            },
          });
          return;
        }
      },

      'Program:exit'() {
        if (!hasEffectLinkage) return;
        for (const report of pending) {
          context.report({
            node: report.node,
            messageId: report.messageId,
            data: report.data,
          });
        }
      },
    };
  },
});
