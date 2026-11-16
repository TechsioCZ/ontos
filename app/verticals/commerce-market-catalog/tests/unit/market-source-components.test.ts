import { OntosComponentContractSchema } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { marketSourceComponentContracts } from '../fixtures/market-source-components.ts';

it.layer(NodeServices.layer)('Market source component contracts', (suite) => {
  for (const [fileName, before, after] of [
    ['module-federation.config.ts', "'./PageEshops':", "'./UndeclaredPage':"],
    ['reference-topology.json', '"id": "commerce-market-catalog"', '"id": "unplaced-market"'],
  ] as const) {
    suite.effect(`refuses source component metadata when ${fileName} does not bind the owner`, () =>
      Effect.gen(function* refuseUnboundMarketComponent() {
        const fs = yield* FileSystem.FileSystem;
        const failure = yield* Effect.flip(
          marketSourceComponentContracts().pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFileString: (file, encoding) =>
                fs.readFileString(file, encoding).pipe(
                  Effect.map((source) => {
                    if (!file.endsWith(fileName)) {
                      return source;
                    }
                    expect(source).toContain(before);
                    return source.replaceAll(before, after);
                  }),
                ),
            }),
          ),
        );
        expect(Predicate.isTagged(failure, 'MarketSourceComponentUnavailable')).toBe(true);
      }),
    );
  }
  suite.effect('projects actual registered pages as deployment metadata rather than React components', () =>
    Effect.gen(function* actualMarketComponents() {
      const components = yield* marketSourceComponentContracts();
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(OntosComponentContractSchema))(components);
      expect(decoded).toEqual([
        {
          expose: './PageEshops',
          key: 'commerce.market-catalog.page-eshops',
          mfBoundaryId: 'verticalCommerceMarketCatalog',
        },
        {
          expose: './PageMarketDetail',
          key: 'commerce.market-catalog.page-market-detail',
          mfBoundaryId: 'verticalCommerceMarketCatalog',
        },
      ]);
    }),
  );
});
