// Using an already-built runtime is not construction: `runtime.runPromise` is the prescribed shape.
import type { Effect, ManagedRuntime } from 'effect';

export interface HostRuntime {
  readonly runtime: ManagedRuntime.ManagedRuntime<never, never>;
}

export const runWithHost = async <A>(
  host: HostRuntime,
  effect: Effect.Effect<A>,
): Promise<A> => host.runtime.runPromise(effect);

export const runSyncWithHost = <A>(host: HostRuntime, effect: Effect.Effect<A>): A =>
  host.runtime.runSync(effect);
