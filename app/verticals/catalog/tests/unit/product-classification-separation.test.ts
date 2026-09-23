import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { PackageOptionReferenceSchema, SetReferenceSchema } from '../../shared/domain/product-form-separation.ts';
import {
  ProductClassificationChangeSchema,
  ProductClassificationSchema,
  SalesChannelRefSchema,
  applyProductClassificationChange,
  productTypeRulesFor,
} from '../../shared/domain/product-classification-separation.ts';
import { ProductTypeCurrentRulesRevisionSchema } from '../../shared/domain/product-type-rules.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const productId = '22222222-2222-4222-8222-222222222222';
const shelfTypeId = '33333333-3333-4333-8333-333333333333';
const serviceTypeId = '44444444-4444-4444-8444-444444444444';
const workshopId = '55555555-5555-4555-8555-555555555555';
const householdId = '66666666-6666-4666-8666-666666666666';
const widthId = '77777777-7777-4777-8777-777777777777';
const variantId = '88888888-8888-4888-8888-888888888888';
const packageDefinitionId = '99999999-9999-4999-8999-999999999999';
const revisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const serviceRevisionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const packageDefinitionRef = {
  moduleId: 'commerce.catalog',
  resourceId: packageDefinitionId,
  resourceType: 'commerce.catalog.package-definition',
  tenantId,
} as const;
const shelfTypeRef = {
  moduleId: 'commerce.catalog',
  resourceId: shelfTypeId,
  resourceType: 'commerce.catalog.product-type',
  tenantId,
} as const;
const serviceTypeRef = {
  moduleId: 'commerce.catalog',
  resourceId: serviceTypeId,
  resourceType: 'commerce.catalog.product-type',
  tenantId,
} as const;
const workshopRef = {
  moduleId: 'commerce.catalog',
  resourceId: workshopId,
  resourceType: 'commerce.catalog.product-category',
  tenantId,
} as const;
const householdRef = {
  moduleId: 'commerce.catalog',
  resourceId: householdId,
  resourceType: 'commerce.catalog.product-category',
  tenantId,
} as const;
const widthRef = {
  moduleId: 'commerce.catalog',
  resourceId: widthId,
  resourceType: 'commerce.catalog.attribute-definition',
  tenantId,
} as const;
const webChannelRef = {
  moduleId: 'commerce.assortment',
  resourceId: 'web-retail',
  resourceType: 'commerce.assortment.sales-channel',
  tenantId,
} as const;

const decodeClassification = Schema.decodeUnknownSync(ProductClassificationSchema, { onExcessProperty: 'error' });
const decodeChange = Schema.decodeUnknownSync(ProductClassificationChangeSchema, { onExcessProperty: 'error' });
const decodeChannel = Schema.decodeUnknownSync(SalesChannelRefSchema, { onExcessProperty: 'error' });

const shelfRules = Schema.decodeUnknownSync(ProductTypeCurrentRulesRevisionSchema)({
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  productTypeRef: shelfTypeRef,
  revision: 1,
  revisionId,
  rules: [{ attributeDefinitionRef: widthRef, level: 'PRODUCT', required: true }],
});
const serviceRules = Schema.decodeUnknownSync(ProductTypeCurrentRulesRevisionSchema)({
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  productTypeRef: serviceTypeRef,
  revision: 1,
  revisionId: serviceRevisionId,
  rules: [],
});

const decodeSet = Schema.decodeUnknownSync(SetReferenceSchema);
const decodePackageOption = Schema.decodeUnknownSync(PackageOptionReferenceSchema);
const setReference = decodeSet({
  compositionRevision: { revision: 1, variantRef },
  kind: 'SET',
  productRef,
  variantRef,
});
const packageOptionRef = decodePackageOption({ kind: 'PACKAGE_OPTION', packageDefinitionRef, variantRef });

const shelfClassification = decodeClassification({
  currentProductTypeRef: shelfTypeRef,
  productCategoryRefs: [workshopRef],
  productRef,
  salesChannelRefs: [],
});
const untypedClassification = decodeClassification({
  productCategoryRefs: [],
  productRef,
  salesChannelRefs: [],
});

describe('Catalog Product Type, Category, and Sales Channel separation', () => {
  it('keeps one Product Type, many Categories, and many Sales Channels as distinct facets', () => {
    const classification = decodeClassification({
      ...shelfClassification,
      productCategoryRefs: [workshopRef, householdRef],
      salesChannelRefs: [webChannelRef],
    });

    expect(classification.currentProductTypeRef).toEqual(shelfTypeRef);
    expect(classification.productCategoryRefs).toHaveLength(2);
    expect(classification.salesChannelRefs).toHaveLength(1);
    expect(classification).not.toHaveProperty('productTypeRefs');
  });

  it('moves a shelf from Workshop to Household without changing its type or required width', () => {
    const facts = { widthCentimeters: 83 };
    const movedIn = applyProductClassificationChange(
      shelfClassification,
      facts,
      decodeChange({ categoryRef: householdRef, kind: 'ADD_PRODUCT_CATEGORY' }),
    );
    if (movedIn.status !== 'APPLIED') {
      throw new Error('Expected an applied classification change');
    }
    const movedOut = applyProductClassificationChange(
      movedIn.product,
      movedIn.facts,
      decodeChange({ categoryRef: workshopRef, kind: 'REMOVE_PRODUCT_CATEGORY' }),
    );
    if (movedOut.status !== 'APPLIED') {
      throw new Error('Expected an applied classification change');
    }

    expect(movedOut.product.productCategoryRefs).toEqual([householdRef]);
    expect(movedOut.product.currentProductTypeRef).toBe(shelfClassification.currentProductTypeRef);
    expect(movedOut.facts).toBe(facts);
    expect(movedOut.facts.widthCentimeters).toBe(83);
    expect(movedOut.changedFacets).toEqual(['PRODUCT_CATEGORY']);
    expect(productTypeRulesFor(movedOut.product, shelfRules)).toEqual(
      productTypeRulesFor(shelfClassification, shelfRules),
    );
    expect(productTypeRulesFor(movedOut.product, shelfRules)).toEqual([
      { attributeDefinitionRef: widthRef, level: 'PRODUCT', required: true },
    ]);
  });

  it('changes the Product Type without moving any Category or Sales Channel', () => {
    const withChannel = applyProductClassificationChange(
      shelfClassification,
      {},
      decodeChange({ kind: 'ADD_SALES_CHANNEL', salesChannelRef: webChannelRef }),
    );
    if (withChannel.status !== 'APPLIED') {
      throw new Error('Expected an applied classification change');
    }
    const categories = withChannel.product.productCategoryRefs;
    const channels = withChannel.product.salesChannelRefs;
    const retyped = applyProductClassificationChange(
      withChannel.product,
      withChannel.facts,
      decodeChange({ kind: 'SET_PRODUCT_TYPE', nextProductTypeRef: serviceTypeRef }),
    );
    if (retyped.status !== 'APPLIED') {
      throw new Error('Expected an applied classification change');
    }

    expect(retyped.product.currentProductTypeRef).toEqual(serviceTypeRef);
    expect(retyped.product.productCategoryRefs).toBe(categories);
    expect(retyped.product.salesChannelRefs).toBe(channels);
    expect(retyped.changedFacets).toEqual(['PRODUCT_TYPE']);
    expect(productTypeRulesFor(retyped.product, shelfRules)).toEqual([]);
  });

  it('keeps a Set composition and Package Option intact through a Category change', () => {
    const facts = { packageOptionRef, setRef: setReference };
    const outcome = applyProductClassificationChange(
      shelfClassification,
      facts,
      decodeChange({ categoryRef: householdRef, kind: 'ADD_PRODUCT_CATEGORY' }),
    );
    if (outcome.status !== 'APPLIED') {
      throw new Error('Expected an applied classification change');
    }

    expect(outcome.changedFacets).toEqual(['PRODUCT_CATEGORY']);
    expect(outcome.facts.setRef).toBe(setReference);
    expect(outcome.facts.packageOptionRef).toBe(packageOptionRef);
    expect(outcome.facts.setRef.compositionRevision.variantRef).toEqual(variantRef);
  });

  it('does not create a parallel Product Type for a Set or a Package Option', () => {
    const outcome = applyProductClassificationChange(
      untypedClassification,
      { packageOptionRef, setRef: setReference },
      decodeChange({ categoryRef: householdRef, kind: 'ADD_PRODUCT_CATEGORY' }),
    );
    if (outcome.status !== 'APPLIED') {
      throw new Error('Expected an applied classification change');
    }

    expect(outcome.product.currentProductTypeRef).toBeUndefined();
    expect(outcome.product.productCategoryRefs).toEqual([householdRef]);
    expect(productTypeRulesFor(outcome.product, shelfRules)).toEqual([]);
  });

  it('never infers Product Type rules from a Category or a Sales Channel', () => {
    expect(productTypeRulesFor(shelfClassification, shelfRules)).toEqual(shelfRules.rules);
    expect(productTypeRulesFor(shelfClassification, serviceRules)).toEqual([]);
    expect(productTypeRulesFor(untypedClassification, shelfRules)).toEqual([]);
    const withCategory = applyProductClassificationChange(
      shelfClassification,
      {},
      decodeChange({ categoryRef: householdRef, kind: 'ADD_PRODUCT_CATEGORY' }),
    );
    if (withCategory.status !== 'APPLIED') {
      throw new Error('Expected an applied classification change');
    }
    const withCategoryAndChannel = applyProductClassificationChange(
      withCategory.product,
      withCategory.facts,
      decodeChange({ kind: 'ADD_SALES_CHANNEL', salesChannelRef: decodeChannel(webChannelRef) }),
    );
    if (withCategoryAndChannel.status !== 'APPLIED') {
      throw new Error('Expected an applied classification change');
    }

    expect(productTypeRulesFor(withCategory.product, shelfRules)).toEqual(
      productTypeRulesFor(shelfClassification, shelfRules),
    );
    expect(productTypeRulesFor(withCategoryAndChannel.product, shelfRules)).toEqual(
      productTypeRulesFor(shelfClassification, shelfRules),
    );
  });

  it('rejects cross-Tenant Type, Category, and Sales Channel links', () => {
    expect(
      applyProductClassificationChange(
        shelfClassification,
        {},
        decodeChange({
          kind: 'SET_PRODUCT_TYPE',
          nextProductTypeRef: { ...shelfTypeRef, tenantId: foreignTenantId },
        }),
      ).status,
    ).toBe('TENANT_MISMATCH');
    expect(
      applyProductClassificationChange(
        shelfClassification,
        {},
        decodeChange({ categoryRef: { ...workshopRef, tenantId: foreignTenantId }, kind: 'ADD_PRODUCT_CATEGORY' }),
      ).status,
    ).toBe('TENANT_MISMATCH');
    expect(
      applyProductClassificationChange(
        shelfClassification,
        {},
        decodeChange({
          kind: 'ADD_SALES_CHANNEL',
          salesChannelRef: decodeChannel({ ...webChannelRef, tenantId: foreignTenantId }),
        }),
      ).status,
    ).toBe('TENANT_MISMATCH');
  });

  it('refuses to carry a Product Type or Product Category as a Sales Channel', () => {
    expect(() => decodeChannel(shelfTypeRef)).toThrow();
    expect(() => decodeChannel(workshopRef)).toThrow();
    expect(decodeChannel(webChannelRef).resourceId).toBe('web-retail');
  });

  it('fails closed on duplicate or cross-Tenant classification snapshots', () => {
    expect(() =>
      decodeClassification({ ...shelfClassification, productCategoryRefs: [householdRef, householdRef] }),
    ).toThrow();
    expect(() =>
      decodeClassification({ ...shelfClassification, salesChannelRefs: [webChannelRef, webChannelRef] }),
    ).toThrow();
    expect(() =>
      decodeClassification({
        currentProductTypeRef: { ...serviceTypeRef, tenantId: foreignTenantId },
        productCategoryRefs: [],
        productRef,
        salesChannelRefs: [],
      }),
    ).toThrow();
  });
});
