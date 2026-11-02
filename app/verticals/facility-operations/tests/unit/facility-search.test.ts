import {
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  ResourceContainmentRelationshipMutation,
  ResourceContainmentMutationUnavailable,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import type { ResourceContainmentRelationshipMutationInput } from '@app/core-runtime';
import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';
import { AssetRefSchema } from '../../shared/resources/asset.ts';
import { DeviceRefSchema } from '../../shared/resources/device.ts';
import { DocumentRefSchema } from '../../shared/resources/document.ts';
import { loadFacilitySearch } from '../../src/search/search-read.ts';
import { buildFacilitySearchDocuments, publishFacilitySearch } from '../../src/services/facility-search-projection.ts';
import type { FacilitySearchSnapshot } from '../../src/services/facility-search-source.ts';
import { company, otherCompany, scope, snapshot, tenantId, workerContext } from './facility-search-fixtures.ts';

it.effect(
  'builds three registered resource types with human titles, company-local identities and only business text',
  () =>
    Effect.gen(function* documents() {
      const docs = yield* buildFacilitySearchDocuments(snapshot);
      expect(docs.map((d) => d.ref.resourceType)).toEqual([
        'facility.operations.asset',
        'facility.operations.device',
        'facility.operations.document',
      ]);
      expect(docs.map((d) => d.title)).toEqual(['Čerpadlo', 'Vstupní kamera', 'Revizní protokol']);
      expect(
        docs.every(
          (d) =>
            d.selectedLegalEntityId === company &&
            d.ref.tenantId === tenantId &&
            d.ref.resourceId.startsWith(`${company}.`),
        ),
      ).toBe(true);
      expect(docs.map((d) => [d.searchableText, d.metadata, d.aliases])).toEqual(
        snapshot.rows.map((row) => [row.text, [], []]),
      );
      const twoCompanies = yield* buildFacilitySearchDocuments({
        ...snapshot,
        rows: [...snapshot.rows, ...snapshot.rows.map((row) => ({ ...row, legalEntityId: otherCompany }))],
      });
      expect(new Set(twoCompanies.map((d) => d.ref.resourceId)).size).toBe(6);
      expect(
        Exit.isFailure(yield* Effect.exit(buildFacilitySearchDocuments({ ...snapshot, tenantId: otherCompany }))),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(buildFacilitySearchDocuments({ ...snapshot, rows: [...snapshot.rows, ...snapshot.rows] })),
        ),
      ).toBe(true);
    }),
);

it.effect(
  'uses the Core index for accent matching, lifecycle changes, archives, deletion, rebuild and stale replay',
  () =>
    Effect.gen(function* lifecycle() {
      const store = makeInMemoryCoreSearchProjectionStore();
      const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      const touches: ResourceContainmentRelationshipMutationInput[] = [];
      const publish = (source: FacilitySearchSnapshot) =>
        publishFacilitySearch(workerContext('rebuild'), source).pipe(
          Effect.provideService(CoreSearchProjectionStore, store),
          Effect.provideService(ResourceContainmentRelationshipMutation, {
            touch: (input) =>
              Effect.sync(() => {
                touches.push(input);
              }),
          }),
        );
      const search = (query: string) =>
        loadFacilitySearch(scope, 'asset', query, AssetRefSchema).pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
        );
      yield* publish(snapshot);
      expect((yield* search('cerpadlo')).length).toBe(1);
      expect(
        (yield* loadFacilitySearch(scope, 'device', 'kamera', DeviceRefSchema).pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
        )).length,
      ).toBe(1);
      expect(
        (yield* loadFacilitySearch(scope, 'document', 'revizni', DocumentRefSchema).pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
        )).length,
      ).toBe(1);
      expect(
        touches
          .flatMap((t) => t.relationships)
          .every((r) => r.container.objectId === toModuleAccessObjectId(tenantId, company, 'facility.operations')),
      ).toBe(true);
      for (const foreignScope of [
        { ...scope, legalEntityId: otherCompany },
        { ...scope, tenantId: otherCompany },
      ]) {
        expect(
          yield* loadFacilitySearch(foreignScope, 'asset', 'cerpadlo', AssetRefSchema).pipe(
            Effect.provideService(CoreSearchQueryRuntime, runtime),
          ),
        ).toEqual([]);
      }
      yield* publish({
        ...snapshot,
        projectionVersion: '2',
        rows: snapshot.rows.map((row) => ({ ...row, text: ['Nový název'], title: 'Nový název' })),
      });
      expect(yield* search('cerpadlo')).toEqual([]);
      expect((yield* search('novy')).length).toBe(1);
      yield* publish({
        ...snapshot,
        projectionVersion: '3',
        rows: snapshot.rows.map((row) => ({ ...row, archived: true })),
      });
      expect(yield* search('cerpadlo')).toEqual([]);
      yield* publish({ ...snapshot, projectionVersion: '4' });
      expect((yield* search('cerpadlo')).length).toBe(1);
      yield* publish({ ...snapshot, projectionVersion: '5', rows: [] });
      yield* publish({ ...snapshot, projectionVersion: '1' });
      expect(yield* search('cerpadlo')).toEqual([]);
      expect(
        yield* loadFacilitySearch(scope, 'document', 'revizni', DocumentRefSchema).pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
        ),
      ).toEqual([]);
    }),
);

it.effect('does not publish any index data when containment fails or the snapshot belongs to a different tenant', () =>
  Effect.gen(function* failClosed() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    let touched = false;
    const result = yield* Effect.exit(
      publishFacilitySearch(workerContext('rebuild'), { ...snapshot, tenantId: otherCompany }).pipe(
        Effect.provideService(CoreSearchProjectionStore, store),
        Effect.provideService(ResourceContainmentRelationshipMutation, {
          touch: () =>
            Effect.sync(() => {
              touched = true;
            }),
        }),
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(touched).toBe(false);
    const denied = yield* Effect.exit(
      publishFacilitySearch(workerContext('rebuild'), snapshot).pipe(
        Effect.provideService(CoreSearchProjectionStore, store),
        Effect.provideService(ResourceContainmentRelationshipMutation, {
          touch: () =>
            Effect.fail(
              new ResourceContainmentMutationUnavailable({ reason: 'Test relationship service unavailable' }),
            ),
        }),
      ),
    );
    expect(Exit.isFailure(denied)).toBe(true);
    expect(
      yield* loadFacilitySearch(scope, 'asset', 'cerpadlo', AssetRefSchema).pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
      ),
    ).toEqual([]);
  }),
);
