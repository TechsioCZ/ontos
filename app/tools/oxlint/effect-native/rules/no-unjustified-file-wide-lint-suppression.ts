/**
 * Audit finding: **A8** — "Fix the generators before generating more code"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`). A8's Effect v4 target ends with an explicit
 * instruction: "Bring `scripts/` and `tools/oxlint` under explicit TypeScript and anti-slop gates.
 * **Govern file-wide Effect diagnostic suppressions with narrow justifications and expiry/removal
 * criteria.**"
 *
 * Roughly 96 files in this workspace open with a file-wide `eslint-disable` / `oxlint-disable` block.
 * They switch off `promise/prefer-await-to-then`, `promise/prefer-await-to-callbacks`,
 * `promise/avoid-new`, `no-await-in-loop`, `no-promise-executor-return`, `max-classes-per-file`,
 * `typescript/no-non-null-assertion` and friends — precisely the diagnostics that fire at the
 * Promise/Effect seams A9 ("Preserve typed Effects through the frontend"), A2 and A5 are supposed to
 * remove. Each carries a prose justification, none carries an expiry or a removal criterion, and the
 * suppression is file-wide rather than pinned to the one line that needs it. The result is that the
 * seam is silenced for the whole file forever: new Promise-first code lands under an old waiver, and
 * the lint signal that would have flagged it never fires again.
 *
 * A file-wide waiver is a *decision with an owner and an end date*, not a formatting nicety. This rule
 * makes the four properties of a governed waiver mandatory: it must name exact rules, it must not
 * cover an Effect/Promise seam rule at file scope at all, it must carry a real justification after
 * `--`, and that justification must state when or under what condition it is removed.
 *
 * What is detected
 * - Every block or line comment whose trimmed text starts with `eslint-disable` or `oxlint-disable`
 *   and is *not* `-disable-next-line` / `-disable-line` (those are already line-scoped and pass).
 *   Each such comment is reported once when it fails any of:
 *   1. **no rule list** — a bare `/* eslint-disable *\/` silences every rule in the file;
 *   2. **Effect/Promise seam rule** — the rule list intersects `effectSeamRules`; these are never
 *      acceptable at file scope, because they mark the exact boundaries the audit is migrating
 *      (`effectSeamRulesAlwaysReport`, default `true`);
 *   3. **missing/thin justification** — no ` -- <why>` description, or one shorter than
 *      `minJustificationLength` characters;
 *   4. **no expiry** — the justification does not state an expiry or removal criterion matching
 *      `expiryPattern` (e.g. `expires: 2026-12-31`, `remove-when: A9 browser runtime lands`,
 *      `tracked in: #1234`).
 * - `// @effect-diagnostics <name>:off` (when `includeEffectDiagnosticsDirectives`, default `true`).
 *   A8's sentence says "file-wide **Effect diagnostic** suppressions" literally, and these are them:
 *   119 files switch off `asyncFunction`, `newPromise`, `processEnv`, `globalDate`,
 *   `globalDateInEffect`, `anyUnknownInErrorContext` and `nodeBuiltinImport` for the whole file — the
 *   Effect language-service diagnostics that flag A9 Promise-first code, A5 ambient `process.env`, A6
 *   ambient `Date` and A2 untyped error channels. None of them carries a justification at all. They are
 *   held to the same bar: a `--` justification of at least `minJustificationLength`, plus an expiry.
 * - `@ts-nocheck` (when `includeTsNocheck`, default `true`): the type-level equivalent — it disables
 *   the entire type checker for a file and can never be justified or expired at all.
 * - All in-scope paths including tests, scripts, scaffolds and `.tsx`: A8 is explicitly about scripts
 *   and generators, and the test suites carry the largest share of the seam suppressions.
 *
 * What is deliberately allowed
 * - `// oxlint-disable-next-line <rule> -- <why>` and `// oxlint-disable-line <rule> -- <why>`. A
 *   line-scoped waiver next to the React callback, the Node process edge or the framework adapter it
 *   covers is exactly the "single outer process/framework adapter seam" the audit's "Existing patterns
 *   to preserve" section blesses. Only unbounded disables are governed here; a later enable must restore every named rule.
 * - `eslint-enable` / `oxlint-enable` comments, and any comment that merely mentions a directive in
 *   prose or inside a nested block-comment body.
 * - A file-wide waiver that names non-seam rules, justifies itself, and states an expiry or removal
 *   criterion — the governed shape this rule asks for.
 * - `@ts-expect-error -- <why>`: a single-line, self-expiring escape hatch (it errors once the
 *   underlying problem is fixed), including the audit's blessed "deliberately malformed casts in tests".
 * - Files matching `ignorePaths` (default: none; production config excludes fixtures) or outside `paths`.
 *
 * Known limitation
 * - A bare `/* eslint-disable *\/` is reported by criterion 1, but oxlint applies its own directive
 *   handling before plugin diagnostics are collected, so a blanket disable also swallows this rule's
 *   own report. This workspace currently contains zero blanket disables, so nothing is lost today; the
 *   behaviour is pinned by `valid/packages/core-runtime/src/blanket-disable-swallowed-by-oxlint.ts`.
 *
 * Report-only: no fixer, no suggestion. Nothing in `apps/`, `verticals/`, `packages/`, `scripts/` or
 * `tools/` is edited to satisfy this rule, and no disable comment is added to silence it.
 */
import { defineRule } from '@oxlint/plugins';

import type { Comment, Context } from '@oxlint/plugins';

import { globToRegExp, normalisePath } from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production defaults instead of forcing the
 * fixture config to pass loosened options (which `run-on-repo.mts` reuses against the real repo).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

/** A8 names `scripts/` and `tools/oxlint` explicitly; the seam suppressions live across all roots. */
const DEFAULT_PATHS: readonly string[] = [
  'apps/**',
  'verticals/**',
  'packages/**',
  'scripts/**',
  'tools/**',
];

/** This rule's own fixtures deliberately contain ungoverned suppressions. */
const DEFAULT_IGNORE_PATHS: readonly string[] = []; // Production config excludes fixtures; synthetic paths stay testable.

/**
 * Diagnostics that fire exactly where Promise code meets Effect code. Silencing one of these for a
 * whole file removes the only automated signal that a Promise-first seam was widened, so a file-wide
 * waiver for them is reported regardless of how well it is justified.
 */
const DEFAULT_EFFECT_SEAM_RULES: readonly string[] = [
  'promise/prefer-await-to-then',
  'promise/prefer-await-to-callbacks',
  'promise/avoid-new',
  'no-await-in-loop',
  'no-promise-executor-return',
  'typescript/no-explicit-any',
  'typescript/no-non-null-assertion',
  'typescript/no-floating-promises',
  'unicorn/no-await-expression-member',
  'complexity',
  'max-classes-per-file',
];

const DEFAULT_MIN_JUSTIFICATION_LENGTH = 20;

const DEFAULT_EXPIRY_PATTERN =
  '\\b(?:expires?|until|remove(?:d|-when)?|removal|tracked(?: in)?|ticket|issue)\\s*[:#]\\s*\\S+';

/** `eslint-disable` / `oxlint-disable` at the very start of the comment body. */
const DIRECTIVE = /^(?:es|ox)lint-disable(?=$|\s)(?<rest>[\s\S]*)$/u;
const ENABLE = /^(?:es|ox)lint-enable(?=$|\s)(?<rest>[\s\S]*)$/u;

/** ESLint's description separator: whitespace, two or more dashes, then whitespace or end of comment. */
const DESCRIPTION_SEPARATOR = /\s-{2,}(?:\s|$)/u;

const TS_NOCHECK = /^(?:\/\s*)?@ts-nocheck\b/u;

/** Effect language-service file-wide directive: `// @effect-diagnostics asyncFunction:off ...`. */
const EFFECT_DIAGNOSTICS = /^@effect-diagnostics(?=$|\s)(?<rest>[\s\S]*)$/u;

/** Only severity-silencing settings are suppressions; raising a severity is not. */
const SILENCED_SEVERITY = new Set(['off', 'none', 'ignore']);

interface RuleOptions {
  readonly effectSeamRules: readonly string[];
  readonly effectSeamRulesAlwaysReport: boolean;
  readonly expiryPattern: string;
  readonly ignorePaths: readonly string[];
  readonly includeEffectDiagnosticsDirectives: boolean;
  readonly includeTsNocheck: boolean;
  readonly minJustificationLength: number;
  readonly paths: readonly string[];
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
  const minimum = record.minJustificationLength;
  const pattern = record.expiryPattern;
  return {
    effectSeamRules: stringArray(record.effectSeamRules, DEFAULT_EFFECT_SEAM_RULES),
    effectSeamRulesAlwaysReport: boolean(record.effectSeamRulesAlwaysReport, true),
    expiryPattern: typeof pattern === 'string' ? pattern : DEFAULT_EXPIRY_PATTERN,
    ignorePaths: stringArray(record.ignorePaths, DEFAULT_IGNORE_PATHS),
    includeEffectDiagnosticsDirectives: boolean(record.includeEffectDiagnosticsDirectives, true),
    includeTsNocheck: boolean(record.includeTsNocheck, true),
    minJustificationLength:
      typeof minimum === 'number' && Number.isFinite(minimum) && minimum >= 0
        ? minimum
        : DEFAULT_MIN_JUSTIFICATION_LENGTH,
    paths: stringArray(record.paths, DEFAULT_PATHS),
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function compileExpiry(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'iu');
  } catch {
    try {
      return new RegExp(DEFAULT_EXPIRY_PATTERN, 'iu');
    } catch {
      return null;
    }
  }
}

/**
 * `@typescript-eslint/no-explicit-any`, `typescript/no-explicit-any` and `@typescript/no-explicit-any`
 * all name the same diagnostic; oxlint and ESLint configs in this workspace use both spellings.
 */
function normaliseRuleName(name: string): string {
  const lower = name.trim().toLowerCase().replace(/^@/u, '');
  if (lower.startsWith('eslint/')) return lower.slice('eslint/'.length);
  return lower.startsWith('typescript-eslint/')
    ? `typescript/${lower.slice('typescript-eslint/'.length)}`
    : lower;
}

/** Rule names in a directive are comma- and/or whitespace-separated. */
function parseRuleList(text: string): readonly string[] {
  return text
    .split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function quoteList(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(', ');
}

interface Directive {
  readonly justification: string | null;
  readonly rules: readonly string[];
}

/** Split a directive body at ESLint's ` -- ` description separator. */
function splitDescription(body: string): {
  readonly description: string | null;
  readonly head: string;
} {
  const separator = DESCRIPTION_SEPARATOR.exec(body);
  if (separator === null) return { description: null, head: body };
  return {
    description: body.slice(separator.index + separator[0].length).trim(),
    head: body.slice(0, separator.index),
  };
}

/** Parse a file-wide disable directive, or `null` when the comment is not one. */
function parseDirective(value: string): Directive | null {
  const trimmed = value.trim();
  const match = DIRECTIVE.exec(trimmed);
  if (match === null) return null;
  const rest = match.groups?.rest ?? '';
  // `-disable-next-line`, `-disable-line` and any other `-disable-…` suffix are not file-wide.
  if (rest.startsWith('-')) return null;
  const parsed = splitDescription(rest);
  return { justification: parsed.description, rules: parseRuleList(parsed.head) };
}

/** The justification and expiry criteria, shared by every kind of file-wide waiver. */
function justificationReasons(
  justification: string | null,
  options: RuleOptions,
  expiry: RegExp | null,
): readonly string[] {
  if (justification === null) return ['it carries no `-- <why>` justification'];
  if (justification.length < options.minJustificationLength) {
    return [
      `its justification is ${justification.length} characters, under the ${options.minJustificationLength} required`,
    ];
  }
  if (expiry !== null && !expiry.test(justification)) {
    return ['its justification states no expiry or removal criterion'];
  }
  return [];
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A8 (with A9/A2/A5): require file-wide `eslint-disable` / `oxlint-disable` blocks to name ' +
        'exact non-seam rules, carry a justification after `--`, and state an expiry or removal criterion. ' +
        'Effect/Promise seam waivers must be line- or region-scoped, and `@ts-nocheck` is never allowed.',
    },
    messages: {
      ungovernedSuppression:
        'File-wide lint suppression is not governed ({{reason}}). Scope it to the one line that needs it ' +
        '(`// oxlint-disable-next-line {{rule}} -- <why>`), list the exact rules, justify it after `--`, and ' +
        'state an expiry or removal criterion (e.g. `remove-when: A9 browser runtime lands`, ' +
        '`expires: 2026-12-31`, `tracked in: #1234`). Audit A8: an unexpiring file-wide waiver keeps the ' +
        'whole file exempt forever, so new code lands under an old decision.',
      ungovernedSeamSuppression:
        'File-wide lint suppression is not governed ({{reason}}). {{rules}} marks an Effect/Promise seam the ' +
        'audit is removing (A9 typed Effects through the frontend, A2 typed failures, A5 Effect-native ' +
        'scripts), so it must never be silenced for a whole file: pin it to the single adapter line ' +
        '(`// oxlint-disable-next-line {{rule}} -- <why>`) or delete the seam by moving the Promise boundary ' +
        'into one `ManagedRuntime` / `Effect.tryPromise` adapter. Add a justification after `--` and an ' +
        'expiry or removal criterion (e.g. `remove-when: A9 browser runtime lands`).',
      ungovernedEffectDiagnostics:
        'File-wide Effect diagnostic suppression is not governed ({{reason}}). Turning {{rules}} off for a ' +
        'whole file is exactly what audit A8 says to govern: it silences the Effect language service at the ' +
        'seam it is meant to guard (`asyncFunction`/`newPromise` — A9 typed Effects; `processEnv` — A5 ' +
        '`Config`/`ConfigProvider`; `globalDate`/`globalDateInEffect` — A6 `Clock`/`DateTime`; ' +
        '`anyUnknownInErrorContext` — A2 typed failure channels). Fix the seam, or narrow the waiver: add ' +
        'a `--` justification and an expiry or removal criterion (e.g. ' +
        '`-- Rspack externals use a callback API. remove-when: A9 browser runtime lands`).',
      tsNocheck:
        '`@ts-nocheck` disables the type checker for this entire file, which is the strongest possible ' +
        'ungoverned suppression and cannot carry a rule list or an expiry. Audit A8 requires generated and ' +
        'script code to be brought *under* explicit TypeScript gates, not exempted from them: fix or ' +
        'regenerate the file, or narrow the escape hatch to a single justified `@ts-expect-error` line.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          effectSeamRules: { type: 'array', items: { type: 'string' } },
          effectSeamRulesAlwaysReport: { type: 'boolean' },
          expiryPattern: { type: 'string' },
          ignorePaths: { type: 'array', items: { type: 'string' } },
          includeEffectDiagnosticsDirectives: { type: 'boolean' },
          includeTsNocheck: { type: 'boolean' },
          minJustificationLength: { type: 'number', minimum: 0 },
          paths: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        effectSeamRules: [...DEFAULT_EFFECT_SEAM_RULES],
        effectSeamRulesAlwaysReport: true,
        expiryPattern: DEFAULT_EXPIRY_PATTERN,
        ignorePaths: [...DEFAULT_IGNORE_PATHS],
        includeEffectDiagnosticsDirectives: true,
        includeTsNocheck: true,
        minJustificationLength: DEFAULT_MIN_JUSTIFICATION_LENGTH,
        paths: [...DEFAULT_PATHS],
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.paths)) return {};
    if (matchesGlobs(path, options.ignorePaths)) return {};

    const seamRules = new Set(options.effectSeamRules.map(normaliseRuleName));
    const expiry = compileExpiry(options.expiryPattern);

    const inspect = (comment: Comment, unboundedRules?: readonly string[]): void => {
      if (comment.type === 'Shebang') return;

      if (options.includeTsNocheck && TS_NOCHECK.test(comment.value.trim())) {
        context.report({ node: comment, messageId: 'tsNocheck' });
        return;
      }

      const trimmed = comment.value.trim();
      const effectDiagnostics = EFFECT_DIAGNOSTICS.exec(trimmed);
      if (effectDiagnostics !== null) {
        if (!options.includeEffectDiagnosticsDirectives) return;
        const body = effectDiagnostics.groups?.rest ?? '';
        const parsed = splitDescription(body);
        const silenced = parseRuleList(parsed.head).filter((token) =>
          SILENCED_SEVERITY.has((token.split(':')[1] ?? '').toLowerCase()),
        );
        if (silenced.length === 0) return;
        const reasons = [...justificationReasons(parsed.description, options, expiry)];
        if (silenced.some((token) => token.split(':')[0] === '*'))
          reasons.push('a wildcard suppresses every diagnostic rather than naming exact rules');
        // A file-wide Effect diagnostic waiver is never line-scoped and never narrow, so an
        // ungoverned one is always reported; a justified, expiring one is accepted.
        if (reasons.length === 0) return;
        context.report({
          node: comment,
          messageId: 'ungovernedEffectDiagnostics',
          data: {
            reason: reasons.join('; '),
            rules: quoteList(silenced.map((token) => token.split(':')[0] ?? token)),
          },
        });
        return;
      }

      const parsedDirective = parseDirective(comment.value);
      if (parsedDirective === null) return;
      const directive =
        unboundedRules === undefined
          ? parsedDirective
          : { ...parsedDirective, rules: unboundedRules };

      const reasons: string[] = [];
      const seamHits = directive.rules.filter((name) => seamRules.has(normaliseRuleName(name)));

      if (directive.rules.length === 0) {
        reasons.push('it names no rules, so it silences every rule for the whole file');
      }
      if (options.effectSeamRulesAlwaysReport && seamHits.length > 0) {
        reasons.push(
          `it silences the Effect/Promise seam ${seamHits.length === 1 ? 'rule' : 'rules'} ${quoteList(seamHits)} for the whole file`,
        );
      }
      reasons.push(...justificationReasons(directive.justification, options, expiry));

      if (reasons.length === 0) return;

      const messageId = seamHits.length > 0 ? 'ungovernedSeamSuppression' : 'ungovernedSuppression';
      const named = seamHits.length > 0 ? seamHits : directive.rules;
      context.report({
        node: comment,
        messageId,
        // `rule` is bare so it reads as code inside the `oxlint-disable-next-line` example;
        // `rules` is back-ticked for the prose sentence.
        data: {
          reason: reasons.join('; '),
          rule: named.length > 0 ? named.join(', ') : '<rule>',
          rules: named.length > 0 ? quoteList(named) : 'This blanket waiver',
        },
      });
    };

    return {
      Program(node) {
        const comments = context.sourceCode.getAllComments?.() ?? node.comments;
        // A later enable bounds the region only for the rules it actually restores.
        // Partial enables must not hide rules left disabled through EOF.
        for (const [index, comment] of comments.entries()) {
          const directive = parseDirective(comment.value);
          if (directive !== null) {
            const remaining = new Set(directive.rules.map(normaliseRuleName));
            let bounded = false;
            for (const later of comments.slice(index + 1)) {
              const enable = ENABLE.exec(later.value.trim());
              if (enable === null) continue;
              const rules = parseRuleList(splitDescription(enable.groups?.rest ?? '').head);
              if (rules.length === 0) {
                bounded = true;
                break;
              }
              for (const name of rules) remaining.delete(normaliseRuleName(name));
              if (directive.rules.length > 0 && remaining.size === 0) {
                bounded = true;
                break;
              }
            }
            if (bounded) continue;
            inspect(comment, [...remaining]);
            continue;
          }
          inspect(comment);
        }
      },
    };
  },
});
