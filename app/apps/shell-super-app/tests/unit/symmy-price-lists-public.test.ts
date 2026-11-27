import { encodeSymmySourceSelector } from '@app/symmy-integration/symmy-source-selector';
import { Result, Schema } from 'effect';
import { assert, describe, expect, it } from 'effect-rstest';

import { SymmyPriceListsReadQuerySchema } from '../../api/symmy/contract.ts';
import {
  mapSymmyPriceListsProjection,
  SymmyPriceListsResponseSchema,
} from '../../api/symmy/price-lists-public-contract.ts';
import { mapSymmyPriceListPricesBatchRequest } from '../../api/symmy/price-lists-prices-batch-public-contract.ts';
import { SymmyPriceListPricesBatchRequestSchema } from '../../api/symmy/price-lists-prices-batch-request-contract.ts';
import { mapSymmyProductsProjection } from '../../api/symmy/products-public-contract.ts';
import {
  SymmyInternalPriceListsProjectionSchema,
  SymmyInternalProductsProjectionSchema,
} from '../../api/symmy/read-projection-contracts.ts';
import { SymmySourcePricesSchema } from '../../api/symmy/source-prices-public-contract.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const groupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const qualifiedId = encodeSymmySourceSelector(
  {
    issuerId: 'issuer',
    routeId: '55555555-5555-4555-8555-555555555555',
    selectorKind: 'PRICE_GROUP',
    sourceNamespace: 'namespace',
    tenantId,
  },
  'CZ wholesale',
  groupRef.resourceId,
);
const baseList = {
  description: 'Wholesale prices',
  id: qualifiedId,
  name: 'CZ wholesale',
  priceGroupRef: groupRef,
  source_record_id: 'CZ wholesale',
  starts_at: '2026-01-01T00:00:00.000Z',
};
const emptyPrices = { count: 0, limit: 50, offset: 0, prices: [] };
type ListInput = typeof baseList & { readonly ends_at?: string; readonly prices?: Schema.Json };

const uuid = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const ownerRef = (moduleId: string, resourceType: string, digit: string) => ({
  moduleId,
  resourceId: uuid(digit),
  resourceType,
  tenantId,
});
const catalogRef = (kind: string, digit: string) => ownerRef('commerce.catalog', `commerce.catalog.${kind}`, digit);
const revisionOf = (kind: string, digit: string) => ({ resourceRef: catalogRef(kind, digit), revision: 1 });
const priceRef = ownerRef('commerce.pricing', 'commerce.pricing.price', '1');
const productRef = catalogRef('product', '2');
const variantRef = catalogRef('variant', '3');
const unitBasis = { quantity: '1', unitRef: catalogRef('product-unit', '6') };
const identityKey = {
  catalogSelection: {
    configuration: {
      choices: [
        {
          attributeDefinition: revisionOf('attribute-definition', '7'),
          choiceKey: 'colour',
          unit: revisionOf('unit', '8'),
          value: 'red',
        },
      ],
      definition: revisionOf('configuration-definition', '9'),
      productRef,
      variantRef,
    },
    packageOption: {
      contentRevision: revisionOf('package-definition', 'a'),
      optionRef: catalogRef('package-definition', 'a'),
    },
    productRef,
    setComposition: revisionOf('set-composition', 'b'),
    variantRef,
  },
  commercialScope: { channelId: 'B2B', marketId: 'cz-market', sellingLegalEntityId: uuid('4') },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef: groupRef },
  unitBasis,
};
const at = '2026-01-01T00:00:00.000Z';
const monetaryAmount = { amount: '25.5', currencyCode: 'CZK' };
const revision = {
  effectiveFrom: at,
  monetaryAmount,
  monetaryBoundary: 'PRE_TAX',
  revision: 1,
  revisionId: uuid('c'),
};
const ownerPrices = {
  count: 2,
  limit: 50,
  offset: 0,
  prices: [
    {
      price: {
        currentEvidence: { observedAt: at, priceRef, revision: 1, revisionId: revision.revisionId },
        definition: { identityKey, priceRef, revision },
        outcome: 'PRICE_DEFINITION_CURRENT',
      },
      provenance: {
        canonicalLink: {
          effectiveFrom: at,
          identityKey,
          monetaryAmount,
          monetaryBoundary: 'PRE_TAX',
          priceRef,
          revision: 1,
          revisionId: revision.revisionId,
        },
        evidence: {
          lineage: { kind: 'INITIAL' },
          recordedAt: at,
          sourceAssertion: {
            lineage: { kind: 'INITIAL' },
            mapping: { mappingContractRef: 'erp-price', mappingContractVersion: '1' },
            originalAssertion: { monetaryAmount, monetaryBoundary: 'PRE_TAX', unitBasis },
            sourceAssertionId: uuid('d'),
            sourceAuthority: { sourceAuthorityRef: 'erp', sourceAuthorityVersion: '1' },
            sourceRecord: {
              sourceChangeCorrelation: 'change-1',
              sourceRecordRef: 'row-1',
              sourceRecordVersion: '1',
              sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'erp' },
            },
            timing: { importedAt: at, ownerBusinessEffectiveAt: at, sourceEffectiveAt: at },
          },
          sourceFactFingerprint: 'e'.repeat(64),
          tenantId,
        },
        provenanceRef: uuid('e'),
      },
    },
    { price: { outcome: 'PRICE_DEFINITION_NOT_FOUND', priceRef } },
  ],
};
const decodeProjection = (list: ListInput, unsupported: readonly 'prices'[]) =>
  Schema.decodeUnknownSync(SymmyInternalPriceListsProjectionSchema)({
    contractVersion: 'INTERNAL_C14',
    count: 3,
    limit: 50,
    offset: 0,
    price_lists: [list],
    projection: 'price_lists',
    unsupported_fields: unsupported,
  });
const projection = (endsAt?: string) => {
  const withPrices = { ...baseList, prices: emptyPrices };
  return decodeProjection(endsAt === undefined ? withPrices : { ...withPrices, ends_at: endsAt }, []);
};
const projectionWithoutPrices = () => decodeProjection(baseList, ['prices']);
const decodeQuery = Schema.decodeUnknownResult(SymmyPriceListsReadQuerySchema);
/** The price list as Symmy reads it, and its first entry: a current price. */
const readPricedList = () => {
  const [list] = mapSymmyPriceListsProjection(decodeProjection({ ...baseList, prices: ownerPrices }, [])).priceLists;
  const [entry] = Schema.decodeUnknownSync(Schema.toType(SymmySourcePricesSchema))(list?.prices).prices;
  assert.isDefined(list);
  assert(entry?.price.outcome === 'PRICE_DEFINITION_CURRENT');
  return { list, price: entry.price };
};

describe('Symmy public price lists body', () => {
  it('maps the projection to camelCase with the price group id and without markers or the qualified id', () => {
    const body = mapSymmyPriceListsProjection(projection());
    expect(body).toEqual({
      count: 3,
      limit: 50,
      offset: 0,
      priceLists: [
        {
          code: 'CZ wholesale',
          description: 'Wholesale prices',
          name: 'CZ wholesale',
          priceGroupId: groupRef.resourceId,
          prices: { count: 0, limit: 50, offset: 0, prices: [] },
          startsAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(Schema.is(Schema.toType(SymmyPriceListsResponseSchema))(body)).toBe(true);
    for (const forbidden of ['contractVersion', 'projection', 'unsupported_fields', 'unsupportedFields']) {
      expect(body).not.toHaveProperty(forbidden);
    }
    expect(body.priceLists[0]).not.toHaveProperty('id');
    expect(body.priceLists[0]).not.toHaveProperty('source_record_id');
    expect(body.priceLists[0]).not.toHaveProperty('endsAt');
  });

  it('names every reference of a price by the plain id the price import takes back', () => {
    const [list] = mapSymmyPriceListsProjection(decodeProjection({ ...baseList, prices: ownerPrices }, [])).priceLists;
    const prices = Schema.decodeUnknownSync(Schema.toType(SymmySourcePricesSchema), { onExcessProperty: 'error' })(
      list?.prices,
    );
    const ids = { productId: productRef.resourceId, variantId: variantRef.resourceId };
    const unit = { quantity: '1', unitId: unitBasis.unitRef.resourceId };
    const revised = (digit: string) => ({ resourceId: uuid(digit), revision: 1 });
    const publicIdentity = {
      ...identityKey,
      catalogSelection: {
        ...ids,
        configuration: {
          ...ids,
          choices: [
            {
              attributeDefinition: { attributeDefinitionId: uuid('7'), revision: 1 },
              choiceKey: 'colour',
              unit: revised('8'),
              value: 'red',
            },
          ],
          definition: revised('9'),
        },
        packageOption: { contentRevision: revised('a'), optionId: uuid('a') },
        setComposition: revised('b'),
      },
      priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupId: groupRef.resourceId },
      unitBasis: unit,
    };
    const [priced, missing] = prices.prices;
    expect(priced?.price).toEqual({
      currentEvidence: { observedAt: at, priceId: priceRef.resourceId, revision: 1, revisionId: revision.revisionId },
      definition: { identityKey: publicIdentity, priceId: priceRef.resourceId, revision },
      outcome: 'PRICE_DEFINITION_CURRENT',
    });
    expect(priced?.provenance?.canonicalLink).toMatchObject({
      identityKey: publicIdentity,
      priceId: priceRef.resourceId,
    });
    expect(priced?.provenance?.evidence.sourceAssertion.originalAssertion.unitBasis).toEqual(unit);
    expect(missing?.price).toEqual({ outcome: 'PRICE_DEFINITION_NOT_FOUND', priceId: priceRef.resourceId });
    expect(priced?.provenance?.evidence.sourceAssertion.sourceRecord.sourceSystem).toEqual({ sourceSystemRef: 'erp' });
    expect(JSON.stringify(prices)).not.toMatch(/moduleId|ownerModuleId|resourceType|tenantId/u);
  });

  it('rebuilds the owner references when the price import sends back what the read answered', () => {
    const { list, price } = readPricedList();
    const { identityKey: key, priceId, revision: current } = price.definition;
    const { productId, variantId } = key.catalogSelection;
    const { amount, currencyCode } = current.monetaryAmount;
    const body = Schema.decodeUnknownSync(SymmyPriceListPricesBatchRequestSchema, { onExcessProperty: 'error' })({
      priceGroupId: list.priceGroupId,
      prices: [
        {
          amount,
          commercialScope: { channelId: key.commercialScope.channelId, marketId: key.commercialScope.marketId },
          currencyCode,
          effectiveFrom: current.effectiveFrom,
          operation: 'DEFINE',
          productId,
          unitBasis: key.unitBasis,
          variantId,
        },
        {
          amount,
          currencyCode,
          expectedRevision: { revision: current.revision, revisionId: current.revisionId },
          operation: 'REVISE',
          priceId,
        },
      ],
    });
    expect(mapSymmyPriceListPricesBatchRequest(body, tenantId)).toMatchObject({
      priceGroupRef: groupRef,
      prices: [{ productRef, unitBasis, variantRef }, { priceRef }],
    });
  });

  it('builds a price import from the ids the products and price list reads answer', () => {
    const { list, price } = readPricedList();
    const [item] = mapSymmyProductsProjection(
      Schema.decodeUnknownSync(SymmyInternalProductsProjectionSchema)({
        contractVersion: 'INTERNAL_C14',
        count: 1,
        limit: 50,
        offset: 0,
        products: [
          {
            id: `~c14r1.${'a'.repeat(43)}`,
            product: {
              catalogReady: true,
              createdAt: at,
              lifecycle: 'ACTIVE',
              productRef,
              revision: 1,
              updatedAt: at,
              variants: [{ lifecycle: 'ACTIVE', productRef, variantId: variantRef.resourceId, variantRef }],
            },
            source_record_id: 'source-product',
            variantSources: [],
          },
        ],
        projection: 'products',
        unsupported_fields: ['tax', 'assortment', 'prices', 'stock'],
      }),
    ).products;
    const [variant] = item?.product.variants ?? [];
    assert.isDefined(item);
    assert.isDefined(variant);
    const { commercialScope, unitBasis: basis } = price.definition.identityKey;
    const body = Schema.decodeUnknownSync(SymmyPriceListPricesBatchRequestSchema, { onExcessProperty: 'error' })({
      priceGroupId: list.priceGroupId,
      prices: [
        {
          amount: '30',
          commercialScope: { channelId: commercialScope.channelId, marketId: commercialScope.marketId },
          currencyCode: 'CZK',
          effectiveFrom: at,
          operation: 'DEFINE',
          productId: item.product.productId,
          unitBasis: { quantity: '1', unitId: basis.unitId },
          variantId: variant.variantId,
        },
      ],
    });
    expect(mapSymmyPriceListPricesBatchRequest(body, tenantId)).toMatchObject({
      priceGroupRef: groupRef,
      prices: [{ productRef, unitBasis, variantRef }],
    });
  });

  it('adds endsAt only when the price list has an end', () => {
    const [list] = mapSymmyPriceListsProjection(projection('2026-12-31T00:00:00.000Z')).priceLists;
    expect(list).toHaveProperty('endsAt', '2026-12-31T00:00:00.000Z');
  });

  it('leaves prices absent when no price source is configured', () => {
    const [list] = mapSymmyPriceListsProjection(projectionWithoutPrices()).priceLists;
    expect(list).not.toHaveProperty('prices');
  });

  it('maps an empty page', () => {
    expect(
      mapSymmyPriceListsProjection({ ...projection(), count: 0, price_lists: [], unsupported_fields: ['prices'] }),
    ).toEqual({ count: 0, limit: 50, offset: 0, priceLists: [] });
  });
});

describe('Symmy price lists query', () => {
  for (const query of [{}, { limit: '1' }, { limit: '100', offset: '0' }, { priceLimit: '1', priceOffset: '0' }]) {
    it(`accepts ${JSON.stringify(query)}`, () => {
      expect(Result.isSuccess(decodeQuery(query))).toBe(true);
    });
  }
  for (const query of [
    { limit: '0' },
    { limit: '101' },
    { limit: 'abc' },
    { offset: '-1' },
    { priceLimit: '0' },
    { priceLimit: '101' },
    { priceOffset: '-1' },
  ]) {
    it(`rejects ${JSON.stringify(query)}`, () => {
      expect(Result.isFailure(decodeQuery(query))).toBe(true);
    });
  }
});
