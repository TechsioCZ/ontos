import { Layer, ManagedRuntime } from 'effect';
import { runPromise as runtimeRunPromise, runFork as runtimeRunFork } from 'effect/Runtime';
import { runPromise as managedRunPromise } from 'effect/ManagedRuntime';

import type { Effect, Runtime } from 'effect';

declare const appLayer: Layer.Layer<never>;
declare const handle: Runtime.Runtime<never>;
declare const program: Effect.Effect<number>;

const managed = ManagedRuntime.make(appLayer);

/**
 * `Runtime.runPromise` / `ManagedRuntime.runPromise` are the prescribed A1 replacement — the very
 * thing the rule's own message asks for. Importing them by name instead of through the namespace
 * must not be reported: no root fiber is created, the captured runtime handle is applied.
 */
export const promised = runtimeRunPromise(handle)(program);

export const forked = runtimeRunFork(handle);

export const viaManaged = managedRunPromise(managed)(program);
