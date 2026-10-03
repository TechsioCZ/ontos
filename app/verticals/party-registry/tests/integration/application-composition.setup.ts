import {
  DatabaseConfig,
  loadDatabaseConnectionPair,
  lockApplicationCompositionPublication,
  publishApplicationCompositionAuthority,
} from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { Effect, Layer } from 'effect';

import { CoreDatabase, CoreDatabaseLive } from '../../../../packages/core-runtime/src/db/client.ts';
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
    yield* executor.transaction((transaction) =>
      Effect.gen(function* publishInAuthorityTransaction() {
        yield* lockApplicationCompositionPublication(transaction);
        const snapshot = yield* partyCompositionSnapshot;
        yield* publishApplicationCompositionAuthority(transaction, snapshot);
      }),
    );
  }),
).pipe(Layer.provide(adminDatabaseLive));

await Effect.runPromise(Effect.scoped(Layer.build(partyAuthorityBootstrap)));
