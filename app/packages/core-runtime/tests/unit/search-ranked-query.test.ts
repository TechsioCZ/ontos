import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import {
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionInvalid,
  CoreSearchProjectionStore,
  CoreSearchProjectionUnavailable,
  CoreSearchQuerySchema,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '../../src/search/projection.ts';
import type { CoreSearchProjectionDocument, CoreSearchProjectionStoreService } from '../../src/search/projection.ts';
import {
  CORE_SEARCH_MAX_RESOURCE_TYPES,
  CORE_SEARCH_RELEVANCE_VERSION,
  parseCoreSearchQuery,
} from '../../src/search/search-contract.ts';
import { coreSearchRank, coreSearchRelevance } from '../../src/search/search-ranking.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const moduleId = 'party.registry';
const resourceType = 'party.registry.party';
const ref = (resourceId: string) => ({ moduleId, resourceId, resourceType, tenantId });
const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000009',
    authContextRef: 'better-auth-session:search-ranked-query',
    authMethod: 'session',
    principalId: '40000000-0000-4000-8000-000000000008',
    tenantId,
  }),
  correlationId: 'search-ranked-query',
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
const document = (
  resourceId: string,
  overrides: Partial<typeof CoreSearchProjectionDocumentSchema.Encoded> = {},
): CoreSearchProjectionDocument =>
  Schema.decodeSync(CoreSearchProjectionDocumentSchema)({
    archived: false,
    facets: [],
    metadata: [],
    projectionVersion: '1',
    ref: ref(resourceId),
    searchableText: [],
    title: `Document ${resourceId}`,
    ...overrides,
  });
type QueryOverrides = Partial<typeof CoreSearchQuerySchema.Encoded>;
const query = (text: string, overrides: QueryOverrides = {}) => ({
  effectiveAt: '2026-11-03T00:00:00Z',
  includeArchived: false,
  moduleId,
  query: text,
  resourceType,
  tenantId,
  ...overrides,
});
const fixture = (documents: readonly CoreSearchProjectionDocument[]) =>
  Effect.gen(function* makeRankedFixture() {
    const store = makeInMemoryCoreSearchProjectionStore();
    for (const entry of documents) {
      yield* store.apply({ document: entry, kind: 'upsert' }, worker);
    }
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    return { runtime, store };
  });
const ids = (hits: readonly { readonly ref: { readonly resourceId: string } }[]) =>
  hits.map(({ ref: hitRef }) => hitRef.resourceId);

it.effect('requires token AND, accepts reversed words and preserves canonical / single-alias grouping', () =>
  Effect.gen(function* verifyGroupedTokenMatching() {
    const { runtime } = yield* fixture([
      document('canonical', { searchableText: ['Jan', 'Dvořák'] }),
      document('alias', {
        aliases: [{ kind: 'resource', ref: ref('former'), searchableText: ['Dvořák', 'Jan'] }],
      }),
      document('split-alias', {
        aliases: [
          { kind: 'resource', ref: ref('one'), searchableText: ['Jan'] },
          { kind: 'subject', ref: ref('two'), searchableText: ['Dvořák'] },
        ],
      }),
      document('split-canonical-alias', {
        aliases: [{ kind: 'resource', ref: ref('one'), searchableText: ['Dvořák'] }],
        searchableText: ['Jan'],
      }),
      document('missing-token', { searchableText: ['Jan'] }),
    ]);
    for (const text of ['jan dvorak', 'DVOŘÁK JAN', 'jan   dvorak jan']) {
      const hits = yield* runtime.search(query(text), scope);
      expect(ids(hits)).toEqual(['alias', 'canonical']);
      expect(hits[0]?.matchedRef).toEqual(ref('former'));
      expect(hits[1]?.matchedRef).toBeUndefined();
    }
  }),
);

it.effect('combines static and active temporal evidence only inside one group at a half-open effective time', () =>
  Effect.gen(function* verifyTemporalTokenMatching() {
    const { runtime } = yield* fixture([
      document('canonical', {
        searchableText: ['alpha'],
        temporalSearchableText: [{ validFrom: '2026-01-01', validTo: '2027-01-01', value: 'beta' }],
      }),
      document('alias', {
        aliases: [
          {
            kind: 'subject',
            ref: ref('subject'),
            searchableText: ['alpha'],
            temporalSearchableText: [{ validFrom: '2026-01-01', validTo: '2027-01-01', value: 'beta' }],
          },
        ],
      }),
      document('expired', {
        searchableText: ['alpha'],
        temporalSearchableText: [{ validFrom: '2025-01-01', validTo: '2026-01-01', value: 'beta' }],
      }),
    ]);
    const hits = yield* runtime.search(query('beta alpha'), scope);
    expect(ids(hits)).toEqual(['alias', 'canonical']);
    expect(hits[0]?.matchedSubjectRef).toEqual(ref('subject'));
    expect(yield* runtime.search(query('alpha beta', { effectiveAt: '2027-01-01T00:00:00Z' }), scope)).toEqual([]);
    expect(yield* runtime.search(query('alpha beta', { effectiveAt: '2025-12-31T23:59:59Z' }), scope)).toEqual([
      {
        archived: false,
        facets: [],
        metadata: [],
        ref: ref('expired'),
        title: 'Document expired',
      },
    ]);
  }),
);

it.effect('stitches one alias group only while its temporal evidence is current at the fixed effectiveAt', () =>
  Effect.gen(function* verifyExpiredAliasGroup() {
    const { runtime } = yield* fixture([
      document('expired-alias', {
        aliases: [
          {
            kind: 'resource',
            ref: ref('former'),
            searchableText: ['anchor'],
            temporalSearchableText: [{ validFrom: '2025-01-01', validTo: '2026-01-01', value: 'former' }],
          },
        ],
        searchableText: [],
        title: 'Current title',
      }),
    ]);
    expect(yield* runtime.search(query('former anchor'), scope)).toEqual([]);
    expect(yield* runtime.search(query('former anchor', { effectiveAt: '2025-12-31T23:59:59Z' }), scope)).toEqual([
      {
        archived: false,
        facets: [],
        matchedRef: ref('former'),
        metadata: [],
        ref: ref('expired-alias'),
        title: 'Current title',
      },
    ]);
    expect(yield* runtime.search(query('current'), scope)).toEqual([
      {
        archived: false,
        facets: [],
        metadata: [],
        ref: ref('expired-alias'),
        title: 'Current title',
      },
    ]);
  }),
);

it.effect(
  'ranks exact public identifier and title above prefix, phrase, reversed words and neutral private terms',
  () =>
    Effect.gen(function* verifyRanking() {
      const { runtime } = yield* fixture([
        document('loose', { searchableText: ['jan dvorak'], title: 'A loose match' }),
        document('words', { title: 'Dvořák Jan' }),
        document('phrase', { title: 'Pan Jan Dvořák mladší' }),
        document('prefix', { title: 'Jan Dvořák mladší' }),
        document('exact', { title: 'Jan Dvořák' }),
        document('jan dvorak', { searchableText: ['jan dvorak'], title: 'Z identifier' }),
      ]);
      expect(ids(yield* runtime.search(query('jan dvorak'), scope))).toEqual([
        'jan dvorak',
        'exact',
        'prefix',
        'phrase',
        'words',
        'loose',
      ]);
      const privateHit = document('private', { searchableText: ['private@example.test'], title: 'Private customer' });
      const parsed = yield* Effect.fromResult(parseCoreSearchQuery('private@example.test'));
      expect(coreSearchRank(privateHit, parsed)).toBe(5);
    }),
);

it.effect('never emits ranking / evidence fields and deterministically orders tied typed refs', () =>
  Effect.gen(function* verifyPublicCompatibility() {
    const { runtime } = yield* fixture([
      document('z', { searchableText: ['private@example.test'], title: 'Same' }),
      document('a', { searchableText: ['private@example.test'], title: 'Same' }),
    ]);
    const hits = yield* runtime.search(query('private@example.test'), scope);
    expect(ids(hits)).toEqual(['a', 'z']);
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Any))(hits);
    expect(encoded).not.toMatch(/private@example|searchableText|aliases|score|rank|searchTextV1/u);
    expect(hits[0]).toEqual({ archived: false, facets: [], metadata: [], ref: ref('a'), title: 'Same' });
  }),
);

it.effect('rejects normalized-empty and oversized input before candidate IO', () =>
  Effect.gen(function* rejectNormalizedEmptyQueries() {
    let reads = 0;
    const store: CoreSearchProjectionStoreService = {
      ...makeInMemoryCoreSearchProjectionStore(),
      queryCandidates: () =>
        Effect.sync(() => {
          reads += 1;
          return [];
        }),
    };
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    for (const text of ['', '   ', '\u0301\u0308', 'x'.repeat(201)]) {
      const failure = yield* Effect.flip(runtime.search(query(text), scope));
      expect(Schema.is(CoreSearchProjectionInvalid)(failure)).toBe(true);
    }
    expect(reads).toBe(0);
  }),
);

it.effect('rechecks archive, scope, type, company and temporal facets without widening store authority', () =>
  Effect.gen(function* verifyExactSelection() {
    const { runtime } = yield* fixture([
      document('visible', {
        temporalFacets: [{ key: 'role', validFrom: '2026-01-01', validTo: '2027-01-01', value: 'CUSTOMER' }],
        title: 'Alpha',
      }),
      document('archived', { archived: true, title: 'Alpha' }),
      document('company', { selectedLegalEntityId: '20000000-0000-4000-8000-000000000001', title: 'Alpha' }),
    ]);
    expect(
      ids(yield* runtime.search(query('alpha', { facets: [{ key: 'role', values: ['CUSTOMER'] }] }), scope)),
    ).toEqual(['visible']);
    expect(
      yield* runtime.search(
        query('alpha', {
          effectiveAt: '2027-01-01T00:00:00Z',
          facets: [{ key: 'role', values: ['CUSTOMER'] }],
        }),
        scope,
      ),
    ).toEqual([]);
    const failure = yield* Effect.flip(
      runtime.search(
        query('alpha', {
          tenantId: '10000000-0000-4000-8000-000000000002',
        }),
        scope,
      ),
    );
    expect(Schema.is(CoreSearchProjectionUnavailable)(failure)).toBe(true);
    expect(ids(yield* runtime.search(query('alpha'), scope))).toEqual(['visible']);
  }),
);

it.effect('each request observes a new accepted mutation / deletion with no query-answer reuse', () =>
  Effect.gen(function* verifyNoQueryCache() {
    const { runtime, store } = yield* fixture([document('changing', { title: 'Alpha' })]);
    expect(ids(yield* runtime.search(query('alpha'), scope))).toEqual(['changing']);
    yield* store.apply(
      { document: document('changing', { projectionVersion: '2', title: 'Beta' }), kind: 'upsert' },
      worker,
    );
    expect(yield* runtime.search(query('alpha'), scope)).toEqual([]);
    expect(ids(yield* runtime.search(query('beta'), scope))).toEqual(['changing']);
    yield* store.apply({ kind: 'delete', projectionVersion: '3', ref: ref('changing') }, worker);
    expect(yield* runtime.search(query('beta'), scope)).toEqual([]);
  }),
);

it.effect('emits opt-in verified relevance as higher-is-better 0..1000, never the raw rank tier', () =>
  Effect.gen(function* verifyRelevanceAdapter() {
    const { runtime } = yield* fixture([
      document('loose', { searchableText: ['jan dvorak'], title: 'A loose match' }),
      document('words', { title: 'Dvořák Jan' }),
      document('phrase', { title: 'Pan Jan Dvořák mladší' }),
      document('prefix', { title: 'Jan Dvořák mladší' }),
      document('exact', { title: 'Jan Dvořák' }),
      document('jan dvorak', { searchableText: ['jan dvorak'], title: 'Z identifier' }),
    ]);
    const plain = yield* runtime.search(query('jan dvorak'), scope);
    expect(plain.every((hit) => !('relevance' in hit))).toBe(true);
    const ranked = yield* runtime.search(query('jan dvorak', { includeRelevance: true }), scope);
    expect(ids(ranked)).toEqual(['jan dvorak', 'exact', 'prefix', 'phrase', 'words', 'loose']);
    expect(ranked.map((hit) => hit.relevance)).toEqual([
      { score: 1000, version: CORE_SEARCH_RELEVANCE_VERSION },
      { score: 900, version: CORE_SEARCH_RELEVANCE_VERSION },
      { score: 800, version: CORE_SEARCH_RELEVANCE_VERSION },
      { score: 700, version: CORE_SEARCH_RELEVANCE_VERSION },
      { score: 600, version: CORE_SEARCH_RELEVANCE_VERSION },
      { score: 100, version: CORE_SEARCH_RELEVANCE_VERSION },
    ]);
    const parsed = yield* Effect.fromResult(parseCoreSearchQuery('private@example.test'));
    const privateHit = document('private', { searchableText: ['private@example.test'], title: 'Private customer' });
    expect(coreSearchRelevance(privateHit, parsed)).toEqual({
      score: 100,
      version: CORE_SEARCH_RELEVANCE_VERSION,
    });
    for (const hit of ranked) {
      expect(coreSearchRank(hit, parsed)).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(hit.relevance?.score)).toBe(true);
      expect(hit.relevance?.score).toBeGreaterThanOrEqual(0);
      expect(hit.relevance?.score).toBeLessThanOrEqual(1000);
    }
  }),
);

it.effect('accepts a bounded multi-type selector while rejecting empty, oversized or unscoped selectors', () =>
  Effect.gen(function* verifyResourceTypes() {
    const otherType = 'party.registry.counterparty';
    const { runtime } = yield* fixture([
      document('party'),
      document('counterparty', { ref: { ...ref('counterparty'), resourceType: otherType } }),
    ]);
    const { resourceType: _singleType, ...multiTypeQuery } = query('document');
    const unscoped = yield* Effect.flip(runtime.search(multiTypeQuery, scope));
    expect(Schema.is(CoreSearchProjectionInvalid)(unscoped)).toBe(true);
    expect(ids(yield* runtime.search({ ...multiTypeQuery, resourceTypes: [resourceType] }, scope))).toEqual(['party']);
    expect(ids(yield* runtime.search({ ...multiTypeQuery, resourceTypes: [resourceType, otherType] }, scope))).toEqual([
      'counterparty',
      'party',
    ]);
    const base = { includeArchived: false, moduleId, query: 'document', tenantId };
    const accepted = Array.from(
      { length: CORE_SEARCH_MAX_RESOURCE_TYPES },
      (_, index) => `party.registry.type-${index}`,
    );
    expect(
      Result.isSuccess(Schema.decodeUnknownResult(CoreSearchQuerySchema)({ ...base, resourceTypes: accepted })),
    ).toBe(true);
    for (const resourceTypes of [[], [...accepted, 'party.registry.overflow'], undefined]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(CoreSearchQuerySchema)({ ...base, resourceTypes }))).toBe(
        true,
      );
    }
  }),
);

it('validates optional relevance at the public hit schema boundary', () => {
  const base = { archived: false, facets: [], metadata: [], ref: ref('schema'), title: 'Schema' };
  expect(Schema.is(CoreSearchProjectionHitSchema)({ ...base, relevance: { score: 0, version: '1' } })).toBe(true);
  expect(Schema.is(CoreSearchProjectionHitSchema)({ ...base, relevance: { score: 1000, version: '1' } })).toBe(true);
  for (const score of [-1, 1001, 1.5]) {
    expect(Schema.is(CoreSearchProjectionHitSchema)({ ...base, relevance: { score, version: '1' } })).toBe(false);
  }
  for (const version of ['2', 1]) {
    expect(Schema.is(CoreSearchProjectionHitSchema)({ ...base, relevance: { score: 1, version } })).toBe(false);
  }
});
