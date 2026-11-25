// Read-only deployed evidence. Never print raw platform logs or credentials.
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Clock, Console, Duration, Effect, Option, Schema, Stream } from 'effect';
import { Argument, Command } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import {
  RuntimeBootSchema,
  RuntimeHeaderSchema,
  RuntimeSummarySchema,
  SourceRevision,
} from '../../packages/storefront-runtime/src/telemetry.ts';
import type { RuntimeSummary } from '../../packages/storefront-runtime/src/telemetry.ts';

export class RuntimeProofFailed extends Schema.TaggedError<RuntimeProofFailed>()('RuntimeProofFailed', {
  reason: Schema.String,
}) {}
const LogRecords = Schema.Array(Schema.Struct({ message: Schema.String }));
const HeaderJson = Schema.fromJsonString(RuntimeHeaderSchema);
const EventTagJson = Schema.fromJsonString(Schema.Struct({ event: RuntimeHeaderSchema.fields.event }));
const SummaryJson = Schema.fromJsonString(RuntimeSummarySchema);
const BootJson = Schema.fromJsonString(RuntimeBootSchema);
const LabelledSummaryJson = Schema.fromJsonString(
  Schema.Struct({ ...RuntimeSummarySchema.fields, label: Schema.String }),
);
const services = [
  ['AKROS', 'pY0EenoKTJC58aFi4gHjhg', 'akros-storefront'],
  ['shop', 'tfB8wJ12QEaW2fCzuIBd2A', 'akros-storefront'],
  ['N1', '2WQe4BcQTMeAHtWsqZpCXQ', 'n1-storefront'],
] as const;
const sameSummary = Schema.toEquivalence(RuntimeSummarySchema);
const sameBootRecord = Schema.toEquivalence(RuntimeBootSchema);

const sameBoot = (summary: RuntimeSummary, boot: typeof RuntimeBootSchema.Type) =>
  boot.at <= summary.at &&
  boot.bootId === summary.bootId &&
  boot.pid === summary.pid &&
  boot.revision === summary.revision &&
  boot.family === summary.family &&
  boot.hostname === summary.hostname &&
  boot.service === summary.service;

export const runtimeEvidence = (
  records: typeof LogRecords.Type,
  revision: string,
  options: {
    readonly family: RuntimeSummary['family'];
    readonly maxAgeMs?: number;
    readonly now?: number;
  },
) =>
  Effect.gen(function* selectEvidence() {
    const now = options.now ?? (yield* Clock.currentTimeMillis);
    const recognized: { readonly header: typeof RuntimeHeaderSchema.Type; readonly message: string }[] = [];
    for (const { message } of records) {
      if (Option.isNone(Schema.decodeUnknownOption(EventTagJson)(message))) {
        continue;
      }
      const header = Schema.decodeUnknownOption(HeaderJson)(message);
      if (Option.isNone(header)) {
        return Option.none<RuntimeSummary>();
      }
      recognized.push({ header: header.value, message });
    }
    const events = recognized.toSorted((left, right) => right.header.at - left.header.at);
    const latestSummary = events.find(({ header }) => header.event === 'storefront.runtime.summary');
    if (latestSummary === undefined) {
      return Option.none<RuntimeSummary>();
    }
    const sample = Schema.decodeUnknownOption(SummaryJson)(latestSummary.message);
    if (Option.isNone(sample)) {
      return sample;
    }
    const summary = sample.value;
    if (
      !events
        .filter(({ header }) => header.event === latestSummary.header.event && header.at === latestSummary.header.at)
        .every(({ message }) =>
          Option.exists(Schema.decodeUnknownOption(SummaryJson)(message), (tied) => sameSummary(summary, tied)),
        )
    ) {
      return Option.none<RuntimeSummary>();
    }
    if (
      summary.revision !== revision ||
      summary.family !== options.family ||
      now - summary.at > (options.maxAgeMs ?? Duration.toMillis(Duration.minutes(1))) ||
      summary.at > now + Duration.toMillis(Duration.seconds(5))
    ) {
      return Option.none<RuntimeSummary>();
    }
    const latestBoot = events.find(({ header }) => header.event === 'storefront.runtime.boot');
    if (latestBoot !== undefined) {
      const boot = Schema.decodeUnknownOption(BootJson)(latestBoot.message);
      if (Option.isNone(boot) || !sameBoot(summary, boot.value)) {
        return Option.none<RuntimeSummary>();
      }
      if (
        !events
          .filter(({ header }) => header.event === latestBoot.header.event && header.at === latestBoot.header.at)
          .every(({ message }) =>
            Option.exists(Schema.decodeUnknownOption(BootJson)(message), (tied) => sameBootRecord(boot.value, tied)),
          )
      ) {
        return Option.none<RuntimeSummary>();
      }
    }
    return sample;
  });

const platformLogs = (service: string) =>
  Effect.gen(function* readLogs() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        'zcli',
        ['service', 'log', '-P', 't1ljmn3DRDafgi8AuPvhdQ', '-S', service, '--limit', '1000', '--format', 'JSON'],
        { forceKillAfter: Duration.seconds(2), stdin: 'ignore' },
      ),
    );
    const output = handle.stdout.pipe(
      Stream.decodeText(),
      Stream.runFoldEffect(
        () => '',
        (text, chunk) =>
          text.length + chunk.length <= 2_097_152
            ? Effect.succeed(text + chunk)
            : Effect.fail(new RuntimeProofFailed({ reason: 'Platform log output exceeded the proof bound' })),
      ),
    );
    const [raw, , code] = yield* Effect.all([output, Stream.runDrain(handle.stderr), handle.exitCode], {
      concurrency: 'unbounded',
    });
    if (Number(code) !== 0) {
      yield* new RuntimeProofFailed({ reason: 'Platform log command failed' });
    }
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LogRecords))(raw);
  }).pipe(
    Effect.scoped,
    Effect.timeout(Duration.seconds(30)),
    Effect.mapError(() => new RuntimeProofFailed({ reason: 'Deployed runtime logs unavailable' })),
  );

export const command = Command.make(
  'prove-storefront-runtime',
  {
    revision: Argument.String('deployed-full-sha').pipe(Argument.withSchema(SourceRevision)),
  },
  ({ revision }) =>
    Effect.gen(function* proveDeployedRuntime() {
      for (const [label, service, family] of services) {
        const evidence = yield* Effect.fromOption(
          yield* runtimeEvidence(yield* platformLogs(service), revision, { family }),
          () => new RuntimeProofFailed({ reason: `FAIL ${label}: no valid current runtime evidence for ${revision}` }),
        );
        yield* Console.log(yield* Schema.encodeEffect(LabelledSummaryJson)({ ...evidence, label }));
      }
    }),
);

if (import.meta.main) {
  NodeRuntime.runMain(Command.run({ version: '1.0.0' })(command).pipe(Effect.provide(NodeServices.layer)));
}
