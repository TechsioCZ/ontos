import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PriceDefinitionSchema,
  PriceIdentityKeySchema,
  PriceRevisionSchema,
} from '../../src/domain/price-definition.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const priceId = '33333333-3333-4333-8333-333333333333';
const productId = '44444444-4444-4444-8444-444444444444';
const variantId = '55555555-5555-4555-8555-555555555555';
const productUnitId = '66666666-6666-4666-8666-666666666666';
const priceGroupId = '77777777-7777-4777-8777-777777777777';
const priceRevisionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: priceId,
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const selection = {
  productRef: catalogRef(productId, 'commerce.catalog.product'),
  variantRef: catalogRef(variantId, 'commerce.catalog.variant'),
};
const unitRef = catalogRef(productUnitId, 'commerce.catalog.product-unit');
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: priceGroupId,
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};
const identityKey = {
  catalogSelection: selection,
  commercialScope: {
    channelId: 'B2C',
    marketId: 'cz-launch',
    sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' as const },
  unitBasis: { quantity: '1', unitRef },
};
const revision = {
  effectiveFrom: '2026-09-27T10:00:00.000Z',
  monetaryAmount: { amount: '0', currencyCode: 'CZK' },
  monetaryBoundary: 'PRE_TAX' as const,
  revision: 1,
  revisionId: priceRevisionId,
};
const definition = { identityKey, priceRef, revision };

const decodeDefinition = Schema.decodeUnknownSync(PriceDefinitionSchema, { onExcessProperty: 'error' });
const decodeIdentity = Schema.decodeUnknownSync(PriceIdentityKeySchema, { onExcessProperty: 'error' });
const decodeRevision = Schema.decodeUnknownSync(PriceRevisionSchema, { onExcessProperty: 'error' });

describe('Pricing Price definition contract', () => {
  it('accepts one exact Variant Price and treats explicit zero as a real pre-Tax amount', () => {
    expect(decodeDefinition(definition)).toEqual(definition);
  });

  it('keeps native currency keys generalized without activating another currency', () => {
    const eurDefinition = {
      ...definition,
      identityKey: { ...identityKey, currencyCode: 'EUR' },
      revision: {
        ...revision,
        monetaryAmount: { amount: '40', currencyCode: 'EUR' },
      },
    };

    expect(decodeDefinition(eurDefinition)).toEqual(eurDefinition);
    expect(decodeIdentity(identityKey)).not.toEqual(decodeIdentity(eurDefinition.identityKey));
  });

  it('requires a concrete Variant and an explicit Price Group or no-group selector', () => {
    const { variantRef: _variantRef, ...productOnly } = selection;
    expect(() => decodeIdentity({ ...identityKey, catalogSelection: productOnly })).toThrow();

    const { priceGroupSelector: _priceGroupSelector, ...implicitGroup } = identityKey;
    expect(() => decodeIdentity(implicitGroup)).toThrow();

    expect(
      decodeIdentity({
        ...identityKey,
        priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef },
      }),
    ).toEqual({
      ...identityKey,
      priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef },
    });
  });

  it('preserves exact optional package, configuration, and Set selection meaning', () => {
    const richSelection = {
      configuration: {
        choices: [{ choiceKey: 'finish', value: 'blue' }],
        definition: {
          resourceRef: catalogRef('88888888-8888-4888-8888-888888888888', 'commerce.catalog.configuration-definition'),
          revision: 4,
        },
        productRef: selection.productRef,
        variantRef: selection.variantRef,
      },
      packageOption: {
        contentRevision: {
          resourceRef: catalogRef('99999999-9999-4999-8999-999999999999', 'commerce.catalog.package-definition'),
          revision: 5,
        },
        optionRef: catalogRef('99999999-9999-4999-8999-999999999999', 'commerce.catalog.package-definition'),
      },
      ...selection,
      setComposition: {
        resourceRef: catalogRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'commerce.catalog.set-composition'),
        revision: 6,
      },
    };

    expect(decodeIdentity({ ...identityKey, catalogSelection: richSelection })).toEqual({
      ...identityKey,
      catalogSelection: richSelection,
    });
  });

  it('rejects Storefront, Cart, occurrence, principal, purchase Quantity, and operation time as Price identity', () => {
    for (const excess of [
      { storefrontId: 'storefront-web' },
      { cartId: 'cart-41' },
      { occurrenceId: 'line-1' },
      { principalId: 'principal-1' },
      { purchaseQuantity: '12' },
      { operationTime: '2026-09-27T10:00:00.000Z' },
      { sourceRecordId: 'legacy-14' },
    ]) {
      expect(() => decodeIdentity({ ...identityKey, ...excess })).toThrow();
    }
    expect(() =>
      decodeIdentity({
        ...identityKey,
        commercialScope: { ...identityKey.commercialScope, storefrontId: 'storefront-web' },
      }),
    ).toThrow();
  });

  it('rejects cross-Tenant references, implicit/wildcard dimensions, and wrong Units', () => {
    expect(() =>
      decodeIdentity({
        ...identityKey,
        priceGroupSelector: {
          kind: 'PRICE_GROUP',
          priceGroupRef: { ...priceGroupRef, tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeIdentity({
        ...identityKey,
        unitBasis: {
          ...identityKey.unitBasis,
          unitRef: { ...unitRef, resourceType: 'commerce.catalog.unit' },
        },
      }),
    ).toThrow();
    for (const omittedDimension of ['channelId', 'marketId', 'sellingLegalEntityId'] as const) {
      const partialScope = { ...identityKey.commercialScope };
      Reflect.deleteProperty(partialScope, omittedDimension);
      expect(() => decodeIdentity({ ...identityKey, commercialScope: partialScope })).toThrow();
    }
    for (const wildcardDimension of ['channelId', 'marketId', 'sellingLegalEntityId'] as const) {
      expect(() =>
        decodeIdentity({
          ...identityKey,
          commercialScope: { ...identityKey.commercialScope, [wildcardDimension]: '*' },
        }),
      ).toThrow();
    }
    expect(() =>
      decodeIdentity({
        ...identityKey,
        commercialScope: { ...identityKey.commercialScope, currencyCode: 'CZK' },
      }),
    ).toThrow();
  });

  it('rejects negative or Tax-inclusive revisions and currency mismatch with the Price key', () => {
    expect(() =>
      decodeRevision({
        ...revision,
        monetaryAmount: { ...revision.monetaryAmount, amount: '-0.01' },
      }),
    ).toThrow();
    expect(() => decodeRevision({ ...revision, monetaryBoundary: 'TAX_INCLUSIVE' })).toThrow();
    expect(() =>
      decodeRevision({ ...revision, sourceProvenanceRef: '88888888-8888-4888-8888-888888888888' }),
    ).toThrow();
    expect(() => decodeRevision({ ...revision, provenance: { sourceRecordRef: 'sensitive-source-row' } })).toThrow();
    expect(() =>
      decodeDefinition({
        ...definition,
        revision: {
          ...revision,
          monetaryAmount: { ...revision.monetaryAmount, currencyCode: 'EUR' },
        },
      }),
    ).toThrow();
  });

  it('accepts numeric(38,9) limits and rejects values PostgreSQL would round or overflow', () => {
    expect(
      decodeRevision({ ...revision, monetaryAmount: { ...revision.monetaryAmount, amount: '0.123456789' } }),
    ).toBeDefined();
    expect(
      decodeRevision({
        ...revision,
        monetaryAmount: {
          ...revision.monetaryAmount,
          amount: '99999999999999999999999999999.123456789',
        },
      }),
    ).toBeDefined();
    for (const amount of ['0.0000000001', '999999999999999999999999999999.123456789']) {
      expect(() => decodeRevision({ ...revision, monetaryAmount: { ...revision.monetaryAmount, amount } })).toThrow();
    }
    for (const quantity of ['1.0000000001', '1.0000000002']) {
      expect(() => decodeIdentity({ ...identityKey, unitBasis: { ...identityKey.unitBasis, quantity } })).toThrow();
    }
    expect(decodeRevision(revision).monetaryAmount.amount).toBe('0');
  });
});
