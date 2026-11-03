import { CoreSearchQueryRuntime, CoreSearchProjectionHitSchema } from '@app/core-runtime';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TasksProviderRequestSchema, TasksProviderResponseSchema } from '../../shared/apis/tasks-search.ts';
import { loadSearch } from '../../src/services/search-read.ts';
import { company, otherCompany, otherTenant, ref, scope } from './search-fixtures.ts';

const hit = { archived: false, facets: [], metadata: [], ref, selectedLegalEntityId: company, title: 'Lidský název' };
it.effect('wire contract requires owner resource, tenant and selected company', () =>
  Effect.gen(function* test() {
    expect(
      yield* Schema.decodeUnknownEffect(TasksProviderResponseSchema)([
        { ref, selectedLegalEntityId: company, title: hit.title },
      ]),
    ).toEqual([{ ref, selectedLegalEntityId: company, title: hit.title }]);
    expect(Schema.is(TasksProviderResponseSchema)([{ ref, title: hit.title }])).toBe(false);
    const { tenantId: _tenantId, ...unscopedRef } = ref;
    expect(
      Schema.is(TasksProviderResponseSchema)([{ ref: unscopedRef, selectedLegalEntityId: company, title: hit.title }]),
    ).toBe(false);
    yield* Effect.void;
  }),
);
it.effect('shares the trimmed 1..200 character ingress query bound', () =>
  Effect.gen(function* test() {
    const decoded = yield* Schema.decodeEffect(TasksProviderRequestSchema)({ query: '  hledat úkol  ' });
    expect(decoded.query).toBe('hledat úkol');
    for (const query of ['   ', 'a'.repeat(201)]) {
      const rejected = yield* Schema.decodeEffect(TasksProviderRequestSchema)({ query }).pipe(Effect.exit);
      expect(Exit.isFailure(rejected)).toBe(true);
    }
    for (const query of ['a', 'a'.repeat(200)]) {
      const accepted = yield* Schema.decodeEffect(TasksProviderRequestSchema)({ query }).pipe(Effect.exit);
      expect(Exit.isSuccess(accepted)).toBe(true);
    }
    yield* Effect.void;
  }),
);
it.effect('opts in at Core while preserving legacy no-metadata responses without inventing relevance', () =>
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
  }),
);
it.effect('passes every verified Core score unchanged without reordering or truncating the hit array', () =>
  Effect.gen(function* verifiedRelevance() {
    const parsed = yield* Schema.decodeEffect(CoreSearchProjectionHitSchema)(hit);
    const hits = [0, 1000, 137].map((score) => ({ ...parsed, relevance: { score, version: '1' as const } }));
    const result = yield* loadSearch(scope, 'lidsky').pipe(
      Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(hits) }),
    );
    expect(result).toEqual(
      hits.map(({ ref: hitRef, relevance, selectedLegalEntityId, title }) => ({
        ref: hitRef,
        relevance,
        selectedLegalEntityId,
        title,
      })),
    );
    expect(Schema.is(TasksProviderResponseSchema)(result)).toBe(true);
  }),
);
it.effect('rejects invalid relevance version, integer or bounds instead of dropping or replacing it', () =>
  Effect.gen(function* invalidRelevance() {
    const parsed = yield* Schema.decodeEffect(CoreSearchProjectionHitSchema)(hit);
    for (const relevance of [
      { score: -1, version: '1' },
      { score: 1001, version: '1' },
      { score: 1.5, version: '1' },
      { score: Number.NaN, version: '1' },
      { score: Number.POSITIVE_INFINITY, version: '1' },
      { score: 500, version: '2' },
      { score: 500, version: 1 },
      { score: '500', version: '1' },
      { version: '1' },
      null,
    ]) {
      expect(
        Schema.is(TasksProviderResponseSchema)([{ ref, relevance, selectedLegalEntityId: company, title: hit.title }]),
      ).toBe(false);
      // A corrupted runtime service must still fail at the owner response boundary.
      const malformed = Object.defineProperty({ ...parsed }, 'relevance', { value: relevance });
      const result = yield* loadSearch(scope, 'lidsky').pipe(
        Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed([parsed, malformed]) }),
        Effect.exit,
      );
      expect(Exit.isFailure(result)).toBe(true);
    }
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
      { ...hit, matchedSubjectRef: ref },
    ];
    for (const candidate of candidates) {
      const parsed = yield* Schema.decodeEffect(CoreSearchProjectionHitSchema)({
        ...candidate,
        relevance: { score: 1000, version: '1' },
      });
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
