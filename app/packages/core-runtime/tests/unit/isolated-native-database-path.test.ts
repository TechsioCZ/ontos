import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, Layer } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../src/testing/module-contract.ts';

for (const purpose of [
  'implementation-1290-assortment-authorization',
  'implementation-1096-privacy-business-reads',
] as const) {
  it.effect(`keeps ${purpose} forbidden in deployed environments before database or process I/O`, () =>
    Effect.scoped(
      Effect.gen(function* rejectsDeployedAssortmentFixture() {
        const context = yield* Layer.build(
          NodeChildProcessSpawner.layer.pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(NodeCrypto.layer),
          ),
        );
        const compositionSnapshot = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'UNIT-GUARD');
        const failure = yield* Effect.flip(
          makeIsolatedNativeDatabaseFixture({
            compositionSnapshot,
            mode: 'schema-only',
            purpose,
          }).pipe(
            Effect.provideContext(context),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' }),
            ),
          ),
        );
        expect(failure).toMatchObject({
          reason: 'Isolated native database fixtures are forbidden in deployed environments',
        });
      }),
    ),
  );
}
