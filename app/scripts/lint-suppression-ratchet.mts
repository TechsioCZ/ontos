#!/usr/bin/env node
import { Array as EffectArray, Config, Console, Data, Effect, FileSystem, Order, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
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

class LintSuppressionReportError extends Data.TaggedError('LintSuppressionReportError')<{
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

const signedDelta = ({ baseline, current }: SuppressionDelta) => {
  const delta = current - baseline;
  return delta > 0 ? `+${delta}` : String(delta);
};
const describe = (entry: SuppressionDelta) =>
  `${entry.rule}: ${entry.baseline} -> ${entry.current} (${signedDelta(entry)})`;
const sum = (counts: Readonly<Record<string, number>>) =>
  Object.values(counts).reduce((total, count) => total + count, 0);
const escapeAnnotation = (value: string) =>
  value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const escapeTableCell = (value: string) => value.replaceAll('|', '&#124;').replaceAll('\r', ' ').replaceAll('\n', ' ');

/** Every rule whose suppression count differs from the committed baseline. */
export const compareLintSuppressions = (
  baseline: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>>,
): readonly SuppressionDelta[] =>
  EffectArray.sort([...new Set([...Object.keys(baseline), ...Object.keys(current)])], Order.String).flatMap((rule) => {
    const delta = { baseline: baseline[rule] ?? 0, current: current[rule] ?? 0, rule };
    return delta.baseline === delta.current ? [] : [delta];
  });

export const checkLintSuppressions = Effect.fn('lintSuppressionReport.check')(function* checkLintSuppressionsEffect(
  baselineSource: string,
  current: Readonly<Record<string, number>>,
) {
  const baseline = yield* Schema.decodeEffect(Baseline)(baselineSource).pipe(
    Effect.mapError((cause) => new LintSuppressionReportError({ message: `Malformed ${BASELINE}: ${String(cause)}` })),
  );
  const deltas = compareLintSuppressions(baseline.rules, current);
  const increased = deltas.filter(({ baseline: before, current: after }) => after > before);
  const total = { baseline: sum(baseline.rules), current: sum(current), rule: 'Total' };
  const entries = [...deltas, total];
  if (deltas.length === 0) {
    yield* Console.log('Lint suppressions match the committed baseline');
  }
  yield* Console.log(entries.map(describe).join('\n'));
  const githubActions = yield* Config.String('GITHUB_ACTIONS').pipe(Config.withDefault('false'));
  if (githubActions === 'true') {
    if (increased.length > 0) {
      yield* Console.log(
        `::warning title=Lint suppressions increased::${escapeAnnotation(increased.map(describe).join(', '))}`,
      );
    }
    const summary = yield* Config.String('GITHUB_STEP_SUMMARY');
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      summary,
      [
        '',
        '## Lint suppressions',
        '',
        'Report only. Counts are compared with the committed baseline.',
        '',
        '| Rule | Baseline | Now | Delta |',
        '| --- | ---: | ---: | ---: |',
        ...entries.map(
          (entry) =>
            `| ${escapeTableCell(entry.rule)} | ${entry.baseline} | ${entry.current} | ${signedDelta(entry)} |`,
        ),
        '',
      ].join('\n'),
      { flag: 'a' },
    );
  }
});

const collectSources = Effect.fn('lintSuppressionReport.collectSources')(function* collectSourcesEffect(root: string) {
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
  'lint-suppression-report',
  { update: Flag.Boolean('update').pipe(Flag.withDefault(false)) },
  ({ update }) =>
    Effect.gen(function* lintSuppressionReportCommand() {
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
    }),
);

if (Schema.is(Schema.Struct({ main: Schema.Literal(true) }))(import.meta)) {
  runQualityCli(Command.run(cli, { version: '1.0.0' }));
}
