import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { mapSymmyProductsBatchRequest } from '../../api/symmy/products-batch-public-contract.ts';
import { SymmyProductsBatchRequestSchema } from '../../api/symmy/products-batch-request-contract.ts';
import { priceGroupRef, productRef, unitRef, variantRef } from './symmy-price-requests.fixtures.ts';
import type { Json } from './symmy-price-requests.fixtures.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const catalogRef = (type: string, suffix: string) => ({
  moduleId: 'commerce.catalog',
  resourceId: `66666666-6666-4666-8666-${suffix.padStart(12, '0')}`,
  resourceType: `commerce.catalog.${type}`,
  tenantId,
});
type Fields = Readonly<Record<string, Json>>;
const map = (products: readonly Json[]) =>
  mapSymmyProductsBatchRequest(Schema.decodeUnknownSync(SymmyProductsBatchRequestSchema)({ products }));
const product = (extra: Fields = {}, variants: readonly Json[] = [{}]) => ({
  name: 'Chair',
  variants,
  ...extra,
});

describe('Symmy products batch public mapping', () => {
  it('hands each product to the owner admission with its variants in request order and nothing else', () => {
    const rows = map([
      product({ description: 'A chair', identifier: { type: 'sku', value: 'CHAIR' }, lifecycle: 'ACTIVE' }, [
        { identifier: { type: 'sku', value: 'CHAIR-RED' } },
        { identifier: { type: 'ean', value: '8590000000011' } },
      ]),
    ]);
    expect(rows).toStrictEqual([
      {
        description: 'A chair',
        identifier: { type: 'sku', value: 'CHAIR' },
        lifecycle: 'ACTIVE',
        name: 'Chair',
        unsupported: [],
        variants: [
          { identifier: { type: 'sku', value: 'CHAIR-RED' }, localized: [], prices: [] },
          { identifier: { type: 'ean', value: '8590000000011' }, localized: [], prices: [] },
        ],
      },
    ]);
  });

  it('is deterministic and keeps the product order', () => {
    const body = [product({ name: 'B' }), product({ name: 'A' })];
    expect(map(body)).toStrictEqual(map(body));
    expect(map(body).map(({ name }) => name)).toEqual(['B', 'A']);
  });

  it('maps a price to the owner facts and leaves out what the body does not name', () => {
    const [row] = map([
      product({}, [
        {
          prices: [
            { amount: '10.5', currencyCode: 'CZK' },
            {
              amount: '9',
              commercialScope: {
                channelRef: { ...productRef, resourceId: 'B2B' },
                commerceMarketRef: {
                  moduleId: 'commerce.market-catalog',
                  resourceId: 'cz-market',
                  resourceType: 'commerce.market-catalog.market',
                  tenantId,
                },
                sellingLegalEntityRef: {
                  moduleId: 'core.identity',
                  resourceId: '88888888-8888-4888-8888-888888888888',
                  resourceType: 'core.identity.legal-entity',
                  tenantId,
                },
              },
              currencyCode: 'EUR',
              effectiveFrom: '2026-01-01T12:00:00+02:00',
              priceGroupCode: 'cz-wholesale',
              unitBasis: { quantity: '2', unitRef },
            },
          ],
        },
      ]),
    ]);
    expect(row?.variants[0]?.prices).toStrictEqual([
      { amount: '10.5', currencyCode: 'CZK' },
      {
        amount: '9',
        commercialScope: {
          channelId: 'B2B',
          marketId: 'cz-market',
          sellingLegalEntityId: '88888888-8888-4888-8888-888888888888',
        },
        currencyCode: 'EUR',
        effectiveFrom: '2026-01-01T10:00:00.000Z',
        priceGroupCode: 'cz-wholesale',
        unitBasis: { quantity: '2', unitRef },
      },
    ]);
  });

  it('reports every supplied field no intent writes, by group, and nothing else', () => {
    const cases: readonly (readonly [string, Fields, readonly string[]])[] = [
      ['categories', { categories: [catalogRef('product-category', '1')] }, ['CategoryHint']],
      [
        'attributes',
        { attributes: [{ attributeDefinitionRef: catalogRef('attribute-definition', '2') }] },
        ['AttributeHint'],
      ],
      [
        'media',
        { media: [{ order: 1, purpose: 'GALLERY', resourceKind: 'MEDIA', resourceRef: productRef }] },
        ['MediaHint'],
      ],
      ['localized', { localized: [{ locale: 'cs', name: 'Zidle' }] }, ['DescriptiveHint']],
      ['sku', { sku: 'CHAIR' }, ['DescriptiveHint']],
      ['gtin', { gtin: { code: '8590000000011', effectiveAt: '2026-01-01T00:00:00Z' } }, ['DescriptiveHint']],
      ['productType', { productType: catalogRef('product-type', '3') }, ['ClassificationHint']],
      ['brand', { brand: { kind: 'unknown' } }, ['ClassificationHint']],
      [
        'manufacturer',
        {
          manufacturer: {
            target: {
              kind: 'PARTY',
              partyRef: {
                moduleId: 'party.registry',
                resourceId: '77777777-7777-4777-8777-777777777777',
                resourceType: 'party.registry.party',
                tenantId,
              },
            },
          },
        },
        ['ClassificationHint'],
      ],
      ['relationships', { relationships: [{ target: variantRef, type: 'SUCCESSOR' }] }, ['ClassificationHint']],
      ['sizes', { sizes: [productRef] }, ['ClassificationHint']],
    ];
    for (const [field, extra, kinds] of cases) {
      expect(map([product(extra)])[0]?.unsupported, field).toEqual(kinds);
    }
    expect(map([product({ categories: [], localized: [], relationships: [], sizes: [] })])[0]?.unsupported).toEqual([]);
  });

  it('reports the variant fields no intent writes, and drops a localized text that has no text', () => {
    const cases: readonly (readonly [string, Fields, readonly string[]])[] = [
      ['sku', { sku: 'CHAIR-RED' }, ['DescriptiveHint']],
      ['gtin', { gtin: { code: '8590000000011', effectiveAt: '2026-01-01T00:00:00Z' } }, ['DescriptiveHint']],
      [
        'attributes',
        { attributes: [{ attributeDefinitionRef: catalogRef('attribute-definition', '2') }] },
        ['AttributeHint'],
      ],
      ['lifecycle ACTIVE', { lifecycle: 'ACTIVE' }, ['VariantUpdateHint']],
      ['lifecycle RETIRED', { lifecycle: 'RETIRED' }, ['VariantUpdateHint']],
      ['lifecycle WORK_IN_PROGRESS', { lifecycle: 'WORK_IN_PROGRESS' }, []],
      ['text-less locale', { localized: [{ locale: 'cs' }] }, ['DescriptiveHint']],
    ];
    for (const [field, extra, kinds] of cases) {
      expect(map([product({}, [extra])])[0]?.unsupported, field).toEqual(kinds);
    }
    const [row] = map([product({}, [{ localized: [{ locale: 'cs' }, { locale: 'en', name: 'Chair' }] }])]);
    expect(row?.variants[0]?.localized).toEqual([{ locale: 'en', name: 'Chair' }]);
  });

  it('never carries a price list ref, a contract version or a reason', () => {
    const [row] = map([product({}, [{ prices: [{ amount: '1', currencyCode: 'CZK' }] }])]);
    expect(JSON.stringify(row)).not.toMatch(/contractVersion|INTERNAL_C14|reason|evidence/u);
    expect(JSON.stringify(row)).not.toContain(priceGroupRef.resourceId);
  });
});
