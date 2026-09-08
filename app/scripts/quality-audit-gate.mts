#!/usr/bin/env node
import { Console, Data, Effect, FileSystem, Match, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { runQualityCli } from './quality-cli-lifecycle.mts';

const FALLOW_FILES = 'fallow-files';
const FALLOW_HEALTH = 'fallow-health';
const Count = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
);
const PositiveCount = Count.check(Schema.isGreaterThan(0));
const Counts = Schema.Record(Schema.String, Count);
const base = {
  diagnostic: Schema.Literal(''),
  files: PositiveCount,
  findings: Count,
  status: Schema.Literal('reported'),
};
const primary = { ...base, advisory: Schema.Literal(false) };
const tokenCoverage = Schema.Struct({ tokenEligibleFiles: PositiveCount });
const ResultSchema = Schema.Union([
  Schema.Struct({
    ...primary,
    coverage: Schema.Struct({
      findingCounts: Counts,
      modeledUsages: Count,
      nativeFindingCounts: Counts,
      processed: PositiveCount,
      total: PositiveCount,
      workspaces: Schema.Array(Schema.NonEmptyString).check(
        Schema.isMinLength(1)
      ),
    }),
    name: Schema.Literal('knip'),
  }),
  Schema.Struct({
    ...primary,
    coverage: tokenCoverage,
    name: Schema.Literal('jscpd'),
  }),
  Schema.Struct({
    ...primary,
    coverage: Schema.Struct({ discoveredFiles: PositiveCount }),
    name: Schema.Literal(FALLOW_FILES),
  }),
  Schema.Struct({
    ...primary,
    coverage: tokenCoverage,
    name: Schema.Literal('fallow-clones'),
  }),
  Schema.Struct({
    ...base,
    advisory: Schema.Literal(true),
    coverage: tokenCoverage,
    name: Schema.Literal('fallow-similarity'),
  }),
  Schema.Struct({
    ...primary,
    coverage: Schema.Struct({
      analyzedFiles: PositiveCount,
      analyzedFunctions: PositiveCount,
      controlFlowFindings: Count,
      uiOnlyFindings: Count,
      weightedFindings: Count,
    }),
    name: Schema.Literal(FALLOW_HEALTH),
  }),
]);
const Summary = Schema.fromJsonString(
  Schema.Struct({
    results: Schema.Array(ResultSchema),
    status: Schema.Literal('reported'),
  })
);

class QualityAuditGateError extends Data.TaggedError('QualityAuditGateError')<{
  message: string;
}> {}
const reject = (message: string) =>
  Effect.fail(new QualityAuditGateError({ message }));
const sum = (counts: Readonly<Record<string, number>>) =>
  Object.values(counts).reduce((total, count) => total + count, 0);

const consistent = (entry: typeof ResultSchema.Type) =>
  Match.value(entry).pipe(
    Match.when({ name: 'knip' }, (result) => {
      const { files, findings } = result;
      const knip = result.coverage;
      const keys = Object.keys(knip.findingCounts);
      return (
        keys.length > 0 &&
        keys.length === Object.keys(knip.nativeFindingCounts).length &&
        keys.every(
          (key) =>
            knip.nativeFindingCounts[key] ===
            (knip.findingCounts[key] ?? 0) +
              (key === 'unlisted' ? knip.modeledUsages : 0)
        ) &&
        sum(knip.findingCounts) === findings &&
        sum(knip.nativeFindingCounts) === findings + knip.modeledUsages &&
        knip.processed === files &&
        knip.total === files
      );
    }),
    Match.when({ name: FALLOW_FILES }, (result) => {
      const { files, findings } = result;
      return result.coverage.discoveredFiles === files && findings === 0;
    }),
    Match.when({ name: FALLOW_HEALTH }, (result) => {
      const { files, findings } = result;
      const health = result.coverage;
      return (
        health.analyzedFiles === files &&
        health.controlFlowFindings === findings &&
        health.weightedFindings === findings + health.uiOnlyFindings &&
        health.weightedFindings <= health.analyzedFunctions
      );
    }),
    Match.orElse(
      (result) => result.coverage.tokenEligibleFiles === result.files
    )
  );

export const validateQualityAuditSummary = Effect.fn(
  'qualityAuditGate.validate'
)(function* validateQualityAuditSummaryEffect(source: string) {
  const summary = yield* Schema.decodeEffect(Summary)(source).pipe(
    Effect.mapError(
      (cause) =>
        new QualityAuditGateError({
          message: `Malformed audit summary: ${String(cause)}`,
        })
    )
  );
  // The schema admits exactly six names; cardinality plus uniqueness requires all of them.
  if (
    summary.results.length !== 6 ||
    new Set(summary.results.map(({ name }) => name)).size !== 6
  ) {
    return yield* reject(
      'Audit gate requires all six unique analyzer results; run the full audit'
    );
  }
  for (const result of summary.results) {
    if (!consistent(result)) {
      return yield* reject(
        `${result.name}: inconsistent audit counts or incomplete analysis`
      );
    }
  }
  const discovery = summary.results.find(({ name }) => name === FALLOW_FILES);
  const health = summary.results.find(({ name }) => name === FALLOW_HEALTH);
  if (discovery?.files !== health?.files) {
    return yield* reject('Fallow discovery and health coverage disagree');
  }
  const findings = summary.results.filter(
    (result) => !result.advisory && result.findings > 0
  );
  const details = findings
    .map(({ findings: count, name }) => `${name}=${count}`)
    .join(', ');
  if (findings.length > 0) {
    return yield* reject(`Quality audit gate failed: ${details}`);
  }
  return yield* Effect.void;
});

const cli = Command.make(
  'quality-audit-gate',
  {
    summary: Flag.string('summary').pipe(
      Flag.withDefault('.codex/reports/quality-audit/summary.json')
    ),
  },
  ({ summary }) =>
    Effect.gen(function* qualityAuditGateCommand() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL('..', import.meta.url));
      yield* validateQualityAuditSummary(
        yield* fs.readFileString(path.resolve(root, summary))
      );
      yield* Console.log(
        'Quality audit gate passed (semantic similarity remains advisory)'
      );
    })
);

if (Schema.is(Schema.Struct({ main: Schema.Literal(true) }))(import.meta)) {
  runQualityCli(Command.run(cli, { version: '1.0.0' }));
}
