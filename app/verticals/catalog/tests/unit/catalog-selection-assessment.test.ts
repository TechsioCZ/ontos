import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { assessCatalogSelection } from '../../shared/domain/catalog-selection-assessment.ts';
import type { CatalogSelectionCurrentFacts } from '../../shared/domain/catalog-selection-assessment.ts';
import {
  CatalogSelectionBasisSchema,
  CatalogSelectionMembershipSchema,
  CatalogSelectionSchema,
} from '../../shared/domain/catalog-selection-evidence.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType,
  tenantId,
});
const productRef = ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222');
const variantRef = ref('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333');
const typeRef = ref('commerce.catalog.product-type', '44444444-4444-4444-8444-444444444444');
const packageRef = ref('commerce.catalog.package-definition', '55555555-5555-4555-8555-555555555555');
const otherProductRef = Schema.decodeUnknownSync(ProductRefSchema)({
  ...productRef,
  resourceId: '77777777-7777-4777-8777-777777777777',
});
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({ productRef, variantRef });
const assessedAt = '2026-09-17T12:00:00.000Z';
const purpose = 'PURCHASE_ACCEPTANCE';
const basis = Schema.decodeUnknownSync(Schema.Array(CatalogSelectionBasisSchema))([
  { role: 'PRODUCT', source: { resourceRef: productRef, revision: 1 } },
  { role: 'VARIANT', source: { resourceRef: variantRef, revision: 2 } },
  { role: 'PRODUCT_TYPE', source: { resourceRef: typeRef, revision: 1 } },
]);
const membership = Schema.decodeUnknownSync(CatalogSelectionMembershipSchema)({
  attestationId: 'owner-current-membership-1',
  observedAt: assessedAt,
  productRef,
  source: 'CATALOG_OWNER_CURRENT_READ',
  variant: { resourceRef: variantRef, revision: 2 },
});
const observed: Extract<CatalogSelectionCurrentFacts, { status: 'OBSERVED' }> = {
  assessedAt,
  basis,
  dependentFactsComplete: true,
  membership,
  productLifecycle: 'ACTIVE',
  purpose,
  selection,
  source: 'CATALOG_OWNER_CURRENT_READ',
  status: 'OBSERVED',
  variantLifecycle: 'ACTIVE',
};

const assess = (current: CatalogSelectionCurrentFacts, selected = selection) =>
  assessCatalogSelection({ assessedAt, current, purpose, selection: selected });

describe('Catalog Selection Current assessment', () => {
  it('issues VALID only for exact owner-observed membership and complete basis', () => {
    expect(assess(observed).status).toBe('VALID');
    expect(assess({ ...observed, dependentFactsComplete: false }).status).toBe('INDETERMINATE');
    expect(assess({ ...observed, basis: basis.filter(({ role }) => role !== 'PRODUCT_TYPE') }).status).toBe(
      'INDETERMINATE',
    );
    expect(
      assess({
        ...observed,
        membership: { ...observed.membership, productRef: otherProductRef },
      }).status,
    ).toBe('INDETERMINATE');
  });

  it('accepts one exact confirmed-untyped decision and rejects absent or contradictory type proof', () => {
    const untyped = Schema.decodeUnknownSync(Schema.Array(CatalogSelectionBasisSchema))([
      ...basis.filter(({ role }) => role !== 'PRODUCT_TYPE'),
      {
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
        role: 'PRODUCT_TYPE_UNTYPED_DECISION',
        source: { resourceRef: productRef, revision: 9 },
      },
    ]);
    const valid = assess({ ...observed, basis: untyped });
    expect(valid.status).toBe('VALID');
    expect(valid.basis).toContainEqual({
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
      role: 'PRODUCT_TYPE_UNTYPED_DECISION',
      source: { resourceRef: productRef, revision: 9 },
    });
    expect(assess({ ...observed, basis: [...basis, ...untyped.slice(-1)] }).status).toBe('INDETERMINATE');
    expect(
      assess({ ...observed, basis: untyped.filter(({ role }) => role !== 'PRODUCT_TYPE_UNTYPED_DECISION') }).status,
    ).toBe('INDETERMINATE');
  });

  it('does not transfer a Current observation to another variant, purpose, or time', () => {
    const another = Schema.decodeUnknownSync(CatalogSelectionSchema)({
      productRef,
      variantRef: ref('commerce.catalog.variant', '66666666-6666-4666-8666-666666666666'),
    });
    expect(assess(observed, another).status).toBe('INDETERMINATE');
    expect(assess({ ...observed, purpose: 'CART' }).status).toBe('INDETERMINATE');
    expect(assess({ ...observed, assessedAt: '2026-09-16T12:00:00.000Z' }).status).toBe('INDETERMINATE');
  });

  it('rejects a superseded pinned package revision without substituting its successor', () => {
    const packed = Schema.decodeUnknownSync(CatalogSelectionSchema)({
      packageOption: { contentRevision: { resourceRef: packageRef, revision: 1 }, optionRef: packageRef },
      productRef,
      variantRef,
    });
    const current: Extract<CatalogSelectionCurrentFacts, { status: 'OBSERVED' }> = {
      ...observed,
      basis: Schema.decodeUnknownSync(Schema.Array(CatalogSelectionBasisSchema))([
        ...basis,
        { role: 'PACKAGE_CONTENT', source: { resourceRef: packageRef, revision: 2 } },
      ]),
      selection: packed,
    };
    const result = assess(current, packed);
    expect(result.status).toBe('INVALID');
    expect(result.selection.packageOption?.contentRevision.revision).toBe(1);
  });

  it('keeps missing indirect proof and inactive lifecycle distinct', () => {
    expect(assess({ ...observed, basis: basis.filter(({ role }) => role !== 'PRODUCT') }).status).toBe('INDETERMINATE');
    expect(assess({ ...observed, productLifecycle: 'RETIRED' }).status).toBe('INVALID');
  });

  it('requires the exact Definition and Unit without inventing an Attribute Definition dependency', () => {
    const definition = {
      resourceRef: ref('commerce.catalog.configuration-definition', '88888888-8888-4888-8888-888888888888'),
      revision: 2,
    };
    const unit = { resourceRef: ref('commerce.catalog.unit', '99999999-9999-4999-8999-999999999999'), revision: 3 };
    const configured = Schema.decodeUnknownSync(CatalogSelectionSchema)({
      configuration: { choices: [{ choiceKey: 'length', unit, value: '83' }], definition, productRef, variantRef },
      productRef,
      variantRef,
    });
    const current = {
      ...observed,
      basis: Schema.decodeUnknownSync(Schema.Array(CatalogSelectionBasisSchema))([
        ...basis,
        { role: 'CONFIGURATION_DEFINITION', source: definition },
        { role: 'UNIT', source: unit },
      ]),
      selection: configured,
    };
    expect(assess(current, configured).status).toBe('VALID');
    expect(assess({ ...current, basis: current.basis.filter(({ role }) => role !== 'UNIT') }, configured).status).toBe(
      'INDETERMINATE',
    );
    expect(
      assess({ ...current, basis: current.basis.filter(({ role }) => role !== 'CONFIGURATION_DEFINITION') }, configured)
        .status,
    ).toBe('INDETERMINATE');
    expect(
      assess(
        {
          ...current,
          basis: current.basis.map((fact) =>
            fact.role === 'UNIT'
              ? Schema.decodeUnknownSync(CatalogSelectionBasisSchema)({
                  role: 'UNIT',
                  source: { ...unit, revision: 4 },
                })
              : fact,
          ),
        },
        configured,
      ).status,
    ).toBe('INVALID');
  });
});
