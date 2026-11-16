import {
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  CoreSearchWorkerSnapshot,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotService } from '@app/core-runtime';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Exit, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { AssetRefSchema } from '../../shared/resources/asset.ts';
import { DeviceRefSchema } from '../../shared/resources/device.ts';
import { DocumentRefSchema } from '../../shared/resources/document.ts';
import { MeterRefSchema } from '../../shared/resources/meter.ts';
import { facilityOperationsRelations } from '../../src/database/schema.ts';
import { loadFacilitySearch } from '../../src/services/facility-search-read.ts';
import { loadFacilitySearchSnapshot } from '../../src/services/facility-search-source.ts';
import { buildFacilitySearchDocuments, publishFacilitySearch } from '../../src/services/facility-search-projection.ts';
import { company, otherCompany, scope, snapshot, tenantId, workerContext } from './facility-search-fixtures.ts';

/** SQL can return null for an absent optional owner field; a number proves malformed evidence stays fatal. */
interface ScriptedSearchRecord {
  readonly archived: boolean;
  readonly id: string;
  readonly text: readonly (number | string | null)[];
  readonly title: string;
  readonly type: 'asset' | 'device' | 'document' | 'meter';
}

const scenario = Effect.fn('FacilitySearchTest.sourceScenario')(function* scenario(
  rowTenant = tenantId,
  rowCompany?: string,
  records: readonly ScriptedSearchRecord[] = snapshot.rows.map(
    ({ legalEntityId: _company, tenantId: _tenant, ...row }) => row,
  ),
) {
  const queries: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
  const scopes: string[] = [];
  const services = yield* Layer.build(
    scriptedPgClientLayer(
      Effect.succeed(
        testSqlConnection((sql, params) => {
          queries.push({ params, sql });
          return Effect.succeed([
            {
              legalEntityId: rowCompany ?? params[1],
              records,
              tenantId: rowTenant,
            },
          ]);
        }),
      ),
    ).pipe(Layer.provide(Reactivity.layer)),
  );
  const executor = yield* makeWithDefaults({ relations: facilityOperationsRelations }).pipe(
    Effect.provideService(PgClient.PgClient, Context.get(services, PgClient.PgClient)),
  );
  const reader: CoreSearchWorkerSnapshotService = {
    read: (_claim, consume) =>
      consume({
        eventWatermark: '12',
        forLegalEntity: (legalEntityId, read) => {
          scopes.push(legalEntityId);
          return read({ select: executor.select.bind(executor) });
        },
        legalEntityIds: [company, otherCompany],
        projectionVersion: '37',
        tenant: () => Effect.die('Tenant SQL forbidden'),
        tenantId,
      }),
  };
  const exit = yield* Effect.exit(
    loadFacilitySearchSnapshot(workerContext('rebuild')).pipe(Effect.provideService(CoreSearchWorkerSnapshot, reader)),
  );
  return { exit, queries, scopes };
});

it.effect('selects only approved labels under explicit tenant/company SQL predicates in every Core company scope', () =>
  Effect.scoped(
    Effect.gen(function* source() {
      const { exit, queries, scopes } = yield* scenario();
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.projectionVersion).toBe('37');
        expect(exit.value.rows.length).toBe(6);
      }
      expect(scopes).toEqual([company, otherCompany]);
      expect(queries.map((q) => q.params)).toEqual([
        [tenantId, company, 'assets', 'security', 'documents', 'meters'],
        [tenantId, otherCompany, 'assets', 'security', 'documents', 'meters'],
      ]);
      expect(
        queries.every(
          (q) => q.sql.includes('jsonb_build_object') && q.sql.includes('"facility_operations"."agenda_states"'),
        ),
      ).toBe(true);
      // Owner snapshot only: the sole join expands the stored service array, never a foreign table or person.
      expect(queries.every((q) => !/\bjoin\s+(?!lateral\b)/iu.test(q.sql))).toBe(true);
      for (const privateField of [
        'note',
        'description',
        'comments',
        'uploadedBy',
        'uploadedAt',
        'body',
        'signature',
        'parties',
        'supplier',
        'history',
        'attachments',
        'contract',
        'administrator',
        'locationDetail',
        'responsible',
        'consumer',
        'readings',
        'readBy',
        'costMinor',
        'photo',
        'voided',
      ]) {
        expect(queries.every((q) => !q.sql.includes(`'${privateField}'`))).toBe(true);
      }
      for (const query of queries) {
        expect(query.sql).toContain("item->'location'->>'label'");
        expect(query.sql).toContain("service->>'title'");
        expect(query.sql).toContain("service->>'nextDueOn'");
        expect(query.sql).toContain("item->'versions'->-1->'file'->>'name'");
        expect(query.sql).toContain("'title', item->>'serialNumber'");
        expect(query.sql).toContain("item->>'status' = 'RETIRED'");
        expect(query.sql).not.toContain("coalesce(item->>'serialNumber', '')");
        // Exact JSON extraction allowlist: never project whole owner records or private subtrees.
        const keys = [...query.sql.matchAll(/->>?'(?<key>[^']+)'/gu)].flatMap((match) =>
          match.groups?.key === undefined ? [] : [match.groups.key],
        );
        const uniqueKeys = [...new Set(keys)];
        expect(uniqueKeys.length).toBe(21);
        for (const key of [
          'assets',
          'category',
          'devices',
          'documents',
          'file',
          'id',
          'inventoryNumber',
          'label',
          'location',
          'medium',
          'meters',
          'name',
          'nextDueOn',
          'serialNumber',
          'services',
          'state',
          'status',
          'supplyPoint',
          'title',
          'unit',
          'versions',
        ]) {
          expect(uniqueKeys).toContain(key);
        }
      }
    }),
  ),
);

it.effect('rejects rows outside the trusted tenant or company', () =>
  Effect.scoped(
    Effect.gen(function* foreignSource() {
      expect(Exit.isFailure((yield* scenario(otherCompany)).exit)).toBe(true);
      expect(Exit.isFailure((yield* scenario(tenantId, otherCompany)).exit)).toBe(true);
    }),
  ),
);

it.effect('rejects a foreign snapshot before owner SQL is reachable', () =>
  Effect.gen(function* foreignSnapshot() {
    let reached = false;
    const exit = yield* Effect.exit(
      loadFacilitySearchSnapshot(workerContext('rebuild')).pipe(
        Effect.provideService(CoreSearchWorkerSnapshot, {
          read: (_context, read) =>
            read({
              eventWatermark: '1',
              forLegalEntity: () =>
                Effect.sync(() => {
                  reached = true;
                }).pipe(Effect.andThen(Effect.die('Foreign SQL'))),
              legalEntityIds: [company],
              projectionVersion: '2',
              tenant: () => Effect.die('Tenant SQL forbidden'),
              tenantId: otherCompany,
            }),
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(reached).toBe(false);
  }),
);

it.effect(
  'publishes every sibling of a valid serialless device with empty optional evidence and strips non-search data',
  () =>
    Effect.scoped(
      Effect.gen(function* optionalEvidence() {
        const records = snapshot.rows.map(({ legalEntityId: _company, tenantId: _tenant, ...row }) => ({
          ...row,
          administrator: 'PRIVATE-ADMIN',
          note: 'PRIVATE-NOTE',
          text: row.type === 'device' ? [row.title, null, '', '  '] : row.text,
          versions: [{ file: { id: 'PRIVATE-FILE-ID', name: 'OLD-PRIVATE-NAME' }, note: 'PRIVATE-VERSION-NOTE' }],
        }));
        const { exit } = yield* scenario(tenantId, undefined, records);
        expect(Exit.isSuccess(exit)).toBe(true);
        if (!Exit.isSuccess(exit)) {
          return;
        }
        const documents = yield* buildFacilitySearchDocuments(exit.value);
        expect(documents.length).toBe(6);
        expect(
          documents
            .filter((document) => document.ref.resourceType === 'facility.operations.device')
            .map((document) => document.searchableText),
        ).toEqual([['Vstupní kamera'], ['Vstupní kamera']]);
        expect(JSON.stringify(documents)).not.toContain('PRIVATE-');

        const store = makeInMemoryCoreSearchProjectionStore();
        const runtime = yield* createCoreSearchQueryRuntime.pipe(
          Effect.provideService(CoreSearchProjectionStore, store),
        );
        yield* publishFacilitySearch(workerContext('rebuild'), exit.value).pipe(
          Effect.provideService(CoreSearchProjectionStore, store),
        );
        const assets = yield* loadFacilitySearch(scope, 'asset', 'cerpadlo', AssetRefSchema).pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
        );
        const devices = yield* loadFacilitySearch(scope, 'device', 'kamera', DeviceRefSchema).pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
        );
        const documentHits = yield* loadFacilitySearch(scope, 'document', 'revizni', DocumentRefSchema).pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
        );
        expect([assets.length, devices.length, documentHits.length]).toEqual([1, 1, 1]);
      }),
    ),
);

it.effect('retains all allowed serial/location/service/filename evidence without exposing it as metadata', () =>
  Effect.scoped(
    Effect.gen(function* approvedEvidence() {
      const texts = [
        ['Čerpadlo', 'INV-01', 'Technologie', 'ASSET-SERIAL', 'Hala Žižkov', 'Revize čerpadla', '2027-03-14'],
        ['Vstupní kamera', 'SN-01'],
        ['Revizní protokol', 'revision', 'revize-čerpadla.pdf'],
      ];
      const records = snapshot.rows.map(({ legalEntityId: _company, tenantId: _tenant, ...row }, index) => ({
        ...row,
        text: texts[index],
      }));
      const { exit } = yield* scenario(tenantId, undefined, records);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) {
        return;
      }
      const documents = yield* buildFacilitySearchDocuments(exit.value);
      expect(documents.map((document) => document.searchableText)).toEqual([...texts, ...texts]);
      expect(
        documents.every((document) => document.metadata.length === 0 && (document.aliases?.length ?? 0) === 0),
      ).toBe(true);
    }),
  ),
);

it.effect('decodes meter-only safe SQL evidence and publishes serial and supply-point hits with sibling records', () =>
  Effect.scoped(
    Effect.gen(function* meterEvidence() {
      const records: readonly ScriptedSearchRecord[] = [
        ...snapshot.rows.map(({ legalEntityId: _company, tenantId: _tenant, ...row }) => row),
        {
          archived: false,
          id: 'meter-1',
          text: ['  EL-ŽIŽKOV-1  ', 'EAN-859182400000000001', 'ELECTRICITY', 'kWh'],
          title: 'EL-ŽIŽKOV-1',
          type: 'meter',
        },
        {
          archived: true,
          id: 'meter-old',
          text: ['EL-OLD', null, 'ELECTRICITY', 'kWh'],
          title: 'EL-OLD',
          type: 'meter',
        },
      ];
      const { exit } = yield* scenario(tenantId, undefined, records);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) {
        return;
      }
      expect(exit.value.rows.length).toBe(10);
      const documents = yield* buildFacilitySearchDocuments(exit.value);
      expect(documents.filter((document) => document.ref.resourceType === 'facility.operations.meter').length).toBe(4);
      const store = makeInMemoryCoreSearchProjectionStore();
      const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      yield* publishFacilitySearch(workerContext('rebuild'), exit.value).pipe(
        Effect.provideService(CoreSearchProjectionStore, store),
      );
      for (const query of ['el-zizkov', 'EAN-859182400000000001']) {
        const hits = yield* loadFacilitySearch(scope, 'meter', query, MeterRefSchema).pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
        );
        expect(hits.map((hit) => hit.ref.resourceId)).toEqual([`${company}.meter-1`]);
      }
      expect(
        yield* loadFacilitySearch(scope, 'meter', 'EL-OLD', MeterRefSchema).pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
        ),
      ).toEqual([]);
      expect(
        (yield* loadFacilitySearch(scope, 'meter', 'EL-OLD', MeterRefSchema, true).pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
        )).map((hit) => hit.ref.resourceId),
      ).toEqual([`${company}.meter-old`]);
    }),
  ),
);

it.effect('does not silently discard malformed non-string evidence from the owner snapshot', () =>
  Effect.scoped(
    Effect.gen(function* malformedEvidence() {
      const records: readonly ScriptedSearchRecord[] = [
        { archived: false, id: 'device-1', text: ['Kamera', 123], title: 'Kamera', type: 'device' },
      ];
      expect(Exit.isFailure((yield* scenario(tenantId, undefined, records)).exit)).toBe(true);
    }),
  ),
);
