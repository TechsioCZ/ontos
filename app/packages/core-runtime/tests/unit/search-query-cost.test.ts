import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import {
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionStore,
  CoreSearchProjectionUnavailable,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '../../src/search/projection.ts';
import type {
  CoreSearchProjectionDocument,
  CoreSearchProjectionHit,
  CoreSearchProjectionStoreService,
  CoreSearchQuerySchema,
} from '../../src/search/projection.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const companyId = '20000000-0000-4000-8000-000000000001';
const otherCompanyId = '20000000-0000-4000-8000-000000000002';
const moduleId = 'party.registry';
const resourceType = 'party.registry.counterparty';
const effectiveAt = '2026-11-02T00:00:00Z';
const ref = (resourceId: string) => ({ moduleId, resourceId, resourceType, tenantId });
const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000009',
    authContextRef: 'better-auth-session:search-query-cost',
    authMethod: 'session',
    legalEntityId: companyId,
    principalId: '40000000-0000-4000-8000-000000000008',
    tenantId,
  }),
  correlationId: 'search-query-cost',
};
const worker = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: '50000000-0000-4000-8000-000000000001',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: moduleId,
  deliveryId: '50000000-0000-4000-8000-000000000002',
  domainEventId: '50000000-0000-4000-8000-000000000003',
  legalEntityScope: 'forbidden',
  messageId: '50000000-0000-4000-8000-000000000004',
  producerModuleKey: moduleId,
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'party.registry.search-refresh-requested.v1',
  workerKey: 'party.registry.refresh-search',
});
type DocumentOverrides = Partial<typeof CoreSearchProjectionDocumentSchema.Encoded>;
type QueryOverrides = Partial<typeof CoreSearchQuerySchema.Encoded>;
const document = (resourceId: string, overrides: DocumentOverrides = {}) =>
  Schema.decodeSync(CoreSearchProjectionDocumentSchema)({
    archived: false,
    facets: [],
    metadata: [],
    projectionVersion: '1',
    ref: ref(resourceId),
    searchableText: ['private@example.test', '+420 731 100 201'],
    selectedLegalEntityId: companyId,
    temporalSearchableText: [
      { validFrom: '2026-01-01', validTo: '2027-01-01', value: 'current-secret' },
      { validFrom: '2025-01-01', validTo: '2026-01-01', value: 'expired-secret' },
    ],
    title: `Acme ${resourceId}`,
    ...overrides,
  });
const query = (text: string, overrides: QueryOverrides = {}) => ({
  effectiveAt,
  includeArchived: false,
  moduleId,
  query: text,
  resourceType,
  selectedLegalEntityId: companyId,
  tenantId,
  ...overrides,
});

interface PeriodReads {
  temporalBoundaries: number;
}
type TemporalEvidence = NonNullable<CoreSearchProjectionDocument['temporalSearchableText']>;
const track = (evidence: TemporalEvidence, reads: PeriodReads): TemporalEvidence =>
  evidence.map((entry) => {
    const tracked = {
      ...entry,
      get validFrom() {
        reads.temporalBoundaries += 1;
        return entry.validFrom;
      },
    };
    const { validTo } = entry;
    if (validTo !== undefined) {
      Object.defineProperty(tracked, 'validTo', {
        enumerable: true,
        get: () => {
          reads.temporalBoundaries += 1;
          return validTo;
        },
      });
    }
    return tracked;
  });

const trackDocument = (entry: CoreSearchProjectionDocument, reads: PeriodReads): CoreSearchProjectionDocument => {
  type MutableDocument = { -readonly [Key in keyof CoreSearchProjectionDocument]: CoreSearchProjectionDocument[Key] };
  const tracked: MutableDocument = { ...entry };
  if (entry.temporalSearchableText !== undefined) {
    tracked.temporalSearchableText = track(entry.temporalSearchableText, reads);
  }
  if (entry.aliases !== undefined) {
    tracked.aliases = entry.aliases.map((alias) =>
      alias.temporalSearchableText === undefined
        ? alias
        : { ...alias, temporalSearchableText: track(alias.temporalSearchableText, reads) },
    );
  }
  return tracked;
};

const trackedStore = (
  store: CoreSearchProjectionStoreService,
  reads: PeriodReads,
): CoreSearchProjectionStoreService => ({
  ...store,
  queryCandidates: (input, operationalScope) =>
    store
      .queryCandidates(input, operationalScope)
      .pipe(Effect.map((candidates) => candidates.map((entry) => trackDocument(entry, reads)))),
});

const fixture = (documents: readonly CoreSearchProjectionDocument[]) =>
  Effect.gen(function* makeCostFixture() {
    const store = makeInMemoryCoreSearchProjectionStore();
    for (const entry of documents) {
      yield* store.apply({ document: entry, kind: 'upsert' }, worker);
    }
    const reads: PeriodReads = { temporalBoundaries: 0 };
    // Count only query-time period reads, after the real store has validated the fixtures.
    const runtime = yield* createCoreSearchQueryRuntime.pipe(
      Effect.provideService(CoreSearchProjectionStore, trackedStore(store, reads)),
    );
    return { reads, runtime };
  });

const expectedHit = (entry: CoreSearchProjectionDocument): CoreSearchProjectionHit => {
  const hit = {
    archived: entry.archived,
    facets: entry.facets,
    metadata: entry.metadata,
    ref: entry.ref,
    title: entry.title,
  };
  return entry.selectedLegalEntityId === undefined
    ? hit
    : { ...hit, selectedLegalEntityId: entry.selectedLegalEntityId };
};
const encodeHits = Schema.encodeSync(Schema.fromJsonString(Schema.Any));

it.effect('keeps all 257 exact static matches without reading irrelevant temporal boundaries', () =>
  Effect.gen(function* staticMatchCost() {
    const documents = Array.from({ length: 257 }, (_, index) => document(index.toString().padStart(3, '0')));
    const { reads, runtime } = yield* fixture([
      ...documents,
      document('archived', { archived: true }),
      document('other-company', { selectedLegalEntityId: otherCompanyId }),
    ]);
    const boundaryReads: number[] = [];
    for (const text of ['a', 'private@example.test', '+420 731 100 201']) {
      const hits = yield* runtime.search(query(text), scope);
      expect(hits).toEqual(documents.map(expectedHit));
      expect(encodeHits(hits)).not.toMatch(/private@example|731 100|secret|searchableText|aliases/iu);
      boundaryReads.push(reads.temporalBoundaries);
    }
    expect(boundaryReads).toEqual([0, 0, 0]);
  }),
);

it.effect('retains temporal fallback, half-open periods and canonical-before-alias precedence', () =>
  Effect.gen(function* temporalMatchParity() {
    const entry = document('canonical', {
      aliases: [
        {
          kind: 'resource',
          ref: ref('alias'),
          searchableText: ['former-name', 'Acme'],
          temporalSearchableText: [{ validFrom: '2026-01-01', validTo: '2027-01-01', value: 'former-secret' }],
        },
        {
          kind: 'subject',
          ref: ref('parent'),
          searchableText: [],
          temporalSearchableText: [{ validFrom: '2026-01-01', validTo: '2027-01-01', value: 'subject-secret' }],
        },
      ],
    });
    const { reads, runtime } = yield* fixture([entry]);
    const canonical = expectedHit(entry);
    const actualReads: number[] = [];
    const expectedReads: number[] = [];
    for (const [text, at, expected, boundaryReads] of [
      ['Acme', effectiveAt, [canonical], 0],
      ['current-secret', effectiveAt, [canonical], 4],
      ['expired-secret', '2026-01-01T00:00:00Z', [], 8],
      ['current-secret', '2027-01-01T00:00:00Z', [], 8],
      ['former-name', effectiveAt, [{ ...canonical, matchedRef: ref('alias') }], 4],
      ['former-secret', effectiveAt, [{ ...canonical, matchedRef: ref('alias') }], 6],
      ['subject-secret', effectiveAt, [{ ...canonical, matchedSubjectRef: ref('parent') }], 8],
      ['no-match', effectiveAt, [], 8],
    ] as const) {
      reads.temporalBoundaries = 0;
      const hits = yield* runtime.search(query(text, { effectiveAt: at }), scope);
      expect(hits).toEqual(expected);
      actualReads.push(reads.temporalBoundaries);
      expectedReads.push(boundaryReads);
      expect(encodeHits(hits)).not.toMatch(/secret|searchableText|temporalSearchableText|aliases/iu);
    }
    expect(actualReads).toEqual(expectedReads);
  }),
);

it.effect('does not bypass company, tenant, module, type, facet or archived selection', () =>
  Effect.gen(function* selectionDenials() {
    const { reads, runtime } = yield* fixture([document('visible'), document('archived', { archived: true })]);
    for (const overrides of [
      { selectedLegalEntityId: otherCompanyId },
      { tenantId: '10000000-0000-4000-8000-000000000002' },
    ]) {
      const failure = yield* Effect.flip(runtime.search(query('a', overrides), scope));
      expect(Schema.is(CoreSearchProjectionUnavailable)(failure)).toBe(true);
    }
    for (const overrides of [
      { moduleId: 'other.module' },
      { resourceType: 'party.registry.party' },
      { facets: [{ key: 'current-role', values: ['SUPPLIER'] }] },
    ]) {
      expect(yield* runtime.search(query('a', overrides), scope)).toEqual([]);
    }
    expect((yield* runtime.search(query('a'), scope)).map(({ ref: hitRef }) => hitRef.resourceId)).toEqual(['visible']);
    expect(
      (yield* runtime.search(query('a', { includeArchived: true }), scope)).map(({ ref: hitRef }) => hitRef.resourceId),
    ).toEqual(['archived', 'visible']);
    expect(reads.temporalBoundaries).toBe(0);
  }),
);
