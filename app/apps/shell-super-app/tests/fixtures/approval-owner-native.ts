import { Effect, Queue, Ref, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';

import {
  NativeOwnerApprovalConfigurationSchema,
  NativeOwnerApprovalListeningSchema,
  NativeOwnerApprovalReadySchema,
} from '../support/approval-owner-native-protocol.ts';

class NativeOwnerProcessUnavailable extends Schema.TaggedError<NativeOwnerProcessUnavailable>()(
  'NativeOwnerProcessUnavailable',
  { reason: Schema.String, stderr: Schema.String },
) {}

/** Parent Scope owns this one child. The child owns its pools/listener/RPC, not the case database. */
export const launchNativeApprovalOwner = Effect.fn('OwnerApprovalNative.launch')(function* launchNativeApprovalOwner() {
  const diagnostics = yield* Ref.make('');
  const fail = (reason: string) =>
    Ref.get(diagnostics).pipe(
      Effect.flatMap((stderr) => Effect.fail(new NativeOwnerProcessUnavailable({ reason, stderr }))),
    );
  const child = yield* ChildProcess.make(
    process.execPath,
    [new URL('../support/approval-owner-native-child.ts', import.meta.url).pathname],
    {
      cwd: new URL('../../../../', import.meta.url).pathname,
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'pipe',
      stdout: 'pipe',
    },
  );
  const stop = child.isRunning.pipe(
    Effect.flatMap((running) =>
      running ? child.kill({ forceKillAfter: '5 seconds', killSignal: 'SIGTERM' }) : Effect.void,
    ),
    Effect.andThen(child.exitCode),
    Effect.timeoutOrElse({ duration: '10 seconds', orElse: () => fail('The independent owner did not stop') }),
  );
  // Registered after process acquisition, so graceful child cleanup precedes its platform release
  // and, later, the parent fixture's database and graph-projection cleanup.
  yield* Effect.addFinalizer(() => stop.pipe(Effect.asVoid, Effect.orDie));
  yield* child.stderr.pipe(
    Stream.decodeText,
    Stream.runForEach((chunk) => Ref.update(diagnostics, (current) => (current + chunk).slice(0, 32_768))),
    Effect.forkScoped,
  );
  const messages = yield* Queue.unbounded<string>();
  yield* child.stdout.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach((line) => Queue.offer(messages, line)),
    Effect.forkScoped,
  );
  const next = Effect.raceFirst(
    Queue.take(messages),
    child.exitCode.pipe(Effect.flatMap(() => fail('The independent owner exited before readiness'))),
  ).pipe(
    Effect.timeoutOrElse({ duration: '20 seconds', orElse: () => fail('The independent owner did not become ready') }),
  );
  const listening = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(NativeOwnerApprovalListeningSchema))(
    yield* next,
  );
  if (listening.pid !== child.pid || listening.pid === process.pid) {
    return yield* fail('The independent owner does not match the approved process placement');
  }
  const configured = yield* Ref.make(false);
  const configure = Effect.fn('OwnerApprovalNative.configure')(function* configure(
    input: typeof NativeOwnerApprovalConfigurationSchema.Type,
  ) {
    if (yield* Ref.getAndSet(configured, true)) {
      return yield* fail('The independent owner was already configured');
    }
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(NativeOwnerApprovalConfigurationSchema))(input);
    yield* Stream.make(new TextEncoder().encode(encoded)).pipe(Stream.run(child.stdin));
    const ready = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(NativeOwnerApprovalReadySchema))(yield* next);
    if (
      ready.pid !== listening.pid ||
      ready.baseUrl !== listening.baseUrl ||
      ready.deployment.appId !== input.expectedDeployment.appId ||
      ready.deployment.buildMarker !== input.expectedDeployment.buildMarker
    ) {
      return yield* fail('The configured owner does not match its approved process placement');
    }
    return ready;
  });
  return { configure, diagnostics: Ref.get(diagnostics), isRunning: child.isRunning, listening, stop };
});
