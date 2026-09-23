/** Static vertical API client surface required by the UltraModern shell contract. */
export { getPartyRegistryReadiness, partyRegistryClient } from '@app/party-registry/api/client';
export type { PartyRegistryClientOptions } from '@app/party-registry/api/client';
export {
  createCommerceCustomerContextClient,
  getCommerceCustomerContextReadiness,
} from '@app/commerce-customer-context/api/client';
export type { CommerceCustomerContextClientOptions } from '@app/commerce-customer-context/api/client';
export { createPaymentTermCatalogClient, getPaymentTermCatalogReadiness } from '@app/payment-term-catalog/api/client';
export type { PaymentTermCatalogClientOptions } from '@app/payment-term-catalog/api/client';
export { createPriceGroupCatalogClient, getPriceGroupCatalogReadiness } from '@app/price-group-catalog/api/client';
export type { PriceGroupCatalogClientOptions } from '@app/price-group-catalog/api/client';

export { findApprovedVerticalPageClient, ultramodernVerticalClients } from './vertical-page-clients.ts';
export type { ApprovedVerticalPageClient, ApprovedVerticalPageComponent } from './vertical-page-clients.ts';
