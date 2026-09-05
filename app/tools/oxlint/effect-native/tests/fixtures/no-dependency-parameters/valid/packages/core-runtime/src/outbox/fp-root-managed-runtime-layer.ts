import { Effect, Layer, ManagedRuntime } from "effect";

// Reduced from packages/core-runtime/src/outbox/process.ts:25-30,77-83.
// `startOutboxWorkerProcess` is the single process-exit adapter at the executable edge: the
// application root composes `outboxWorkerLayer` and hands it here, and this function's only job is
// `ManagedRuntime.make(input.layer)` — exactly A1's "create one ManagedRuntime per long-lived
// host/runtime" target and B3's "keep one small process-exit adapter at the executable edge".
// The requirement is fully transparent in the signature; nothing is reconstructed or hidden, and
// there is no `yield* TheService` that could replace a root layer argument.
class OutboxRuntime extends Effect.Service<OutboxRuntime>()("OutboxRuntime", {
	succeed: { run: () => Effect.void },
}) {}

export interface StartOutboxWorkerProcessInput {
	readonly claimOwnerPrefix: string;
	readonly layer: Layer.Layer<OutboxRuntime>;
}

export const startOutboxWorkerProcess = (input: StartOutboxWorkerProcessInput): void => {
	const runtime = ManagedRuntime.make(input.layer);
	void runtime.runPromise(Effect.void).finally(async () => await runtime.dispose());
};
