import { Context, Effect, Layer } from 'effect';

import { bundleMarketRevisionNativeChild, spawnMarketRevisionNativeOwner } from './market-revision-native.ts';
import type { MarketRevisionNativeArtifact } from './market-revision-native.ts';

/**
 * The bundled child is a pure function of the owner source tree and its build marker: the executor
 * under test is chosen by the spawned child's environment, not by the bundle. A suite that starts
 * several owners therefore builds this once and spawns per test.
 */
export class MarketRevisionNativeBundle extends Context.Service<
  MarketRevisionNativeBundle,
  MarketRevisionNativeArtifact
>()('@app/commerce-market-catalog/tests/fixtures/market-revision-native-bundle/MarketRevisionNativeBundle') {}

export const MarketRevisionNativeBundleLive = Layer.effect(
  MarketRevisionNativeBundle,
  bundleMarketRevisionNativeChild(),
);

/** Starts an owner child from the bundle its suite layer already built. */
export const makeMarketRevisionNativeOwner = Effect.fn('MarketRevisionNativeLauncher.makeFromBundle')(
  function* makeMarketRevisionNativeOwner(
    options: { readonly retirementManagementExecutor?: 'allowed' | 'denied' } = {},
  ) {
    return yield* spawnMarketRevisionNativeOwner(yield* MarketRevisionNativeBundle, options);
  },
);
