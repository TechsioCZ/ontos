import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  CoreSearchProjectionHitSchema,
  CoreSearchQueryRuntime,
  CoreSearchProjectionStore,
  ResourceContainmentRelationshipMutation,
} from '@app/core-runtime';
import type { OperationalScope, OutboxWorkerHandlerContext } from '@app/core-runtime';
import { AgreementsStateSchema } from '../../shared/apis/records.ts';
import { ContractsProviderResponseSchema } from '../../shared/apis/contracts-search.ts';
import { SearchProjectionUnavailable } from '../../shared/domain/search-projection-error.ts';
import { SearchSource } from '../../src/services/search-source.ts';
import { buildSearchDocuments, createSearchProjector, loadSearchHits } from '../../src/services/search-projection.ts';
import { contractsRead } from '../../src/search/contracts.provider.ts';

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
const context: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: 'claim',
  compositionRevision: 'a'.repeat(64),
  deliveryId: 'delivery',
  domainEventId: 'event',
  messageId: 'message',
  producerModuleKey: 'legal.agreements',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'legal.agreements.search-changed.v1',
  workerKey: 'legal.agreements.project-search',
};
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
        occupancyRef: null,
        propertyRef: null,
        renewalNoticeDate: null,
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
it.effect('indexes public subject and trusted company, never notes or responsible person', () =>
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
      searchableText: ['Pronájem kanceláře'],
      selectedLegalEntityId: legalEntityId,
      title: 'Pronájem kanceláře',
    });
    expect(Schema.is(ContractsProviderResponseSchema)([{ ref, title: 'Smlouva' }])).toBe(false);
    expect(contractsRead.descriptor.legalEntityScope).toBe('required');
    expect(contractsRead.descriptor.permissionTarget).toBe('module');
  }),
);
it.effect('ended contracts disappear and cross-tenant canonical refs fail closed', () =>
  Effect.gen(function* test() {
    const ended = yield* makeState('TERMINATED');
    const expired = yield* makeState('EXPIRED');
    expect(
      yield* buildSearchDocuments({ companies: [{ legalEntityId, state: ended }], projectionVersion: '2', tenantId }),
    ).toEqual([]);
    expect(
      yield* buildSearchDocuments({ companies: [{ legalEntityId, state: expired }], projectionVersion: '3', tenantId }),
    ).toEqual([]);
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
it.effect('query ignores caller archive filter and rejects other readable companies or tenants', () =>
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
          expect(input).toMatchObject({ includeArchived: false, selectedLegalEntityId: legalEntityId, tenantId });
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
it.effect('post-commit containment is scoped and full replacements converge on update and deletion', () =>
  Effect.gen(function* test() {
    let state = yield* makeState();
    let projectionVersion = '1';
    let snapshotClosed = false;
    const replacements: unknown[] = [];
    const touched: unknown[] = [];
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
      Effect.provideService(ResourceContainmentRelationshipMutation, {
        touch: (relationships) => {
          expect(snapshotClosed).toBe(true);
          touched.push(relationships);
          return Effect.void;
        },
      }),
    );
    yield* projector.project(context);
    expect(touched[0]).toMatchObject({
      relationships: [
        { container: { objectType: 'module_access' }, relation: 'module', resource: { objectType: 'resource' } },
      ],
    });
    state = { ...state, contracts: state.contracts.map((contract) => ({ ...contract, subject: 'Nová smlouva' })) };
    projectionVersion = '2';
    snapshotClosed = false;
    yield* projector.project(context);
    expect(replacements[1]).toMatchObject({ documents: [{ title: 'Nová smlouva' }], rebuildVersion: '2' });
    state = { contracts: [], documents: [] };
    projectionVersion = '3';
    snapshotClosed = false;
    yield* projector.project(context);
    expect(replacements[2]).toMatchObject({
      documents: [],
      rebuildVersion: '3',
      resourceType: 'legal.agreements.contract',
      tenantId,
    });
  }),
);
