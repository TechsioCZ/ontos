// The single blessed browser adapter seam (A9): one ManagedRuntime behind the query/mutation adapter.
import { Effect, Layer, ManagedRuntime } from 'effect';

declare const BrowserServicesLive: Layer.Layer<never>;

export const browserRuntime = ManagedRuntime.make(Layer.orDie(BrowserServicesLive));

export const runQuery = async <A>(effect: Effect.Effect<A>): Promise<A> =>
  browserRuntime.runPromise(effect);
