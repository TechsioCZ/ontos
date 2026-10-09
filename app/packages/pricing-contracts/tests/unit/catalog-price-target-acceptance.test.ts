import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CurrentSupportedCurrenciesRequestSchema } from '../../src/apis/current-supported-currencies.ts';
import {
  PriceCatalogTargetAssessmentSchema,
  PriceCatalogTargetSchema,
  PriceProductTargetOutcomeIdentitySchema,
  PriceProductTargetSnapshotSchema,
  priceCatalogTargetsEqual,
} from '../../src/domain/catalog-price-target.ts';
import { PriceIdentityKeySchema } from '../../src/domain/price-definition.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '99999999-9999-4999-8999-999999999999';
const capturedAt = '2026-09-27T10:00:00.000Z';

const catalogRef = <const ResourceType extends string>(
  resourceId: string,
  resourceType: ResourceType,
  refTenantId = tenantId,
) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId: refTenantId,
});

const productRef = catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product');
const otherProductRef = catalogRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'commerce.catalog.product');
const variantRef = catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant');
const otherVariantRef = catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.variant');
const productUnitRef = catalogRef('55555555-5555-4555-8555-555555555555', 'commerce.catalog.product-unit');
const packageRef = catalogRef('66666666-6666-4666-8666-666666666666', 'commerce.catalog.package-definition');
const configurationRef = catalogRef(
  '77777777-7777-4777-8777-777777777777',
  'commerce.catalog.configuration-definition',
);
const setCompositionRef = catalogRef('88888888-8888-4888-8888-888888888888', 'commerce.catalog.set-composition');

const exactTarget = { productRef, variantRef };
const richTarget = {
  configuration: {
    choices: [{ choiceKey: 'finish', value: 'blue' }],
    definition: { resourceRef: configurationRef, revision: 4 },
    productRef,
    variantRef,
  },
  packageOption: {
    contentRevision: { resourceRef: packageRef, revision: 5 },
    optionRef: packageRef,
  },
  productRef,
  setComposition: { resourceRef: setCompositionRef, revision: 6 },
  variantRef,
};

const catalogEvidenceFor = (target: typeof exactTarget | typeof richTarget) => {
  const variantRevision = { resourceRef: target.variantRef, revision: 2 };
  return {
    assessedAt: capturedAt,
    basis: [
      { role: 'PRODUCT' as const, source: { resourceRef: target.productRef, revision: 1 } },
      { role: 'VARIANT' as const, source: variantRevision },
      {
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
        role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
        source: { resourceRef: target.productRef, revision: 1 },
      },
      ...('packageOption' in target
        ? [{ role: 'PACKAGE_CONTENT' as const, source: target.packageOption.contentRevision }]
        : []),
      ...('configuration' in target
        ? [{ role: 'CONFIGURATION_DEFINITION' as const, source: target.configuration.definition }]
        : []),
      ...('setComposition' in target ? [{ role: 'SET_COMPOSITION' as const, source: target.setComposition }] : []),
    ],
    membership: {
      attestationId: 'catalog-membership-1',
      observedAt: capturedAt,
      productRef: target.productRef,
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
      variant: variantRevision,
    },
    purpose: 'PRICING' as const,
    selection: target,
    status: 'VALID' as const,
  };
};

const decodeTarget = Schema.decodeUnknownSync(PriceCatalogTargetSchema, { onExcessProperty: 'error' });
const decodeAssessment = Schema.decodeUnknownSync(PriceCatalogTargetAssessmentSchema, {
  onExcessProperty: 'error',
});
const decodeSnapshot = Schema.decodeUnknownSync(PriceProductTargetSnapshotSchema, {
  onExcessProperty: 'error',
});
const decodeOutcomeIdentity = Schema.decodeUnknownSync(PriceProductTargetOutcomeIdentitySchema, {
  onExcessProperty: 'error',
});
const decodePriceIdentity = Schema.decodeUnknownSync(PriceIdentityKeySchema, { onExcessProperty: 'error' });
const decodeCurrencySupportRequest = Schema.decodeUnknownSync(CurrentSupportedCurrenciesRequestSchema, {
  onExcessProperty: 'error',
});

const snapshotFor = (
  targets = [
    {
      catalogEvidence: catalogEvidenceFor(exactTarget),
      target: exactTarget,
      targetId: 'catalog-target:variant-3333',
    },
  ],
) => ({
  capturedAt,
  catalogOwnerRevision: 'catalog-product-variants:17',
  productRef,
  snapshotId: 'catalog-product-snapshot:17',
  targets,
  targetSetCompleteness: {
    observedAt: capturedAt,
    ownerRevision: 'catalog-product-variants:17',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-product:active-variants' },
  },
});

describe('Pricing exact Catalog target acceptance', () => {
  it('requires one explicit Variant even when a Product has only one selectable Variant', () => {
    expect(decodeTarget(exactTarget)).toEqual(exactTarget);
    expect(() => decodeTarget({ productRef })).toThrow();

    expect(
      decodeAssessment({
        outcome: 'PRICE_CATALOG_TARGET_REJECTED',
        productRef,
        reason: 'PRODUCT_ONLY_TARGET',
      }),
    ).toMatchObject({ reason: 'PRODUCT_ONLY_TARGET' });
    expect(() =>
      decodeAssessment({
        outcome: 'PRICE_CATALOG_TARGET_REJECTED',
        productRef,
        reason: 'PRODUCT_ONLY_TARGET',
        variantRef,
      }),
    ).toThrow();
  });

  it('keeps missing, foreign, and invalidly parented Variants as closed rejection outcomes', () => {
    expect(
      decodeAssessment({
        outcome: 'PRICE_CATALOG_TARGET_REJECTED',
        productRef,
        reason: 'VARIANT_MISSING',
      }),
    ).toMatchObject({ reason: 'VARIANT_MISSING' });
    expect(
      decodeAssessment({
        outcome: 'PRICE_CATALOG_TARGET_REJECTED',
        productRef,
        reason: 'VARIANT_FOREIGN_TENANT',
        variantRef: { ...variantRef, tenantId: foreignTenantId },
      }),
    ).toMatchObject({ reason: 'VARIANT_FOREIGN_TENANT' });
    expect(() =>
      decodeAssessment({
        outcome: 'PRICE_CATALOG_TARGET_REJECTED',
        productRef,
        reason: 'VARIANT_FOREIGN_TENANT',
        variantRef,
      }),
    ).toThrow();
    expect(
      decodeAssessment({
        outcome: 'PRICE_CATALOG_TARGET_REJECTED',
        productRef,
        reason: 'VARIANT_NOT_CHILD_OF_PRODUCT',
        variantRef,
      }),
    ).toMatchObject({ reason: 'VARIANT_NOT_CHILD_OF_PRODUCT' });
  });

  it('requires Catalog evidence for every selected package, configuration, and Set material', () => {
    const accepted = {
      catalogEvidence: catalogEvidenceFor(richTarget),
      outcome: 'PRICE_CATALOG_TARGET_ACCEPTED' as const,
      target: richTarget,
    };
    expect(decodeAssessment(accepted)).toMatchObject({ outcome: 'PRICE_CATALOG_TARGET_ACCEPTED' });

    for (const missingRole of ['PACKAGE_CONTENT', 'CONFIGURATION_DEFINITION', 'SET_COMPOSITION'] as const) {
      expect(() =>
        decodeAssessment({
          ...accepted,
          catalogEvidence: {
            ...accepted.catalogEvidence,
            basis: accepted.catalogEvidence.basis.filter(({ role }) => role !== missingRole),
          },
        }),
      ).toThrow();
    }

    for (const reason of [
      'PACKAGE_CONTENT_EVIDENCE_MISSING',
      'CONFIGURATION_EVIDENCE_MISSING',
      'SET_COMPOSITION_EVIDENCE_MISSING',
    ] as const) {
      expect(
        decodeAssessment({
          outcome: 'PRICE_CATALOG_TARGET_REJECTED',
          productRef,
          reason,
          variantRef,
        }),
      ).toMatchObject({ reason });
    }
  });

  it('keeps optional material exact and never treats absence as a wildcard', () => {
    const decodedExactTarget = decodeTarget(exactTarget);
    const decodedRichTarget = decodeTarget(richTarget);
    expect(priceCatalogTargetsEqual(decodedExactTarget, decodedRichTarget)).toBe(false);
    expect(priceCatalogTargetsEqual(decodedRichTarget, decodeTarget({ ...richTarget }))).toBe(true);

    const accepted = {
      catalogEvidence: catalogEvidenceFor(exactTarget),
      outcome: 'PRICE_CATALOG_TARGET_ACCEPTED' as const,
      target: richTarget,
    };
    expect(() => decodeAssessment(accepted)).toThrow();
  });

  it('keeps a Product expansion fixed to its owner-complete Variant snapshot', () => {
    const captured = decodeSnapshot(snapshotFor());
    const laterTarget = { productRef, variantRef: otherVariantRef };

    expect(captured.targets.map(({ target }) => target.variantRef.resourceId)).toEqual([variantRef.resourceId]);
    expect(captured.targets).toHaveLength(1);
    expect(
      decodeSnapshot(
        snapshotFor([
          ...snapshotFor().targets,
          {
            catalogEvidence: catalogEvidenceFor(laterTarget),
            target: laterTarget,
            targetId: 'catalog-target:variant-4444',
          },
        ]),
      ).targets,
    ).toHaveLength(2);
    expect(captured.targets).toHaveLength(1);
  });

  it('requires Pricing evidence assessed no earlier than the Product snapshot capture', () => {
    const snapshot = snapshotFor();
    const [entry] = snapshot.targets;
    expect(entry).toBeDefined();
    if (entry === undefined) {
      return;
    }

    expect(() =>
      decodeSnapshot({
        ...snapshot,
        targets: [
          {
            ...entry,
            catalogEvidence: { ...entry.catalogEvidence, purpose: 'ORDER_HISTORY' },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeSnapshot({
        ...snapshot,
        targets: [
          {
            ...entry,
            catalogEvidence: {
              ...entry.catalogEvidence,
              assessedAt: '2026-09-27T09:59:59.000Z',
              membership: {
                ...entry.catalogEvidence.membership,
                observedAt: '2026-09-27T09:59:59.000Z',
              },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects duplicate targets, repeated target IDs, and a Variant from another Product snapshot', () => {
    const firstEntry = {
      catalogEvidence: catalogEvidenceFor(exactTarget),
      target: exactTarget,
      targetId: 'catalog-target:variant-3333',
    };
    expect(() => decodeSnapshot(snapshotFor([firstEntry, { ...firstEntry }]))).toThrow();
    expect(() =>
      decodeSnapshot(
        snapshotFor([
          firstEntry,
          {
            catalogEvidence: catalogEvidenceFor({ productRef: otherProductRef, variantRef: otherVariantRef }),
            target: { productRef: otherProductRef, variantRef: otherVariantRef },
            targetId: 'catalog-target:other-product',
          },
        ]),
      ),
    ).toThrow();
  });

  it('binds every per-target result identity to the snapshot, target ID, and exact target', () => {
    const identity = decodeOutcomeIdentity({
      snapshotId: 'catalog-product-snapshot:17',
      target: exactTarget,
      targetId: 'catalog-target:variant-3333',
    });
    expect(identity).toEqual({
      snapshotId: 'catalog-product-snapshot:17',
      target: exactTarget,
      targetId: 'catalog-target:variant-3333',
    });
    expect(() => decodeOutcomeIdentity({ ...identity, target: { productRef } })).toThrow();
  });

  it('keeps line target identity separate from a whole-purchase allocation recipient', () => {
    expect(() => decodeTarget({ ...exactTarget, recipient: { kind: 'WHOLE_PURCHASE' } })).toThrow();
    expect(() => decodeTarget({ ...exactTarget, scope: 'WHOLE_PURCHASE' })).toThrow();
    expect(decodeTarget(exactTarget)).toEqual(exactTarget);
  });

  it('keeps Currency Support separate while isolating the same exact selection by native currency', () => {
    const identity = {
      catalogSelection: exactTarget,
      commercialScope: {
        channelId: 'B2C',
        marketId: 'cz-launch',
        sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      currencyCode: 'CZK',
      priceGroupSelector: { kind: 'NO_GROUP' as const },
      unitBasis: { quantity: '1', unitRef: productUnitRef },
    };
    const czk = decodePriceIdentity(identity);
    const eur = decodePriceIdentity({ ...identity, currencyCode: 'EUR' });

    expect(czk.catalogSelection).toEqual(eur.catalogSelection);
    expect(czk.currencyCode).toBe('CZK');
    expect(eur.currencyCode).toBe('EUR');
    expect(() => decodeTarget({ ...exactTarget, currencyCode: 'CZK' })).toThrow();
    expect(decodeCurrencySupportRequest({ effectiveAt: capturedAt, tenantId })).toEqual({
      effectiveAt: capturedAt,
      tenantId,
    });
    expect(() => decodeCurrencySupportRequest({ effectiveAt: capturedAt, selection: exactTarget, tenantId })).toThrow();
  });
});
