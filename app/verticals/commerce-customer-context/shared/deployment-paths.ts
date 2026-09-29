export const COMMERCE_CUSTOMER_CONTEXT_API_PREFIX = '/commerce-customer-context-api';
export const COMMERCE_PORTAL_AUTH_INTERNAL_BASE_PATH = '/api/portal-auth';
export const COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH = `${COMMERCE_CUSTOMER_CONTEXT_API_PREFIX}${COMMERCE_PORTAL_AUTH_INTERNAL_BASE_PATH}`;

/**
 * The Worker service binding Commerce reaches Price Group Catalog through on Cloudflare: the
 * provider's topology `workerDispatch.serviceBinding`, bound by `unitServiceBindings` in
 * `topology/cloudflare-placement.json`.
 */
export const PRICE_GROUP_CATALOG_SERVICE_BINDING = 'VERTICAL_PRICE_GROUP_CATALOG_WORKER';
