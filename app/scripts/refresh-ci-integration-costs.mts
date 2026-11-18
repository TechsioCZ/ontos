// From app/: mise exec -- node scripts/refresh-ci-integration-costs.mts <finished-full-run-id>
// Reads GitHub only; it neither starts a run nor changes the task/shard inventory.
import { Array as EffectArray, Effect, FileSystem, Order, Path, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import matrices from './ci-matrices.json' with { type: 'json' };
import { runQualityCli } from './quality-cli-lifecycle.mts';

const repository = 'TechsioCZ/ontos';
const RunIdSchema = Schema.String.check(Schema.isPattern(/^\d+$/u)).pipe(Schema.brand('CiIntegrationTimingRunId'));
const FinishedRunSchema = Schema.Struct({
  conclusion: Schema.String,
  headSha: Schema.String,
  jobs: Schema.Array(Schema.Struct({ conclusion: Schema.String, databaseId: Schema.Int, name: Schema.String })),
  status: Schema.String,
});
const CostTableSchema = Schema.Struct({
  headSha: Schema.String,
  repository: Schema.String,
  runId: RunIdSchema,
  seconds: Schema.Record(Schema.String, Schema.Int),
});
class IntegrationCostInvalid extends Schema.TaggedError<IntegrationCostInvalid>()('IntegrationCostInvalid', {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export const integrationTimings = (log: string) =>
  Effect.gen(function* parseIntegrationTimings() {
    const seconds: Record<string, number> = {};
    for (const match of log.matchAll(
      /Suite wall time: (?<duration>\d+)s slot=\d+ task=(?<task>\S+) status=(?<status>\d+)/gu,
    )) {
      const { duration, status, task } = match.groups ?? {};
      const elapsed = Number(duration);
      if (
        task === undefined ||
        status !== '0' ||
        !Number.isSafeInteger(elapsed) ||
        elapsed <= 0 ||
        seconds[task] !== undefined
      ) {
        return yield* new IntegrationCostInvalid({ reason: `Invalid, failed or duplicate suite timing: ${match[0]}` });
      }
      seconds[task] = elapsed;
    }
    return seconds;
  });

const gh = (args: readonly string[]) =>
  Effect.gen(function* readGithub() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.string(ChildProcess.make('gh', [...args]));
  });

const cli = Command.make(
  'refresh-ci-integration-costs',
  { runId: Argument.String('run-id').pipe(Argument.withSchema(RunIdSchema)) },
  ({ runId }) =>
    Effect.gen(function* refreshIntegrationCosts() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const run = yield* gh(['run', 'view', runId, '-R', repository, '--json', 'status,conclusion,headSha,jobs']).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FinishedRunSchema))),
      );
      if (run.status !== 'completed' || run.conclusion !== 'success') {
        return yield* new IntegrationCostInvalid({ reason: 'Costs require a completed successful full run' });
      }
      const jobs = run.jobs.filter((job) => /^Owner Integration \(\d+\/11\)$/u.test(job.name));
      if (jobs.length !== 11 || jobs.some((job) => job.conclusion !== 'success')) {
        return yield* new IntegrationCostInvalid({ reason: 'Costs require all eleven successful owner rows' });
      }
      // gh run view --log may reuse an incomplete cached log. The job endpoint returns the finished log.
      const logs: string[] = [];
      for (const job of jobs) {
        logs.push(
          yield* gh(['api', '--allow-escape-sequences', `repos/${repository}/actions/jobs/${job.databaseId}/logs`]),
        );
      }
      const seconds = yield* integrationTimings(logs.join('\n'));
      const expected = EffectArray.sort(
        matrices.integration.flatMap((row) => row.tasks ?? []),
        Order.String,
      );
      const actual = EffectArray.sort(Object.keys(seconds), Order.String);
      if (actual.length !== expected.length || actual.some((task, index) => task !== expected[index])) {
        return yield* new IntegrationCostInvalid({
          reason: 'Run timing tasks do not exactly match ci-matrices.json; no costs were written',
        });
      }
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(CostTableSchema, { space: 2 }))({
        headSha: run.headSha,
        repository,
        runId,
        seconds: Object.fromEntries(EffectArray.sortWith(Object.entries(seconds), ([key]) => key, Order.String)),
      });
      const output = yield* path.fromFileUrl(new URL('ci-integration-costs.json', import.meta.url));
      return yield* fs.writeFileString(output, `${encoded}\n`);
    }),
);

if (Schema.is(Schema.Struct({ main: Schema.Literal(true) }))(import.meta)) {
  runQualityCli(Command.run(cli, { version: '1.0.0' }));
}
