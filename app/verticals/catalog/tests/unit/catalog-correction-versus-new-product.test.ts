import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ProductAttributeChangeClassificationSchema,
  VariantAttributeChangeClassificationSchema,
  requireProductAttributeCorrection,
  requireVariantAttributeChange,
} from '../../shared/actions/attribute-value-mutations.ts';
import { CorrectProductPayloadSchema } from '../../shared/actions/correct-product.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { ProductChangeClassificationSchema } from '../../shared/domain/product-change-classification.ts';
import { ProductCorrectionRequired } from '../../shared/domain/product-errors.ts';
import { ProductSchema } from '../../shared/domain/product.ts';
import { SetCompositionRevisionSchema, classifySetCompositionChange } from '../../shared/domain/set-composition.ts';
import { correctProductAction, handleCorrectProduct } from '../../src/actions/correct-product.action.ts';
import type { CreateProductResult } from '../../shared/actions/create-product.ts';
import type { createProductAction } from '../../src/actions/create-product.action.ts';
import { handleCreateProduct, recordCreateProductResultSnapshot } from '../../src/actions/create-product.action.ts';
import type { CatalogPersistence } from '../../src/persistence/catalog-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '44444444-4444-4444-8444-444444444444';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const replacementProductRef = { ...productRef, resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const variantId = '33333333-3333-4333-8333-333333333333';
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const replacementVariantRef = { ...variantRef, resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };

const product = (revision: number, name: string) =>
  Schema.decodeUnknownSync(ProductSchema)({
    catalogReady: true,
    createdAt: '2026-09-17T10:00:00.000Z',
    lifecycle: 'ACTIVE',
    name,
    productRef,
    revision,
    updatedAt: '2026-09-18T10:00:00.000Z',
    variants: [{ lifecycle: 'ACTIVE', productRef, variantId, variantRef }],
  });

const successorProduct = Schema.decodeUnknownSync(ProductSchema)({
  catalogReady: false,
  createdAt: '2026-09-18T10:00:00.000Z',
  lifecycle: 'DRAFT',
  name: 'Police Beta',
  productRef: replacementProductRef,
  revision: 1,
  updatedAt: '2026-09-18T10:00:00.000Z',
  variants: [
    {
      lifecycle: 'WORK_IN_PROGRESS',
      productRef: replacementProductRef,
      variantId: replacementVariantRef.resourceId,
      variantRef: replacementVariantRef,
    },
  ],
});

const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:correction-acceptance:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'correction-acceptance-test',
} as const;

const unexpected = () => Effect.die('Unexpected Catalog persistence call');
type AuditEvidence = Readonly<Record<string, Schema.Schema.Type<typeof Schema.Json>>>;
const context = <Events extends typeof correctProductAction.descriptor.domainEvents>(
  domainEvents: Events,
  services: Partial<CatalogPersistence>,
) => {
  const events: { eventType: string; payloadJson: unknown; reference: object }[] = [];
  const audit: AuditEvidence[] = [];
  const persistence: CatalogPersistence = {
    correct: unexpected,
    create: unexpected,
    getCreatedByInvocation: unexpected,
    getCurrent: unexpected,
    getHistory: unexpected,
    reactivate: unexpected,
    recoverCreateProduct: unexpected,
    recoverUpdateProduct: unexpected,
    retire: unexpected,
    update: unexpected,
    ...services,
  };
  const value: ActionHandlerContext<Events, CatalogPersistence> = {
    actionInvocationId: '55555555-5555-4555-8555-555555555555',
    addDomainEvent: (event) =>
      Effect.sync(() => {
        expect(Object.keys(domainEvents)).toContain(event.eventType);
        const reference = Object.create(null);
        events.push({ eventType: event.eventType, payloadJson: event.payloadJson, reference });
        return reference;
      }),
    addOutboxMessage: () => Effect.void,
    recordAuditEvidence: (evidence) =>
      Effect.sync(() => {
        audit.push(evidence);
      }),
    recordDataAccess: () => Effect.void,
    scope,
    services: persistence,
  };
  return { audit, events, value };
};

const decodeClassification = Schema.decodeUnknownSync(ProductChangeClassificationSchema);

const createContext = () => {
  const events: { eventType: string; payloadJson: unknown }[] = [];
  const audit: AuditEvidence[] = [];
  const services = {
    captureResult: () => Effect.void,
    correct: unexpected,
    create: () =>
      Effect.succeed({
        _tag: 'created' as const,
        product: successorProduct,
        variantId: replacementVariantRef.resourceId,
      }),
    getCreatedByInvocation: unexpected,
    getCurrent: unexpected,
    getHistory: unexpected,
    reactivate: unexpected,
    recoverCreateProduct: unexpected,
    recoverUpdateProduct: unexpected,
    retire: unexpected,
    update: unexpected,
  };
  const value: ActionHandlerContext<typeof createProductAction.descriptor.domainEvents, typeof services> = {
    actionInvocationId: '55555555-5555-4555-8555-555555555555',
    addDomainEvent: (event) =>
      Effect.sync(() => {
        events.push({ eventType: event.eventType, payloadJson: event.payloadJson });
        return Object.create(null);
      }),
    addOutboxMessage: () => Effect.void,
    recordAuditEvidence: (evidence) =>
      Effect.sync(() => {
        audit.push(evidence);
      }),
    recordDataAccess: () => Effect.void,
    scope,
    services,
  };
  return { audit, events, value };
};

describe('Catalog Correction versus new Product realization (#415)', () => {
  it.effect('corrects a typo in place and keeps Product identity without Current revalidation', () =>
    Effect.gen(function* typo() {
      const state = context(correctProductAction.descriptor.domainEvents, {
        correct: () => Effect.succeed({ _tag: 'corrected', changed: true, product: product(2, 'Police Alfa') }),
      });
      const result = yield* handleCorrectProduct(
        {
          classification: {
            affectsOpenSelection: false,
            evidenceRefs: ['urn:evidence:spelling'],
            kind: 'COSMETIC_CORRECTION',
            productRef,
            reason: 'Fix the recorded name typo',
          },
          expectedRevision: 1,
          name: 'Police Alfa',
          productRef,
          reason: 'Fix the recorded name typo',
        },
        state.value,
      );
      expect(result.classification.kind).toBe('COSMETIC_CORRECTION');
      expect(result.product.productRef).toEqual(productRef);
      expect(result.product.revision).toBe(2);
      expect(result.selectionRevalidation).toEqual({ kind: 'NOT_REQUIRED' });
      expect(state.events.map(({ eventType }) => eventType)).toEqual(['commerce.catalog.product-corrected.v1']);
      expect(state.audit).toHaveLength(1);
    }),
  );

  it.effect('preserves identity for a documented dimension correction and hands open selections to #479', () =>
    Effect.gen(function* dimension() {
      const reason = 'Recorded width was wrong; the item always measured 90 cm';
      const state = context(correctProductAction.descriptor.domainEvents, {
        correct: () => Effect.succeed({ _tag: 'corrected', changed: true, product: product(2, 'Police 90 cm') }),
      });
      const result = yield* handleCorrectProduct(
        {
          classification: {
            affectsOpenSelection: true,
            evidenceRefs: ['urn:evidence:always-90'],
            kind: 'COSMETIC_CORRECTION',
            productRef,
            reason,
          },
          description: 'Width 90 cm',
          expectedRevision: 1,
          productRef,
          reason,
        },
        state.value,
      );
      expect(result.product.revision).toBe(2);
      expect(result.selectionRevalidation).toEqual({
        evidenceRefs: ['urn:evidence:always-90'],
        kind: 'REVALIDATION_REQUIRED',
        productRef,
        reason,
        sourceRevision: 2,
      });
      expect(state.events.map(({ eventType }) => eventType)).toEqual([
        'commerce.catalog.product-corrected.v1',
        'commerce.catalog.selection-revalidation-required.v1',
      ]);
    }),
  );

  it.effect('rejects a genuinely new atomic realization or Product from the correction path', () =>
    Effect.gen(function* material() {
      const reason = 'Manufacturer replaced the 80 cm realization with 90 cm';
      const evidenceRefs = ['urn:evidence:manufacturer-change'];
      const classifications = [
        decodeClassification({
          affectsOpenSelection: true,
          evidenceRefs,
          kind: 'NEW_REALIZATION',
          newVariantRef: replacementVariantRef,
          productRef,
          reason,
        }),
        decodeClassification({
          affectsOpenSelection: true,
          evidenceRefs,
          kind: 'SUCCESSOR_REALIZATION',
          newVariantRef: replacementVariantRef,
          previousVariantRef: variantRef,
          productRef,
          reason,
        }),
        decodeClassification({
          affectsOpenSelection: true,
          evidenceRefs,
          kind: 'NEW_PRODUCT',
          newProductRef: replacementProductRef,
          previousProductRef: productRef,
          reason,
        }),
      ];
      for (const classification of classifications) {
        const state = context(correctProductAction.descriptor.domainEvents, {});
        const error = yield* handleCorrectProduct(
          { classification, expectedRevision: 1, name: 'Police 90 cm', productRef, reason },
          state.value,
        ).pipe(Effect.flip);
        expect(Schema.is(ProductCorrectionRequired)(error)).toBe(true);
        expect(error.reason).toContain('owning Variant or Product creation Action');
        expect(state.events).toHaveLength(0);
      }
    }),
  );

  it.effect('creates and durably captures the evidenced successor under its new Product identity', () =>
    Effect.gen(function* successor() {
      const reason = 'A new common business identity replaces the previous Product';
      const state = createContext();
      const result = yield* handleCreateProduct(
        {
          classification: {
            affectsOpenSelection: true,
            evidenceRefs: ['urn:evidence:successor-product'],
            kind: 'NEW_PRODUCT',
            previousProductRef: productRef,
            reason,
          },
          name: 'Police Beta',
          reason,
        },
        state.value,
      );
      expect(result.classification).toMatchObject({
        kind: 'NEW_PRODUCT',
        newProductRef: replacementProductRef,
        previousProductRef: productRef,
      });
      expect(state.audit).toEqual([{ evidenceRefs: ['urn:evidence:successor-product'], reason }]);
      expect(state.events[0]).toMatchObject({
        eventType: 'commerce.catalog.product-created.v1',
        payloadJson: { classification: { kind: 'NEW_PRODUCT', newProductRef: replacementProductRef } },
      });

      let captured: CreateProductResult | undefined;
      yield* recordCreateProductResultSnapshot({
        actionInvocationId: state.value.actionInvocationId,
        result,
        services: {
          captureResult: (_actionInvocationId, persistedResult) =>
            Effect.sync(() => {
              captured = persistedResult;
            }),
        },
      });
      expect(captured?.classification).toEqual(result.classification);
    }),
  );

  it('requires a distinct, explicitly superseded Product identity for a new-Product decision', () => {
    const base = {
      affectsOpenSelection: true,
      evidenceRefs: ['urn:evidence:new-identity'],
      kind: 'NEW_PRODUCT',
      newProductRef: replacementProductRef,
      previousProductRef: productRef,
      reason: 'A different common business identity',
    };
    expect(decodeClassification(base).kind).toBe('NEW_PRODUCT');
    expect(() =>
      decodeClassification({
        affectsOpenSelection: true,
        evidenceRefs: ['urn:evidence:new-identity'],
        kind: 'NEW_PRODUCT',
        newProductRef: replacementProductRef,
        reason: 'A different common business identity',
      }),
    ).toThrow();
    expect(() => decodeClassification({ ...base, previousProductRef: replacementProductRef })).not.toThrow();
  });

  it('refuses an undocumented same-field change as an ordinary correction', () => {
    const decode = Schema.decodeUnknownSync(CorrectProductPayloadSchema);
    expect(() =>
      decode({
        classification: {
          affectsOpenSelection: false,
          evidenceRefs: [],
          kind: 'COSMETIC_CORRECTION',
          productRef,
          reason: 'Width changed',
        },
        expectedRevision: 1,
        name: 'Police 90 cm',
        productRef,
        reason: 'Width changed',
      }),
    ).toThrow();
    expect(() =>
      decodeClassification({
        affectsOpenSelection: true,
        evidenceRefs: [' '],
        kind: 'COSMETIC_CORRECTION',
        productRef,
        reason: 'Width changed',
      }),
    ).toThrow();
    expect(() =>
      decodeClassification({
        affectsOpenSelection: true,
        evidenceRefs: ['urn:evidence:1'],
        kind: 'COSMETIC_CORRECTION',
        productRef,
        reason: ' ',
      }),
    ).toThrow();
  });

  it('uses a new immutable Set composition revision instead of a Product correction for successor content', () => {
    const ref = (type: string, id: string) => ({
      moduleId: 'commerce.catalog' as const,
      resourceId: id,
      resourceType: `commerce.catalog.${type}`,
      tenantId,
    });
    const unitRef = ref('product-unit', '44444444-4444-4444-8444-444444444444');
    const compositionRef = ref('set-composition', '55555555-5555-4555-8555-555555555555');
    const bracketA = Schema.decodeUnknownSync(CatalogSelectionSchema)({
      productRef: ref('product', '66666666-6666-4666-8666-666666666666'),
      variantRef: ref('variant', '77777777-7777-4777-8777-777777777777'),
    });
    const bracketB = Schema.decodeUnknownSync(CatalogSelectionSchema)({
      productRef: ref('product', '88888888-8888-4888-8888-888888888888'),
      variantRef: ref('variant', '99999999-9999-4999-8999-999999999999'),
    });
    const needA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const needB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const r1 = Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
      components: [
        { componentId: needA, quantity: { amount: '2', unitRef }, selection: bracketA },
        { componentId: needB, quantity: { amount: '2', unitRef }, selection: bracketA },
      ],
      productRef,
      provenance: { changeKind: 'INITIAL', evidenceRefs: ['set:initial'], reason: 'Initial two-bracket set' },
      reference: { resourceRef: compositionRef, revision: 1 },
      variantRef,
    });
    const r2 = Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
      components: [
        { componentId: needA, quantity: { amount: '2', unitRef }, selection: bracketB },
        { componentId: needB, quantity: { amount: '2', unitRef }, selection: bracketA },
      ],
      predecessor: r1.reference,
      productRef,
      provenance: {
        changeKind: 'MATERIAL_CHANGE',
        evidenceRefs: ['set:bracket-change'],
        reason: 'Bracket B replaces A',
      },
      reference: { resourceRef: compositionRef, revision: 2 },
      variantRef,
    });
    expect(classifySetCompositionChange(r1, r2)).toBe('MATERIAL_CHANGE');
    expect(r2.predecessor).toEqual(r1.reference);
    // The accepted revision keeps its exact goods as immutable history.
    expect(r1.reference.revision).toBe(1);
    expect(r1.components[0]?.selection).toEqual(bracketA);
  });

  it.effect('applies the same materiality guard to import and Local Override attribute writes', () =>
    Effect.gen(function* override() {
      const decode = Schema.decodeUnknownSync(VariantAttributeChangeClassificationSchema);
      const correction = {
        evidenceRefs: ['original-data-error:source-7'],
        kind: 'EVIDENCED_CORRECTION',
        originalDataErrorEvidenceRef: 'original-data-error:source-7',
        reason: 'Source recorded 80 cm; the item is 90 cm',
      };
      expect(yield* requireVariantAttributeChange(decode(correction))).toBe('REVALIDATION_REQUIRED');
      const unproven = yield* requireVariantAttributeChange(
        decode({ ...correction, evidenceRefs: ['generic-note'], originalDataErrorEvidenceRef: 'generic-note-missing' }),
      ).pipe(Effect.flip);
      expect(unproven.code).toBe('variant_attribute_change_conflict');
      const realization = yield* requireVariantAttributeChange(
        decode({
          evidenceRefs: ['urn:evidence:real-90'],
          kind: 'NEW_REALIZATION',
          newVariantRef: replacementVariantRef,
          reason: 'Actually a new 90 cm realization',
        }),
      ).pipe(Effect.flip);
      expect(realization.reason).toContain('distinct Variant');
      const productRejected = yield* requireProductAttributeCorrection(
        Schema.decodeUnknownSync(ProductAttributeChangeClassificationSchema)({
          evidenceRefs: ['urn:evidence:real-90'],
          kind: 'NEW_REALIZATION',
          newVariantRef: replacementVariantRef,
          previousVariantRef: variantRef,
          reason: 'Actually a new 90 cm realization',
        }),
        productRef,
      ).pipe(Effect.flip);
      expect(productRejected.code).toBe('product_attribute_change_conflict');
    }),
  );

  it.effect('revisions and explains a correction without rewriting accepted history', () =>
    Effect.gen(function* afterAcceptance() {
      const reason = 'Recorded width corrected after order acceptance';
      const state = context(correctProductAction.descriptor.domainEvents, {
        correct: () => Effect.succeed({ _tag: 'corrected', changed: true, product: product(2, 'Police 90 cm') }),
      });
      const result = yield* handleCorrectProduct(
        {
          classification: {
            affectsOpenSelection: true,
            evidenceRefs: ['urn:evidence:always-90'],
            kind: 'COSMETIC_CORRECTION',
            productRef,
            reason,
          },
          description: 'Width 90 cm',
          expectedRevision: 1,
          productRef,
          reason,
        },
        state.value,
      );
      // Catalog returns and rewrites only Product facts; Order and Party stay with their owners.
      expect(new Set(Object.keys(result))).toEqual(
        new Set(['changed', 'classification', 'product', 'selectionRevalidation']),
      );
      expect(result.product.revision).toBe(2);
      const corrected = state.events.find(({ eventType }) => eventType === 'commerce.catalog.product-corrected.v1');
      expect(corrected?.payloadJson).toMatchObject({
        changed: true,
        classification: { evidenceRefs: ['urn:evidence:always-90'], reason },
        product: { productRef, revision: 2 },
      });
    }),
  );

  it.effect('binds the correction decision to the exact Product scope and stated reason', () =>
    Effect.gen(function* binding() {
      const reason = 'Recorded width was wrong';
      const state = context(correctProductAction.descriptor.domainEvents, {});
      const variantScoped = yield* handleCorrectProduct(
        {
          classification: {
            affectsOpenSelection: true,
            evidenceRefs: ['urn:evidence:1'],
            kind: 'COSMETIC_CORRECTION',
            productRef,
            reason,
            variantRef,
          },
          description: 'Width 90 cm',
          expectedRevision: 1,
          productRef,
          reason,
        },
        state.value,
      ).pipe(Effect.flip);
      expect(Schema.is(ProductCorrectionRequired)(variantScoped)).toBe(true);
      expect(variantScoped.reason).toContain('cannot be scoped to one Variant');

      const mismatchedReason = yield* handleCorrectProduct(
        {
          classification: {
            affectsOpenSelection: false,
            evidenceRefs: ['urn:evidence:1'],
            kind: 'COSMETIC_CORRECTION',
            productRef,
            reason: 'A different reason',
          },
          expectedRevision: 1,
          name: 'Police Alfa',
          productRef,
          reason: 'Original reason',
        },
        state.value,
      ).pipe(Effect.flip);
      expect(mismatchedReason.reason).toContain('same Product and reason');
      expect(state.events).toHaveLength(0);
    }),
  );
});
