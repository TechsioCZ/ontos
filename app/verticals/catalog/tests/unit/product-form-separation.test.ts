import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  CatalogSelectionTargetReferenceSchema,
  PackageContentRevisionReferenceSchema,
  PackageOptionReferenceSchema,
  ProductConfigurationDefinitionReferenceSchema,
  ProductConfigurationSchema,
  ProductFormReferenceSchema,
  ProductReferenceSchema,
  SetCompositionRevisionReferenceSchema,
  SetReferenceSchema,
  SkuReferenceSchema,
  VariantReferenceSchema,
} from '../../shared/domain/product-form-separation.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const packageDefinitionId = '44444444-4444-4444-8444-444444444444';
const configurationDefinitionId = '55555555-5555-4555-8555-555555555555';

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
const configurationDefinitionRef = {
  moduleId: 'commerce.catalog',
  resourceId: configurationDefinitionId,
  resourceType: 'commerce.catalog.configuration-definition',
  tenantId,
} as const;

const variantTarget = { kind: 'VARIANT', variantRef } as const;
const packageOption = {
  kind: 'PACKAGE_OPTION',
  packageDefinitionRef,
  variantRef,
} as const;
const packageOptionTarget = { kind: 'PACKAGE_OPTION', packageOptionRef: packageOption } as const;

describe('Catalog product-form reference separation', () => {
  it('keeps Product and Variant as distinct branded ResourceRefs', () => {
    expect(Schema.decodeUnknownSync(ProductReferenceSchema, { onExcessProperty: 'error' })(productRef)).toEqual(
      productRef,
    );
    expect(Schema.decodeUnknownSync(VariantReferenceSchema, { onExcessProperty: 'error' })(variantRef)).toEqual(
      variantRef,
    );
    expect(() => Schema.decodeUnknownSync(VariantReferenceSchema)(productRef)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ProductReferenceSchema)({ ...productRef, resourceType: 'commerce.catalog.variant' }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ProductReferenceSchema)({ ...productRef, tenantId: ` ${tenantId}` }),
    ).toThrow();
  });

  it('represents SKU as a target-bound code, not Product or Variant identity', () => {
    const sku = Schema.decodeUnknownSync(SkuReferenceSchema, { onExcessProperty: 'error' })({
      code: 'SHELF-WHITE',
      kind: 'SKU',
      target: variantTarget,
    });

    expect(sku.target).toEqual(variantTarget);
    expect(Schema.decodeUnknownSync(CatalogSelectionTargetReferenceSchema)(packageOptionTarget)).toEqual(
      packageOptionTarget,
    );
    expect(() =>
      Schema.decodeUnknownSync(SkuReferenceSchema)({ code: ' ', kind: 'SKU', target: variantTarget }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SkuReferenceSchema)({ code: 'SHELF-WHITE', kind: 'SKU', target: productRef }),
    ).toThrow();
  });

  it('keeps Package Option as a role of one definition and one Variant', () => {
    const decoded = Schema.decodeUnknownSync(PackageOptionReferenceSchema, { onExcessProperty: 'error' })(
      packageOption,
    );
    expect(decoded.packageDefinitionRef).toEqual(packageDefinitionRef);
    expect(decoded.variantRef).toEqual(variantRef);
    expect(() =>
      Schema.decodeUnknownSync(PackageOptionReferenceSchema)({
        ...packageOption,
        variantRef: { ...variantRef, tenantId: '99999999-9999-4999-8999-999999999999' },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PackageOptionReferenceSchema, { onExcessProperty: 'error' })({
        ...packageOption,
        packageOptionResourceId: packageDefinitionId,
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(PackageContentRevisionReferenceSchema)({
        packageDefinitionRef,
        revision: 1,
      }),
    ).toMatchObject({ revision: 1 });
  });

  it('keeps Product Configuration as an immutable target value with a separate definition reference', () => {
    const configuration = Schema.decodeUnknownSync(ProductConfigurationSchema, { onExcessProperty: 'error' })({
      kind: 'PRODUCT_CONFIGURATION',
      target: variantTarget,
      values: { length: { unit: 'cm', value: 83 } },
    });

    expect(configuration.target).toEqual(variantTarget);
    expect(configuration.values).toEqual({ length: { unit: 'cm', value: 83 } });
    expect(Schema.decodeUnknownSync(ProductConfigurationDefinitionReferenceSchema)(configurationDefinitionRef)).toEqual(
      configurationDefinitionRef,
    );
    expect(() =>
      Schema.decodeUnknownSync(ProductConfigurationDefinitionReferenceSchema)({
        ...configurationDefinitionRef,
        resourceType: 'commerce.catalog.product-configuration-definition',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ProductConfigurationSchema, { onExcessProperty: 'error' })({
        configurationResourceId: configurationDefinitionId,
        kind: 'PRODUCT_CONFIGURATION',
        target: variantTarget,
        values: {},
      }),
    ).toThrow();
  });

  it('represents a Set through its ordinary Product/Variant and exact composition revision', () => {
    const compositionRevision = { revision: 1, variantRef } as const;
    expect(() =>
      Schema.decodeUnknownSync(SetReferenceSchema)({
        compositionRevision: { revision: 1, variantRef: { ...variantRef, resourceId: packageDefinitionId } },
        kind: 'SET',
        productRef,
        variantRef,
      }),
    ).toThrow();
    const set = Schema.decodeUnknownSync(SetReferenceSchema, { onExcessProperty: 'error' })({
      compositionRevision,
      kind: 'SET',
      productRef,
      variantRef,
    });

    expect(set.productRef).toEqual(productRef);
    expect(set.variantRef).toEqual(variantRef);
    expect(Schema.decodeUnknownSync(SetCompositionRevisionReferenceSchema)(compositionRevision)).toEqual(
      compositionRevision,
    );
    expect(() =>
      Schema.decodeUnknownSync(SetReferenceSchema, { onExcessProperty: 'error' })({
        ...set,
        setResourceRef: productRef,
      }),
    ).toThrow();
  });

  it('provides one explicitly tagged union without collapsing the meanings', () => {
    const references = [
      { kind: 'PRODUCT', ref: productRef },
      { kind: 'VARIANT', ref: variantRef },
      { code: 'SHELF-WHITE', kind: 'SKU', target: variantTarget },
      { kind: 'PRODUCT_CONFIGURATION', target: variantTarget, values: {} },
      packageOption,
      { compositionRevision: { revision: 1, variantRef }, kind: 'SET', productRef, variantRef },
    ] as const;

    for (const reference of references) {
      expect(Schema.decodeUnknownSync(ProductFormReferenceSchema)(reference)).toEqual(reference);
    }
  });
});
