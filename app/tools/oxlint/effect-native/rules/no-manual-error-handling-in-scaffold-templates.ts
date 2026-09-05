/**
 * effect-native/no-manual-error-handling-in-scaffold-templates
 *
 * Audit findings enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *   - **A8** "Fix the generators before generating more code" — "Generators currently emit
 *     Promise-first browser code, repeated route argument types, per-call clients, **manual error
 *     switches**, and—in one stale template—manual JWK parsing that production Contacts had already
 *     replaced." The A8 target is explicit that scaffolds must emit "**exhaustive typed error
 *     handling**". Evidence sites: `scripts/scaffolding/governed-contribution/scaffold.mts:281`,
 *     `scripts/scaffolding/microvertical-page/scaffold.mts:236`.
 *   - **A4** "Rebuild the error system around typed channels and contract-owned Problem Details" —
 *     "Roughly 113 manual `_tag` comparisons […] `_tag ===` inside `Effect.catch` and `mapError`,
 *     non-exhaustive switches". The A4 target: "Use `Effect.catchTag`, `Effect.catchTags`, and
 *     exhaustive `Match`."
 *
 * A8 multiplies A4. A hand-written `switch (error._tag)` in one repository file is one A4 site; the
 * same switch inside a scaffold template is one A4 site *per generated MicroVertical*, forever, and
 * it is the shape every contributor copies because the generator produced it. That is why generated
 * text is held to a stricter standard than the generator's own control flow: nobody reviews emitted
 * code against the architecture, they review the template once.
 *
 * ## What is detected
 *
 * Inside scaffold template files (default `scripts/scaffolding/ ** /*.mts` and `.ts`, tests excluded)
 * every `TemplateElement` — the literal text chunks of a template literal, including tagged
 * templates and templates nested inside other templates — is scanned for manual error-discrimination
 * shapes in the *emitted* code:
 *
 *   1. `switch (error._tag)` / `switch (result.cause._tag)` — a hand-rolled, non-exhaustive
 *      dispatch over the failure vocabulary (`switch\s*\(\s*[\w$.]*\._tag\s*\)`).
 *   2. `error._tag === 'X'` / `error._tag !== 'X'` — a manual tag comparison
 *      (`\._tag\s*[!=]==?`), the exact A4 shape, whether it sits in an `if`, a ternary, an
 *      `Effect.catch` predicate or an `Effect.mapError` mapper.
 *   3. `error instanceof SomethingError` — constructor-identity narrowing of a failure
 *      (`instanceof\s+[A-Za-z_$][\w$]*Error\b`). Effect failures are discriminated by tag, not by
 *      prototype; `instanceof` silently stops working across module realms and Module Federation
 *      remotes, which is exactly where generated MicroVertical code runs.
 *   4. `.catch((error) => { … if ( … ` — a Promise-style catch callback that immediately branches
 *      on the caught value, i.e. an error classifier reconstructed outside the typed channel.
 *
 * Each match highlights the containing quasi/string literal, or the whole template when it crosses
 * an interpolation. This intentionally avoids guessing source offsets from cooked/CRLF text.
 * Overlapping matches from different patterns are reported once.
 *
 * ## What is deliberately allowed
 *
 *   - **The generator's own control flow.** Only text inside template literals is scanned. A
 *     scaffold that itself does `error instanceof Error ? error.message : …` while *writing* files
 *     (`scripts/scaffolding/cli.mts:663`) is a script-level concern owned by `no-throw-in-scripts` /
 *     `no-native-error-construction`, not by this rule.
 *   - **Everything outside `scripts/scaffolding/**`.** Hand-written application code with a `_tag`
 *     comparison is A4's own rule (`no-manual-tag-comparison`, `no-raw-effect-adt-tag-check`); this
 *     rule exists solely for the multiplier.
 *   - **Test files** (`scripts/scaffolding/tests/**`, `*.test.mts`, `*.spec.mts`). The scaffold
 *     golden-output tests *assert on* the generated text and legitimately quote it; the audit also
 *     blesses "deliberately malformed casts in tests".
 *   - **Emitting a tag as data.** `_tag: '${stem}InvalidProblem' as const` is a Schema.TaggedError /
 *     Problem Details literal — the contract-owned vocabulary A4 asks for — and is not a comparison,
 *     so it never matches.
 *   - **Every "Existing patterns to preserve" and D-tier shape.** The single outer process/framework
 *     adapter seam, `Layer.orDie` at a deliberate startup root, correct Drizzle JSONB / HttpApi
 *     serialization, `JSON.stringify` in external test-fixture APIs and native array operations
 *     contain no tag comparison, no `instanceof …Error` and no branching promise `.catch`.
 *   - **Narrow escape hatches, off by default:** `templatePaths` (which files count as templates),
 *     `patterns` (replace the detected shapes wholesale) and `ignore` (path globs never scanned).
 *     The production config passes none of them.
 *
 * Static template and ordinary string fragments are scanned lexically; comments and quoted data
 * in emitted code and direct generator log/shell/error arguments are skipped. Interpolations use
 * opaque placeholders. Generated types, arbitrary aliases, regex literals and helper-returned source
 * are not inferred. A catch member is not proof of Promise identity; direct Effect.catch is excluded
 * from catch diagnostics while its actual tag comparisons still report.
 *
 * Scope lives in the rule, so `oxlint.config.ts` only needs
 * `'effect-native/no-manual-error-handling-in-scaffold-templates': 'error'`.
 *
 * Report-only: no fixers, no suggestions.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree } from '@oxlint/plugins';

import { isTestFile, matchesAny, normalisePath } from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets the fixtures exercise the real production defaults instead of forcing
 * the fixture config to pass loosened options (which `run-on-repo.mts` reuses verbatim).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

/** Scaffold generators: the files whose template literals become every generated MicroVertical. */
const DEFAULT_TEMPLATE_PATHS: readonly string[] = [
  'scripts/scaffolding/**/*.mts',
  'scripts/scaffolding/**/*.ts',
  'scripts/scaffolding/**/*.tsx',
];

/** Manual error-discrimination shapes that must never be emitted. Sources, compiled with `gs`. */
const DEFAULT_PATTERNS: readonly string[] = [
  String.raw`switch\s*\([^;{}]*?(?:\?*\.\s*_tag|\[\s*['"]_tag['"]\s*\])\s*\)`,
  String.raw`(?:\.\s*_tag|\[\s*['"]_tag['"]\s*\]|\b_tag)\s*[!=]==?`,
  String.raw`instanceof\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)*(?!(?:TypeError|RangeError|SyntaxError|ReferenceError|URIError|EvalError|AggregateError)\b)[A-Za-z_$][\w$]*(?:Error|Problem|Failure|Exception|Defect)\b`,
  String.raw`\.\s*catch\s*\(\s*(?:async\s+)?(?:function\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*(?:=>)?\s*\{[^}]*?\b(?:if|switch)\s*\([^{};]*?\b\1\b`,
];

/** Which replacement the diagnostic should name, keyed by the shape that matched. */
const SWITCH_SHAPE = /^switch/u;
const INSTANCEOF_SHAPE = /instanceof/u;
const CATCH_SHAPE = /^\.\s*catch/u;

interface RuleOptions {
  readonly templatePaths: readonly string[];
  readonly patterns: readonly string[];
  readonly ignore: readonly string[];
}

interface Match {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function readOptions(raw: unknown): RuleOptions {
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    templatePaths: stringArray(record.templatePaths, DEFAULT_TEMPLATE_PATHS),
    patterns: stringArray(record.patterns, DEFAULT_PATTERNS),
    ignore: stringArray(record.ignore, []),
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real scaffold paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

/** Compile the configured pattern sources once per file; an invalid source is skipped, not thrown. */
function compilePatterns(sources: readonly string[]): readonly RegExp[] {
  const compiled: RegExp[] = [];
  for (const source of sources) {
    try {
      compiled.push(new RegExp(source, 'gs'));
    } catch {
      // A user-supplied pattern that does not compile disables that pattern rather than the rule.
    }
  }
  return compiled;
}

/** Collapse the matched text to one short, readable line for the diagnostic. */
function snippetOf(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > 72 ? `${flat.slice(0, 69)}…` : flat;
}

/** Which `messageId` names the right Effect-native replacement for this shape. */
function messageIdFor(
  text: string,
): 'tagSwitch' | 'instanceofError' | 'promiseCatchBranch' | 'tagComparison' {
  if (SWITCH_SHAPE.test(text.trimStart())) return 'tagSwitch';
  if (CATCH_SHAPE.test(text.trimStart())) return 'promiseCatchBranch';
  if (INSTANCEOF_SHAPE.test(text)) return 'instanceofError';
  return 'tagComparison';
}

/**
 * All non-overlapping matches of every pattern, earliest first. Longer matches win a tie so
 * `switch (error._tag)` is reported as a switch rather than twice.
 */
function collectMatches(text: string, patterns: readonly RegExp[]): readonly Match[] {
  const found: Match[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      if (
        match[0].length > 0 &&
        !(CATCH_SHAPE.test(match[0]) && /\bEffect\s*$/u.test(text.slice(0, match.index)))
      ) {
        found.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
      }
      // Guard against zero-length matches from a user-supplied pattern.
      if (match[0].length === 0) pattern.lastIndex += 1;
      match = pattern.exec(text);
    }
  }
  found.sort((left, right) => left.start - right.start || right.end - left.end);
  const kept: Match[] = [];
  let consumedTo = -1;
  for (const candidate of found) {
    if (candidate.start < consumedTo) continue;
    kept.push(candidate);
    consumedTo = candidate.end;
  }
  return kept;
}

/** Lexical template inspection, not a type checker or an evaluator of interpolations.
 * Mask comments and (optionally) strings without moving offsets. Dynamic generated fragments,
 * regex literals and arbitrary helper-returned source cannot be fully reconstructed here. */
function maskText(text: string, strings = false): string {
  return text.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/gu,
    (value) => (value.startsWith('/') || strings ? value.replace(/[^\r\n]/g, ' ') : value),
  );
}
/** Log/prose/shell arguments belong to the generator driver, not the emitted module. */
function driverText(node: ESTree.Node): boolean {
  if (
    node.parent?.type === 'ImportDeclaration' ||
    node.parent?.type === 'ImportExpression' ||
    node.parent?.type === 'ExportNamedDeclaration' ||
    node.parent?.type === 'ExportAllDeclaration'
  )
    return true;
  let current = node;
  while (current.parent !== null && current.parent !== undefined) {
    const parent = current.parent;
    if (parent.type === 'CallExpression' || parent.type === 'NewExpression') {
      const callee = parent.callee;
      if (
        callee.type === 'Identifier' &&
        /^(?:Error|TypeError|exec|execSync|execFile|execFileSync|spawn|spawnSync)$/.test(
          callee.name,
        )
      )
        return true;
      if (
        callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        callee.object.name === 'console'
      )
        return true;
      return false;
    }
    if (
      ['VariableDeclarator', 'ReturnStatement', 'TemplateLiteral', 'Program'].includes(parent.type)
    )
      return false;
    current = parent;
  }
  return false;
}

type StringNode = Extract<ESTree.Node, { type: 'TemplateLiteral' | 'Literal' }>;
/** Interpolations are opaque identifier placeholders, not evaluated generator code. */
function emittedText(node: StringNode): string {
  return node.type === 'TemplateLiteral'
    ? node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('_')
    : typeof node.value === 'string'
      ? node.value
      : '';
}
/** Report the containing quasi (or whole literal across quasis), not a guessed raw offset.
 * Cooked text normalises CRLF and escapes, so its character offsets are not source offsets. */
function reportNode(node: StringNode, start: number, end: number): ESTree.Node {
  if (node.type !== 'TemplateLiteral') return node;
  let offset = 0;
  for (const quasi of node.quasis) {
    const length = (quasi.value.cooked ?? quasi.value.raw).length;
    if (start >= offset && end <= offset + length) return quasi;
    offset += length + 1;
  }
  return node;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        "Audit A8/A4: scaffold templates must not emit manual `switch (error._tag)`, `error._tag === '…'`, " +
        '`instanceof SomeError` narrowing or `.catch` classifiers. Generated code must ' +
        'discriminate failures with `Effect.catchTag`/`catchTags` or an exhaustive `Match` over the ' +
        'contract-owned `Schema.TaggedError` vocabulary. Lexical generated-text analysis only: dynamic fragments, error types and binding identities cannot be proven.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#a8-fix-the-generators-before-generating-more-code',
    },
    messages: {
      tagSwitch:
        'Audit A8/A4: this scaffold emits a hand-written `switch` over `_tag` (matched `{{snippet}}`), so every ' +
        'generated MicroVertical inherits hand-rolled dispatch over the failure vocabulary. Emit an exhaustive `Match` instead — ' +
        "`Match.type<ReadCoreError>().pipe(Match.tag('ReadInputValidationError', () => invalidProblem()), …, " +
        'Match.exhaustive)` — so a new `Schema.TaggedError` in the contract is a compile error in every ' +
        'generated module.',
      tagComparison:
        "Audit A8/A4: this scaffold emits a manual `_tag` comparison (matched `{{snippet}}`), multiplying A4's " +
        "~113 hand-written tag checks once per generated MicroVertical. Emit `Effect.catchTag('ActionPrincipalUnavailableError', …)` " +
        '/ `Effect.catchTags({ … })`, or an exhaustive `Match.tag(...)` pipeline over the contract-owned ' +
        '`Schema.TaggedError` vocabulary, so the failure union stays typed instead of being re-derived from a string.',
      instanceofError:
        'Audit A8/A4: this scaffold emits `instanceof`-based failure narrowing (matched `{{snippet}}`). Effect ' +
        'failures are discriminated by tag, not by prototype identity, and `instanceof` breaks across module ' +
        'realms — precisely where generated MicroVertical code runs. Declare the failures on the HttpApi ' +
        'endpoint as `Schema.TaggedError`; use `Schema.is` for unknown adapter errors, or `Effect.catchTags({ … })` / `Match.tag(...)` in typed code.',
      promiseCatchBranch:
        'Audit A8/A4: this scaffold emits a `.catch` callback that branches on the caught value ' +
        '(matched `{{snippet}}`), rebuilding an error classifier instead of tagged failure dispatch in every generated ' +
        'module. Keep the failure in `E`: emit `Effect.catchTag`/`Effect.catchTags` (or `Effect.catchCause` at ' +
        "the single outer seam) over the endpoint's declared error vocabulary rather than a `.catch` with an `if`.",
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          templatePaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs (repo-relative) of generator files whose template literals are scanned. Default: scripts/scaffolding/**/*.mts and **/*.ts.',
          },
          patterns: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Regular-expression sources (compiled with `gs`) replacing the default manual error-handling shapes. Supplying this replaces the defaults wholesale.',
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: 'Globs of template files exempted from this rule (default: none).',
          },
        },
      },
    ],
    defaultOptions: [
      { templatePaths: [...DEFAULT_TEMPLATE_PATHS], patterns: [...DEFAULT_PATTERNS], ignore: [] },
    ],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    const path = scopePath(context.filename);
    if (isTestFile(path)) return {};
    if (!matchesAny(path, options.templatePaths)) return {};
    if (matchesAny(path, options.ignore)) return {};

    const patterns = compilePatterns(options.patterns);
    if (patterns.length === 0) return {};

    function inspect(node: StringNode): void {
      if (driverText(node)) return;
      const text = emittedText(node);
      const code = maskText(text);
      const syntax = maskText(text, true);
      const matches = collectMatches(code, patterns);
      for (const match of matches) {
        if (syntax[match.start] === ' ') continue;
        // `_tag` alone requires an actual destructuring declaration, not a coincidental
        // variable name in prose or application data. Full generated binding flow is unknown.
        if (/^_tag/u.test(match.text) && !/\{\s*_tag\s*\}\s*=/u.test(syntax)) continue;
        context.report({
          node: reportNode(node, match.start, match.end),
          messageId: messageIdFor(match.text),
          data: { snippet: snippetOf(match.text) },
        });
      }
    }
    return {
      TemplateLiteral: inspect,
      Literal(node) {
        if (typeof node.value === 'string') inspect(node);
      },
    };
  },
});
