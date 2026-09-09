/**
 * Audit findings: **A4** — "Rebuild the error system around typed channels and contract-owned Problem
 * Details" and **A6** — "Activate real observability at the runtime roots"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`).
 *
 * A4 counts *"approximately 20 local defect-to-500 seams"* and lists as evidence
 * `apps/shell-super-app/api/index.ts:186`, `verticals/contacts/api/index.ts:179` and
 * `verticals/contacts/api/read-server-support.ts:67`. Its target is explicit: *"Keep unexpected
 * defects in `Cause` until one outer HTTP seam converts them into a sanitized typed internal
 * problem."* A6 asks for the counterpart: *"Establish one outer HTTP instrumentation/error seam."*
 *
 * Today every handler owns its own miniature seam. `apps/shell-super-app/api/index.ts` repeats
 * `Effect.catchCause((cause) => Cause.hasDies(cause) ? log(...).pipe(Effect.andThen(Effect.fail(
 * internalProblem()))) : Effect.failCause(cause))` ten times with copy-pasted correlation logging;
 * the six Contacts read servers and the Contacts action BFF repeat `Effect.catchDefect((defect) =>
 * log(...).pipe(Effect.andThen(Effect.fail(problems.internal()))))`; and the Action/Read transaction
 * engines re-implement the same split with `Cause.hasDies` / `Cause.hasInterrupts` /
 * `Cause.findErrorOption` before throwing a private rollback sentinel.
 *
 * What is detected (in `include` paths, outside `ignore`/`seamPaths`, never in tests or scripts)
 * - Any reference to a namespace-qualified member listed in `members`, i.e. the defect-catching
 *   combinators (`Effect.catchDefect`, `Effect.catchCause`, `Effect.catchAllCause`,
 *   `Effect.catchSomeCause`, `Effect.sandbox`, ...) and the `Cause` decomposition predicates that
 *   split a cause into "expected failure" vs "defect" locally (`Cause.hasDies`, `Cause.hasInterrupts`,
 *   `Cause.findErrorOption`, `Cause.squash`, `Cause.dieOption`, ...).
 * - Data-first and data-last usage are identical: the rule reports the callee reference itself, so
 *   `Effect.catchCause(effect, f)`, `effect.pipe(Effect.catchCause(f))` and the point-free
 *   `pipe(effect, Effect.sandbox)` all report once.
 * - Aliased imports (`import { Effect as Fx, Cause as C } from "effect"`), submodule namespace
 *   imports (`import * as Cause from "effect/Cause"`), root barrel imports
 *   (`import * as E from "effect"` → `E.Cause.hasDies`), direct member imports
 *   (`import { hasDies } from "effect/Cause"`), computed access (`Cause["hasDies"]`) and optional
 *   chaining (`Cause?.hasDies`).
 * - Effect re-export barrels (`reexportModules`, default the Modern.js
 *   `@modern-js/plugin-bff/effect-edge` edge barrel that both BFF entry points import `Effect` from).
 *
 * What is deliberately allowed
 * - Files matching `seamPaths`: the single outer HTTP instrumentation/error seam the audit asks for.
 *   The default names the conventional file (`**​/http-error-seam.ts[x]`); no such file exists yet,
 *   which is exactly the finding. Add the real path once it is built instead of relaxing the rule.
 * - Re-raising a cause unchanged (`Effect.failCause`, `Effect.tapCause` logging, `Cause.fail`,
 *   `Cause.die`, `Cause.pretty`), typed handling (`Effect.catchTag(s)`, exhaustive `Match`), and
 *   `Exit.isFailure` — none of those convert a defect into a response.
 * - Tests (`includeTests`), `scripts/**`, `tools/**`, `dist/**` and declaration files: the audit
 *   targets production request paths. Worker supervisors that intentionally swallow a defect to keep
 *   a poll loop alive are still reported; add their file to `seamPaths` if that is a deliberate,
 *   reviewed seam.
 *
 * Known limitation: without types this cannot prove that a given `Effect.catchCause` really produces
 * a 500. It reports the *seam primitive* wherever it is not the single blessed one. Report-only: this
 * rule never fixes or suggests.
 */
import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree } from '@oxlint/plugins';

import { lookupVariable } from '../shared/bindings.ts';
import { effectOrigin } from '../shared/effect-identity.ts';
import { collectEffectBindings } from '../shared/effect-imports.ts';
import { collectDirectMemberImports, collectNamespaceLocals, splitMembers } from '../shared/imports.ts';
import { optionRecord } from '../shared/options.ts';
import { stringArray } from '../shared/options.ts';
import { isScriptFile, isTestFile, matchesGlobs, scopePath } from '../shared/paths.ts';
import { isInTypePosition, isNonReferencePosition } from '../shared/reference-positions.ts';

const RUNTIME_TS_EXPRESSIONS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**'];

const DEFAULT_IGNORE = ['**/dist/**', '**/build/**', '**/node_modules/**', '**/*.d.ts'];

/**
 * The one outer HTTP instrumentation/error seam A4/A6 asks for. Nothing in the repository matches
 * today; that is the finding, not a bug in the default.
 */
const DEFAULT_SEAM_PATHS = ['**/http-error-seam.ts', '**/http-error-seam.tsx'];

/**
 * Namespace-qualified seam primitives. `Effect.*` catches or exposes the defect channel; `Cause.*`
 * decomposes a cause into "expected failure" vs "defect" at a local site.
 */
const DEFAULT_MEMBERS = [
  'Effect.catchDefect',
  'Effect.catchAllDefect',
  'Effect.catchSomeDefect',
  'Effect.catchCause',
  'Effect.catchAllCause',
  'Effect.catchSomeCause',
  'Effect.catchCauseIf',
  'Effect.sandbox',
  'Cause.hasDies',
  'Cause.isDie',
  'Cause.died',
  'Cause.squash',
  'Cause.squashWith',
  'Cause.dieOption',
  'Cause.findDieOption',
  'Cause.defects',
  'Cause.filterDefects',
  'Cause.hasInterrupts',
  'Cause.isInterrupted',
  'Cause.isInterruptedOnly',
  'Cause.findErrorOption',
  'Cause.failureOrCause',
];

/** Barrels that re-export Effect namespaces verbatim; `Effect` from them is Effect's `Effect`. */
const DEFAULT_REEXPORT_MODULES = ['@modern-js/plugin-bff/effect-edge'];

type RuleOptions = Readonly<ReturnType<typeof readOptions>>;

function readOptions(context: Context) {
  const record = optionRecord(context.options?.[0]);
  return {
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    seamPaths: stringArray(record.seamPaths, DEFAULT_SEAM_PATHS),
    members: stringArray(record.members, DEFAULT_MEMBERS),
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
    includeTests: record.includeTests === true,
    includeScripts: record.includeScripts === true,
  };
}

function isIncludedPath(path: string, options: RuleOptions): boolean {
  if (matchesGlobs(path, options.ignore) || matchesGlobs(path, options.seamPaths)) return false;
  if (!matchesGlobs(path, options.include)) return false;
  if (!options.includeTests && isTestFile(path)) return false;
  return options.includeScripts || !isScriptFile(path);
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A4/A6: no per-handler defect-to-500 seams. `Effect.catchDefect` / `Effect.catchCause` / ' +
        '`Cause.hasDies` / `Cause.findErrorOption` outside the single outer HTTP instrumentation/error seam ' +
        'are seam primitives that require review. Static analysis cannot prove they convert a defect to a response; explicit seamPaths covers reviewed HTTP and worker boundaries.',
    },
    messages: {
      defectCatch:
        'Local defect-channel seam primitive `{{member}}` (audit A4/A6). Preserve Cause and typed failures; own conversion at the outer HTTP or worker boundary, listed in seamPaths. This syntactic rule cannot prove the callback converts a defect or emits HTTP 500.',
      causeInspection:
        'Local Cause inspection primitive `{{member}}` (audit A4/A6). Keep expected failures typed and preserve defects until the owning outer HTTP or worker seam. Review this decomposition and list deliberate seam files in seamPaths; a predicate alone does not prove HTTP conversion.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          seamPaths: { type: 'array', items: { type: 'string' } },
          members: { type: 'array', items: { type: 'string' } },
          reexportModules: { type: 'array', items: { type: 'string' } },
          includeTests: { type: 'boolean' },
          includeScripts: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: DEFAULT_INCLUDE,
        ignore: DEFAULT_IGNORE,
        seamPaths: DEFAULT_SEAM_PATHS,
        members: DEFAULT_MEMBERS,
        reexportModules: DEFAULT_REEXPORT_MODULES,
        includeTests: false,
        includeScripts: false,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (!isIncludedPath(path, options)) return {};

    const { byNamespace, namespaces: watched } = splitMembers(options.members);
    if (byNamespace.size === 0) return {};

    const program = context.sourceCode.ast;
    const bindings = collectEffectBindings(program);
    const { namespaced, barrel } = collectNamespaceLocals(program, bindings, watched, options.reexportModules);
    const directMembers = collectDirectMemberImports(program, byNamespace);
    if (namespaced.size === 0 && barrel.size === 0 && directMembers.size === 0) return {};

    const report = (node: ESTree.Node, namespace: string, member: string): void => {
      context.report({
        node,
        messageId: namespace === 'Cause' ? 'causeInspection' : 'defectCatch',
        data: { member: `${namespace}.${member}` },
      });
    };

    const inspect = (node: ESTree.Node): void => {
      const origin = effectOrigin(context, node, options.reexportModules);
      if (origin?.length !== 2 || !byNamespace.get(origin[0]!)?.has(origin[1]!)) return;
      report(node, origin[0]!, origin[1]!);
    };
    return {
      MemberExpression: inspect,
      Identifier(node) {
        if (isNonReferencePosition(node)) return;
        const variable = lookupVariable(context, node);
        if (!variable?.references.some((reference) => reference.identifier === node && reference.isRead())) return;
        // Type queries and type-member names are not runtime seam references.
        if (isInTypePosition(node, RUNTIME_TS_EXPRESSIONS)) return;
        inspect(node);
      },
    };
  },
});
