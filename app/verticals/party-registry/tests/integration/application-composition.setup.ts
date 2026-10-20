import { DatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { Effect, Layer } from 'effect';

import {
  CoreDatabase,
  CoreDatabaseLive,
  publishTestApplicationCompositionAuthority,
} from '@app/core-runtime/testing/owner-evidence';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

export const partyCompositionSnapshot = makeApplicationCompositionSnapshotFixture(
  [ultramodernApiMarker.appId],
  ultramodernApiMarker.buildMarker,
);

const adminDatabaseLive = CoreDatabaseLive.pipe(
  Layer.provide(
    Layer.effect(
      DatabaseConfig,
      loadDatabaseConnectionPair({ envPath: '/dev/null' }).pipe(Effect.map((connections) => connections.admin)),
    ),
  ),
);

const partyAuthorityBootstrap = Layer.effectDiscard(
  Effect.gen(function* publishPartyCompositionAuthority() {
    const { executor } = yield* CoreDatabase;
    const snapshot = yield* partyCompositionSnapshot;
    yield* publishTestApplicationCompositionAuthority(executor, snapshot);
  }),
).pipe(Layer.provide(adminDatabaseLive));

await Effect.runPromise(Effect.scoped(Layer.build(partyAuthorityBootstrap)));
