import { CoreSearchQueryRuntime, CoreSearchProjectionHitSchema } from '@app/core-runtime';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TasksProviderResponseSchema } from '../../shared/apis/tasks-search.ts';
import { loadSearch } from '../../src/services/search-read.ts';
import { company, otherCompany, otherTenant, ref, scope } from './search-fixtures.ts';

const hit = { archived: false, facets: [], metadata: [], ref, selectedLegalEntityId: company, title: 'Lidský název' };
it.effect('wire contract requires owner resource, tenant and selected company', () =>
  Effect.gen(function* test() {
    expect(Schema.is(TasksProviderResponseSchema)([{ ref, selectedLegalEntityId: company, title: hit.title }])).toBe(
      true,
    );
    expect(Schema.is(TasksProviderResponseSchema)([{ ref, title: hit.title }])).toBe(false);
    const { tenantId: _tenantId, ...unscopedRef } = ref;
    expect(
      Schema.is(TasksProviderResponseSchema)([{ ref: unscopedRef, selectedLegalEntityId: company, title: hit.title }]),
    ).toBe(false);
    yield* Effect.void;
  }),
);
it.effect('passes trusted context into Core and returns only the raw wire fields', () =>
  Effect.gen(function* test() {
    const parsed = yield* Schema.decodeEffect(CoreSearchProjectionHitSchema)(hit);
    const result = yield* loadSearch(scope, 'lidsky').pipe(
      Effect.provideService(CoreSearchQueryRuntime, {
        search: (input, operationScope) => {
          expect(input).toMatchObject({
            includeArchived: false,
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
