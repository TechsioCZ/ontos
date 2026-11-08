import { facilityOperationsRegistration } from '../../vertical.registration.ts';
import {
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { CoreSearchQueryRuntimeService } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { NodeCrypto } from '@effect/platform-node';
import { Context, Crypto, Effect, Exit, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { MetersProviderRequestSchema, MetersProviderResponseSchema } from '../../shared/apis/meters-search.ts';
import { MeterRefSchema, meterResourceDescriptor } from '../../shared/resources/meter.ts';
import { metersRead } from '../../src/search/meters.provider.ts';
import { loadFacilitySearch } from '../../src/search/search-read.ts';
import {
  buildFacilitySearchDocuments,
  facilitySearchChanged,
  publishFacilitySearch,
} from '../../src/services/facility-search-projection.ts';
import type { FacilitySearchSnapshot } from '../../src/services/facility-search-source.ts';
import { company, otherCompany, scope, snapshot, tenantId, workerContext } from './facility-search-fixtures.ts';

const meterSnapshot: FacilitySearchSnapshot = {
  ...snapshot,
  rows: [
    ...snapshot.rows,
    {
      archived: false,
      id: 'meter-1',
      legalEntityId: company,
      tenantId,
      text: ['VOD-ŽIŽKOV-42', 'EAN-859182400000000042', 'WATER', 'm³'],
      title: 'VOD-ŽIŽKOV-42',
      type: 'meter',
    },
    {
      archived: true,
      id: 'meter-retired',
      legalEntityId: company,
      tenantId,
      text: ['VOD-OLD-42', 'EAN-859182400000000042', 'WATER', 'm³'],
      title: 'VOD-OLD-42',
      type: 'meter',
    },
  ],
};

const searchMeter = (runtime: CoreSearchQueryRuntimeService, query: string, includeArchived = false) =>
  loadFacilitySearch(scope, 'meter', query, MeterRefSchema, includeArchived).pipe(
    Effect.provideService(CoreSearchQueryRuntime, runtime),
  );

const publish = (source: FacilitySearchSnapshot, store: typeof CoreSearchProjectionStore.Service) =>
  publishFacilitySearch(workerContext('rebuild'), source).pipe(Effect.provideService(CoreSearchProjectionStore, store));

it.effect(
  'finds actual indexed meter serial, supply point, medium and unit with company-qualified local identities',
  () =>
    Effect.gen(function* realHits() {
      const store = makeInMemoryCoreSearchProjectionStore();
      const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      yield* publish(meterSnapshot, store);
      for (const query of ['vod-zizkov', 'EAN-859182400000000042', 'water', 'm³']) {
        const hits = yield* searchMeter(runtime, query);
        expect(hits.map((hit) => hit.ref.resourceId)).toEqual([`${company}.meter-1`]);
        expect(hits[0]?.title).toBe('VOD-ŽIŽKOV-42');
        expect(hits[0]?.selectedLegalEntityId).toBe(company);
        expect(hits[0]?.ref.tenantId).toBe(tenantId);
        expect(Schema.is(MetersProviderResponseSchema)(hits)).toBe(true);
        expect(new Set(Object.keys(hits[0] ?? {}))).toEqual(
          new Set(['ref', 'relevance', 'selectedLegalEntityId', 'title']),
        );
      }
      const hits = yield* searchMeter(runtime, 'VOD-ŽIŽKOV-42');
      expect(hits[0]?.relevance).toEqual({ score: 900, version: '1' });
      // Shell owns the URL adapter: removing exactly the selected-company prefix yields the owner's ?meter=<localid>.
      expect(hits[0]?.ref.resourceId.slice(`${company}.`.length)).toBe('meter-1');
      expect(yield* searchMeter(runtime, 'PRIVATE-NOTE')).toEqual([]);
      const documents = yield* buildFacilitySearchDocuments(meterSnapshot);
      const meter = documents.find((document) => document.ref.resourceType === 'facility.operations.meter');
      expect(meter?.searchableText).toEqual(meterSnapshot.rows[3]?.text);
      expect(meter?.metadata).toEqual([]);
      expect(meter?.aliases).toEqual([]);
      return yield* Effect.void;
    }),
);

it.effect('omits retired meters by default and includes them only under the explicit archive option', () =>
  Effect.gen(function* archives() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    yield* publish(meterSnapshot, store);
    expect(yield* searchMeter(runtime, 'VOD-OLD-42')).toEqual([]);
    expect((yield* searchMeter(runtime, 'VOD-OLD-42', true)).map((hit) => hit.ref.resourceId)).toEqual([
      `${company}.meter-retired`,
    ]);
    expect((yield* searchMeter(runtime, 'EAN-859182400000000042', true)).length).toBe(2);
    return yield* Effect.void;
  }),
);

it.effect(
  'replaces changed meter evidence, removes deletions and rejects stale rebuild replay without result caching',
  () =>
    Effect.gen(function* lifecycle() {
      const store = makeInMemoryCoreSearchProjectionStore();
      const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      yield* publish(meterSnapshot, store);
      expect((yield* searchMeter(runtime, 'VOD-ŽIŽKOV-42')).length).toBe(1);
      yield* publish(
        {
          ...meterSnapshot,
          projectionVersion: '2',
          rows: meterSnapshot.rows.map((row) =>
            row.type === 'meter' ? { ...row, text: ['NOVÉ-MĚŘIDLO-44'], title: 'NOVÉ-MĚŘIDLO-44' } : row,
          ),
        },
        store,
      );
      expect(yield* searchMeter(runtime, 'VOD-ŽIŽKOV-42')).toEqual([]);
      expect((yield* searchMeter(runtime, 'nove-meridlo')).length).toBe(1);
      yield* publish({ ...meterSnapshot, projectionVersion: '3', rows: snapshot.rows }, store);
      yield* publish(meterSnapshot, store);
      expect(yield* searchMeter(runtime, 'VOD-ŽIŽKOV-42', true)).toEqual([]);
      expect(yield* searchMeter(runtime, 'nove-meridlo', true)).toEqual([]);
      return yield* Effect.void;
    }),
);

it.effect('isolates identical local meter IDs by current tenant and company', () =>
  Effect.gen(function* currentScope() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    yield* publish(
      {
        ...meterSnapshot,
        rows: [
          ...meterSnapshot.rows,
          ...meterSnapshot.rows
            .filter((row) => row.type === 'meter')
            .map((row) => ({ ...row, legalEntityId: otherCompany })),
        ],
      },
      store,
    );
    for (const legalEntityId of [company, otherCompany]) {
      const hits = yield* loadFacilitySearch(
        { ...scope, legalEntityId },
        'meter',
        'VOD-ŽIŽKOV-42',
        MeterRefSchema,
      ).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime));
      expect(hits.map((hit) => hit.ref.resourceId)).toEqual([`${legalEntityId}.meter-1`]);
    }
    expect(
      yield* loadFacilitySearch({ ...scope, tenantId: otherCompany }, 'meter', 'VOD-ŽIŽKOV-42', MeterRefSchema).pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
      ),
    ).toEqual([]);
    return yield* Effect.void;
  }),
);

it.effect('rejects forged meter scope, owner, resource type, archive and subject evidence from Core', () =>
  Effect.gen(function* forgedHits() {
    const documents = yield* buildFacilitySearchDocuments(meterSnapshot);
    const meter = documents.find((document) => document.ref.resourceType === 'facility.operations.meter');
    if (meter === undefined) {
      return yield* Effect.die('Missing meter fixture');
    }
    const base = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)(meter);
    for (const forged of [
      { ...base, selectedLegalEntityId: otherCompany },
      { ...base, archived: true },
      { ...base, ref: { ...base.ref, tenantId: otherCompany } },
      { ...base, ref: { ...base.ref, resourceId: `${otherCompany}.meter-1` } },
      { ...base, ref: { ...base.ref, moduleId: 'foreign.owner' } },
      { ...base, ref: { ...base.ref, resourceType: 'facility.operations.asset' } },
      { ...base, subjectRef: base.ref },
      { ...base, matchedRef: base.ref },
      { ...base, matchedSubjectRef: base.ref },
    ]) {
      const hit = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)(forged);
      const result = yield* Effect.exit(searchMeter({ search: () => Effect.succeed([hit]) }, 'VOD-ŽIŽKOV-42'));
      expect(Exit.isFailure(result)).toBe(true);
    }
    return yield* Effect.void;
  }),
);

it.effect('bounds meter query input and preserves exact resource and verified relevance wire contracts', () =>
  Effect.gen(function* wireContracts() {
    for (const query of ['', '   ', '\u0301', 'a'.repeat(201)]) {
      expect(
        Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(MetersProviderRequestSchema)({ query }))),
      ).toBe(true);
    }
    expect(yield* Schema.decodeUnknownEffect(MetersProviderRequestSchema)({ query: '  VOD-42  ' })).toEqual({
      query: 'VOD-42',
    });
    expect(
      yield* Schema.decodeUnknownEffect(MetersProviderRequestSchema)({ includeArchived: true, query: 'VOD-42' }),
    ).toEqual({ includeArchived: true, query: 'VOD-42' });
    const ref = {
      moduleId: 'facility.operations',
      resourceId: `${company}.meter-1`,
      resourceType: 'facility.operations.meter',
      tenantId,
    } as const;
    const refWithoutTenant = {
      moduleId: ref.moduleId,
      resourceId: ref.resourceId,
      resourceType: ref.resourceType,
    } as const;
    const hit = { ref, selectedLegalEntityId: company, title: 'VOD-42' } as const;
    expect(Schema.is(MetersProviderResponseSchema)([hit])).toBe(true);
    for (const score of [0, 1000]) {
      expect(Schema.is(MetersProviderResponseSchema)([{ ...hit, relevance: { score, version: '1' } }])).toBe(true);
    }
    for (const relevance of [
      { score: -1, version: '1' },
      { score: 1001, version: '1' },
      { score: 500.5, version: '1' },
      { score: 500, version: '2' },
    ]) {
      expect(Schema.is(MetersProviderResponseSchema)([{ ...hit, relevance }])).toBe(false);
    }
    for (const invalid of [
      { ref, title: hit.title },
      { ...hit, ref: refWithoutTenant },
      { ...hit, ref: { ...ref, resourceType: 'facility.operations.device' } },
      { ...hit, ref: { ...ref, resourceId: 'a'.repeat(301) } },
    ]) {
      expect(Schema.is(MetersProviderResponseSchema)([invalid])).toBe(false);
    }
    expect(meterResourceDescriptor.capabilities).toEqual({
      graphVisible: false,
      linkable: false,
      mediaAttachable: false,
      searchable: true,
      timelineVisible: false,
    });
    return yield* Effect.void;
  }),
);

it.effect('refreshes every meter mutation through the already registered facility search invalidation seam', () =>
  Effect.gen(function* invalidation() {
    const result = yield* Schema.decodeUnknownEffect(ApplyCommandResultSchema)({
      agenda: 'meters',
      entityIds: ['meter-1'],
      revision: 2,
    });
    expect(facilitySearchChanged(result)).toBe(true);
    return yield* Effect.void;
  }),
);

it.effect('uses the governed Read and canonical operational gate for actual Core meter hits', () =>
  Effect.scoped(
    Effect.gen(function* governedRead() {
      const cryptoServices = yield* Layer.build(NodeCrypto.layer);
      const crypto = Context.get(cryptoServices, Crypto.Crypto);
      const store = makeInMemoryCoreSearchProjectionStore();
      const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      yield* publish(meterSnapshot, store);
      expect(metersRead.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
      expect(metersRead.descriptor.legalEntityScope).toBe('required');
      for (const decision of ['allowed', 'denied', 'unavailable'] as const) {
        const harness = yield* makeReadTestHarness({
          access: 'allowed',
          compositionRevision: 'a'.repeat(64),
          executeOwnerQuery: () =>
            Effect.succeed([
              {
                legalEntityId: company,
                records: meterSnapshot.rows.map(({ archived, id, title }) => ({ archived, id, title })),
                tenantId,
              },
            ]),
          operationTime: new Date('2026-11-03T01:00:00Z'),
          ownerAuthorizationDecision: 'allowed',
          ownerRegistration: facilityOperationsRegistration,
          permissionDecision: 'allowed',
          scope,
        }).pipe(Effect.provideService(Crypto.Crypto, crypto));
        const gate = makeTestAccessDecision({
          answers: {
            'facility.operations.api-records.read': {
              outcome: ({ allowed: 'ALLOWED', denied: 'DENIED', unavailable: 'UNAVAILABLE' } as const)[decision],
            },
          },
        });
        let searched = false;
        const result = yield* Effect.exit(
          harness.runtime
            .runRead({
              input: { query: 'vod-zizkov' },
              principal: scope,
              registration: metersRead,
              transport: { correlationId: scope.correlationId },
            })
            .pipe(
              Effect.provideService(AccessDecisionGate, gate),
              Effect.provideService(CoreSearchQueryRuntime, {
                search: (input, trusted) => {
                  searched = true;
                  return runtime.search(input, trusted);
                },
              }),
            ),
        );
        if (decision !== 'unavailable' && Exit.isFailure(result)) {
          return yield* Effect.failCause(result.cause);
        }
        expect(Exit.isSuccess(result)).toBe(decision !== 'unavailable');
        expect(searched).toBe(decision === 'allowed');
        expect(gate.askedDecisions.map((question) => question.carrier.accessDeclaration?.key)).toEqual([
          'facility.operations.api-records.read',
          'facility.operations.records-restricted.read',
          'facility.operations.apply-command.write',
        ]);
        if (Exit.isSuccess(result)) {
          expect(result.value.map((hit) => hit.ref.resourceId)).toEqual(
            decision === 'allowed' ? [`${company}.meter-1`] : [],
          );
        }
      }
      return yield* Effect.void;
    }),
  ),
);
