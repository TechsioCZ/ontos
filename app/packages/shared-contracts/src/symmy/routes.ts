export const SYMMY_REST_PREFIX = '/api/symmy/v1';

type SymmyRouteDefinition = Readonly<
  {
    path: `${typeof SYMMY_REST_PREFIX}/${string}`;
    selector?: 'code' | 'id';
  } & (
    | { method: 'POST'; mode: 'durable_job'; successStatus: 202 }
    | { method: 'POST'; mode: 'item_results'; successStatus: 200 }
    | { method: 'GET'; mode: 'business_read' | 'job_read'; successStatus: 200 }
  )
>;

/** The approved internal route inventory. No source payload or compatibility DTO is implied. */
export const SYMMY_ROUTES = {
  adminCustomers: {
    method: 'GET',
    mode: 'business_read',
    path: `${SYMMY_REST_PREFIX}/admin/customers`,
    successStatus: 200,
  },
  adminProducts: {
    method: 'GET',
    mode: 'business_read',
    path: `${SYMMY_REST_PREFIX}/admin/products`,
    successStatus: 200,
  },
  adminRegions: {
    method: 'GET',
    mode: 'business_read',
    path: `${SYMMY_REST_PREFIX}/admin/regions`,
    successStatus: 200,
  },
  customerGroupCustomersBatch: {
    method: 'POST',
    mode: 'durable_job',
    path: `${SYMMY_REST_PREFIX}/customer-groups/{code}/customers/batch`,
    selector: 'code',
    successStatus: 202,
  },
  customerGroupsBatch: {
    method: 'POST',
    mode: 'item_results',
    path: `${SYMMY_REST_PREFIX}/customer-groups/batch`,
    successStatus: 200,
  },
  customersBatch: {
    method: 'POST',
    mode: 'durable_job',
    path: `${SYMMY_REST_PREFIX}/customers/batch`,
    successStatus: 202,
  },
  inventoryStockBatch: {
    method: 'POST',
    mode: 'item_results',
    path: `${SYMMY_REST_PREFIX}/inventory/stock/batch`,
    successStatus: 200,
  },
  job: {
    method: 'GET',
    mode: 'job_read',
    path: `${SYMMY_REST_PREFIX}/jobs/{id}`,
    selector: 'id',
    successStatus: 200,
  },
  priceListPricesBatch: {
    method: 'POST',
    mode: 'durable_job',
    path: `${SYMMY_REST_PREFIX}/price-lists/{code}/prices/batch`,
    selector: 'code',
    successStatus: 202,
  },
  priceLists: {
    method: 'GET',
    mode: 'business_read',
    path: `${SYMMY_REST_PREFIX}/price-lists`,
    successStatus: 200,
  },
  priceListsBatchUpsert: {
    method: 'POST',
    mode: 'durable_job',
    path: `${SYMMY_REST_PREFIX}/price-lists/batch-upsert`,
    successStatus: 202,
  },
  productsBatch: {
    method: 'POST',
    mode: 'durable_job',
    path: `${SYMMY_REST_PREFIX}/products/batch`,
    successStatus: 202,
  },
} as const satisfies Readonly<Record<string, SymmyRouteDefinition>>;

export type SymmyRouteKey = keyof typeof SYMMY_ROUTES;
