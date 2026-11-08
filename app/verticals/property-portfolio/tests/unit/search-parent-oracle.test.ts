import {
  CoreSearchProjectionStore,
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionUnavailable,
  CoreSearchQueryRuntime,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { buildSearchDocuments } from '../../src/search/projection.ts';
import { loadOwnerSearch } from '../../src/search/search-read.ts';
import { searchCompanyId, searchState, searchTenantId } from '../support/search-state.ts';

const scope = {
  authContextRef: 'job:search:run:parent-oracle',
  authMethod: 'system',
  correlationId: 'parent-oracle',
  legalEntityId: searchCompanyId,
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId: searchTenantId,
} as const;
const worker = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: 'parent-oracle',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: 'property.portfolio',
  deliveryId: 'parent-oracle',
  domainEventId: 'parent-oracle',
  messageId: 'parent-oracle',
  producerModuleKey: 'property.portfolio',
  tenantId: searchTenantId,
  tenantSequenceNo: 1n,
  topic: 'property.portfolio.search-refresh-requested.v1',
  workerKey: 'property.portfolio.refresh-search',
});

for (const resource of ['unit', 'asset'] as const) {
  it.effect(`${resource} renamed Machine to Orchid is independent of old denied parent Orchid versus Cedar`, () =>
    Effect.gen(function* renamedChildOracle() {
      const asset = yield* Effect.fromNullishOr(searchState.assets[0]);
      const unit = yield* Effect.fromNullishOr(searchState.units[0]);
      const current = { ...searchState, assets: [{ ...asset, name: 'Orchid' }], units: [{ ...unit, name: 'Orchid' }] };
      const old = { ...searchState, assets: [{ ...asset, name: 'Machine' }], units: [{ ...unit, name: 'Machine' }] };
      const oldDocuments = (yield* buildSearchDocuments({
        companies: [{ legalEntityId: searchCompanyId, state: old }],
        projectionVersion: '1',
        tenantId: searchTenantId,
      })).filter(({ ref }) => ref.resourceType === `property.portfolio.${resource}`);
      const ref = resource === 'unit' ? unit.unitRef : asset.assetRef;
      const key = yield* Schema.decodeUnknownEffect(RecordKeySchema)(ref.resourceId);
      const answers = yield* Effect.forEach(['Orchid', 'Cedar'], (oldDeniedParent) =>
        Effect.gen(function* historicalParentVariant() {
          const store = makeInMemoryCoreSearchProjectionStore();
          yield* store.replace(
            {
              documents: oldDocuments.map((document) => ({
                ...document,
                searchableText: [...document.searchableText, oldDeniedParent],
              })),
              moduleId: 'property.portfolio',
              rebuildVersion: '1',
              resourceType: `property.portfolio.${resource}`,
              tenantId: searchTenantId,
            },
            worker,
          );
          const runtime = yield* createCoreSearchQueryRuntime.pipe(
            Effect.provideService(CoreSearchProjectionStore, store),
          );
          return yield* loadOwnerSearch(
            scope,
            'Orchid',
            `property.portfolio.${resource}`,
            {
              groups: [{ clauses: [{ conditions: [{ _tag: 'RecordKeyIn', recordKeys: [key] }] }] }],
            },
            current,
            [],
          ).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime));
        }),
      );
      const expected = { ref, selectedLegalEntityId: searchCompanyId, title: 'Orchid' };
      const result = [resource === 'asset' ? { ...expected, relevance: { score: 900, version: '1' } } : expected];
      expect(answers).toEqual([result, result]);
    }),
  );
}

for (const resource of ['unit', 'asset'] as const) {
  for (const index of ['absent', 'empty', 'forged', 'unavailable'] as const) {
    it.effect(`${resource} renamed child appears independently of historical index state ${index}`, () =>
      Effect.gen(function* noIndexDependency() {
        const asset = yield* Effect.fromNullishOr(searchState.assets[0]);
        const unit = yield* Effect.fromNullishOr(searchState.units[0]);
        const state = { ...searchState, assets: [{ ...asset, name: 'Orchid' }], units: [{ ...unit, name: 'Orchid' }] };
        const ref = resource === 'unit' ? unit.unitRef : asset.assetRef;
        const forged = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
          archived: false,
          facets: [],
          metadata: [],
          ref: { ...ref, tenantId: '10000000-0000-4000-8000-000000000002' },
          relevance: { score: 1000, version: '1' },
          selectedLegalEntityId: '20000000-0000-4000-8000-000000000002',
          title: 'Forged Orchid parent',
        });
        const operation = loadOwnerSearch(scope, 'Orchid', `property.portfolio.${resource}`, { groups: [] }, state, []);
        let indexObservations = 0;
        const result =
          index === 'absent'
            ? yield* operation
            : yield* operation.pipe(
                Effect.provideService(CoreSearchQueryRuntime, {
                  search: () => {
                    indexObservations += 1;
                    return index === 'unavailable'
                      ? Effect.fail(
                          new CoreSearchProjectionUnavailable({
                            code: 'core_search_projection_unavailable',
                            reason: 'Historical index unavailable',
                          }),
                        )
                      : Effect.succeed(index === 'empty' ? [] : [forged]);
                  },
                }),
              );
        const expected = { ref, selectedLegalEntityId: searchCompanyId, title: 'Orchid' };
        expect(result).toEqual([
          resource === 'asset' ? { ...expected, relevance: { score: 900, version: '1' } } : expected,
        ]);
        expect(indexObservations).toBe(0);
      }),
    );
  }
}
