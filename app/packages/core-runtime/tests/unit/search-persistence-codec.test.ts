import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  CORE_SEARCH_BODY_TEXT_MAX_LENGTH,
  CoreSearchBodyTextSchema,
  CoreSearchPersistedPayloadSchema,
  coreSearchDocumentBodyText,
  coreSearchDocumentPayload,
  decodeCoreSearchDocumentRow,
} from '../../src/search/persistence.ts';
import {
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionStore,
  createCoreSearchQueryRuntime,
} from '../../src/search/projection.ts';
import type { CoreSearchProjectionDocument, CoreSearchProjectionStoreService } from '../../src/search/projection.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const companyId = '20000000-0000-4000-8000-000000000001';
const moduleId = 'demo.merchandise';
const resourceType = 'demo.merchandise.product';
const resourceId = `${companyId}.${'x'.repeat(300)}`;
const ref = { moduleId, resourceId, resourceType, tenantId };
const payloadJson = Schema.fromJsonString(CoreSearchPersistedPayloadSchema);
const encodePayload = Schema.encodeSync(payloadJson);
const decodePayload = Schema.decodeSync(payloadJson);
const document = (searchableText: readonly string[], title = 'Supported product') =>
  Schema.decodeSync(CoreSearchProjectionDocumentSchema)({
    aliases: [{ kind: 'resource', ref, searchableText: ['Alias'] }],
    archived: false,
    facets: [{ key: 'product-state', values: ['active'] }],
    matchedRef: ref,
    matchedSubjectRef: ref,
    metadata: [{ key: 'public-description', kind: 'string', value: 'Product description' }],
    projectionVersion: '7',
    ref,
    searchableText,
    selectedLegalEntityId: companyId,
    subjectRef: ref,
    temporalFacets: [{ key: 'product-state', validFrom: '2026-01-01T00:00:00Z', value: 'active' }],
    temporalSearchableText: [{ validFrom: '2026-01-01T00:00:00Z', value: 'Seasonal product' }],
    title,
  });
const persistedRow = (value: CoreSearchProjectionDocument) => ({
  bodyText: Result.getOrThrow(coreSearchDocumentBodyText(value)),
  facetsJson: decodePayload(encodePayload(coreSearchDocumentPayload(value))),
  legalEntityId: value.selectedLegalEntityId ?? null,
  projectionVersion: BigInt(value.projectionVersion),
  sourceModuleKey: value.ref.moduleId,
  sourceResourceId: value.ref.resourceId,
  sourceResourceType: value.ref.resourceType,
  tenantId: value.ref.tenantId,
  title: value.title,
});
const fullTerms = [
  'parent-sku-only',
  'parent-name-only',
  ...Array.from({ length: 1000 }, (_, index) => {
    const number = index.toString().padStart(4, '0');
    return [`sku-${number}-end`, `name-${number}-end`];
  }).flat(),
].map((term) => term.padEnd(300, '.'));
const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000009',
    authContextRef: 'better-auth-session:search-persistence-codec',
    authMethod: 'session',
    legalEntityId: companyId,
    principalId: '40000000-0000-4000-8000-000000000008',
    tenantId,
  }),
  correlationId: 'search-persistence-codec',
};

it('v2 storage round-trips exact individual terms, including duplicate, newline and normalization-sensitive text', () => {
  const value = document(['Červená', 'ﬃ', 'MiXeD', 'line\nbreak', 'Červená']);
  const row = persistedRow(value);
  expect(row.facetsJson.schemaVersion).toBe('2');
  expect(row.facetsJson.searchableText).toEqual(value.searchableText);
  expect(row.bodyText).toContain('ffi');
  expect(row.bodyText).not.toContain('ﬃ');
  expect(Result.getOrThrow(decodeCoreSearchDocumentRow(row))).toEqual(value);
  expect(Result.isFailure(decodeCoreSearchDocumentRow({ ...row, bodyText: 'stale or altered aggregate' }))).toBe(true);
});

it.effect('all 2002 full-length terms survive SQL-row decoding and the final active variant still matches', () =>
  Effect.gen(function* searchPersistedFinalVariant() {
    const value = document(fullTerms, 'T'.repeat(300));
    const row = persistedRow(value);
    expect(row.bodyText).toHaveLength(602_902);
    const decoded = yield* Effect.fromResult(decodeCoreSearchDocumentRow(row));
    expect(decoded).toEqual(value);
    expect(decoded.searchableText).toHaveLength(2002);
    expect(decoded.searchableText.every((term) => term.length === 300)).toBe(true);
    const store: CoreSearchProjectionStoreService = {
      apply: () => Effect.void,
      queryCandidates: () => Effect.succeed([decoded]),
      replace: () => Effect.void,
    };
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    for (const query of ['parent-sku-only', 'parent-name-only', 'sku-0000-end', 'sku-0999-end', 'name-0999-end']) {
      const hits = yield* runtime.search(
        { includeArchived: false, moduleId, query, resourceType, selectedLegalEntityId: companyId, tenantId },
        scope,
      );
      expect(hits.map(({ ref: hitRef }) => hitRef.resourceId)).toEqual([resourceId]);
    }
  }),
);

it('the aggregate capacity accounts for worst-case Unicode normalization without clipping any text', () => {
  // Unicode 17 U+FDFA is the maximum NFKC + und lowercase expansion, 18 output units per input unit.
  const term = '\uFDFA'.repeat(300);
  expect('\uFDFA'.normalize('NFKC').toLocaleLowerCase('und')).toHaveLength(18);
  expect('İ'.normalize('NFKC').toLocaleLowerCase('und')).toHaveLength(2);
  const value = document(
    Array.from({ length: 2002 }, () => term),
    term,
  );
  const row = persistedRow(value);
  expect(CORE_SEARCH_BODY_TEXT_MAX_LENGTH).toBe(10_818_202);
  expect(row.bodyText).toHaveLength(CORE_SEARCH_BODY_TEXT_MAX_LENGTH);
  expect(Schema.is(CoreSearchBodyTextSchema)(row.bodyText)).toBe(true);
  expect(Schema.is(CoreSearchBodyTextSchema)(`${row.bodyText}x`)).toBe(false);
  expect(Result.getOrThrow(decodeCoreSearchDocumentRow(row))).toEqual(value);
});

it('storage fails closed on legacy or unknown versions and unsupported term or resource bounds', () => {
  const row = persistedRow(document(['parent']));
  const { searchableText, ...legacyPayload } = row.facetsJson;
  expect(searchableText).toEqual(['parent']);
  for (const facetsJson of [
    { ...legacyPayload, schemaVersion: '1' },
    { ...row.facetsJson, schemaVersion: '1' },
    { ...row.facetsJson, schemaVersion: '3' },
    legacyPayload,
    { ...row.facetsJson, searchableText: ['x'.repeat(301)] },
    { ...row.facetsJson, searchableText: [...fullTerms, 'overflow'] },
    { ...row.facetsJson, searchableText: [''] },
  ]) {
    expect(Result.isFailure(decodeCoreSearchDocumentRow({ ...row, facetsJson }))).toBe(true);
  }
  for (const sourceResourceId of ['x'.repeat(301), `${companyId}.`, `${companyId}.${'x'.repeat(301)}`]) {
    expect(Result.isFailure(decodeCoreSearchDocumentRow({ ...row, sourceResourceId }))).toBe(true);
  }
});
