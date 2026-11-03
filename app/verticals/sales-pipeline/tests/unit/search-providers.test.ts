import { CoreSearchQueryRuntime, CoreSearchProjectionHitSchema } from '@app/core-runtime';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { OpportunitiesProviderResponseSchema } from '../../shared/apis/opportunities-search.ts';
import { loadSearch } from '../../src/services/search-read.ts';
import { company, otherCompany, otherTenant, ref, scope } from './search-fixtures.ts';

const hit = { archived: false, facets: [], metadata: [], ref, selectedLegalEntityId: company, title: 'Lidský název' };
it.effect('wire contract requires owner resource, tenant and selected company', () =>
  Effect.gen(function* test() {
    expect(
      Schema.is(OpportunitiesProviderResponseSchema)([{ ref, selectedLegalEntityId: company, title: hit.title }]),
    ).toBe(true);
    expect(Schema.is(OpportunitiesProviderResponseSchema)([{ ref, title: hit.title }])).toBe(false);
    const { tenantId: _tenantId, ...unscopedRef } = ref;
    expect(
      Schema.is(OpportunitiesProviderResponseSchema)([
        { ref: unscopedRef, selectedLegalEntityId: company, title: hit.title },
      ]),
    ).toBe(false);
    yield* Effect.void;
  }),
);
it('accepts only the verified optional Core relevance v1 score range', () => {
  const result = { ref, selectedLegalEntityId: company, title: hit.title };
  expect(Schema.is(OpportunitiesProviderResponseSchema)([result])).toBe(true);
  for (const relevance of [
    { score: 0, version: '1' },
    { score: 1000, version: '1' },
  ]) {
    expect(Schema.is(OpportunitiesProviderResponseSchema)([{ ...result, relevance }])).toBe(true);
  }
  for (const relevance of [
    { score: -1, version: '1' },
    { score: 1001, version: '1' },
    { score: 500.5, version: '1' },
    { score: 500, version: '2' },
  ]) {
    expect(Schema.is(OpportunitiesProviderResponseSchema)([{ ...result, relevance }])).toBe(false);
  }
});
it.effect('passes trusted context into Core and returns only the raw wire fields', () =>
  Effect.gen(function* test() {
    const parsed = yield* Schema.decodeEffect(CoreSearchProjectionHitSchema)(hit);
    const result = yield* loadSearch(scope, 'lidsky').pipe(
      Effect.provideService(CoreSearchQueryRuntime, {
        search: (input, operationScope) => {
          expect(input).toMatchObject({
            includeArchived: false,
            includeRelevance: true,
            moduleId: ref.moduleId,
            resourceType: ref.resourceType,
            selectedLegalEntityId: company,
            tenantId: scope.tenantId,
          });
          expect(operationScope).toEqual(scope);
          return Effect.succeed([parsed]);
        },
      }),
    );
    expect(result).toEqual([{ ref, selectedLegalEntityId: company, title: hit.title }]);
    expect(result[0]).not.toHaveProperty('relevance');
  }),
);
it.effect('publishes a verified Core relevance without inventing one', () =>
  Effect.gen(function* test() {
    const parsed = yield* Schema.decodeEffect(CoreSearchProjectionHitSchema)({
      ...hit,
      relevance: { score: 1000, version: '1' },
    });
    const result = yield* loadSearch(scope, 'lidsky').pipe(
      Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed([parsed]) }),
    );
    expect(result).toEqual([
      {
        ref,
        relevance: { score: 1000, version: '1' },
        selectedLegalEntityId: company,
        title: hit.title,
      },
    ]);
  }),
);
it.effect('fails closed for forged tenant/company/module/type, archived and expanded alias hits', () =>
  Effect.gen(function* test() {
    const candidates = [
      { ...hit, selectedLegalEntityId: otherCompany },
      { ...hit, ref: { ...ref, tenantId: otherTenant } },
      { ...hit, ref: { ...ref, moduleId: 'demo.foreign' } },
      { ...hit, ref: { ...ref, resourceType: 'demo.foreign.record' } },
      { ...hit, archived: true },
      { ...hit, subjectRef: ref },
      { ...hit, matchedRef: ref },
    ];
    for (const candidate of candidates) {
      const parsed = yield* Schema.decodeEffect(CoreSearchProjectionHitSchema)(candidate);
      const result = yield* loadSearch(scope, 'x')
        .pipe(Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed([parsed]) }))
        .pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
    }
    const { legalEntityId: _company, ...noCompany } = scope;
    const missing = yield* loadSearch(noCompany, 'x')
      .pipe(
        Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.die('No Core query without company') }),
      )
      .pipe(Effect.exit);
    expect(Exit.isFailure(missing)).toBe(true);
  }),
);
