import { Clock, Duration, Effect, Exit, Ref } from 'effect';

export interface SpiceDbClientSample {
  readonly durationMs: number;
  readonly event: 'spicedb.channel-setup' | 'spicedb.first-rpc';
  readonly method: string;
  readonly outcome: 'success' | 'failure';
}

declare global {
  /** Shared across independently bundled owners in the same process. No request or credential data. */
  var ontosSpiceDbClientObserver: ((sample: SpiceDbClientSample) => void) | undefined;
  var ontosSpiceDbFirstRpcStarted: Ref.Ref<boolean> | undefined;
}

const recordFirstRpc = (method: string, start: bigint) =>
  Effect.fn('SpiceDb.recordFirstRpc')(function* record<Value, Failure>(exit: Exit.Exit<Value, Failure>) {
    const end = yield* Clock.monotonicTimeNanos;
    const sample: SpiceDbClientSample = {
      durationMs: Duration.toMillis(Duration.nanos(end - start)),
      event: 'spicedb.first-rpc',
      method,
      outcome: Exit.isSuccess(exit) ? 'success' : 'failure',
    };
    yield* Effect.logInfo(sample.event, sample);
    yield* Effect.sync(() => globalThis.ontosSpiceDbClientObserver?.(sample));
  });

/** Report only the first RPC in the process, including timeout, failure and interruption. */
export const observeFirstSpiceDbRpc = (method: string) =>
  Effect.fnUntraced(function* observeFirstRpc<Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>,
  ) {
    const state = globalThis.ontosSpiceDbFirstRpcStarted;
    if (state === undefined || (yield* Ref.getAndSet(state, true))) {
      return yield* effect;
    }
    const start = yield* Clock.monotonicTimeNanos;
    yield* Effect.logInfo('spicedb.first-rpc.start', { method });
    return yield* effect.pipe(Effect.onExit(recordFirstRpc(method, start)));
  });
