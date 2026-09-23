import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { prepareCatalogAcceptedSelectionHandoff } from '../../shared/domain/catalog-selection-handoff.ts';
import {
  CatalogSelectionBasisSchema,
  CatalogSelectionEvidenceSchema,
  CatalogSelectionSchema,
} from '../../shared/domain/catalog-selection-evidence.ts';
import {
  CatalogRetainedProductSchema,
  CatalogRetainedVariantSchema,
} from '../../shared/domain/catalog-revision-reference.ts';
import { CatalogQuantityHandoffSchema } from '../../shared/domain/catalog-quantity-handoff.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType,
  tenantId,
});
const productRef = ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222');
const variantRef = ref('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333');
const unitRef = ref('commerce.catalog.unit', '44444444-4444-4444-8444-444444444444');
const productRevision = { resourceRef: productRef, revision: 1, revisionId: '55555555-5555-4555-8555-555555555555' };
const variantRevision = { resourceRef: variantRef, revision: 2, revisionId: '66666666-6666-4666-8666-666666666666' };
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({ productRef, variantRef });
const evidence = Schema.decodeUnknownSync(CatalogSelectionEvidenceSchema)({
  assessedAt: '2026-09-17T12:00:00.000Z',
  basis: [
    { role: 'PRODUCT', source: productRevision },
    { role: 'VARIANT', source: variantRevision },
    {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
      role: 'PRODUCT_TYPE_UNTYPED_DECISION',
      source: { resourceRef: productRef, revision: 1 },
    },
  ],
  membership: {
    attestationId: 'membership-1',
    observedAt: '2026-09-17T12:00:00.000Z',
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ',
    variant: variantRevision,
  },
  purpose: 'PURCHASE_ACCEPTANCE',
  selection,
  status: 'VALID',
});
if (evidence.status !== 'VALID') {
  throw new Error('Fixture must be VALID');
}
const product = Schema.decodeUnknownSync(CatalogRetainedProductSchema)({
  historical: true,
  kind: 'PRODUCT',
  lifecycle: 'ACTIVE',
  name: 'Original product',
  reference: productRevision,
});
const variant = Schema.decodeUnknownSync(CatalogRetainedVariantSchema)({
  historical: true,
  kind: 'VARIANT',
  lifecycle: 'ACTIVE',
  productRef,
  reference: variantRevision,
});
const quantity = Schema.decodeUnknownSync(CatalogQuantityHandoffSchema)({
  completeness: {
    observedAt: '2026-09-17T12:00:00.000Z',
    ownerRevision: 'commerce.catalog.quantity:test-owner-revision',
    scope: {
      kind: 'EXACT_PREDICATE',
      predicateRef: 'commerce.catalog.quantity-preparation:test-selection:purchase:2',
    },
  },
  divisible: false,
  equivalentSelectionKey: 'commerce.catalog.selection:test-selection',
  evidence,
  hierarchyRevision: 'commerce.catalog.hierarchy:test-hierarchy-revision',
  ownerRevision: 'commerce.catalog.quantity:test-owner-revision',
  quantity: {
    changed: false,
    notice: null,
    requested: '2',
    resulting: '2',
    rounding: 'UP',
    status: 'VALID',
    step: '1',
    targetId: variantRef.resourceId,
    tenantId,
    unitId: unitRef.resourceId,
    unitRuleRevision: 1,
  },
  quantityBasis: {
    targetDivisibilityRevision: 1,
    targetRef: variantRef,
    unitRef,
    unitRuleRevision: 1,
  },
  selection,
  status: 'READY',
  unitRef,
});
if (quantity.status !== 'READY') {
  throw new Error('Fixture must be READY');
}
const input = () => ({
  acceptedAt: '2026-09-17T12:01:00.000Z',
  product,
  purpose: 'PURCHASE_ACCEPTANCE',
  quantity,
  variant,
});

describe('Catalog accepted Selection historical handoff', () => {
  it('retains exact accepted values and does not change when source objects change', () => {
    const result = prepareCatalogAcceptedSelectionHandoff(input());
    expect(result.status).toBe('ACCEPTED');
    if (result.status !== 'ACCEPTED') {
      return;
    }
    expect(result.handoff.historical).toBe(true);
    expect(result.handoff.product.name).toBe('Original product');
    expect(result.handoff.selection).not.toBe(selection);
    expect(result.handoff.quantity.resulting).toBe('2');
  });

  it('fails closed on missing owner facts, purpose mismatch, and successor revision', () => {
    expect(
      prepareCatalogAcceptedSelectionHandoff({
        acceptedAt: input().acceptedAt,
        purpose: input().purpose,
        quantity,
        variant,
      }).status,
    ).toBe('UNVERIFIABLE');
    expect(prepareCatalogAcceptedSelectionHandoff({ ...input(), purpose: 'PRICING' }).status).toBe('UNVERIFIABLE');
    expect(
      prepareCatalogAcceptedSelectionHandoff({
        ...input(),
        variant: Schema.decodeUnknownSync(CatalogRetainedVariantSchema)({
          ...variant,
          reference: { ...variant.reference, revision: 3 },
        }),
      }).status,
    ).toBe('UNVERIFIABLE');
  });

  it('requires exact Unit basis and Attribute Definition basis only when associated', () => {
    const definition = {
      resourceRef: ref('commerce.catalog.configuration-definition', '77777777-7777-4777-8777-777777777777'),
      revision: 1,
    };
    const attribute = {
      resourceRef: ref('commerce.catalog.attribute-definition', '88888888-8888-4888-8888-888888888888'),
      revision: 3,
    };
    const choiceUnit = { resourceRef: unitRef, revision: 4 };
    const configured = Schema.decodeUnknownSync(CatalogSelectionSchema)({
      configuration: {
        choices: [{ attributeDefinition: attribute, choiceKey: 'length', unit: choiceUnit, value: '83' }],
        definition,
        productRef,
        variantRef,
      },
      productRef,
      variantRef,
    });
    const basis = [
      ...evidence.basis,
      Schema.decodeUnknownSync(CatalogSelectionBasisSchema)({ role: 'CONFIGURATION_DEFINITION', source: definition }),
      Schema.decodeUnknownSync(CatalogSelectionBasisSchema)({ role: 'ATTRIBUTE_DEFINITION', source: attribute }),
      Schema.decodeUnknownSync(CatalogSelectionBasisSchema)({ role: 'UNIT', source: choiceUnit }),
    ];
    const resultWith = (chosenBasis: typeof basis) => {
      const configuredEvidence = {
        ...evidence,
        basis: chosenBasis,
        selection: configured,
      };
      return prepareCatalogAcceptedSelectionHandoff({
        ...input(),
        quantity: { ...quantity, evidence: configuredEvidence, selection: configured },
      });
    };
    expect(resultWith(basis).status).toBe('ACCEPTED');
    const withoutAttribute = Schema.decodeUnknownSync(CatalogSelectionSchema)({
      ...configured,
      configuration: {
        ...configured.configuration,
        choices: [{ choiceKey: 'length', unit: choiceUnit, value: '83' }],
      },
    });
    const withoutAttributeBasis = basis.filter((item) => item.role !== 'ATTRIBUTE_DEFINITION');
    expect(
      prepareCatalogAcceptedSelectionHandoff({
        ...input(),
        quantity: {
          ...quantity,
          evidence: { ...evidence, basis: withoutAttributeBasis, selection: withoutAttribute },
          selection: withoutAttribute,
        },
      }).status,
    ).toBe('ACCEPTED');
    expect(resultWith(basis.filter((item) => item.role !== 'ATTRIBUTE_DEFINITION')).status).toBe('UNVERIFIABLE');
    expect(resultWith(basis.filter((item) => item.role !== 'UNIT')).status).toBe('UNVERIFIABLE');
    expect(
      resultWith(
        basis.map((item) =>
          item.role === 'ATTRIBUTE_DEFINITION'
            ? Schema.decodeUnknownSync(CatalogSelectionBasisSchema)({
                role: 'ATTRIBUTE_DEFINITION',
                source: { ...attribute, revision: 4 },
              })
            : item,
        ),
      ).status,
    ).toBe('UNVERIFIABLE');
  });
});
