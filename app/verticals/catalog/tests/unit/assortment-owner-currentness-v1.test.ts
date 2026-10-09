import { DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AssortmentProductClassificationV1RequestSchema,
  AssortmentProductClassificationV1ResponseSchema,
} from '../../shared/apis/assortment-product-classification-v1.ts';
import type { AssortmentProductClassificationFactsV1Schema } from '../../shared/apis/assortment-product-classification-v1.ts';
import {
  AssortmentSetCompositionV1RequestSchema,
  AssortmentSetCompositionV1ResponseSchema,
} from '../../shared/apis/assortment-set-composition-v1.ts';
import { AssortmentSelectionAssessmentV1RequestSchema } from '../../shared/apis/assortment-selection-assessment-v1.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { SetCompositionRevisionSchema } from '../../shared/domain/set-composition.ts';
import { CategoryPersistenceUnavailable } from '../../src/persistence/category-persistence.ts';
import type { AssortmentProductClassificationV1Source } from '../../src/persistence/assortment-product-classification-v1.ts';
import { observeOrVerifyAssortmentProductClassificationV1 } from '../../src/persistence/assortment-product-classification-v1.ts';
import type { AssortmentSetCompositionV1Source } from '../../src/persistence/assortment-set-composition-v1.ts';
import { observeOrVerifyAssortmentSetCompositionV1 } from '../../src/persistence/assortment-set-composition-v1.ts';
import { SetCompositionPersistenceUnavailable } from '../../src/persistence/set-composition-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const id = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, '0')}`;
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: id('1'),
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: id('2'),
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const compositionRef = {
  moduleId: 'commerce.catalog',
  resourceId: id('3'),
  resourceType: 'commerce.catalog.set-composition',
  tenantId,
} as const;
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: id('4'),
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({ productRef, variantRef });
const firstComponentSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: { ...productRef, resourceId: id('10') },
  variantRef: { ...variantRef, resourceId: id('11') },
});
const secondComponentSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: { ...productRef, resourceId: id('12') },
  variantRef: { ...variantRef, resourceId: id('13') },
});
const composition = (
  revision: number,
  components: readonly unknown[] = [
    {
      componentId: id('20'),
      quantity: { amount: '1', unitRef },
      selection: firstComponentSelection,
    },
    {
      componentId: id('21'),
      quantity: { amount: '2', unitRef },
      selection: secondComponentSelection,
    },
  ],
) => {
  const base = {
    components,
    productRef,
    provenance: {
      changeKind: revision === 1 ? 'INITIAL' : 'MATERIAL_CHANGE',
      evidenceRefs: ['record:composition'],
      reason: 'Recorded Set composition',
    },
    reference: { resourceRef: compositionRef, revision },
    variantRef,
  };
  const revisionInput =
    revision === 1 ? base : { ...base, predecessor: { resourceRef: compositionRef, revision: revision - 1 } };
  return Schema.decodeUnknownSync(SetCompositionRevisionSchema)(revisionInput);
};

const categoryRef = {
  moduleId: 'commerce.catalog',
  resourceId: id('30'),
  resourceType: 'commerce.catalog.product-category',
  tenantId,
} as const;
const effectiveAt = DateTime.fromDateUnsafe(new Date('2026-09-28T12:00:00.000Z'));
const laterEffectiveAt = DateTime.fromDateUnsafe(new Date('2026-09-28T13:00:00.000Z'));

it.effect('proves an exact Set component revision and returns STALE after composition replacement', () =>
  Effect.gen(function* setCompositionReplacement() {
    interface MockCurrentComposition {
      currentRevision: number;
      effectiveFrom: Date;
      revision: typeof SetCompositionRevisionSchema.Type;
    }
    const current: MockCurrentComposition = {
      currentRevision: 1,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      revision: composition(1),
    };
    const source: AssortmentSetCompositionV1Source = {
      observe: () => Effect.succeed(Option.some(current)),
    };
    const observed = yield* observeOrVerifyAssortmentSetCompositionV1(
      { compositionRef, effectiveAt, operation: 'OBSERVE', productRef, variantRef },
      tenantId,
      source,
    );
    expect(observed).toMatchObject({
      observation: {
        completeness: {
          ownerRevision: 'current:1;composition:1',
          scope: { kind: 'EXACT_PREDICATE' },
        },
        composition: { components: [{ componentId: id('20') }, { componentId: id('21') }], reference: { revision: 1 } },
      },
      operation: 'OBSERVE',
    });
    expect(() => Schema.encodeSync(AssortmentSetCompositionV1ResponseSchema)(observed)).not.toThrow();

    if (observed.operation !== 'OBSERVE') {
      throw new Error('Expected initial Set observation');
    }
    const originalObservation = observed.observation;
    const unchanged = yield* observeOrVerifyAssortmentSetCompositionV1(
      { effectiveAt, observation: originalObservation, operation: 'VERIFY_CURRENT' },
      tenantId,
      source,
    );
    expect(unchanged).toMatchObject({ operation: 'VERIFY_CURRENT', status: 'CURRENT' });
    const wrongTime = yield* observeOrVerifyAssortmentSetCompositionV1(
      { effectiveAt: laterEffectiveAt, observation: originalObservation, operation: 'VERIFY_CURRENT' },
      tenantId,
      source,
    );
    expect(wrongTime).toMatchObject({ operation: 'VERIFY_CURRENT', status: 'STALE' });

    current.currentRevision = 2;
    const originalComponents = composition(1).components;
    const reorderedComponents: (typeof originalComponents)[number][] = [];
    for (const component of originalComponents) {
      reorderedComponents.unshift(component);
    }
    current.revision = composition(2, reorderedComponents);
    const reorderedRevision = yield* observeOrVerifyAssortmentSetCompositionV1(
      { effectiveAt, observation: originalObservation, operation: 'VERIFY_CURRENT' },
      tenantId,
      source,
    );
    expect(reorderedRevision).toMatchObject({ operation: 'VERIFY_CURRENT', status: 'STALE' });

    current.currentRevision = 3;
    current.revision = composition(3, [
      ...composition(1).components,
      {
        componentId: id('22'),
        quantity: { amount: '1', unitRef },
        selection: firstComponentSelection,
      },
    ]);
    const stale = yield* observeOrVerifyAssortmentSetCompositionV1(
      { effectiveAt, observation: originalObservation, operation: 'VERIFY_CURRENT' },
      tenantId,
      source,
    );
    expect(stale).toMatchObject({ operation: 'VERIFY_CURRENT', status: 'STALE' });

    const unavailableSource: AssortmentSetCompositionV1Source = {
      observe: () =>
        Effect.fail(
          new SetCompositionPersistenceUnavailable({
            code: 'set_composition_persistence_unavailable',
            reason: 'Owner completeness fence unavailable',
          }),
        ),
    };
    const unavailable = yield* observeOrVerifyAssortmentSetCompositionV1(
      { effectiveAt, observation: originalObservation, operation: 'VERIFY_CURRENT' },
      tenantId,
      unavailableSource,
    );
    expect(unavailable).toMatchObject({ operation: 'VERIFY_CURRENT', status: 'UNAVAILABLE' });
  }),
);

it.effect('proves an empty classification set and detects a later matching assignment', () =>
  Effect.gen(function* classificationInsertion() {
    let current: typeof AssortmentProductClassificationFactsV1Schema.Type = {
      ancestors: [],
      directCategories: [],
      revision: { assignments: 0, hierarchy: 0 },
    };
    const source: AssortmentProductClassificationV1Source = {
      read: () => Effect.succeed(Option.some(current)),
    };
    const observed = yield* observeOrVerifyAssortmentProductClassificationV1(
      { effectiveAt, operation: 'OBSERVE', productRef },
      tenantId,
      source,
    );
    expect(observed).toMatchObject({
      observation: {
        completeness: {
          ownerRevision: 'assignments:0;hierarchy:0',
          scope: {
            declaredScopeRef: `tenant-category-classification:${tenantId}`,
            kind: 'SAFELY_BROADER_SCOPE',
          },
        },
        facts: { ancestors: [], directCategories: [], revision: { assignments: 0, hierarchy: 0 } },
      },
      operation: 'OBSERVE',
    });
    expect(() => Schema.encodeSync(AssortmentProductClassificationV1ResponseSchema)(observed)).not.toThrow();
    if (observed.operation !== 'OBSERVE') {
      throw new Error('Expected empty Product classification observation');
    }
    const originalObservation = observed.observation;
    const unchanged = yield* observeOrVerifyAssortmentProductClassificationV1(
      { effectiveAt, observation: originalObservation, operation: 'VERIFY_CURRENT' },
      tenantId,
      source,
    );
    expect(unchanged).toMatchObject({ operation: 'VERIFY_CURRENT', status: 'CURRENT' });
    const wrongTime = yield* observeOrVerifyAssortmentProductClassificationV1(
      { effectiveAt: laterEffectiveAt, observation: originalObservation, operation: 'VERIFY_CURRENT' },
      tenantId,
      source,
    );
    expect(wrongTime).toMatchObject({ operation: 'VERIFY_CURRENT', status: 'STALE' });

    current = {
      ...current,
      directCategories: [categoryRef],
      revision: { assignments: 1, hierarchy: 0 },
    };
    const stale = yield* observeOrVerifyAssortmentProductClassificationV1(
      { effectiveAt, observation: originalObservation, operation: 'VERIFY_CURRENT' },
      tenantId,
      source,
    );
    expect(stale).toMatchObject({ operation: 'VERIFY_CURRENT', status: 'STALE' });

    const unavailableSource: AssortmentProductClassificationV1Source = {
      read: () =>
        Effect.fail(
          new CategoryPersistenceUnavailable({
            code: 'category_persistence_unavailable',
            reason: 'Owner completeness fence unavailable',
          }),
        ),
    };
    const unavailable = yield* observeOrVerifyAssortmentProductClassificationV1(
      { effectiveAt, observation: originalObservation, operation: 'VERIFY_CURRENT' },
      tenantId,
      unavailableSource,
    );
    expect(unavailable).toMatchObject({ operation: 'VERIFY_CURRENT', status: 'UNAVAILABLE' });
  }),
);

it.effect('publishes all three Catalog owner contracts through the deployed client barrel', () =>
  Effect.gen(function* publicClients() {
    const client = yield* Effect.promise(() => import('@app/catalog/api/client'));
    expect(client.executeAssortmentSelectionAssessmentV1).toBeTypeOf('function');
    expect(client.executeAssortmentSetCompositionV1).toBeTypeOf('function');
    expect(client.executeAssortmentProductClassificationV1).toBeTypeOf('function');
  }),
);

it('requires the published single-payload request envelope for each discriminated owner operation', () => {
  const classificationRequest = {
    request: { effectiveAt: '2026-09-28T12:00:00.000Z', operation: 'OBSERVE', productRef },
  };
  const setCompositionRequest = {
    request: {
      compositionRef,
      effectiveAt: '2026-09-28T12:00:00.000Z',
      operation: 'OBSERVE',
      productRef,
      variantRef,
    },
  };
  const selectionAssessmentRequest = { request: { operation: 'ASSESS', selection } };
  expect(() =>
    Schema.decodeUnknownSync(AssortmentProductClassificationV1RequestSchema)(classificationRequest),
  ).not.toThrow();
  expect(() => Schema.decodeUnknownSync(AssortmentSetCompositionV1RequestSchema)(setCompositionRequest)).not.toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentSelectionAssessmentV1RequestSchema)(selectionAssessmentRequest),
  ).not.toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentProductClassificationV1RequestSchema)(classificationRequest.request),
  ).toThrow();
});
