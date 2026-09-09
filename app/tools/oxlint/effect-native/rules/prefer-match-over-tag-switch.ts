/**
 * effect-native/prefer-match-over-tag-switch
 *
 * Audit findings: **A4** ("Rebuild the error system around typed channels and contract-owned Problem
 * Details"), **C2** ("Replace raw Option, Exit, and `_tag` inspection") and **B5** ("Adopt Effect's
 * ADTs and temporal model consistently") of `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`.
 *
 * A4 counts "roughly 113 manual `_tag` comparisons" and "non-exhaustive switches" as a load-bearing
 * part of the error-system problem, and names
 * `apps/shell-super-app/api/index.ts:186`, `verticals/contacts/api/index.ts:179`,
 * `verticals/contacts/api/read-server-support.ts:67` and
 * `verticals/contacts/src/routes/[lang]/contacts/customers/page.tsx:95` as the examples: an error
 * union is classified by a hand-rolled `switch (error._tag)` instead of `Effect.catchTag(s)` on the
 * error channel or an exhaustive `Match`. C2 asks for `Option.match` / `Exit.match` /
 * `Effect.catchTag(s)` / exhaustive `Match` in place of raw `_tag` inspection. B5 adds the closed
 * vocabularies — `state`, `status`, `outcome`, `role`, `captureMode`, auth method — that are
 * re-declared and then dispatched on by hand rather than owned by `Schema.Literal` and matched
 * exhaustively. Production `Match.` usage in this repository is currently zero.
 *
 * ## What this detects
 *
 * A `SwitchStatement` whose discriminant (unwrapped through `ChainExpression`, `TSNonNullExpression`,
 * `TSAsExpression`, `TSSatisfiesExpression`, `TSTypeAssertion`, `TSInstantiationExpression` and
 * `ParenthesizedExpression`) is either:
 *
 * - **a tag member access** — a `MemberExpression` whose final property is `_tag`
 *   (`tagProperties`). Depth does not matter: `error._tag` and `error.reason._tag` both qualify, and
 *   a computed access with a static string key (`error['_tag']`) is treated the same as
 *   `error._tag`. Effect's discriminator is never a numeric protocol code, so this branch reports
 *   whatever the case tests look like; **or**
 * - **a domain-vocabulary member access** — a `MemberExpression` whose final property is one of
 *   `discriminantProperties` (`state`, `status`, `kind`, `outcome`, `reason`, `role`,
 *   `captureMode`), *unless every non-`default` case tests a numeric literal*. `result.state`,
 *   `resolution.outcome` and `accessEvidencePolicy.captureMode` qualify; `response.status` with
 *   `case 400:` / `case 404:` does not, because those property names are also the natural spelling
 *   of an open numeric protocol space (HTTP status, `ts.SyntaxKind`) that the audit's D tier
 *   blesses; **or**
 * - **a closed string vocabulary** — every non-`default` case tests a string literal (or a
 *   template literal with no interpolation) and there are at least `minLiteralCases` of them. That
 *   catches `switch (role)`, `switch (authMethod)` and any other hand-rolled classifier over a set
 *   of literals, whatever the discriminant expression looks like.
 *
 * The report is emitted on the discriminant. A switch whose case literals include an
 * `adtTags` name (`Some`, `None`, `Success`, `Failure`, `Left`, `Right`) reports the ADT-specific
 * message pointing at `Option.match` / `Exit.match` instead of hand-written `_tag` inspection
 * (C2). Tests and `.tsx` route components are in scope by default — the audit's evidence list
 * includes both — unless `ignoreTests` is set.
 *
 * ## What is deliberately allowed
 *
 * - **Numeric switches.** `switch (status) { case 400: …; case 404: … }` and
 *   `switch (response.status) { case 400: …; case 404: … }` (the ARES HTTP status classifier,
 *   `verticals/contacts/src/integrations/ares/ares-subject.service.ts:163`, in both its bare-identifier
 *   and its object-property spelling) dispatch over an open numeric protocol space, not a closed
 *   tagged vocabulary. Every non-`default` case testing a numeric literal (`400`, `-1`, `0x1f`,
 *   `262n`) suppresses the `discriminantProperties` branch, so a numeric `kind` dispatch such as a
 *   `ts.SyntaxKind` codemod is allowed too. A numeric `_tag` is not a thing, so `tagProperties` is
 *   never suppressed this way.
 * - **Non-literal case tests.** `switch (x) { case SOME_CONST: … }`, `switch (a.b) { case other.c: … }`
 *   and interpolating template literals are not a declared closed vocabulary, so they only report if
 *   the discriminant is itself a tag / domain-vocabulary member access.
 * - **A single literal case** (`minLiteralCases` defaults to 2) on a non-discriminant expression.
 * - **Everything Effect-native**: `Match.value(x).pipe(Match.tag/tags/discriminators/when,
 *   Match.exhaustive)`, `Effect.catchTag`/`Effect.catchTags`, `Option.match`, `Exit.match`,
 *   `Schema.Literal`-owned vocabularies — none of them are `SwitchStatement`s, so none of them can
 *   report, under any import alias or `effect/*` namespace import.
 * - **Compiler-proven exhaustive switches**, but only when `allowExhaustive` is enabled (it is
 *   `false` by default, because the audit wants these dispatchers moved onto `Match`/`catchTags`,
 *   not merely made total). When enabled, a `default:` branch that declares `const x: never = …`,
 *   applies `satisfies never` / `as never`, or calls an `exhaustiveHelpers` identifier (including
 *   `absurd` reached through a tracked `effect` namespace binding) suppresses the report.
 * - Anything outside `include` (`apps/**`, `verticals/**`, `packages/**`, `scripts/**`) or matching
 *   `ignore` — `tools/**` owns its own dispatchers.
 *
 * Report-only: no fixer, no suggestion. Existing violations are the intended output.
 */
import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree } from '@oxlint/plugins';

import { unwrapNode } from '../shared/ast.ts';
import { collectEffectBindings, effectMember } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { optionRecord } from '../shared/options.ts';
import { stringArray, positiveInteger } from '../shared/options.ts';
import { isTestFile, scopePath, matchesGlobs } from '../shared/paths.ts';

const DEFAULT_INCLUDE: readonly string[] = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];

const DEFAULT_IGNORE: readonly string[] = [];

/** Effect's own discriminator, and the properties the audit names as hand-rolled vocabularies. */
const DEFAULT_TAG_PROPERTIES: readonly string[] = ['_tag'];

const DEFAULT_DISCRIMINANT_PROPERTIES: readonly string[] = [
  'state',
  'status',
  'kind',
  'outcome',
  'reason',
  'role',
  'captureMode',
];

/** Case literals that mean the switch is inspecting an Effect ADT rather than a domain union. */
const DEFAULT_ADT_TAGS: readonly string[] = ['Some', 'None', 'Success', 'Failure', 'Left', 'Right'];

const DEFAULT_EXHAUSTIVE_HELPERS: readonly string[] = ['absurd', 'assertNever'];

const DEFAULT_MIN_LITERAL_CASES = 2;

/** Depth guard for the discriminant unwrap; real expressions never approach this. */
const MAX_UNWRAP_DEPTH = 32;

/** Longest discriminant rendering embedded in a diagnostic message. */
const MAX_DISCRIMINANT_LENGTH = 60;

type RuleOptions = Readonly<ReturnType<typeof readOptions>>;

function readOptions(context: Context) {
  const record = optionRecord(context.options?.[0]);
  return {
    tagProperties: stringArray(record.tagProperties, DEFAULT_TAG_PROPERTIES),
    discriminantProperties: stringArray(record.discriminantProperties, DEFAULT_DISCRIMINANT_PROPERTIES),
    minLiteralCases: positiveInteger(record.minLiteralCases, DEFAULT_MIN_LITERAL_CASES),
    allowExhaustive: record.allowExhaustive === true,
    exhaustiveHelpers: stringArray(record.exhaustiveHelpers, DEFAULT_EXHAUSTIVE_HELPERS),
    adtTags: stringArray(record.adtTags, DEFAULT_ADT_TAGS),
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    ignoreTests: record.ignoreTests === true,
  };
}

/** Keep the original bounded, sequence-last discriminant policy. */
function unwrapExpression(node: ESTree.Node): ESTree.Node {
  return unwrapNode(node, { maxDepth: MAX_UNWRAP_DEPTH, sequence: true });
}

/** Static string value of a `case` test: `'ready'` and `` `ready` `` both yield `"ready"`. */
function staticStringTest(node: ESTree.Node): string | null {
  const expression = unwrapExpression(node);
  if (expression.type === 'Literal') return typeof expression.value === 'string' ? expression.value : null;
  if (expression.type === 'TemplateLiteral') {
    if (expression.expressions.length > 0 || expression.quasis.length !== 1) return null;
    return expression.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/**
 * `true` for a numeric `case` test — `400`, `-1`, `0x1f`, `262n`. A switch whose every non-`default`
 * case is numeric dispatches over an open protocol space (HTTP status, `ts.SyntaxKind`), which the
 * audit's D tier blesses; it is never an Effect tagged union, whose discriminator is a string.
 */
function isNumericTest(node: ESTree.Node): boolean {
  const expression = unwrapExpression(node);
  if (expression.type === 'Literal') {
    return typeof expression.value === 'number' || typeof expression.value === 'bigint';
  }
  if (expression.type === 'UnaryExpression' && (expression.operator === '-' || expression.operator === '+')) {
    return isNumericTest(expression.argument);
  }
  return false;
}

/** Static property name of a member access: `a._tag` and `a['_tag']` both yield `"_tag"`. */
function memberPropertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  return staticStringTest(node.property);
}

/**
 * The discriminant property when the switch dispatches on a tag or closed-vocabulary field
 * (`error._tag`, `error.reason._tag`, `result.state`, `accessEvidencePolicy.captureMode`), else `null`.
 *
 * `kind` distinguishes Effect's own discriminator — which is always a string and therefore always
 * reports — from the domain vocabulary names (`status`, `kind`, `state`, …), which double as the
 * natural spelling of an open numeric protocol space and must first be shown not to be one.
 */
function discriminantProperty(
  node: ESTree.Node,
  options: RuleOptions,
): { name: string; kind: 'tag' | 'vocabulary' } | null {
  if (node.type !== 'MemberExpression') return null;
  const name = memberPropertyName(node);
  if (name === null) return null;
  if (options.tagProperties.includes(name)) return { name, kind: 'tag' };
  return options.discriminantProperties.includes(name) ? { name, kind: 'vocabulary' } : null;
}

/** Render `error.reason._tag` for the message; falls back to the raw source text, collapsed. */
function describeDiscriminant(context: Context, node: ESTree.Node): string {
  const parts: string[] = [];
  let current: ESTree.Node = unwrapExpression(node);
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    if (current.type === 'Identifier') {
      parts.unshift(current.name);
      return parts.join('.');
    }
    if (current.type === 'ThisExpression') {
      parts.unshift('this');
      return parts.join('.');
    }
    if (current.type !== 'MemberExpression') break;
    const name = memberPropertyName(current);
    if (name === null) break;
    parts.unshift(name);
    current = unwrapExpression(current.object);
  }
  const text = context.sourceCode.getText(node).replace(/\s+/gu, ' ').trim();
  if (text.length === 0) return '…';
  return text.length > MAX_DISCRIMINANT_LENGTH ? `${text.slice(0, MAX_DISCRIMINANT_LENGTH - 1)}…` : text;
}

/** Statements of a `default:` branch, unwrapping the common single-block form. */
function defaultStatements(node: ESTree.SwitchCase): readonly ESTree.Node[] {
  const consequent = node.consequent;
  if (consequent.length === 1 && consequent[0]?.type === 'BlockStatement') return consequent[0].body;
  return consequent;
}

function isNeverAnnotation(node: ESTree.Node | null | undefined): boolean {
  if (node === null || node === undefined) return false;
  if (node.type === 'TSTypeAnnotation') return node.typeAnnotation.type === 'TSNeverKeyword';
  return node.type === 'TSNeverKeyword';
}

function isExhaustiveHelperCall(node: ESTree.Node, options: RuleOptions, bindings: EffectBindings): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = unwrapExpression(node.callee);
  if (callee.type === 'Identifier') return options.exhaustiveHelpers.includes(callee.name);
  if (callee.type !== 'MemberExpression') return false;
  const member = effectMember(callee, bindings);
  if (member !== null) return options.exhaustiveHelpers.includes(member.member);
  const name = memberPropertyName(callee);
  return name !== null && options.exhaustiveHelpers.includes(name);
}

function statementExpression(statement: ESTree.Node): ESTree.Node | null | undefined {
  if (statement.type === 'ReturnStatement' || statement.type === 'ThrowStatement') return statement.argument;
  return statement.type === 'ExpressionStatement' ? statement.expression : null;
}

function statementIsExhaustive(statement: ESTree.Node, options: RuleOptions, bindings: EffectBindings): boolean {
  if (statement.type === 'VariableDeclaration') {
    return statement.declarations.some(
      (declarator) => declarator.id.type === 'Identifier' && isNeverAnnotation(declarator.id.typeAnnotation),
    );
  }
  const expression = statementExpression(statement);
  if (expression === null || expression === undefined) return false;
  if (
    (expression.type === 'TSAsExpression' || expression.type === 'TSSatisfiesExpression') &&
    isNeverAnnotation(expression.typeAnnotation)
  )
    return true;
  return isExhaustiveHelperCall(unwrapExpression(expression), options, bindings);
}

/** `true` when the `default:` branch proves exhaustiveness to the compiler. */
function hasExhaustiveGuard(node: ESTree.SwitchCase, options: RuleOptions, bindings: EffectBindings): boolean {
  return defaultStatements(node).some((statement) => statementIsExhaustive(statement, options, bindings));
}

function summarizeCases(cases: readonly ESTree.SwitchCase[]) {
  const literals: string[] = [];
  let everyCaseIsLiteral = true;
  let testCount = 0;
  let numericTestCount = 0;
  let defaultCase: ESTree.SwitchCase | null = null;
  for (const switchCase of cases) {
    if (switchCase.test === null || switchCase.test === undefined) {
      defaultCase = switchCase;
      continue;
    }
    testCount += 1;
    if (isNumericTest(switchCase.test)) numericTestCount += 1;
    const literal = staticStringTest(switchCase.test);
    if (literal === null) everyCaseIsLiteral = false;
    else literals.push(literal);
  }
  return {
    literals,
    everyCaseIsLiteral,
    defaultCase,
    allTestsNumeric: testCount > 0 && numericTestCount === testCount,
  };
}

function reportSwitch(
  context: Context,
  node: ESTree.SwitchStatement,
  options: RuleOptions,
  literals: readonly string[],
  property: string | null,
): void {
  const adtTag = literals.find((literal) => options.adtTags.includes(literal));
  const messageId = adtTag !== undefined ? 'adtSwitch' : property !== null ? 'tagSwitch' : 'literalSwitch';
  context.report({
    node: node.discriminant,
    messageId,
    data: {
      count: String(literals.length),
      discriminant: describeDiscriminant(context, node.discriminant),
      property: property ?? 'this vocabulary',
      tag: adtTag ?? '',
    },
  });
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A4 + C2 + B5: a `switch` over `_tag` or a closed literal vocabulary is a hand-rolled, ' +
        'non-exhaustive classifier. Dispatch with Match.value(...).pipe(Match.tag / Match.tags / ' +
        'Match.discriminators / Match.when, Match.exhaustive), handle failures on the error channel with ' +
        "Effect.catchTag(s), and use Option.match / Exit.match for Effect's own ADTs.",
    },
    messages: {
      tagSwitch:
        '`switch ({{discriminant}})` hand-writes classification over a tag/vocabulary ' +
        '(audit A4/C2). Dispatch with Match.value(...).pipe(Match.tag / Match.tags / Match.discriminators, ' +
        'Match.exhaustive) so coverage is checked; if this value is an Effect error-channel failure, ' +
        'use Effect.catchTag / Effect.catchTags instead of inspecting `{{property}}` by hand.',
      adtSwitch:
        '`switch ({{discriminant}})` inspects an Effect ADT tag (`{{tag}}`) by hand (audit C2). Use ' +
        'Option.match / Option.isSome, Exit.match / Exit.isFailure, or Match.value(...).pipe(Match.tag, ' +
        'Match.exhaustive) — never a `{{property}}` switch — so absence and failure stay typed and ' +
        'exhaustively handled.',
      literalSwitch:
        '`switch ({{discriminant}})` dispatches on a hand-rolled closed vocabulary of {{count}} string ' +
        'literals with no exhaustiveness guarantee (audit B5/A4). Own the vocabulary with Schema.Literal ' +
        'and branch with Match.value(...).pipe(Match.when / Match.whenOr / Match.discriminators, ' +
        'Match.exhaustive), or model the outcome as a tagged union and use Effect.catchTags.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          tagProperties: { type: 'array', items: { type: 'string' } },
          discriminantProperties: { type: 'array', items: { type: 'string' } },
          minLiteralCases: { type: 'integer', minimum: 1 },
          allowExhaustive: { type: 'boolean' },
          exhaustiveHelpers: { type: 'array', items: { type: 'string' } },
          adtTags: { type: 'array', items: { type: 'string' } },
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          ignoreTests: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        tagProperties: [...DEFAULT_TAG_PROPERTIES],
        discriminantProperties: [...DEFAULT_DISCRIMINANT_PROPERTIES],
        minLiteralCases: DEFAULT_MIN_LITERAL_CASES,
        allowExhaustive: false,
        exhaustiveHelpers: [...DEFAULT_EXHAUSTIVE_HELPERS],
        adtTags: [...DEFAULT_ADT_TAGS],
        include: [...DEFAULT_INCLUDE],
        ignore: [...DEFAULT_IGNORE],
        ignoreTests: false,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore)) return {};
    if (!matchesGlobs(path, options.include)) return {};
    if (options.ignoreTests && isTestFile(path)) return {};

    let bindings: EffectBindings = {
      namespaces: new Map<string, string>(),
      importsEffect: false,
    };

    return {
      Program(node) {
        bindings = collectEffectBindings(node);
      },

      SwitchStatement(node) {
        const discriminant = unwrapExpression(node.discriminant);
        const candidate = discriminantProperty(discriminant, options);

        const { literals, everyCaseIsLiteral, defaultCase, allTestsNumeric } = summarizeCases(node.cases);
        // Numeric protocol spaces are allowed; Effect tag properties remain string discriminators.
        const property = candidate !== null && (candidate.kind === 'tag' || !allTestsNumeric) ? candidate.name : null;

        const closedVocabulary = everyCaseIsLiteral && literals.length >= options.minLiteralCases;
        if (property === null && !closedVocabulary) return;

        if (options.allowExhaustive && defaultCase !== null && hasExhaustiveGuard(defaultCase, options, bindings)) {
          return;
        }

        reportSwitch(context, node, options, literals, property);
      },
    };
  },
});
