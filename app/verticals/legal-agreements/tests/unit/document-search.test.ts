import { NodeCrypto } from '@effect/platform-node';
import {
  ContextAccess,
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  ReadPermissionDenied,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { DocumentsProviderRequestSchema, DocumentsProviderResponseSchema } from '../../shared/apis/documents-search.ts';
import { ContractsProviderResponseSchema } from '../../shared/apis/contracts-search.ts';
import { AgreementsStateSchema } from '../../shared/apis/records.ts';
import type { AgreementsState } from '../../shared/apis/records.ts';
import { SearchProjectionUnavailable } from '../../shared/domain/search-projection-error.ts';
import { documentsRead } from '../../src/search/documents.provider.ts';
import {
  buildSearchDocuments,
  createSearchProjector,
  loadCurrentSearchHits as loadAuthorizedCurrentSearchHits,
} from '../../src/services/search-projection.ts';
import { SearchSource } from '../../src/services/search-source.ts';
import { legalAgreementsRegistration } from '../../vertical.registration.ts';
import { contractsRead } from '../../src/search/contracts.provider.ts';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { gateAnswer, gateWithList, recordKeys, searchAuthorization, retiredAccess } from '../support/search-access.ts';

const loadCurrentSearchHits = (
  ...args: [
    Parameters<typeof loadAuthorizedCurrentSearchHits>[0],
    Parameters<typeof loadAuthorizedCurrentSearchHits>[1],
    Parameters<typeof loadAuthorizedCurrentSearchHits>[2],
    Parameters<typeof loadAuthorizedCurrentSearchHits>[3],
  ]
) => loadAuthorizedCurrentSearchHits(...args, searchAuthorization);

const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const otherCompany = '30000000-0000-4000-8000-000000000002';
const contractId = '40000000-0000-4000-8000-000000000001';
const documentId = '40000000-0000-4000-8000-000000000002';
const otherDocumentId = '40000000-0000-4000-8000-000000000003';
// A JSON string, so `not.toContain` searches the projected text (an encoded object is no searchable value).
const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(Schema.Unknown)));
const contractRef = {
  moduleId: 'legal.agreements',
  resourceId: contractId,
  resourceType: 'legal.agreements.contract',
  tenantId,
};
const documentRef = { ...contractRef, resourceId: documentId, resourceType: 'legal.agreements.document' };
const scope: OperationalScope = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:document-search',
  authMethod: 'session',
  correlationId: 'document-search',
  legalEntityId,
  principalId: '50000000-0000-4000-8000-000000000001',
  tenantId,
};
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
const encoded = {
  contracts: [
    {
      contractRef,
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: '40000000-0000-4000-8000-000000000099',
        resourceType: 'party.registry.counterparty',
        tenantId,
      },
      endDate: null,
      kind: 'OTHER',
      lifecycleState: 'ACTIVE',
      note: 'private-contract-note',
      occupancyRef: null,
      propertyRef: null,
      renewalNoticeDate: null,
      signatureState: 'SIGNED',
      startDate: '2026-11-01',
      subject: 'Pronájem kanceláře',
      supersedesContractRef: null,
      unitRef: null,
    },
  ],
  documents: [
    {
      contractRef,
      createdAt: '2026-09-15T09:00:00.000Z',
      documentRef,
      fileName: 'Predavaci-protokol-AB42.pdf',
      kind: 'PŘÍLOHA',
      lifecycleState: 'FINAL',
      signedBy: 'private-signatory',
      signedDocumentReference: 'private-signature-reference',
      signedOn: '2026-09-16',
      title: 'Předávací protokol kanceláře',
      updatedAt: '2026-09-17T09:00:00.000Z',
    },
  ],
};
const makeState = () => Schema.decodeUnknownEffect(AgreementsStateSchema)(encoded);
const allowedAccess = gateAnswer();
const build = (state: AgreementsState, projectionVersion = '1', businessDate = '2026-11-03') =>
  buildSearchDocuments({ companies: [{ legalEntityId, state }], projectionVersion, tenantId }, businessDate);
const documentsOfType = <Document extends { readonly ref: { readonly resourceType: string } }>(
  documents: readonly Document[],
  resourceType: string,
) => documents.filter((document) => document.ref.resourceType === resourceType);
const realRuntime = Effect.gen(function* makeRuntime() {
  const store = makeInMemoryCoreSearchProjectionStore();
  const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
  const publish = (state: AgreementsState, version: string) =>
    build(state, version).pipe(
      Effect.flatMap((documents) =>
        Effect.forEach(
          ['legal.agreements.contract', 'legal.agreements.document'],
          (resourceType) =>
            store.replace(
              {
                documents: documentsOfType(documents, resourceType),
                moduleId: 'legal.agreements',
                rebuildVersion: version,
                resourceType,
                tenantId,
              },
              context,
            ),
          { discard: true },
        ),
      ),
    );
  const search = (state: AgreementsState, query: string, includeArchived = false, includeRelevance = false) =>
    loadCurrentSearchHits(scope, 'legal.agreements.document', { includeArchived, includeRelevance, query }, state).pipe(
      Effect.provideService(CoreSearchQueryRuntime, runtime),
      Effect.provideService(AccessDecisionGate, allowedAccess),
    );
  return { publish, runtime, search, store };
});

it.effect('generated documents ingress validates normalized query, typed identity, company and relevance v1', () =>
  Effect.sync(() => {
    for (const query of ['', '   ', '\u0301', 'a'.repeat(201)]) {
      expect(Schema.is(DocumentsProviderRequestSchema)({ query })).toBe(false);
    }
    expect(
      Schema.is(DocumentsProviderRequestSchema)({ includeArchived: true, includeRelevance: true, query: 'příloha' }),
    ).toBe(true);
    expect(Schema.is(DocumentsProviderResponseSchema)([{ ref: documentRef, title: 'Dokument' }])).toBe(false);
    const result = { ref: documentRef, selectedLegalEntityId: legalEntityId, title: 'Dokument' };
    expect(Schema.is(DocumentsProviderResponseSchema)([result])).toBe(true);
    expect(Schema.is(DocumentsProviderResponseSchema)([{ ...result, ref: contractRef }])).toBe(false);
    for (const relevance of [
      { score: -1, version: '1' },
      { score: 1001, version: '1' },
      { score: 900, version: '2' },
      { score: 1.5, version: '1' },
    ]) {
      expect(Schema.is(DocumentsProviderResponseSchema)([{ ...result, relevance }])).toBe(false);
      expect(Schema.is(ContractsProviderResponseSchema)([{ ...result, ref: contractRef, relevance }])).toBe(false);
    }
    expect(documentsRead.descriptor).toMatchObject({
      accessDeclaration: {
        key: 'legal.agreements.search-documents.read',
        kind: 'read',
        modes: ['run'],
        placement: { group: 'legal-agreements', level: 'basic' },
        risk: 'sensitive',
        selectors: ['all'],
      },
      accessKind: 'search',
      entrypoint: { authorization: { kind: 'protected' } },
      legalEntityScope: 'required',
      owningModuleKey: 'legal.agreements',
      policies: [],
    });
  }),
);

it.effect('projects actual state.documents title, kind, filename and own ID with no private evidence', () =>
  Effect.gen(function* documentEvidence() {
    const documents = yield* build(yield* makeState());
    expect(documents).toHaveLength(2);
    const document = documents.find(({ ref }) => ref.resourceType === documentRef.resourceType);
    expect(document).toMatchObject({
      archived: false,
      facets: [],
      metadata: [],
      projectionVersion: '1',
      ref: documentRef,
      searchableText: ['Předávací protokol kanceláře', 'PŘÍLOHA', documentId, 'Predavaci-protokol-AB42.pdf'],
      selectedLegalEntityId: legalEntityId,
      title: 'Předávací protokol kanceláře',
    });
    const serialized = serialize(document);
    for (const value of [
      'private-signatory',
      'private-signature-reference',
      'private-contract-note',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      contractId,
      encoded.contracts[0]?.counterpartyRef.resourceId,
    ]) {
      expect(serialized).not.toContain(value);
    }
  }),
);

it.effect('real Core retrieval matches accentless multiword metadata, kind, filename and own ID only', () =>
  Effect.gen(function* realMatches() {
    const state = yield* makeState();
    const { publish, search } = yield* realRuntime;
    yield* publish(state, '1');
    for (const query of ['Předávací protokol', 'predavaci kancelare', 'priloha AB42', 'pdf', documentId]) {
      const result = yield* search(state, query);
      expect(result).toEqual([
        { ref: documentRef, selectedLegalEntityId: legalEntityId, title: 'Předávací protokol kanceláře' },
      ]);
      expect(Object.keys(result[0] ?? {}).toSorted()).toEqual(['ref', 'selectedLegalEntityId', 'title']);
    }
    for (const query of [
      'private-signatory',
      'private-signature-reference',
      'private-contract-note',
      '2026-09-16',
      '2026-09-15',
      '2026-09-17',
      contractId,
      'SIGNED',
      'nonexistent',
      'predavaci nonexistent',
    ]) {
      expect(yield* search(state, query)).toEqual([]);
    }
  }),
);

it.effect(
  'stale title, filename and kind cannot match current documents, while surviving terms return the current title',
  () =>
    Effect.gen(function* staleMetadata() {
      const state = yield* makeState();
      const { publish, search } = yield* realRuntime;
      yield* publish(state, '1');
      const renamed = {
        ...state,
        documents: state.documents.map((document) => ({
          ...document,
          fileName: 'current-file.pdf',
          kind: 'DODATEK',
          title: 'Aktuální protokol',
        })),
      };
      for (const query of ['kancelare', 'priloha', 'AB42']) {
        expect(yield* search(renamed, query)).toEqual([]);
      }
      expect(yield* search(renamed, 'protokol')).toMatchObject([{ ref: documentRef, title: 'Aktuální protokol' }]);
      const noFile = { ...state, documents: state.documents.map((document) => ({ ...document, fileName: null })) };
      expect(yield* search(noFile, 'AB42')).toEqual([]);
      expect(yield* search(noFile, 'predavaci')).toHaveLength(1);
      expect(yield* search({ ...state, documents: [] }, 'predavaci', true)).toEqual([]);
      yield* publish(renamed, '2');
      expect(yield* search(renamed, 'AB42')).toEqual([]);
      expect(yield* search(renamed, 'current-file')).toMatchObject([{ ref: documentRef, title: 'Aktuální protokol' }]);
    }),
);

it.effect('current document archive and parent termination/expiry override stale index flags', () =>
  Effect.gen(function* currentArchives() {
    const state = yield* makeState();
    const { publish, search } = yield* realRuntime;
    yield* publish(state, '1');
    const archived = {
      ...state,
      documents: state.documents.map((document) => ({ ...document, lifecycleState: 'ARCHIVED' as const })),
    };
    const terminated = {
      ...state,
      contracts: state.contracts.map((contract) => ({ ...contract, lifecycleState: 'TERMINATED' as const })),
    };
    const expired = {
      ...state,
      contracts: state.contracts.map((contract) => ({ ...contract, lifecycleState: 'EXPIRED' as const })),
    };
    const elapsed = {
      ...state,
      contracts: state.contracts.map((contract) => ({ ...contract, endDate: '2026-11-02' })),
    };
    for (const current of [archived, terminated, expired, elapsed]) {
      expect(yield* search(current, 'predavaci')).toEqual([]);
      expect(yield* search(current, 'predavaci', true)).toMatchObject([{ ref: documentRef }]);
    }
    yield* publish(archived, '2');
    expect(yield* search(state, 'predavaci')).toMatchObject([{ ref: documentRef }]);
  }),
);

it.effect('document parent archive follows the canonical inclusive end-date boundary, not a local expiry rule', () =>
  Effect.gen(function* expiryBoundary() {
    const state = yield* makeState();
    for (const lifecycleState of ['DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED'] as const) {
      const dated = {
        ...state,
        contracts: state.contracts.map((contract) => ({ ...contract, endDate: '2026-11-03', lifecycleState })),
      };
      for (const date of ['2026-11-02', '2026-11-03', '2026-11-04']) {
        const documents = yield* build(dated, '1', date);
        const parent = documents.find(({ ref }) => ref.resourceType === contractRef.resourceType);
        const document = documents.find(({ ref }) => ref.resourceType === documentRef.resourceType);
        expect(document?.archived).toBe(parent?.archived);
        expect(document?.archived).toBe(
          lifecycleState === 'TERMINATED' ||
            lifecycleState === 'EXPIRED' ||
            (lifecycleState === 'ACTIVE' && date >= '2026-11-03'),
        );
      }
    }
  }),
);

it.effect(
  'deleted/withdrawn/orphaned parents suppress linked documents even with includeArchived, but real unlinked documents remain searchable',
  () =>
    Effect.gen(function* parentPresence() {
      const state = yield* makeState();
      const { publish, search } = yield* realRuntime;
      yield* publish(state, '1');
      const orphan = { ...state, contracts: [] };
      expect(yield* build(orphan)).toEqual([]);
      for (const includeArchived of [false, true]) {
        expect(yield* search(orphan, 'predavaci', includeArchived)).toEqual([]);
        const relinked = {
          ...state,
          documents: state.documents.map((document) => ({
            ...document,
            contractRef: { ...document.contractRef, ...state.contracts[0]?.contractRef, resourceId: otherDocumentId },
          })),
        };
        const decodedRelinked = yield* Schema.decodeUnknownEffect(AgreementsStateSchema)(relinked);
        expect(yield* search(decodedRelinked, 'predavaci', includeArchived)).toEqual([]);
      }
      const unlinked = {
        ...state,
        contracts: [],
        documents: state.documents.map((document) => ({ ...document, contractRef: null })),
      };
      expect(yield* search(unlinked, 'predavaci')).toMatchObject([{ ref: documentRef }]);
      yield* publish(orphan, '2');
      expect(yield* search(state, 'predavaci', true)).toEqual([]);
    }),
);

it.effect('current parent contract LIST is independent, original, scoped and evaluated once per search', () =>
  Effect.gen(function* parentAuthorization() {
    const state = yield* makeState();
    const multiple = {
      ...state,
      documents: [
        ...state.documents,
        ...state.documents.map((document) => ({
          ...document,
          documentRef: { ...document.documentRef, resourceId: otherDocumentId },
        })),
      ],
    };
    const candidates = yield* build(multiple);
    let calls = 0;
    let allowed = true;
    const access = gateWithList((input) => {
      calls += 1;
      expect(input.scope).toBe(scope);
      expect(input.carrier.accessDeclaration).toBe(contractsRead.descriptor.accessDeclaration);
      expect(input.legalEntityScope).toBe('required');
      return gateAnswer(allowed ? 'ALLOWED' : 'DENIED', recordKeys(contractId)).list(input);
    });
    const search = () =>
      loadCurrentSearchHits(
        scope,
        'legal.agreements.document',
        { includeArchived: true, query: 'predavaci' },
        multiple,
      ).pipe(
        Effect.provideService(AccessDecisionGate, access),
        Effect.provideService(ContextAccess, retiredAccess),
        Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(candidates) }),
      );
    expect(yield* search()).toHaveLength(2);
    allowed = false;
    expect(yield* search()).toEqual([]);
    allowed = true;
    expect(yield* search()).toHaveLength(2);
    expect(calls).toBe(3);
  }),
);
it.effect('denied parent contracts cannot hide readable independent documents or disclose linked metadata', () =>
  Effect.gen(function* mixedParents() {
    const state = yield* makeState();
    const mixed = {
      ...state,
      documents: [
        ...state.documents,
        ...state.documents.map((document) => ({
          ...document,
          contractRef: null,
          documentRef: { ...document.documentRef, resourceId: otherDocumentId },
          title: 'Předávací veřejný protokol',
        })),
      ],
    };
    const candidates = yield* build(mixed);
    const result = yield* loadCurrentSearchHits(scope, 'legal.agreements.document', { query: 'predavaci' }, mixed).pipe(
      Effect.provideService(AccessDecisionGate, gateAnswer('DENIED')),
      Effect.provideService(ContextAccess, retiredAccess),
      Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(candidates) }),
    );
    expect(result).toEqual([
      {
        ref: { ...documentRef, resourceId: otherDocumentId },
        selectedLegalEntityId: legalEntityId,
        title: 'Předávací veřejný protokol',
      },
    ]);
    expect(serialize(result)).not.toContain(documentId);
    expect(serialize(result)).not.toContain('AB42');
  }),
);
it.effect('unavailable parent authority fails closed before observing index candidates', () =>
  Effect.gen(function* uncertainParents() {
    const state = yield* makeState();
    const failure = yield* loadCurrentSearchHits(
      scope,
      'legal.agreements.document',
      { includeArchived: true, query: 'predavaci' },
      state,
    ).pipe(
      Effect.provideService(AccessDecisionGate, gateAnswer('UNAVAILABLE')),
      Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.die('Unavailable parent must not search') }),
      Effect.flip,
    );
    expect(Schema.is(SearchProjectionUnavailable)(failure)).toBe(true);
  }),
);

it.effect(
  'foreign document/parent tenants fail publication and mismatched candidate identity/company cannot survive rematch',
  () =>
    Effect.gen(function* scopeIsolation() {
      const state = yield* makeState();
      const foreignStates = yield* Effect.forEach(
        [
          {
            ...state,
            documents: state.documents.map((document) => ({
              ...document,
              documentRef: { ...document.documentRef, tenantId: otherCompany },
            })),
          },
          {
            ...state,
            documents: state.documents.map((document) => ({
              ...document,
              contractRef: { ...contractRef, ...document.contractRef, tenantId: otherCompany },
            })),
          },
        ],
        (candidate) => Schema.decodeUnknownEffect(AgreementsStateSchema)(candidate),
      );
      for (const foreign of foreignStates) {
        expect(Schema.is(SearchProjectionUnavailable)(yield* build(foreign).pipe(Effect.flip))).toBe(true);
      }
      const candidates = (yield* build(state)).filter(({ ref }) => ref.resourceType === documentRef.resourceType);
      for (const wrongCandidate of [
        candidates.map((hit) => ({ ...hit, ref: { ...hit.ref, tenantId: otherCompany } })),
        candidates.map((hit) => ({ ...hit, ref: { ...hit.ref, resourceType: contractRef.resourceType } })),
        candidates.map((hit) => ({ ...hit, ref: { ...hit.ref, moduleId: 'foreign.owner' } })),
        candidates.map((hit) => ({ ...hit, selectedLegalEntityId: otherCompany })),
      ]) {
        const wrong = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))(wrongCandidate);
        expect(
          yield* loadCurrentSearchHits(scope, 'legal.agreements.document', { query: 'predavaci' }, state).pipe(
            Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(wrong) }),
            Effect.provideService(AccessDecisionGate, allowedAccess),
          ),
        ).toEqual([]);
      }
      const { legalEntityId: _selected, ...unselected } = scope;
      const failure = yield* loadCurrentSearchHits(
        unselected,
        'legal.agreements.document',
        { query: 'predavaci' },
        state,
      ).pipe(
        Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.die('Unscoped search must not run') }),
        Effect.provideService(AccessDecisionGate, allowedAccess),
        Effect.flip,
      );
      expect(Schema.is(SearchProjectionUnavailable)(failure)).toBe(true);
    }),
);

it.effect('document and contract relevance is opt-in, validated and recomputed/reranked from the current title', () =>
  Effect.gen(function* currentRelevance() {
    const state = yield* makeState();
    const renamed = {
      contracts: state.contracts.map((contract) => ({ ...contract, subject: 'Nový protokol kanceláře' })),
      documents: state.documents.map((document) => ({ ...document, title: 'Nový protokol kanceláře' })),
    };
    for (const resourceType of ['legal.agreements.contract', 'legal.agreements.document'] as const) {
      const candidates = (yield* build(renamed))
        .filter(({ ref }) => ref.resourceType === resourceType)
        .map((hit) => ({ ...hit, relevance: { score: 0, version: '1' as const }, title: 'protokol' }));
      const search = (includeRelevance: boolean) =>
        loadCurrentSearchHits(scope, resourceType, { includeRelevance, query: 'protokol' }, renamed).pipe(
          Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(candidates) }),
          Effect.provideService(AccessDecisionGate, allowedAccess),
        );
      expect(yield* search(false)).toMatchObject([{ title: 'Nový protokol kanceláře' }]);
      expect((yield* search(false))[0]).not.toHaveProperty('relevance');
      const scored = yield* search(true);
      expect(scored).toMatchObject([{ relevance: { score: 700, version: '1' }, title: 'Nový protokol kanceláře' }]);
      expect(
        Schema.is(
          resourceType === 'legal.agreements.contract'
            ? ContractsProviderResponseSchema
            : DocumentsProviderResponseSchema,
        )(scored),
      ).toBe(true);
    }
    const second = {
      ...renamed,
      documents: [
        ...renamed.documents,
        ...renamed.documents.map((document) => ({
          ...document,
          documentRef: { ...document.documentRef, resourceId: otherDocumentId },
          title: 'protokol',
        })),
      ],
    };
    const indexed = yield* build(second);
    const result = yield* loadCurrentSearchHits(
      scope,
      'legal.agreements.document',
      { includeRelevance: true, query: 'protokol' },
      second,
    ).pipe(
      Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(indexed) }),
      Effect.provideService(AccessDecisionGate, allowedAccess),
    );
    expect(result.map(({ ref }) => ref.resourceId)).toEqual([otherDocumentId, documentId]);
    expect(result).toMatchObject([{ relevance: { score: 900 } }, { relevance: { score: 700 } }]);
  }),
);

it.effect(
  'projector publishes both complete resource-type units; deletion and stale generations preserve Core floors',
  () =>
    Effect.gen(function* completeUnits() {
      let state = yield* makeState();
      let version = '1';
      const store = makeInMemoryCoreSearchProjectionStore();
      const replacements: unknown[] = [];
      const projector = yield* createSearchProjector.pipe(
        Effect.provideService(SearchSource, {
          load: () => Effect.succeed({ companies: [{ legalEntityId, state }], projectionVersion: version, tenantId }),
        }),
        Effect.provideService(CoreSearchProjectionStore, {
          ...store,
          apply: () => Effect.die('Per-record ingestion is forbidden'),
          replace: (replacement, worker) => {
            replacements.push(replacement);
            return store.replace(replacement, worker);
          },
        }),
      );
      yield* projector.project(context);
      expect(replacements).toMatchObject([
        { documents: [{ ref: contractRef }], rebuildVersion: '1', resourceType: contractRef.resourceType },
        { documents: [{ ref: documentRef }], rebuildVersion: '1', resourceType: documentRef.resourceType },
      ]);
      const original = state;
      state = { ...state, documents: [] };
      version = '2';
      yield* projector.project(context);
      expect(replacements[3]).toMatchObject({
        documents: [],
        rebuildVersion: '2',
        resourceType: documentRef.resourceType,
      });
      state = original;
      version = '1';
      yield* projector.project(context);
      const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      expect(
        yield* loadCurrentSearchHits(
          scope,
          'legal.agreements.document',
          { includeArchived: true, query: 'predavaci' },
          state,
        ).pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
          Effect.provideService(AccessDecisionGate, allowedAccess),
        ),
      ).toEqual([]);
    }),
);

it.layer(NodeCrypto.layer)('registered Legal document search lifecycle', (suite) => {
  suite.effect('loads scoped SQL, commits, then checks original parent authority and searches with evidence', () =>
    Effect.scoped(
      Effect.gen(function* registeredSearch() {
        const state = yield* makeState();
        const candidates = yield* build(state);
        const harness = yield* makeReadTestHarness({
          access: 'allowed',
          executeOwnerQuery: ({ params, scope: actual, sql }) => {
            expect(sql).toContain('"legal_agreements"."state"');
            expect(params).toEqual([tenantId, legalEntityId, 1]);
            expect(actual).toEqual({ legalEntityId, tenantId });
            return Effect.succeed([{ legalEntityId, revision: 7, snapshot: state, tenantId }]);
          },
          operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T00:00:00.000Z')),
          ownerAuthorizationDecision: 'allowed',
          ownerRegistration: legalAgreementsRegistration,
          scope,
        });
        let parentChecks = 0;
        const access = gateWithList((input) =>
          Effect.gen(function* parentAfterCommit() {
            parentChecks += 1;
            expect(harness.snapshot().statements).toContain('COMMIT');
            expect(input.carrier.accessDeclaration).toBe(contractsRead.descriptor.accessDeclaration);
            expect(input.scope).toMatchObject(scope);
            expect(harness.snapshot().ownerQueries).toHaveLength(1);
            return yield* allowedAccess.list(input);
          }),
        );
        const result = yield* harness.runtime
          .runRead({
            input: { includeRelevance: true, query: 'predavaci' },
            principal: scope,
            registration: documentsRead,
            transport: { correlationId: scope.correlationId },
          })
          .pipe(
            Effect.provideService(ContextAccess, retiredAccess),
            Effect.provideService(AccessDecisionGate, access),
            Effect.provideService(CoreSearchQueryRuntime, {
              search: (_input, _scope, authorization) => {
                expect(harness.snapshot().ownerQueries).toHaveLength(1);
                expect(harness.snapshot().statements).toContain('COMMIT');
                expect(authorization?.listAccess).toBeDefined();
                return Effect.succeed(candidates);
              },
            }),
          );
        expect(result).toMatchObject([
          {
            ref: documentRef,
            relevance: { score: 800, version: '1' },
            selectedLegalEntityId: legalEntityId,
            title: 'Předávací protokol kanceláře',
          },
        ]);
        expect(parentChecks).toBe(1);
        expect(harness.snapshot().evidenceWrites).toBe(1);
      }),
    ),
  );
  suite.effect('canonical search denial occurs before private SQL or index observation', () =>
    Effect.scoped(
      Effect.gen(function* deniedRead() {
        const harness = yield* makeReadTestHarness({
          access: 'denied',
          executeOwnerQuery: () => Effect.die('Denied entrypoint must not load owner SQL'),
          operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T00:00:00.000Z')),
          ownerAuthorizationDecision: 'allowed',
          ownerRegistration: legalAgreementsRegistration,
          scope,
        });
        const denied = yield* harness.runtime
          .runRead({
            input: { query: 'predavaci' },
            principal: scope,
            registration: documentsRead,
            transport: { correlationId: scope.correlationId },
          })
          .pipe(
            Effect.provideService(ContextAccess, retiredAccess),
            Effect.provideService(AccessDecisionGate, gateAnswer('DENIED')),
            Effect.provideService(CoreSearchQueryRuntime, {
              search: () => Effect.die('Denied entrypoint must not search'),
            }),
            Effect.flip,
          );
        expect(Schema.is(ReadPermissionDenied)(denied)).toBe(true);
        expect(harness.snapshot().ownerQueries).toEqual([]);
      }),
    ),
  );
});
