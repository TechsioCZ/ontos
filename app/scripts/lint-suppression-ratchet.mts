#!/usr/bin/env node
import { Array as EffectArray, Console, Data, Effect, FileSystem, Order, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { parseSync } from 'oxc-parser';

import { runQualityCli } from './quality-cli-lifecycle.mts';

const BASELINE = 'quality-audit/lint-suppressions.json';
const SCOPE = 'quality-audit/scope.json';
const DIRECTIVE = /^\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?(?=\s|$)(?<body>[^]*)$/u;
// A directive without a rule list disables every rule.
const ALL_RULES = '*';

const Count = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));
const Counts = Schema.Record(Schema.String, Count);
const Baseline = Schema.fromJsonString(Schema.Struct({ rules: Counts }), { space: 2 });
const Scope = Schema.fromJsonString(
  Schema.Struct({ exclude: Schema.Array(Schema.String), patterns: Schema.Array(Schema.String) }),
);

class LintSuppressionRatchetError extends Data.TaggedError('LintSuppressionRatchetError')<{
  message: string;
}> {}

export interface SourceFile {
  readonly path: string;
  readonly source: string;
}

/** Rules named by one comment's disable directive, or none when the comment is not a directive. */
const directiveRules = (comment: string): readonly string[] => {
  const body = DIRECTIVE.exec(comment)?.groups?.body;
  if (body === undefined) {
    return [];
  }
  const [ruleList = ''] = body.split(/\s--(?:\s|$)/u);
  // Oxlint accepts comma- and whitespace-separated rule lists.
  const rules = ruleList.split(/[\s,]+/u).filter((rule) => rule.length > 0);
  return rules.length > 0 ? rules : [ALL_RULES];
};

/** Count Oxlint/ESLint disable directives per rule; only real comments count, never string contents. */
export const countLintSuppressions = (files: readonly SourceFile[]): Readonly<Record<string, number>> => {
  const counts = new Map<string, number>();
  for (const file of files) {
    for (const comment of parseSync(file.path, file.source).comments) {
      for (const rule of directiveRules(comment.value)) {
        counts.set(rule, (counts.get(rule) ?? 0) + 1);
      }
    }
  }
  return Object.fromEntries(EffectArray.sort(counts.keys(), Order.String).map((rule) => [rule, counts.get(rule) ?? 0]));
};

export interface SuppressionDelta {
  readonly baseline: number;
  readonly current: number;
  readonly rule: string;
}

const describe = (entries: readonly SuppressionDelta[]) =>
  entries.map(({ baseline: before, current: after, rule }) => `${rule} ${before} -> ${after}`).join(', ');

/** Every rule whose suppression count differs from the committed baseline. */
export const compareLintSuppressions = (
  baseline: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>>,
): readonly SuppressionDelta[] =>
  EffectArray.sort([...new Set([...Object.keys(baseline), ...Object.keys(current)])], Order.String).flatMap((rule) => {
    const delta = { baseline: baseline[rule] ?? 0, current: current[rule] ?? 0, rule };
    return delta.baseline === delta.current ? [] : [delta];
  });

export const checkLintSuppressions = Effect.fn('lintSuppressionRatchet.check')(function* checkLintSuppressionsEffect(
  baselineSource: string,
  current: Readonly<Record<string, number>>,
) {
  const baseline = yield* Schema.decodeEffect(Baseline)(baselineSource).pipe(
    Effect.mapError((cause) => new LintSuppressionRatchetError({ message: `Malformed ${BASELINE}: ${String(cause)}` })),
  );
  const deltas = compareLintSuppressions(baseline.rules, current);
  const increased = deltas.filter(({ baseline: before, current: after }) => after > before);
  const decreased = deltas.filter(({ baseline: before, current: after }) => after < before);
  if (increased.length > 0) {
    yield* new LintSuppressionRatchetError({
      message: `Lint suppressions increased: ${describe(increased)}. Fix the diagnostic, or encode a repeated false positive as a rule exemption instead of disabling it.`,
    });
  }
  if (decreased.length > 0) {
    yield* new LintSuppressionRatchetError({
      message: `Lint suppressions decreased: ${describe(decreased)}. Lower ${BASELINE} with \`pnpm lint:suppressions --update\`.`,
    });
  }
});

const collectSources = Effect.fn('lintSuppressionRatchet.collectSources')(function* collectSourcesEffect(root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Schema.decodeEffect(Scope)(yield* fs.readFileString(path.join(root, SCOPE)));
  const groups = yield* Effect.forEach(
    scope.patterns,
    (pattern) => fs.glob(pattern, { exclude: scope.exclude, root }),
    {
      concurrency: 'unbounded',
    },
  );
  const files = EffectArray.sort([...new Set(groups.flat())], Order.String);
  return yield* Effect.forEach(
    files,
    (file) => Effect.map(fs.readFileString(path.join(root, file)), (source) => ({ path: file, source })),
    { concurrency: 16 },
  );
});

const cli = Command.make(
  'lint-suppression-ratchet',
  { update: Flag.Boolean('update').pipe(Flag.withDefault(false)) },
  ({ update }) =>
    Effect.gen(function* lintSuppressionRatchetCommand() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL('..', import.meta.url));
      const current = countLintSuppressions(yield* collectSources(root));
      const baselinePath = path.join(root, BASELINE);
      if (update) {
        yield* fs.writeFileString(baselinePath, `${yield* Schema.encodeEffect(Baseline)({ rules: current })}\n`);
        yield* Console.log(`Wrote ${BASELINE}`);
        return;
      }
      yield* checkLintSuppressions(yield* fs.readFileString(baselinePath), current);
      yield* Console.log('Lint suppressions match the committed baseline');
    }),
);

if (Schema.is(Schema.Struct({ main: Schema.Literal(true) }))(import.meta)) {
  runQualityCli(Command.run(cli, { version: '1.0.0' }));
}
