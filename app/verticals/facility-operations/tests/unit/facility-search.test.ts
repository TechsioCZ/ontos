import {
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { CoreSearchQueryRuntimeService } from '@app/core-runtime';
import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';
import { AssetRefSchema } from '../../shared/resources/asset.ts';
import { DeviceRefSchema } from '../../shared/resources/device.ts';
import { DocumentRefSchema } from '../../shared/resources/document.ts';
import { loadFacilitySearch } from '../../src/search/search-read.ts';
import { buildFacilitySearchDocuments, publishFacilitySearch } from '../../src/services/facility-search-projection.ts';
import type { FacilitySearchSnapshot } from '../../src/services/facility-search-source.ts';
import { company, otherCompany, scope, snapshot, tenantId, workerContext } from './facility-search-fixtures.ts';

const searchFacilityAsset = (runtime: CoreSearchQueryRuntimeService, query: string) =>
  loadFacilitySearch(scope, 'asset', query, AssetRefSchema).pipe(
    Effect.provideService(CoreSearchQueryRuntime, runtime),
  );

const approvedEvidence = (row: FacilitySearchSnapshot['rows'][number]): readonly string[] => {
  if (row.type === 'asset') {
    return [...row.text, 'ASSET-SERIAL-42', 'Hala Žižkov', 'Kontrola čerpadla', '2027-03-14'];
  }
  return row.type === 'document' ? [...row.text, 'revize-čerpadla.pdf'] : row.text;
};

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
      const publish = (source: FacilitySearchSnapshot) =>
        publishFacilitySearch(workerContext('rebuild'), source).pipe(
          Effect.provideService(CoreSearchProjectionStore, store),
        );
      yield* publish(snapshot);
      expect((yield* searchFacilityAsset(runtime, 'cerpadlo')).length).toBe(1);
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
      expect(yield* searchFacilityAsset(runtime, 'cerpadlo')).toEqual([]);
      expect((yield* searchFacilityAsset(runtime, 'novy')).length).toBe(1);
      yield* publish({
        ...snapshot,
        projectionVersion: '3',
        rows: snapshot.rows.map((row) => ({ ...row, archived: true })),
      });
      expect(yield* searchFacilityAsset(runtime, 'cerpadlo')).toEqual([]);
      yield* publish({ ...snapshot, projectionVersion: '4' });
      expect((yield* searchFacilityAsset(runtime, 'cerpadlo')).length).toBe(1);
      yield* publish({ ...snapshot, projectionVersion: '5', rows: [] });
      yield* publish({ ...snapshot, projectionVersion: '1' });
      expect(yield* searchFacilityAsset(runtime, 'cerpadlo')).toEqual([]);
      expect(
        yield* loadFacilitySearch(scope, 'document', 'revizni', DocumentRefSchema).pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
        ),
      ).toEqual([]);
    }),
);

it.effect('does not publish any index data when the snapshot belongs to a different tenant', () =>
  Effect.gen(function* failClosed() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const result = yield* Effect.exit(
      publishFacilitySearch(workerContext('rebuild'), { ...snapshot, tenantId: otherCompany }).pipe(
        Effect.provideService(CoreSearchProjectionStore, store),
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(
      yield* loadFacilitySearch(scope, 'asset', 'cerpadlo', AssetRefSchema).pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
      ),
    ).toEqual([]);
  }),
);

it.effect('publishes the whole snapshot when a valid device has no serial, including legacy blank terms', () =>
  Effect.gen(function* seriallessPublication() {
    const serialless: FacilitySearchSnapshot = {
      ...snapshot,
      rows: snapshot.rows.map((row) => (row.type === 'device' ? { ...row, text: [row.title, '', '   '] } : row)),
    };
    const documents = yield* buildFacilitySearchDocuments(serialless);
    expect(documents.length).toBe(3);
    expect(
      documents.find((document) => document.ref.resourceType === 'facility.operations.device')?.searchableText,
    ).toEqual(['Vstupní kamera']);
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    yield* publishFacilitySearch(workerContext('rebuild'), serialless).pipe(
      Effect.provideService(CoreSearchProjectionStore, store),
    );
    const assets = yield* loadFacilitySearch(scope, 'asset', 'cerpadlo', AssetRefSchema).pipe(
      Effect.provideService(CoreSearchQueryRuntime, runtime),
    );
    const devices = yield* loadFacilitySearch(scope, 'device', 'kamera', DeviceRefSchema).pipe(
      Effect.provideService(CoreSearchQueryRuntime, runtime),
    );
    const documentsFound = yield* loadFacilitySearch(scope, 'document', 'revizni', DocumentRefSchema).pipe(
      Effect.provideService(CoreSearchQueryRuntime, runtime),
    );
    expect([assets.length, devices.length, documentsFound.length]).toEqual([1, 1, 1]);
  }),
);

it.effect('returns verified Core relevance v1 for exact, prefix and identifier facility matches', () =>
  Effect.gen(function* relevance() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    yield* publishFacilitySearch(workerContext('rebuild'), snapshot).pipe(
      Effect.provideService(CoreSearchProjectionStore, store),
    );
    expect((yield* searchFacilityAsset(runtime, 'Čerpadlo'))[0]?.relevance).toEqual({ score: 900, version: '1' });
    expect((yield* searchFacilityAsset(runtime, 'čerp'))[0]?.relevance).toEqual({ score: 800, version: '1' });
    expect((yield* searchFacilityAsset(runtime, 'erpad'))[0]?.relevance).toEqual({ score: 700, version: '1' });
    expect((yield* searchFacilityAsset(runtime, 'INV-01'))[0]?.relevance).toEqual({ score: 100, version: '1' });
  }),
);

it.effect('finds allowed asset and current-file evidence only inside its company and lifecycle', () =>
  Effect.gen(function* evidenceLifecycle() {
    const source: FacilitySearchSnapshot = {
      ...snapshot,
      rows: snapshot.rows.map((row) => ({ ...row, text: approvedEvidence(row) })),
    };
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const publish = (value: FacilitySearchSnapshot) =>
      publishFacilitySearch(workerContext('rebuild'), value).pipe(
        Effect.provideService(CoreSearchProjectionStore, store),
      );
    yield* publish(source);
    for (const query of ['ASSET-SERIAL-42', 'zizkov', 'kontrola', '2027-03-14']) {
      const hits = yield* searchFacilityAsset(runtime, query);
      expect(hits.map((hit) => hit.ref.resourceId)).toEqual([`${company}.asset-1`]);
      const hitKeys = Object.keys(hits[0] ?? {});
      expect(hitKeys.length).toBe(4);
      for (const key of ['ref', 'relevance', 'selectedLegalEntityId', 'title']) {
        expect(hitKeys).toContain(key);
      }
    }
    expect(
      (yield* loadFacilitySearch(scope, 'device', 'SN-01', DeviceRefSchema).pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
      )).map((hit) => hit.ref.resourceId),
    ).toEqual([`${company}.device-1`]);
    expect(
      (yield* loadFacilitySearch(scope, 'document', 'revize-cerpadla.pdf', DocumentRefSchema).pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
      )).map((hit) => hit.ref.resourceId),
    ).toEqual([`${company}.document-1`]);
    for (const foreignScope of [
      { ...scope, legalEntityId: otherCompany },
      { ...scope, tenantId: otherCompany },
    ]) {
      expect(
        yield* loadFacilitySearch(foreignScope, 'asset', 'ASSET-SERIAL-42', AssetRefSchema).pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
        ),
      ).toEqual([]);
    }
    yield* publish({ ...source, projectionVersion: '2', rows: source.rows.map((row) => ({ ...row, archived: true })) });
    expect(yield* searchFacilityAsset(runtime, 'ASSET-SERIAL-42')).toEqual([]);
    yield* publish({ ...snapshot, projectionVersion: '3' });
    expect(yield* searchFacilityAsset(runtime, '2027-03-14')).toEqual([]);
    expect(yield* searchFacilityAsset(runtime, 'ASSET-SERIAL-42')).toEqual([]);
    expect(
      yield* loadFacilitySearch(scope, 'document', 'revize-cerpadla.pdf', DocumentRefSchema).pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
      ),
    ).toEqual([]);
  }),
);
