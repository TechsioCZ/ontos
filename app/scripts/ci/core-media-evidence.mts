/*
 * The evidence record of one Core Media proof run (#1446 section D.16-18), generated from the Rstest JSON reports
 * run-core-media-proof.sh collected. Nothing in it is written by hand: a declared file whose cases did not all run
 * and pass is FAIL or NOT VERIFIED, and either one fails the command.
 */
import { createHash } from 'node:crypto';

import {
  Array as EffectArray,
  Config,
  Console,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Order,
  Path,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/cli';

import { runQualityCli } from '../quality-cli-lifecycle.mts';

const ReportSchema = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      results: Schema.Array(Schema.Struct({ fullName: Schema.String, status: Schema.String })),
      status: Schema.String,
      testPath: Schema.String,
    }),
  ),
  status: Schema.String,
});
const SettingsSchema = Schema.Record(Schema.String, Schema.String);

export interface RunInput {
  /** The files the run was asked to execute, relative to app/. */
  readonly declared: readonly string[];
  readonly name: string;
  /** The package directory the report's test paths are relative to; empty for app/ itself. */
  readonly packageDirectory: string;
  /** None when the run left no readable report. */
  readonly report: Option.Option<typeof ReportSchema.Type>;
  readonly settings: typeof SettingsSchema.Type;
}

const VerdictSchema = Schema.Literals(['PASS', 'FAIL', 'NOT VERIFIED']);
type Verdict = typeof VerdictSchema.Type;
const [PASS, FAIL, NOT_VERIFIED] = VerdictSchema.literals;

const verdictOf = (verdicts: readonly Verdict[]): Verdict => {
  if (verdicts.includes(FAIL)) {
    return FAIL;
  }
  return verdicts.length === 0 || verdicts.includes(NOT_VERIFIED) ? NOT_VERIFIED : PASS;
};

/** A stable digest of the non-secret settings; the runner never records a credential. */
const fingerprintOf = (settings: typeof SettingsSchema.Type) =>
  createHash('sha256')
    .update(
      EffectArray.sort(Object.keys(settings), Order.String)
        .map((name) => `${name}=${settings[name]}\n`)
        .join(''),
    )
    .digest('hex');

const fileRecord = (run: RunInput, file: string) => {
  const reported = run.report.pipe(
    Option.flatMap((report) =>
      Option.fromUndefinedOr(
        report.files.find(({ testPath }) => [run.packageDirectory, testPath].filter(Boolean).join('/') === file),
      ),
    ),
  );
  const tests = Option.match(reported, { onNone: () => [], onSome: ({ results }) => results });
  const count = (status: string) => tests.filter((test) => test.status === status).length;
  const totals = {
    failed: count('fail'),
    passed: count('pass'),
    // Anything Rstest neither passed nor failed did not run.
    skipped: tests.length - count('pass') - count('fail'),
  };
  // A file can fail with every case green, for example in a suite hook.
  const broken = totals.failed > 0 || Option.exists(reported, ({ status }) => status === 'fail');
  let status: Verdict = PASS;
  if (broken) {
    status = FAIL;
  } else if (totals.skipped > 0 || totals.passed === 0) {
    status = NOT_VERIFIED;
  }
  return { file, status, ...totals, tests: tests.map(({ fullName, status: result }) => ({ fullName, result })) };
};

const runRecord = (run: RunInput) => {
  const files = run.declared.map((file) => fileRecord(run, file));
  // A report can fail without a failed case, for example on an unhandled error.
  const reportFailed = Option.exists(run.report, ({ status }) => status !== 'pass');
  const verdicts = files.map(({ status }) => status);
  return {
    configFingerprint: fingerprintOf(run.settings),
    files,
    name: run.name,
    settings: run.settings,
    status: verdictOf(reportFailed ? [...verdicts, FAIL] : verdicts),
  };
};

export const coreMediaEvidence = (runs: readonly RunInput[]) => {
  const records = runs.map(runRecord);
  const files = records.flatMap((record) => record.files);
  const total = (key: 'failed' | 'passed' | 'skipped') => files.reduce((sum, file) => sum + file[key], 0);
  return {
    runs: records,
    status: verdictOf(records.map(({ status }) => status)),
    totals: { failed: total('failed'), files: files.length, passed: total('passed'), skipped: total('skipped') },
  };
};

const optional = (name: string) => Config.option(Config.String(name)).pipe(Effect.map(Option.getOrNull));

/** Which commit and which CI run produced the reports; every value is null outside GitHub Actions. */
const origin = Effect.gen(function* readOrigin() {
  const repository = yield* optional('GITHUB_REPOSITORY');
  const server = yield* optional('GITHUB_SERVER_URL');
  const runId = yield* optional('GITHUB_RUN_ID');
  return {
    commit: yield* optional('GITHUB_SHA'),
    event: yield* optional('GITHUB_EVENT_NAME'),
    ref: yield* optional('GITHUB_REF'),
    runAttempt: yield* optional('GITHUB_RUN_ATTEMPT'),
    runId,
    runUrl:
      server === null || repository === null || runId === null ? null : `${server}/${repository}/actions/runs/${runId}`,
  };
});

/** One declared run, with whatever it left behind. */
const readRun = Effect.fn('CoreMediaEvidence.readRun')(function* readRun(directory: string, declaration: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const name = declaration.slice(0, -'.files'.length);
  const declared = (yield* fs.readFileString(path.join(directory, declaration))).split('\n').filter(Boolean);
  const settings = yield* fs.readFileString(path.join(directory, `${name}.settings.json`)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SettingsSchema))),
    Effect.orElseSucceed(() => ({})),
  );
  const report = yield* fs
    .readFileString(path.join(directory, `${name}.report.json`))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))), Effect.option);
  return {
    declared,
    name,
    // `<package>/tests/...` names its package; a root file has no such segment and is already relative to app/.
    packageDirectory: /^(?<directory>.+?)\/tests\//u.exec(declared[0] ?? '')?.groups?.['directory'] ?? '',
    report,
    settings,
  } satisfies RunInput;
});

const readRuns = Effect.fn('CoreMediaEvidence.readRuns')(function* readRuns(directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory(directory);
  const declarations = EffectArray.sort(
    entries.filter((entry) => entry.endsWith('.files')),
    Order.String,
  );
  const runs: RunInput[] = [];
  for (const declaration of declarations) {
    runs.push(yield* readRun(directory, declaration));
  }
  return runs;
});

class CoreMediaProofIncomplete extends Schema.TaggedError<CoreMediaProofIncomplete>()('CoreMediaProofIncomplete', {
  reason: Schema.String,
}) {}

const cli = Command.make(
  'core-media-evidence',
  { output: Flag.String('output'), runs: Flag.String('runs') },
  ({ output, runs }) =>
    Effect.gen(function* writeEvidence() {
      const fs = yield* FileSystem.FileSystem;
      const evidence = coreMediaEvidence(yield* readRuns(runs));
      const record = {
        environment: {
          objectStore: 'S3-compatible emulator (MinIO) on the runner. NOT Cloudflare R2 or any hosted provider.',
          requiredRun: 'D20_E2E_REQUIRED=1: a case the run could not execute fails instead of skipping.',
        },
        generatedAt: DateTime.formatIso(yield* DateTime.now),
        origin: yield* origin,
        schema: 'ontos.core-media.ci-evidence/v1',
        ...evidence,
      };
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(record);
      yield* fs.writeFileString(output, `${encoded}\n`);
      for (const run of evidence.runs) {
        for (const file of run.files) {
          yield* Console.log(
            `${file.status}: ${file.file} passed=${file.passed} failed=${file.failed} skipped=${file.skipped}`,
          );
        }
      }
      return yield* evidence.status === PASS
        ? Effect.void
        : Effect.fail(new CoreMediaProofIncomplete({ reason: `The Core Media proof is ${evidence.status}` }));
    }),
);

if (Schema.is(Schema.Struct({ main: Schema.Literal(true) }))(import.meta)) {
  runQualityCli(Command.run(cli, { version: '1.0.0' }));
}
