import {
  ContextAccess,
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime/operations/context';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { AgreementsStateSchema } from '../../shared/apis/records.ts';
import { presentContracts } from '../../src/services/persistence.service.ts';
import { ContractsProviderRequestSchema, ContractsProviderResponseSchema } from '../../shared/apis/contracts-search.ts';
import { SearchProjectionUnavailable } from '../../shared/domain/search-projection-error.ts';
import { SearchSource } from '../../src/services/search-source.ts';
import {
  buildSearchDocuments,
  createSearchProjector,
  loadCurrentSearchHits as loadAuthorizedCurrentSearchHits,
  loadSearchHits as loadAuthorizedSearchHits,
} from '../../src/services/search-projection.ts';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { contractsRead } from '../../src/search/contracts.provider.ts';
import { gateAnswer, searchAuthorization, retiredAccess } from '../support/search-access.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const otherCompany = '30000000-0000-4000-8000-000000000002';
const contractId = '40000000-0000-4000-8000-000000000001';
const ref = {
  moduleId: 'legal.agreements',
  resourceId: contractId,
  resourceType: 'legal.agreements.contract',
  tenantId,
};
const scope: OperationalScope = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'test',
  authMethod: 'session',
  correlationId: 'search',
  legalEntityId,
  principalId: '50000000-0000-4000-8000-000000000001',
  tenantId,
};
const loadSearchHits = (
  ...args: [
    Parameters<typeof loadAuthorizedSearchHits>[0],
    Parameters<typeof loadAuthorizedSearchHits>[1],
    Parameters<typeof loadAuthorizedSearchHits>[2],
  ]
) => loadAuthorizedSearchHits(...args, searchAuthorization);
const loadCurrentSearchHits = (
  ...args: [
    Parameters<typeof loadAuthorizedCurrentSearchHits>[0],
    Parameters<typeof loadAuthorizedCurrentSearchHits>[1],
    Parameters<typeof loadAuthorizedCurrentSearchHits>[2],
    Parameters<typeof loadAuthorizedCurrentSearchHits>[3],
  ]
) =>
  loadAuthorizedCurrentSearchHits(...args, searchAuthorization).pipe(
    Effect.provideService(AccessDecisionGate, gateAnswer()),
  );
const context = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: 'claim',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: 'legal.agreements',
  deliveryId: 'delivery',
  domainEventId: 'event',
  messageId: 'message',
  producerModuleKey: 'legal.agreements',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'legal.agreements.search-changed.v1',
  workerKey: 'legal.agreements.project-search',
});
const makeState = (lifecycleState = 'ACTIVE', refTenant = tenantId) =>
  Schema.decodeUnknownEffect(AgreementsStateSchema)({
    contracts: [
      {
        contractRef: { ...ref, tenantId: refTenant },
        counterpartyRef: {
          moduleId: 'party.registry',
          resourceId: contractId,
          resourceType: 'party.registry.counterparty',
          tenantId: refTenant,
        },
        endDate: null,
        kind: 'LEASE',
        lifecycleState,
        note: 'secret-note',
        noticePeriod: 'secret-notice-period',
        occupancyRef: null,
        propertyRef: null,
        renewalNoticeDate: null,
        rentTerms: { currency: 'CZK', monthlyRentMinor: 123_456, paymentDay: 15, serviceChargesMinor: 78_901 },
        responsiblePerson: 'secret-person',
        signatureState: 'SIGNED',
        startDate: '2026-11-01',
        subject: 'Pronájem kanceláře',
        supersedesContractRef: null,
        unitRef: null,
      },
    ],
    documents: [],
  });
it.effect('search request rejects blank normalized, mark-only and overlong queries', () =>
  Effect.sync(() => {
    expect(Schema.is(ContractsProviderRequestSchema)({ query: '   ' })).toBe(false);
    expect(Schema.is(ContractsProviderRequestSchema)({ query: '\u0301' })).toBe(false);
    expect(Schema.is(ContractsProviderRequestSchema)({ query: 'a'.repeat(201) })).toBe(false);
    expect(Schema.is(ContractsProviderRequestSchema)({ query: 'nájem' })).toBe(true);
  }),
);
it.effect('indexes only approved subject, kind, dates and own ID in the trusted company', () =>
  Effect.gen(function* test() {
    const state = yield* makeState();
    const documents = yield* buildSearchDocuments({
      companies: [{ legalEntityId, state }],
      projectionVersion: '1',
      tenantId,
    });
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      metadata: [],
      ref: { tenantId },
      searchableText: ['Pronájem kanceláře', 'LEASE', 'Nájemní smlouva', contractId, '2026-11-01'],
      selectedLegalEntityId: legalEntityId,
      title: 'Pronájem kanceláře',
    });
    expect(Schema.is(ContractsProviderResponseSchema)([{ ref, title: 'Smlouva' }])).toBe(false);
    expect(contractsRead.descriptor.legalEntityScope).toBe('required');
    expect(contractsRead.descriptor.accessDeclaration?.key).toBe('legal.agreements.search-contracts.read');
    expect(contractsRead.descriptor.accessDeclaration?.selectors).toEqual(['all']);
  }),
);
it.effect('ended contracts remain archived and cross-tenant canonical refs fail closed', () =>
  Effect.gen(function* test() {
    const ended = yield* makeState('TERMINATED');
    const expired = yield* makeState('EXPIRED');
    expect(
      yield* buildSearchDocuments({ companies: [{ legalEntityId, state: ended }], projectionVersion: '2', tenantId }),
    ).toMatchObject([{ archived: true, ref }]);
    expect(
      yield* buildSearchDocuments({ companies: [{ legalEntityId, state: expired }], projectionVersion: '3', tenantId }),
    ).toMatchObject([{ archived: true, ref }]);
    const foreign = yield* makeState('ACTIVE', otherCompany);
    expect(
      Schema.is(SearchProjectionUnavailable)(
        yield* buildSearchDocuments({
          companies: [{ legalEntityId, state: foreign }],
          projectionVersion: '4',
          tenantId,
        }).pipe(Effect.flip),
      ),
    ).toBe(true);
  }),
);
it.effect('query honors caller archive filter and rejects other readable companies or tenants', () =>
  Effect.gen(function* test() {
    const hit = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
      archived: false,
      facets: [],
      metadata: [],
      ref,
      selectedLegalEntityId: legalEntityId,
      title: 'Pronájem kanceláře',
    });
    const result = yield* loadSearchHits(scope, 'legal.agreements.contract', {
      includeArchived: true,
      query: 'pronajem',
    }).pipe(
      Effect.provideService(CoreSearchQueryRuntime, {
        search: (input, trusted) => {
          expect(trusted).toBe(scope);
          expect(input).toMatchObject({ includeArchived: true, selectedLegalEntityId: legalEntityId, tenantId });
          return Effect.succeed([hit]);
        },
      }),
    );
    expect(result).toHaveLength(1);
    const wrongCompany = yield* loadSearchHits(scope, 'legal.agreements.contract', { query: 'pronajem' }).pipe(
      Effect.provideService(CoreSearchQueryRuntime, {
        search: () =>
          Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))([
            { ...hit, selectedLegalEntityId: otherCompany },
          ]).pipe(Effect.orDie),
      }),
      Effect.flip,
    );
    expect(Schema.is(SearchProjectionUnavailable)(wrongCompany)).toBe(true);
    const wrongTenant = yield* loadSearchHits(scope, 'legal.agreements.contract', { query: 'pronajem' }).pipe(
      Effect.provideService(CoreSearchQueryRuntime, {
        search: () =>
          Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))([
            { ...hit, ref: { ...hit.ref, tenantId: otherCompany } },
          ]).pipe(Effect.orDie),
      }),
      Effect.flip,
    );
    expect(Schema.is(SearchProjectionUnavailable)(wrongTenant)).toBe(true);
  }),
);
it.effect('archive classification follows canonical expiry at the inclusive end-date boundary', () =>
  Effect.gen(function* test() {
    const state = yield* makeState();
    for (const lifecycleState of ['DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED'] as const) {
      const datedState = {
        ...state,
        contracts: state.contracts.map((contract) => ({ ...contract, endDate: '2026-11-03', lifecycleState })),
      };
      for (const businessDate of ['2026-11-02', '2026-11-03', '2026-11-04']) {
        const canonical = presentContracts(datedState, businessDate);
        const documents = yield* buildSearchDocuments(
          { companies: [{ legalEntityId, state: datedState }], projectionVersion: '5', tenantId },
          businessDate,
        );
        expect(documents[0]?.archived).toBe(lifecycleState === 'TERMINATED' || canonical[0]?.isExpired === true);
        if (lifecycleState === 'ACTIVE') {
          expect(documents[0]?.archived).toBe(businessDate >= '2026-11-03');
        }
        if (lifecycleState === 'DRAFT') {
          expect(documents[0]?.archived).toBe(false);
        }
      }
    }
  }),
);
it.effect('real kind, dates and own ID match without indexing related IDs or private metadata', () =>
  Effect.gen(function* test() {
    const state = yield* makeState();
    const datedState = {
      ...state,
      contracts: state.contracts.map((contract) => ({
        ...contract,
        counterpartyRef: { ...contract.counterpartyRef, resourceId: '40000000-0000-4000-8000-000000000099' },
        endDate: '2027-12-31',
        kind: 'OTHER' as const,
        renewalNoticeDate: '2027-11-30',
      })),
    };
    const documents = yield* buildSearchDocuments(
      { companies: [{ legalEntityId, state: datedState }], projectionVersion: '6', tenantId },
      '2026-11-03',
    );
    const store = makeInMemoryCoreSearchProjectionStore();
    yield* store.replace(
      { documents, moduleId: 'legal.agreements', rebuildVersion: '6', resourceType: ref.resourceType, tenantId },
      context,
    );
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    for (const query of ['pronajem', 'OTHER', '2026-11-01', '2027-12-31', '2027-11-30', contractId]) {
      const hits = yield* loadSearchHits(scope, 'legal.agreements.contract', { query }).pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
      );
      expect(hits).toMatchObject([{ ref, title: 'Pronájem kanceláře' }]);
      expect(hits[0]).not.toHaveProperty('searchableText');
      expect(hits[0]).not.toHaveProperty('metadata');
    }
    for (const query of [
      'secret-note',
      'secret-person',
      'secret-notice-period',
      '123456',
      'SIGNED',
      '40000000-0000-4000-8000-000000000099',
    ]) {
      expect(
        yield* loadSearchHits(scope, 'legal.agreements.contract', { query }).pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
        ),
      ).toEqual([]);
    }
  }),
);
it.effect('default search excludes ended contracts while includeArchived finds the same real reference', () =>
  Effect.gen(function* test() {
    const state = yield* makeState('TERMINATED');
    const documents = yield* buildSearchDocuments({
      companies: [{ legalEntityId, state }],
      projectionVersion: '7',
      tenantId,
    });
    const store = makeInMemoryCoreSearchProjectionStore();
    yield* store.replace(
      { documents, moduleId: 'legal.agreements', rebuildVersion: '7', resourceType: ref.resourceType, tenantId },
      context,
    );
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    for (const includeArchived of [undefined, false, true]) {
      const input = includeArchived === undefined ? { query: 'pronajem' } : { includeArchived, query: 'pronajem' };
      const hits = yield* loadSearchHits(scope, 'legal.agreements.contract', input).pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
      );
      expect(hits).toEqual(
        includeArchived === true ? [{ ref, selectedLegalEntityId: legalEntityId, title: documents[0]?.title }] : [],
      );
    }
    const unexpectedArchive = yield* loadSearchHits(scope, 'legal.agreements.contract', { query: 'pronajem' }).pipe(
      Effect.provideService(CoreSearchQueryRuntime, {
        search: () => Effect.succeed(documents),
      }),
      Effect.flip,
    );
    expect(Schema.is(SearchProjectionUnavailable)(unexpectedArchive)).toBe(true);
  }),
);
it.effect('subject withdrawal removes old evidence on replacement without indexing private fallbacks', () =>
  Effect.gen(function* test() {
    const state = yield* makeState();
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const replace = (snapshotState: typeof state, projectionVersion: string) =>
      buildSearchDocuments({ companies: [{ legalEntityId, state: snapshotState }], projectionVersion, tenantId }).pipe(
        Effect.flatMap((documents) =>
          store.replace(
            {
              documents,
              moduleId: 'legal.agreements',
              rebuildVersion: projectionVersion,
              resourceType: ref.resourceType,
              tenantId,
            },
            context,
          ),
        ),
      );
    yield* replace(state, '8');
    const search = (query: string) =>
      loadSearchHits(scope, 'legal.agreements.contract', { query }).pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
      );
    expect(yield* search('pronajem')).toHaveLength(1);
    const withdrawn = {
      ...state,
      contracts: state.contracts.map(({ subject: _subject, ...contract }) => contract),
    };
    yield* replace(withdrawn, '9');
    expect(yield* search('pronajem kancelare')).toEqual([]);
    expect(yield* search('secret-person')).toEqual([]);
    expect(yield* search('najemni smlouva')).toMatchObject([{ ref, title: 'Nájemní smlouva' }]);
    yield* replace({ contracts: [], documents: [] }, '10');
    expect(yield* search(contractId)).toEqual([]);
  }),
);
it.effect('current rematch rejects stale subject, kind and date evidence and follows current archive state', () =>
  Effect.gen(function* test() {
    const active = yield* makeState();
    const withdrawn = {
      ...active,
      contracts: active.contracts.map(({ subject: _subject, ...contract }) => contract),
    };
    const changed = {
      ...active,
      contracts: active.contracts.map((contract) => ({
        ...contract,
        endDate: '2027-12-31',
        kind: 'OTHER' as const,
        renewalNoticeDate: '2027-11-30',
      })),
    };
    const ended = yield* makeState('TERMINATED');
    const store = makeInMemoryCoreSearchProjectionStore();
    let version = 10;
    const publish = (state: typeof active) =>
      buildSearchDocuments({
        companies: [{ legalEntityId, state }],
        projectionVersion: String(version + 1),
        tenantId,
      }).pipe(
        Effect.flatMap((documents) => {
          version += 1;
          return store.replace(
            {
              documents,
              moduleId: 'legal.agreements',
              rebuildVersion: String(version),
              resourceType: ref.resourceType,
              tenantId,
            },
            context,
          );
        }),
      );
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const searchCurrent = (visible: typeof active, query: string, includeArchived = false) =>
      loadCurrentSearchHits(scope, 'legal.agreements.contract', { includeArchived, query }, visible).pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
        Effect.provideService(ContextAccess, retiredAccess),
      );

    yield* publish(changed);
    expect(yield* searchCurrent(active, 'OTHER')).toEqual([]);
    expect(yield* searchCurrent(active, '2027-12-31')).toEqual([]);
    expect(yield* searchCurrent(active, '2027-11-30')).toEqual([]);
    expect(yield* searchCurrent(active, 'pronajem')).toMatchObject([{ ref }]);

    yield* publish(active);
    expect(yield* searchCurrent(withdrawn, 'pronajem')).toEqual([]);
    expect(yield* searchCurrent(withdrawn, 'najemni smlouva')).toMatchObject([{ ref, title: 'Nájemní smlouva' }]);

    yield* publish(ended);
    expect(yield* searchCurrent(active, 'pronajem')).toMatchObject([{ ref }]);
    expect(yield* searchCurrent(ended, 'pronajem')).toEqual([]);
    expect(yield* searchCurrent(ended, 'pronajem', true)).toMatchObject([{ ref, title: 'Pronájem kanceláře' }]);

    const foreign = {
      ...active,
      contracts: active.contracts.map((contract) => ({
        ...contract,
        contractRef: { ...contract.contractRef, tenantId: otherCompany },
      })),
    };
    expect(Schema.is(SearchProjectionUnavailable)(yield* searchCurrent(foreign, 'pronajem').pipe(Effect.flip))).toBe(
      true,
    );
  }),
);
it.effect('full replacements converge on update and deletion after the snapshot closes', () =>
  Effect.gen(function* test() {
    let state = yield* makeState();
    let projectionVersion = '1';
    let snapshotClosed = false;
    const replacements: unknown[] = [];
    const projector = yield* createSearchProjector.pipe(
      Effect.provideService(SearchSource, {
        load: () =>
          Effect.sync(() => {
            snapshotClosed = true;
            return { companies: [{ legalEntityId, state }], projectionVersion, tenantId };
          }),
      }),
      Effect.provideService(CoreSearchProjectionStore, {
        apply: () => Effect.void,
        queryCandidates: () => Effect.succeed([]),
        replace: (replacement) => {
          expect(snapshotClosed).toBe(true);
          replacements.push(replacement);
          return Effect.void;
        },
      }),
    );
    yield* projector.project(context);
    state = { ...state, contracts: state.contracts.map((contract) => ({ ...contract, subject: 'Nová smlouva' })) };
    projectionVersion = '2';
    snapshotClosed = false;
    yield* projector.project(context);
    expect(replacements[2]).toMatchObject({ documents: [{ title: 'Nová smlouva' }], rebuildVersion: '2' });
    state = { contracts: [], documents: [] };
    projectionVersion = '3';
    snapshotClosed = false;
    yield* projector.project(context);
    expect(replacements[4]).toMatchObject({
      documents: [],
      rebuildVersion: '3',
      resourceType: 'legal.agreements.contract',
      tenantId,
    });
  }),
);
