import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import {
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionStore,
  CoreSearchResourceRefSchema,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '../../src/search/projection.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const companyId = '20000000-0000-4000-8000-000000000001';
const otherCompanyId = '20000000-0000-4000-8000-000000000002';
const localId = 'x'.repeat(300);
const moduleId = 'demo.merchandise';
const resourceType = 'demo.merchandise.product';
const ref = (resourceId: string) => ({ moduleId, resourceId, resourceType, tenantId });
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
  topic: 'demo.merchandise.search-refresh-requested.v1',
  workerKey: 'demo.merchandise.refresh-search',
});
const scope = (legalEntityId: string) => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000009',
    authContextRef: 'better-auth-session:search-capacity',
    authMethod: 'session',
    legalEntityId,
    principalId: '40000000-0000-4000-8000-000000000008',
    tenantId,
  }),
  correlationId: 'search-capacity',
});
const product = (
  searchableText: readonly string[],
  selectedLegalEntityId = companyId,
  resourceId = `${companyId}.${localId}`,
) => ({
  archived: false,
  facets: [],
  metadata: [],
  projectionVersion: '1',
  ref: ref(resourceId),
  searchableText,
  selectedLegalEntityId,
  title: 'Supported product',
});
const query = (text: string, selectedLegalEntityId = companyId) => ({
  includeArchived: false,
  moduleId,
  query: text,
  resourceType,
  selectedLegalEntityId,
  tenantId,
});
const terms = [
  'parent-sku-only',
  'Parent name only',
  ...Array.from({ length: 1000 }, (_, index) => {
    const number = index.toString().padStart(4, '0');
    return [`sku-${number}-end`, `Variant ${number} name`];
  }).flat(),
];

it.effect(
  'all 2002 parent and 1000 active variant terms remain searchable with a scoped337 ref',
  () =>
    Effect.gen(function* searchEverySupportedVariantTerm() {
      expect.assertions(2003);
      const store = makeInMemoryCoreSearchProjectionStore();
      yield* store.apply({ document: product(terms), kind: 'upsert' }, worker);
      const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      expect(terms).toHaveLength(2002);
      for (const term of terms) {
        const hits = yield* runtime.search(query(term), scope(companyId));
        expect(hits.map(({ ref: hitRef }) => hitRef.resourceId)).toEqual([`${companyId}.${localId}`]);
      }
    }),
  // Loaded CI completed 224 searches in 5s, so the full loop needs about 45s plus scheduling headroom.
  120_000,
);

it.effect('native300 and scoped337 identities do not change company isolation or trusted scope checks', () =>
  Effect.gen(function* preserveScopedSearchIsolation() {
    const store = makeInMemoryCoreSearchProjectionStore();
    for (const document of [
      product(['boundary-witness']),
      product(['boundary-witness'], otherCompanyId, `${otherCompanyId}.${localId}`),
      product(['native-witness'], companyId, localId),
    ]) {
      yield* store.apply({ document, kind: 'upsert' }, worker);
    }
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    for (const selectedCompany of [companyId, otherCompanyId]) {
      const hits = yield* runtime.search(query('boundary-witness', selectedCompany), scope(selectedCompany));
      expect(hits.map(({ ref: hitRef }) => hitRef.resourceId)).toEqual([`${selectedCompany}.${localId}`]);
    }
    expect(
      (yield* runtime.search(query('native-witness'), scope(companyId))).map(({ ref: hitRef }) => hitRef.resourceId),
    ).toEqual([localId]);
    expect(yield* runtime.search(query('native-witness', otherCompanyId), scope(otherCompanyId))).toEqual([]);
    const failure = yield* Effect.flip(runtime.search(query('boundary-witness', otherCompanyId), scope(companyId)));
    expect(Predicate.isTagged(failure, 'CoreSearchProjectionUnavailable')).toBe(true);
  }),
);

it.effect('2003 terms, empty terms and oversized terms fail mutations and replacements without partial writes', () =>
  Effect.gen(function* rejectUnsupportedSearchCapacity() {
    const store = makeInMemoryCoreSearchProjectionStore();
    for (const searchableText of [[...terms, 'overflow'], [''], ['x'.repeat(301)]]) {
      const document = product(searchableText);
      expect(Schema.is(CoreSearchProjectionDocumentSchema)(document)).toBe(false);
      const mutationFailure = yield* Effect.flip(store.apply({ document, kind: 'upsert' }, worker));
      expect(Predicate.isTagged(mutationFailure, 'CoreSearchProjectionInvalid')).toBe(true);
      const replacementFailure = yield* Effect.flip(
        store.replace({ documents: [document], moduleId, rebuildVersion: '1', resourceType, tenantId }, worker),
      );
      expect(Predicate.isTagged(replacementFailure, 'CoreSearchProjectionInvalid')).toBe(true);
    }
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    expect(yield* runtime.search(query('parent-sku-only'), scope(companyId))).toEqual([]);
    expect(Schema.is(CoreSearchProjectionDocumentSchema)(product(['x'.repeat(300)]))).toBe(true);
  }),
);

it('search resource refs reject malformed scoped and oversized native identities', () => {
  for (const resourceId of [
    '',
    'x'.repeat(301),
    `not-a-company.${localId}`,
    `${companyId.replace('2', 'g')}.${localId}`,
    `${companyId}.`,
    `${companyId}.${'x'.repeat(301)}`,
  ]) {
    expect(Schema.is(CoreSearchResourceRefSchema)(ref(resourceId))).toBe(false);
  }
});
