import { NodeRuntime, NodeServices, NodeSocketServer } from '@effect/platform-node';
import {
  Clock,
  Console,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Ref,
  Match,
  Schedule,
  Schema,
  Stream,
} from 'effect';
import { Argument, Command } from 'effect/cli';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { readCgroupMemory } from '../../packages/storefront-runtime/src/observability.ts';
import {
  RuntimeHeaderSchema,
  RuntimeTelemetryJson,
  SourceRevision,
} from '../../packages/storefront-runtime/src/telemetry.ts';
import type { CgroupMemory, RuntimeBoot, RuntimeSummary } from '../../packages/storefront-runtime/src/telemetry.ts';

class ArtifactProofFailed extends Schema.TaggedError<ArtifactProofFailed>()('ArtifactProofFailed', {
  reason: Schema.String,
}) {}
const TelemetryEventJson = Schema.fromJsonString(Schema.Struct({ event: RuntimeHeaderSchema.fields.event }));
const loopback = '127.0.0.1';
const availablePort = Effect.gen(function* reservePort() {
  const socket = yield* NodeSocketServer.make({ host: loopback, port: 0 });
  return yield* Match.value(socket.address).pipe(
    Match.tag('UnixPathAddress', () => Effect.fail(new ArtifactProofFailed({ reason: 'Expected an internet socket' }))),
    Match.orElse((address) => Effect.succeed(address.port)),
  );
}).pipe(Effect.scoped);
interface Evidence {
  readonly boot: Option.Option<RuntimeBoot>;
  readonly summary: Option.Option<RuntimeSummary>;
}
export const validateController = (actual: CgroupMemory, runner: CgroupMemory) =>
  actual.version === runner.version &&
  (Option.isNone(runner.currentBytes) || Option.isSome(actual.currentBytes)) &&
  (Option.isNone(runner.oom) || Option.isSome(actual.oom)) &&
  (Option.isNone(runner.oomKill) || Option.isSome(actual.oomKill)) &&
  (runner.limitKind === 'unavailable' ||
    (actual.limitKind === runner.limitKind &&
      Option.getOrNull(actual.limitBytes) === Option.getOrNull(runner.limitBytes)));

const acceptTelemetry = (
  line: string,
  state: Ref.Ref<Evidence>,
  expected: {
    readonly controller: CgroupMemory;
    readonly family: RuntimeSummary['family'];
    readonly pid: number;
    readonly revision: string;
  },
) =>
  Effect.gen(function* acceptMeasurement() {
    if (Option.isNone(Schema.decodeUnknownOption(TelemetryEventJson)(line))) {
      return;
    }
    const event = yield* Schema.decodeUnknownEffect(RuntimeTelemetryJson)(line).pipe(
      Effect.mapError(() => new ArtifactProofFailed({ reason: 'Invalid packaged telemetry contract' })),
    );
    const now = yield* Clock.currentTimeMillis;
    if (
      event.revision !== expected.revision ||
      event.family !== expected.family ||
      event.pid !== expected.pid ||
      now - event.at > Duration.toMillis(Duration.seconds(30)) ||
      event.at > now + Duration.toMillis(Duration.seconds(5))
    ) {
      yield* new ArtifactProofFailed({
        reason: 'Packaged telemetry must originate in the current packaged process and source',
      });
    }
    const current = yield* Ref.get(state);
    if (event.event === 'storefront.runtime.boot') {
      if (Option.isSome(current.boot)) {
        yield* new ArtifactProofFailed({ reason: 'More than one packaged observer' });
      }
      yield* Ref.set(state, { ...current, boot: Option.some(event) });
      return;
    }
    const boot = yield* Effect.fromOption(
      current.boot,
      () => new ArtifactProofFailed({ reason: 'Summary without a packaged boot' }),
    );
    if (
      event.bootId !== boot.bootId ||
      event.at < boot.at ||
      event.family !== boot.family ||
      event.hostname !== boot.hostname ||
      event.service !== boot.service ||
      !validateController(event.cgroup, expected.controller)
    ) {
      yield* new ArtifactProofFailed({ reason: 'Packaged summary does not match its boot or runner controller' });
    }
    yield* Ref.set(state, { ...current, summary: Option.some(event) });
  });

const boundOutput = (bytes: Ref.Ref<number>, chunk: Uint8Array) =>
  Effect.gen(function* checkOutputBound() {
    const total = yield* Ref.updateAndGet(bytes, (size) => size + chunk.length);
    if (total > 1_048_576) {
      yield* new ArtifactProofFailed({ reason: 'Packaged stdout exceeded the proof bound' });
    }
    return chunk;
  });

export const proveArtifact = (directory: string, packageName: RuntimeSummary['family'], revision: string) =>
  Effect.gen(function* proveRelocatedArtifact() {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const cwd = path.resolve(directory);
    if (!(yield* fs.exists(path.join(cwd, packageName, 'server.js')))) {
      yield* new ArtifactProofFailed({ reason: 'Relocated standalone server is missing' });
    }
    const port = yield* availablePort;
    const controller = yield* readCgroupMemory;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [`${packageName}/server.js`], {
        cwd,
        env: { HOSTNAME: loopback, NODE_ENV: 'production', PORT: String(port) },
        extendEnv: true,
        forceKillAfter: Duration.seconds(2),
        stdin: 'ignore',
      }),
    );
    const state = yield* Ref.make<Evidence>({ boot: Option.none(), summary: Option.none() });
    const bytes = yield* Ref.make(0);
    const stdout = child.stdout.pipe(
      Stream.mapEffect((chunk) => boundOutput(bytes, chunk)),
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        acceptTelemetry(line, state, { controller, family: packageName, pid: Number(child.pid), revision }),
      ),
      Effect.andThen(Effect.fail(new ArtifactProofFailed({ reason: 'Packaged stdout ended before proof completed' }))),
    );
    const ready = Effect.gen(function* checkReady() {
      const served = yield* HttpClient.get(`http://${loopback}:${port}/robots.txt`).pipe(
        Effect.map((response) => response.status === 200),
        Effect.scoped,
        Effect.timeout(Duration.seconds(1)),
        Effect.orElseSucceed(() => false),
      );
      const evidence = yield* Ref.get(state);
      return served && Option.isSome(evidence.boot) && Option.isSome(evidence.summary);
    }).pipe(Effect.repeat({ schedule: Schedule.spaced(Duration.millis(100)), until: (complete) => complete }));
    yield* Effect.raceFirst(
      ready,
      Effect.all(
        [
          stdout,
          Stream.runDrain(child.stderr),
          child.exitCode.pipe(
            Effect.flatMap(() =>
              Effect.fail(new ArtifactProofFailed({ reason: 'Packaged server exited before proof completed' })),
            ),
          ),
        ],
        { concurrency: 'unbounded' },
      ),
    );
    if (!(yield* child.isRunning)) {
      yield* new ArtifactProofFailed({ reason: 'Packaged server is no longer running' });
    }
    yield* Console.log(
      `PASS relocated ${packageName}: serves HTTP; one observer; source ${revision}; cgroup ${controller.version}:${controller.limitKind}`,
    );
  }).pipe(
    Effect.scoped,
    Effect.timeout(Duration.seconds(30)),
    Effect.mapError(
      () => new ArtifactProofFailed({ reason: 'Relocated artifact proof failed; raw child output withheld' }),
    ),
  );

const command = Command.make(
  'prove-storefront-artifact',
  {
    directory: Argument.String('relocated-dir'),
    packageName: Argument.Literals('package', ['akros-storefront', 'n1-storefront']),
    revision: Argument.String('revision').pipe(Argument.withSchema(SourceRevision)),
  },
  ({ directory, packageName, revision }) => proveArtifact(directory, packageName, revision),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Command.run({ version: '1.0.0' })(command).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
  );
}
