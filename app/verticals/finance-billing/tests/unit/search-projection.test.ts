import { SearchSource } from '../../src/services/search-source.ts';
import { SearchProjectionUnavailable } from '../../shared/domain/search-projection-error.ts';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  CoreSearchProjectionHitSchema,
  CoreSearchQueryRuntime,
  CoreSearchProjectionStore,
  ResourceContainmentRelationshipMutation,
} from '@app/core-runtime';
import { FinanceStateSchema, FinanceInvoiceResourceIdSchema } from '../../shared/apis/records.ts';
import { buildSearchDocuments, loadSearchHits, createSearchProjector } from '../../src/services/search-projection.ts';
import { InvoicesProviderRequestSchema, InvoicesProviderResponseSchema } from '../../shared/apis/invoices-search.ts';
import { DocumentsProviderRequestSchema, DocumentsProviderResponseSchema } from '../../shared/apis/documents-search.ts';
import { invoicesRead } from '../../src/search/invoices.provider.ts';
import { documentsRead } from '../../src/search/documents.provider.ts';
import type { OperationalScope, OutboxWorkerHandlerContext } from '@app/core-runtime';

const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const otherCompany = '30000000-0000-4000-8000-000000000002';
const scope: OperationalScope = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'test',
  authMethod: 'session',
  correlationId: 'search-test',
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
  producerModuleKey: 'finance.billing',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'finance.billing.search-changed.v1',
  workerKey: 'finance.billing.project-search',
};
const empty = { financialPlanEntries: [], invoices: [] };
const state = () =>
  Schema.decodeUnknownEffect(FinanceStateSchema)({
    ...empty,
    documents: [
      {
        actorLabel: 'secret-actor',
        fileName: 'Veřejná příloha.pdf',
        id: 'document-1',
        mimeType: 'application/pdf',
        sha256: 'secret-hash',
        sizeBytes: 10,
        uploadedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
  });
it.effect('projects public filename and required trusted company, not hashes, actors or bytes', () =>
  Effect.gen(function* test() {
    const documents = yield* buildSearchDocuments({
      companies: [{ legalEntityId, state: yield* state() }],
      projectionVersion: '1',
      tenantId,
    });
    expect(documents.length).toBe(1);
    expect(documents[0]?.selectedLegalEntityId).toBe(legalEntityId);
    expect(documents[0]?.ref.tenantId).toBe(tenantId);
    expect(documents[0]?.searchableText).toEqual(['Veřejná příloha.pdf']);
    expect(documents[0]?.metadata).toEqual([]);
    expect(documents[0]?.title).toBe('Veřejná příloha.pdf');
  }),
);
it.effect('never discovers an attachment of a missing or withdrawn invoice', () =>
  Effect.gen(function* test() {
    const original = yield* state();
    const documents = yield* buildSearchDocuments({
      companies: [
        {
          legalEntityId,
          state: {
            ...original,
            documents: (original.documents ?? []).map((document) => ({
              ...document,
              invoiceResourceId: FinanceInvoiceResourceIdSchema.make('missing'),
            })),
          },
        },
      ],
      projectionVersion: '2',
      tenantId,
    });
    expect(documents).toEqual([]);
  }),
);
it.effect('queries only trusted company and rejects wrong company/tenant hits', () =>
  Effect.gen(function* test() {
    const hit = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
      archived: false,
      facets: [],
      metadata: [],
      ref: { moduleId: 'finance.billing', resourceId: 'invoice-1', resourceType: 'finance.billing.invoice', tenantId },
      selectedLegalEntityId: legalEntityId,
      title: 'Faktura',
    });
    const hits = yield* loadSearchHits(scope, 'finance.billing.invoice', {
      includeArchived: true,
      query: 'Faktura',
    }).pipe(
      Effect.provideService(CoreSearchQueryRuntime, {
        search: (input, actualScope) => {
          expect(input).toMatchObject({ includeArchived: false, selectedLegalEntityId: legalEntityId, tenantId });
          expect(actualScope).toBe(scope);
          return Effect.succeed([hit]);
        },
      }),
    );
    expect(hits).toHaveLength(1);
    const denied = yield* loadSearchHits(scope, 'finance.billing.invoice', { query: 'Faktura' }).pipe(
      Effect.provideService(CoreSearchQueryRuntime, {
        search: () =>
          Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))([
            { ...hit, selectedLegalEntityId: otherCompany },
          ]).pipe(Effect.orDie),
      }),
      Effect.flip,
    );
    expect(Schema.is(SearchProjectionUnavailable)(denied)).toBe(true);
    const wrongTenant = yield* loadSearchHits(scope, 'finance.billing.invoice', { query: 'Faktura' }).pipe(
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
it('both request contracts share normalized nonempty input and retain boolean archive compatibility', () => {
  for (const request of [InvoicesProviderRequestSchema, DocumentsProviderRequestSchema]) {
    for (const query of ['', ' ', '\u0301\u030C', 'x'.repeat(201)]) {
      expect(Schema.is(request)({ query })).toBe(false);
    }
    for (const includeArchived of [false, true]) {
      expect(Schema.is(request)({ includeArchived, query: 'Žluťoučký' })).toBe(true);
    }
    expect(Schema.is(request)({ query: 'x'.repeat(200) })).toBe(true);
    expect(Schema.is(request)({ query: 'x' })).toBe(true);
    expect(Schema.is(request)({ query: 'Faktura' })).toBe(true);
  }
});
it('both Finance response contracts accept legacy hits and only relevance v1 integer scores in 0..1000', () => {
  for (const [schema, resourceType] of [
    [InvoicesProviderResponseSchema, 'finance.billing.invoice'],
    [DocumentsProviderResponseSchema, 'finance.billing.document'],
  ] as const) {
    const hit = {
      ref: { moduleId: 'finance.billing', resourceId: 'record-1', resourceType, tenantId },
      selectedLegalEntityId: legalEntityId,
      title: 'Current public title',
    };
    expect(Schema.is(schema)([hit])).toBe(true);
    for (const score of [0, 100, 1000]) {
      expect(Schema.is(schema)([{ ...hit, relevance: { score, version: '1' } }])).toBe(true);
    }
    for (const relevance of [
      { score: -1, version: '1' },
      { score: 1001, version: '1' },
      { score: 1.5, version: '1' },
      { score: 100, version: '2' },
    ]) {
      expect(Schema.is(schema)([{ ...hit, relevance }])).toBe(false);
    }
  }
});
it('raw results require tenant and company; each provider retains the native module and company gates', () => {
  expect(
    Schema.is(InvoicesProviderResponseSchema)([
      { ref: { moduleId: 'finance.billing', resourceId: 'a', resourceType: 'finance.billing.invoice' }, title: 'A' },
    ]),
  ).toBe(false);
  expect(invoicesRead.descriptor.legalEntityScope).toBe('required');
  expect(documentsRead.descriptor.legalEntityScope).toBe('required');
  expect(invoicesRead.descriptor.permissionTarget).toBe('module');
  for (const registration of [invoicesRead, documentsRead]) {
    expect(registration.descriptor.resultAuthorization).toEqual({
      accessFiltering: 'legal_entity_scope',
      kind: 'owner-legal-entity-scope',
      requiredModuleAccess: true,
    });
    expect(registration.descriptor.entrypoint.authorization).toEqual({
      kind: 'context_permission',
      permission: 'module.access',
    });
  }
});
it.effect('full replacement updates titles, prunes deletion and touches containment only post snapshot', () =>
  Effect.gen(function* test() {
    const original = yield* state();
    let current = original;
    let projectionVersion = '1';
    let snapshotClosed = false;
    const replacements: unknown[] = [];
    const touched: unknown[] = [];
    const projector = yield* createSearchProjector.pipe(
      Effect.provideService(SearchSource, {
        load: () =>
          Effect.sync(() => {
            snapshotClosed = true;
            return { companies: [{ legalEntityId, state: current }], projectionVersion, tenantId };
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
        touch: (request) => {
          expect(snapshotClosed).toBe(true);
          touched.push(request);
          return Effect.void;
        },
      }),
    );
    yield* projector.project(context);
    expect(touched).toHaveLength(1);
    expect(touched[0]).toMatchObject({
      relationships: [
        { container: { objectType: 'module_access' }, relation: 'module', resource: { objectType: 'resource' } },
      ],
    });
    current = {
      ...original,
      documents: (original.documents ?? []).map((document) => ({ ...document, fileName: 'Nová příloha.pdf' })),
    };
    projectionVersion = '2';
    snapshotClosed = false;
    yield* projector.project(context);
    expect(replacements[3]).toMatchObject({ documents: [{ title: 'Nová příloha.pdf' }], rebuildVersion: '2' });
    current = { ...original, documents: [] };
    projectionVersion = '3';
    snapshotClosed = false;
    yield* projector.project(context);
    expect(replacements[5]).toMatchObject({
      documents: [],
      rebuildVersion: '3',
      resourceType: 'finance.billing.document',
      tenantId,
    });
    const deniedProjector = yield* createSearchProjector.pipe(
      Effect.provideService(SearchSource, {
        load: () => Effect.succeed({ companies: [], projectionVersion: '4', tenantId: otherCompany }),
      }),
      Effect.provideService(CoreSearchProjectionStore, {
        apply: () => Effect.void,
        queryCandidates: () => Effect.succeed([]),
        replace: () => Effect.die('cross-tenant replace'),
      }),
      Effect.provideService(ResourceContainmentRelationshipMutation, {
        touch: () => Effect.die('cross-tenant containment'),
      }),
    );
    expect(Schema.is(SearchProjectionUnavailable)(yield* deniedProjector.project(context).pipe(Effect.flip))).toBe(
      true,
    );
  }),
);
it.effect('invoice labels are public, voided invoices disappear and tenant mismatch fails closed', () =>
  Effect.gen(function* test() {
    const invoice = {
      accountingCorrelation: 'private-accounting',
      accountingSyncState: 'FAILED',
      businessState: 'CONFIRMED',
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: 'a0000000-0000-4000-8000-000000000012',
        resourceType: 'party.registry.counterparty',
        tenantId,
      },
      createdAt: '2026-11-01T00:00:00Z',
      currency: 'CZK',
      direction: 'OUTGOING',
      documentNumber: 'FV-2026-101',
      dueDate: '2026-11-10',
      issueDate: '2026-11-01',
      paidMinor: 0,
      paymentState: 'UNPAID',
      ref: {
        moduleId: 'finance.billing',
        resourceId: 'invoice-101',
        resourceType: 'finance.billing.invoice',
        tenantId,
      },
      totalMinor: 100,
      updatedAt: '2026-11-01T00:00:00Z',
    };
    const decoded = yield* Schema.decodeUnknownEffect(FinanceStateSchema)({ ...empty, invoices: [invoice] });
    const documents = yield* buildSearchDocuments({
      companies: [{ legalEntityId, state: decoded }],
      projectionVersion: '1',
      tenantId,
    });
    expect(documents[0]?.title).toBe('FV-2026-101');
    expect(documents[0]?.searchableText).toEqual(['FV-2026-101', '2026-11-01', '2026-11-10']);
    const voided = yield* Schema.decodeUnknownEffect(FinanceStateSchema)({
      ...empty,
      invoices: [{ ...invoice, businessState: 'VOIDED' }],
    });
    expect(
      yield* buildSearchDocuments({ companies: [{ legalEntityId, state: voided }], projectionVersion: '2', tenantId }),
    ).toEqual([]);
    const failure = yield* buildSearchDocuments({
      companies: [{ legalEntityId, state: decoded }],
      projectionVersion: '3',
      tenantId: otherCompany,
    }).pipe(Effect.flip);
    expect(Schema.is(SearchProjectionUnavailable)(failure)).toBe(true);
  }),
);
