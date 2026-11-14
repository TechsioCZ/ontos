import type { Schema } from 'effect';

export type Json = typeof Schema.Json.Type;

const catalogModule = 'commerce.catalog';
const tenantId = '11111111-1111-4111-8111-111111111111';
const id = (suffix: string) => `33333333-3333-4333-8333-${suffix.padStart(12, '0')}`;

export const productRef = {
  moduleId: catalogModule,
  resourceId: id('1'),
  resourceType: 'commerce.catalog.product',
  tenantId,
};
export const variantRef = {
  moduleId: catalogModule,
  resourceId: id('2'),
  resourceType: 'commerce.catalog.variant',
  tenantId,
};
export const unitRef = {
  moduleId: catalogModule,
  resourceId: id('3'),
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
};
export const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: id('4'),
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
};
export const priceRef = {
  moduleId: 'commerce.pricing',
  resourceId: id('5'),
  resourceType: 'commerce.pricing.price',
  tenantId,
};
export const commercialScope = { channelId: 'B2B', marketId: 'cz-market' };
export const unitBasis = { quantity: '1', unitRef };
