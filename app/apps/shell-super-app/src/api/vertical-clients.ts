/** Static vertical API client surface required by the UltraModern shell contract. */
export { createCatalogClient, getCatalogReadiness } from '@app/catalog/api/client';
export type { CatalogClientOptions } from '@app/catalog/api/client';
export { getPartyRegistryReadiness, partyRegistryClient } from '@app/party-registry/api/client';
export type { PartyRegistryClientOptions } from '@app/party-registry/api/client';
export {
  createCommerceCustomerContextClient,
  getCommerceCustomerContextReadiness,
} from '@app/commerce-customer-context/api/client';
export type { CommerceCustomerContextClientOptions } from '@app/commerce-customer-context/api/client';
export {
  createCommerceMarketCatalogClient,
  getCommerceMarketCatalogReadiness,
} from '@app/commerce-market-catalog/api/client';
export type { CommerceMarketCatalogClientOptions } from '@app/commerce-market-catalog/api/client';
export { createPaymentTermCatalogClient, getPaymentTermCatalogReadiness } from '@app/payment-term-catalog/api/client';
export type { PaymentTermCatalogClientOptions } from '@app/payment-term-catalog/api/client';
export { createPricingClient, getPricingReadiness } from '@app/pricing/api/client';
export type { PricingClientOptions } from '@app/pricing/api/client';
export { createStorefrontRegistryClient, getStorefrontRegistryReadiness } from '@app/storefront-registry/api/client';
export type { StorefrontRegistryClientOptions } from '@app/storefront-registry/api/client';

export { findApprovedVerticalPageClient, ultramodernVerticalClients } from './vertical-page-clients.ts';
export type { ApprovedVerticalPageClient, ApprovedVerticalPageComponent } from './vertical-page-clients.ts';
