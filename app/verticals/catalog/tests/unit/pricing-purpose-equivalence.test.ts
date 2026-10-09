import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type {
  CatalogQuantityHandoff,
  CatalogQuantityHandoffReady,
} from '../../shared/domain/catalog-quantity-handoff.ts';
import { CatalogQuantityHandoffReadySchema } from '../../shared/domain/catalog-quantity-handoff.ts';
import type { CatalogSelection } from '../../shared/domain/catalog-selection-evidence.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type {
  PricingPurposeEquivalenceRequest,
  PricingPurposeEquivalenceResponse,
} from '../../shared/apis/pricing-purpose-equivalence.ts';
import {
  PricingPurposeEquivalenceRequestSchema,
  PricingPurposeEquivalenceResponseSchema,
} from '../../shared/apis/pricing-purpose-equivalence.ts';
import { resolvePricingPurposeEquivalence } from '../../src/api/pricing-purpose-equivalence.read.ts';
import type { CatalogQuantityHandoffRequest } from '../../src/persistence/catalog-quantity-handoff.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const effectiveAt = '2026-09-28T12:00:00.000Z';
const validThrough = '2026-09-29T00:00:00.000Z';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const otherProductRef = { ...productRef, resourceId: '22222222-2222-4222-8222-222222222299' };
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const otherVariantRef = {
  ...variantRef,
  resourceId: '44444444-4444-4444-8444-444444444444',
};
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const categoryRef = {
  moduleId: 'commerce.catalog',
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.catalog.product-category',
  tenantId,
} as const;
const packageRef = {
  moduleId: 'commerce.catalog',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'commerce.catalog.package-definition',
  tenantId,
} as const;
const configurationDefinitionRef = {
  moduleId: 'commerce.catalog',
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'commerce.catalog.configuration-definition',
  tenantId,
} as const;
const setCompositionRef = {
  moduleId: 'commerce.catalog',
  resourceId: '99999999-9999-4999-8999-999999999999',
  resourceType: 'commerce.catalog.set-composition',
  tenantId,
} as const;

const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({ productRef, variantRef });
const otherProductSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: otherProductRef,
  variantRef,
});
const otherSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({ productRef, variantRef: otherVariantRef });
const packageSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  packageOption: {
    contentRevision: { resourceRef: packageRef, revision: 10 },
    optionRef: packageRef,
  },
  productRef,
  variantRef: otherVariantRef,
});
const currentPackageSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  packageOption: {
    contentRevision: { resourceRef: packageRef, revision: 11 },
    optionRef: packageRef,
  },
  productRef,
  variantRef: otherVariantRef,
});
const configuredSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  configuration: {
    choices: [],
    definition: { resourceRef: configurationDefinitionRef, revision: 10 },
    productRef,
    variantRef: otherVariantRef,
  },
  productRef,
  variantRef: otherVariantRef,
});
const currentConfiguredSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  configuration: {
    choices: [],
    definition: { resourceRef: configurationDefinitionRef, revision: 11 },
    productRef,
    variantRef: otherVariantRef,
  },
  productRef,
  variantRef: otherVariantRef,
});
const setSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef,
  setComposition: { resourceRef: setCompositionRef, revision: 10 },
  variantRef: otherVariantRef,
});
const currentSetSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef,
  setComposition: { resourceRef: setCompositionRef, revision: 11 },
  variantRef: otherVariantRef,
});

interface HandoffOptions {
  readonly equivalentSelectionKey?: string;
  readonly finiteValidity?: boolean;
  readonly ownerRevision?: string;
  readonly packageMeaningRevision?: number;
  readonly selection?: CatalogSelection;
  readonly unitRuleRevision?: number;
}

const handoff = ({
  equivalentSelectionKey = 'commerce.catalog.pricing-purpose:shared',
  finiteValidity = true,
  ownerRevision = 'commerce.catalog.quantity:revision-7',
  packageMeaningRevision,
  selection: exactSelection = selection,
  unitRuleRevision = 7,
}: HandoffOptions = {}): CatalogQuantityHandoffReady => {
  const selectedPackage = exactSelection.packageOption;
  const targetRef = selectedPackage?.optionRef ?? exactSelection.variantRef;
  const contentRevision = packageMeaningRevision ?? selectedPackage?.contentRevision.revision;
  const boundaryFields = finiteValidity
    ? {
        completeness: { nextApplicabilityBoundary: validThrough },
        evidence: { validUntil: validThrough },
      }
    : { completeness: {}, evidence: {} };
  const packageFields =
    selectedPackage === undefined || contentRevision === undefined
      ? {}
      : {
          packageContent: {
            amount: '20',
            path: [{ resourceRef: selectedPackage.contentRevision.resourceRef, revision: contentRevision }],
            status: 'VALID' as const,
            unitRef,
          },
          packageRevision: {
            amount: '10',
            form: { productRef, variantRef: exactSelection.variantRef },
            reference: { resourceRef: selectedPackage.contentRevision.resourceRef, revision: contentRevision },
            unitRef,
          },
        };

  return Schema.decodeUnknownSync(CatalogQuantityHandoffReadySchema)({
    completeness: {
      ...boundaryFields.completeness,
      observedAt: effectiveAt,
      ownerRevision,
      scope: {
        kind: 'EXACT_PREDICATE',
        predicateRef: `commerce.catalog.quantity-preparation:${targetRef.resourceId}:2`,
      },
    },
    divisible: true,
    equivalentSelectionKey,
    evidence: {
      ...boundaryFields.evidence,
      assessedAt: effectiveAt,
      basis: [
        { role: 'PRODUCT', source: { resourceRef: productRef, revision: 2 } },
        { role: 'VARIANT', source: { resourceRef: exactSelection.variantRef, revision: 3 } },
        {
          provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
          role: 'PRODUCT_TYPE_UNTYPED_DECISION',
          source: { resourceRef: productRef, revision: 2 },
        },
        { role: 'CATEGORY', source: { resourceRef: categoryRef, revision: 4 } },
        ...(selectedPackage === undefined || contentRevision === undefined
          ? []
          : [
              {
                role: 'PACKAGE_CONTENT' as const,
                source: { resourceRef: selectedPackage.contentRevision.resourceRef, revision: contentRevision },
              },
            ]),
        ...(exactSelection.configuration === undefined
          ? []
          : [
              {
                role: 'CONFIGURATION_DEFINITION' as const,
                source: exactSelection.configuration.definition,
              },
              ...exactSelection.configuration.choices.flatMap(({ attributeDefinition, unit }) => [
                ...(attributeDefinition === undefined
                  ? []
                  : [{ role: 'ATTRIBUTE_DEFINITION' as const, source: attributeDefinition }]),
                ...(unit === undefined ? [] : [{ role: 'UNIT' as const, source: unit }]),
              ]),
            ]),
        ...(exactSelection.setComposition === undefined
          ? []
          : [{ role: 'SET_COMPOSITION' as const, source: exactSelection.setComposition }]),
        { role: 'UNIT_RULE', source: { resourceRef: unitRef, revision: unitRuleRevision } },
        { role: 'UNIT_TARGET_DIVISIBILITY', source: { resourceRef: targetRef, revision: 5 } },
      ],
      membership: {
        attestationId: `commerce.catalog.membership:${exactSelection.variantRef.resourceId}`,
        observedAt: effectiveAt,
        productRef,
        source: 'CATALOG_OWNER_CURRENT_READ',
        variant: { resourceRef: exactSelection.variantRef, revision: 3 },
      },
      purpose: 'PRICING',
      selection: exactSelection,
      status: 'VALID',
    },
    hierarchyRevision: 'commerce.catalog.hierarchy:revision-5',
    ownerRevision,
    ...packageFields,
    quantity: {
      changed: false,
      notice: null,
      requested: '2',
      resulting: '2',
      rounding: 'UP',
      status: 'VALID',
      step: '1',
      targetId: targetRef.resourceId,
      tenantId,
      unitId: unitRef.resourceId,
      unitRuleRevision,
    },
    quantityBasis: {
      targetDivisibilityRevision: 5,
      targetRef,
      unitRef,
      unitRuleRevision,
    },
    selection: exactSelection,
    status: 'READY',
    unitRef,
  });
};

const request = (
  anchorSelection: CatalogSelection,
  members: readonly { readonly handoff: CatalogQuantityHandoffReady; readonly occurrenceId: string }[],
): PricingPurposeEquivalenceRequest =>
  Schema.decodeUnknownSync(PricingPurposeEquivalenceRequestSchema)({ anchorSelection, effectiveAt, members });

const preparedInOrder = (...handoffs: readonly CatalogQuantityHandoff[]) => {
  let callIndex = 0;
  const calls: CatalogQuantityHandoffRequest[] = [];
  return {
    calls,
    prepare: (input: CatalogQuantityHandoffRequest) =>
      Effect.sync(() => {
        calls.push(input);
        const prepared = handoffs[callIndex];
        callIndex += 1;
        return prepared ?? { reason: 'Unexpected preparation call', status: 'UNVERIFIABLE' as const };
      }),
  };
};

const expectSchemaValid = (result: PricingPurposeEquivalenceResponse): void => {
  expect(Schema.is(PricingPurposeEquivalenceResponseSchema)(result)).toBe(true);
};

describe('Catalog Pricing-purpose equivalence read', () => {
  it('rejects cross-Product member reads before the anchor resource authorization boundary', () => {
    const current = handoff();
    expect(() =>
      request(otherProductSelection, [{ handoff: current, occurrenceId: 'unauthorized-product-line' }]),
    ).toThrow();
  });

  it.effect('confirms the exact same Current selection with finite owner currentness and completeness', () =>
    Effect.gen(function* confirmsExactCurrentMeaning() {
      const current = handoff();
      const prepared = preparedInOrder(current, current);
      const result = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: current, occurrenceId: 'line-1' }]),
        prepared,
      );

      expect(prepared.calls).toEqual([
        { amount: '2', purpose: 'PRICING', selection },
        { amount: '2', purpose: 'PRICING', selection },
      ]);
      expect(result).toMatchObject({
        assessments: [
          { handoff: current, role: 'ANCHOR' },
          { handoff: current, occurrenceId: 'line-1', role: 'MEMBER' },
        ],
        currentness: {
          effectiveAt,
          observedAt: effectiveAt,
          status: 'CURRENT',
          validThrough,
        },
        currentnessEvidence: {
          effectiveAt,
          observedAt: effectiveAt,
          revalidatedAt: effectiveAt,
          validThrough,
          verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED',
        },
        evidence: {
          anchorSelection: selection,
          effectiveAt,
          members: [{ occurrenceId: 'line-1', selection }],
          observedAt: effectiveAt,
          ownerModuleId: 'commerce.catalog',
          purpose: 'PRICING',
          status: 'CONFIRMED',
          validThrough,
        },
        outcome: 'CATALOG_EQUIVALENCE_CONFIRMED',
        verificationReceipt: {
          issuedAt: effectiveAt,
          ownerModuleId: 'commerce.catalog',
          predicate: {
            anchor: {
              quantityBasis: current.quantityBasis,
              requestedQuantity: current.quantity.requested,
              selection,
            },
            effectiveAt,
            members: [
              {
                occurrenceId: 'line-1',
                quantityBasis: current.quantityBasis,
                requestedQuantity: current.quantity.requested,
                selection,
              },
            ],
            purpose: 'PRICING',
          },
        },
      });
      expect(result.outcome === 'CATALOG_EQUIVALENCE_CONFIRMED' && result.generation).toMatch(
        /^commerce\.catalog\.pricing-purpose-equivalence-generation:/u,
      );
      expectSchemaValid(result);
    }),
  );

  it.effect('issues a replayable owner generation and changes it only when owner-native revisions change', () =>
    Effect.gen(function* verifiesOwnerGeneration() {
      const current = handoff();
      const initial = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: current, occurrenceId: 'line-1' }]),
        preparedInOrder(current, current),
      );
      const revised = Schema.decodeUnknownSync(CatalogQuantityHandoffReadySchema)({
        ...current,
        completeness: { ...current.completeness, ownerRevision: 'commerce.catalog.quantity:revision-8' },
        ownerRevision: 'commerce.catalog.quantity:revision-8',
      });
      const revalidated = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: current, occurrenceId: 'line-1' }]),
        preparedInOrder(revised, revised),
      );

      if (
        initial.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED' ||
        revalidated.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED'
      ) {
        throw new Error('Fixtures must produce confirmed Catalog equivalence');
      }
      expect(initial.verificationReceipt.generation).toBe(initial.generation);
      expect(initial.verificationReceipt.ownerRevision).toBe(initial.evidence.ownerRevision);
      expect(revalidated.generation).not.toBe(initial.generation);
      expect(revalidated.verificationReceipt.predicate).toEqual(initial.verificationReceipt.predicate);
      expect(
        Schema.is(PricingPurposeEquivalenceResponseSchema)({
          ...initial,
          verificationReceipt: {
            ...initial.verificationReceipt,
            predicate: {
              ...initial.verificationReceipt.predicate,
              members: initial.verificationReceipt.predicate.members.map((member) => ({
                ...member,
                quantityBasis: { ...member.quantityBasis, unitRuleRevision: 999 },
              })),
            },
          },
        }),
      ).toBe(false);
    }),
  );

  it.effect(
    'does not infer equivalence for different exact selections from equal quantities or caller occurrence IDs',
    () =>
      Effect.gen(function* rejectsCallerInferences() {
        const anchor = handoff({ equivalentSelectionKey: 'catalog-meaning:anchor' });
        const member = handoff({ equivalentSelectionKey: 'catalog-meaning:member', selection: otherSelection });
        const original = yield* resolvePricingPurposeEquivalence(
          request(selection, [{ handoff: member, occurrenceId: 'same-caller-key' }]),
          preparedInOrder(anchor, member),
        );
        const renamed = yield* resolvePricingPurposeEquivalence(
          request(selection, [{ handoff: member, occurrenceId: 'different-caller-key' }]),
          preparedInOrder(anchor, member),
        );

        expect(anchor.quantity.requested).toBe(member.quantity.requested);
        expect(original).toMatchObject({
          assessments: [
            { handoff: { selection }, role: 'ANCHOR' },
            { handoff: { selection: otherSelection }, occurrenceId: 'same-caller-key', role: 'MEMBER' },
          ],
          currentness: { status: 'CURRENT' },
          outcome: 'CATALOG_EQUIVALENCE_NON_EQUIVALENT',
        });
        expect(renamed).toMatchObject({
          assessments: [{ role: 'ANCHOR' }, { occurrenceId: 'different-caller-key', role: 'MEMBER' }],
          currentness: original.currentness,
          outcome: 'CATALOG_EQUIVALENCE_NON_EQUIVALENT',
        });
        expectSchemaValid(original);
        expectSchemaValid(renamed);
      }),
  );

  it.effect('reports stale supplied Unit and Package revisions against owner Current preparation', () =>
    Effect.gen(function* rejectsStaleMaterialRevisions() {
      const anchor = handoff();
      const suppliedUnit = handoff({ selection: otherSelection, unitRuleRevision: 7 });
      const currentUnit = handoff({
        ownerRevision: 'commerce.catalog.quantity:revision-8',
        selection: otherSelection,
        unitRuleRevision: 8,
      });
      const staleUnit = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: suppliedUnit, occurrenceId: 'unit-line' }]),
        preparedInOrder(anchor, currentUnit),
      );

      expect(staleUnit).toMatchObject({ currentness: { status: 'STALE' }, outcome: 'CATALOG_EQUIVALENCE_STALE' });
      expectSchemaValid(staleUnit);

      const suppliedPackage = handoff({ packageMeaningRevision: 10, selection: packageSelection });
      const currentPackage = handoff({
        ownerRevision: 'commerce.catalog.quantity:revision-11',
        packageMeaningRevision: 11,
        selection: currentPackageSelection,
      });
      const stalePackage = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: suppliedPackage, occurrenceId: 'package-line' }]),
        preparedInOrder(anchor, currentPackage),
      );

      expect(stalePackage).toMatchObject({ currentness: { status: 'STALE' }, outcome: 'CATALOG_EQUIVALENCE_STALE' });
      expectSchemaValid(stalePackage);

      if (suppliedPackage.packageRevision === undefined) {
        throw new Error('Package fixture must contain its exact owner revision');
      }
      const forgedPackageParentage = {
        ...suppliedPackage,
        packageRevision: {
          ...suppliedPackage.packageRevision,
          form: { productRef, variantRef },
        },
      };
      const staleParentage = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: forgedPackageParentage, occurrenceId: 'package-parent-line' }]),
        preparedInOrder(anchor, suppliedPackage),
      );

      expect(staleParentage).toMatchObject({
        currentness: { status: 'STALE' },
        outcome: 'CATALOG_EQUIVALENCE_STALE',
      });
      expectSchemaValid(staleParentage);
    }),
  );

  it.effect('rejects caller-asserted equivalence and changed Configuration or Set revisions', () =>
    Effect.gen(function* rejectsCallerAssertions() {
      const anchor = handoff();

      const assertedEquivalent = handoff({
        equivalentSelectionKey: anchor.equivalentSelectionKey,
        selection: otherSelection,
      });
      const ownerMeaning = handoff({
        equivalentSelectionKey: 'commerce.catalog.pricing-purpose:owner-meaning',
        ownerRevision: 'commerce.catalog.quantity:owner-meaning',
        selection: otherSelection,
      });
      const forged = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: assertedEquivalent, occurrenceId: 'forged-equivalence' }]),
        preparedInOrder(anchor, ownerMeaning),
      );
      expect(forged).toMatchObject({
        currentness: { status: 'STALE' },
        outcome: 'CATALOG_EQUIVALENCE_STALE',
      });
      expectSchemaValid(forged);

      const suppliedConfiguration = handoff({ selection: configuredSelection });
      const currentConfiguration = handoff({
        ownerRevision: 'commerce.catalog.quantity:configuration-11',
        selection: currentConfiguredSelection,
      });
      const staleConfiguration = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: suppliedConfiguration, occurrenceId: 'configuration-line' }]),
        preparedInOrder(anchor, currentConfiguration),
      );
      expect(staleConfiguration).toMatchObject({
        currentness: { status: 'STALE' },
        outcome: 'CATALOG_EQUIVALENCE_STALE',
      });
      expectSchemaValid(staleConfiguration);

      const suppliedSet = handoff({ selection: setSelection });
      const currentSet = handoff({
        ownerRevision: 'commerce.catalog.quantity:set-11',
        selection: currentSetSelection,
      });
      const staleSet = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: suppliedSet, occurrenceId: 'set-line' }]),
        preparedInOrder(anchor, currentSet),
      );
      expect(staleSet).toMatchObject({
        currentness: { status: 'STALE' },
        outcome: 'CATALOG_EQUIVALENCE_STALE',
      });
      expectSchemaValid(staleSet);
    }),
  );

  it.effect('accepts a fresh Current attestation when material selection and quantity still agree', () =>
    Effect.gen(function* acceptsFreshOwnerRevision() {
      const current = handoff();
      const supplied = Schema.decodeUnknownSync(CatalogQuantityHandoffReadySchema)({
        ...current,
        completeness: { ...current.completeness, ownerRevision: 'commerce.catalog.quantity:old' },
        ownerRevision: 'commerce.catalog.quantity:old',
      });
      const result = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: supplied, occurrenceId: 'line-1' }]),
        preparedInOrder(current, current),
      );

      expect(result).toMatchObject({ currentness: { status: 'CURRENT' }, outcome: 'CATALOG_EQUIVALENCE_CONFIRMED' });
      expectSchemaValid(result);
    }),
  );

  it.effect('reports a conflict when one repeated exact selection has contradictory Current meaning', () =>
    Effect.gen(function* detectsOwnerConflict() {
      const anchorMeaning = handoff({ equivalentSelectionKey: 'catalog-meaning:first' });
      const contradictoryMeaning = handoff({ equivalentSelectionKey: 'catalog-meaning:second' });
      const result = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: anchorMeaning, occurrenceId: 'line-1' }]),
        preparedInOrder(anchorMeaning, contradictoryMeaning),
      );

      expect(result).toMatchObject({
        currentness: { status: 'CONFLICT' },
        outcome: 'CATALOG_EQUIVALENCE_CONFLICT',
        reason: 'Catalog produced conflicting Current meanings for one exact selection',
      });
      expectSchemaValid(result);
    }),
  );

  it.effect('returns retryable unavailable when the owner Current reader is unavailable', () =>
    Effect.gen(function* reportsUnavailableReader() {
      const current = handoff();
      const result = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: current, occurrenceId: 'line-1' }]),
        {
          prepare: () =>
            Effect.fail(
              new CatalogPersistenceUnavailable({
                code: 'catalog_persistence_unavailable',
                reason: 'Catalog storage is unavailable',
              }),
            ),
        },
      );

      expect(result).toEqual({
        currentness: { effectiveAt, status: 'UNAVAILABLE' },
        outcome: 'CATALOG_EQUIVALENCE_UNAVAILABLE',
        reason: 'Catalog Current equivalence facts are temporarily unavailable',
        retryable: true,
      });
      expectSchemaValid(result);
    }),
  );

  it.effect('remains unverifiable when exact Current selections have no finite validity boundary', () =>
    Effect.gen(function* requiresFiniteValidity() {
      const boundaryless = handoff({ finiteValidity: false });
      const result = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: boundaryless, occurrenceId: 'line-1' }]),
        preparedInOrder(boundaryless, boundaryless),
      );

      expect(result).toMatchObject({
        currentness: { effectiveAt, observedAt: effectiveAt, status: 'UNVERIFIABLE' },
        outcome: 'CATALOG_EQUIVALENCE_UNVERIFIABLE',
        reason: 'Catalog cannot prove a finite Current interval for every exact selection',
      });
      expectSchemaValid(result);

      const finite = handoff();
      const mixed = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: boundaryless, occurrenceId: 'line-1' }]),
        preparedInOrder(finite, boundaryless),
      );
      expect(mixed).toMatchObject({
        currentness: { effectiveAt, observedAt: effectiveAt, status: 'UNVERIFIABLE' },
        outcome: 'CATALOG_EQUIVALENCE_UNVERIFIABLE',
        reason: 'Catalog cannot prove a finite Current interval for every exact selection',
      });
      expectSchemaValid(mixed);
    }),
  );

  it.effect('fails closed before comparing meanings when boundaryless selections are not equivalent', () =>
    Effect.gen(function* rejectsBoundarylessNonEquivalence() {
      const anchor = handoff({ equivalentSelectionKey: 'catalog-meaning:anchor', finiteValidity: false });
      const member = handoff({
        equivalentSelectionKey: 'catalog-meaning:member',
        finiteValidity: false,
        selection: otherSelection,
      });
      const result = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: member, occurrenceId: 'line-1' }]),
        preparedInOrder(anchor, member),
      );

      expect(result).toMatchObject({
        currentness: { effectiveAt, observedAt: effectiveAt, status: 'UNVERIFIABLE' },
        outcome: 'CATALOG_EQUIVALENCE_UNVERIFIABLE',
        reason: 'Catalog cannot prove a finite Current interval for every exact selection',
      });
      expectSchemaValid(result);
    }),
  );

  it.effect('rejects internally inconsistent or non-Pricing owner handoffs without reissuing their evidence', () =>
    Effect.gen(function* rejectsIncoherentOwnerEvidence() {
      const current = handoff();
      const nonPricing = Schema.decodeUnknownSync(CatalogQuantityHandoffReadySchema)({
        ...current,
        evidence: { ...current.evidence, purpose: 'CHECKOUT' },
      });
      const result = yield* resolvePricingPurposeEquivalence(
        request(selection, [{ handoff: current, occurrenceId: 'line-1' }]),
        preparedInOrder(nonPricing, current),
      );

      expect(result).toEqual({
        assessments: [],
        currentness: { effectiveAt, status: 'UNVERIFIABLE' },
        outcome: 'CATALOG_EQUIVALENCE_UNVERIFIABLE',
        reason: 'Catalog Current Quantity evidence is internally inconsistent or not issued for Pricing',
      });
      expect(result).not.toHaveProperty('evidenceRef');
      expectSchemaValid(result);
    }),
  );
});
