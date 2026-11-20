import { PaymentReconciliationGroup } from '@app/payment/payment-gateway-relay';
import { GatewayContextApiGroup } from '@app/shared-contracts';
import { SYMMY_FIXTURE_ROUTES, SYMMY_ROUTES } from '@app/shared-contracts/symmy';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { OpenApi } from 'effect/http-api';
import {
  SymmyCustomersReadQuerySchema,
  SymmyPriceListsReadQuerySchema,
  SymmyProductsReadQuerySchema,
  SymmyRegionsReadQuerySchema,
  SymmySchemaError,
  symmyCodeParams,
  symmyFixtureSubmitOptions,
  symmyJobOptions,
  symmyReadOptions,
  symmySubmitOptions,
  symmyWriteOptions,
} from '../api/symmy/contract.ts';
import { SymmyDefectBoundary } from '../api/symmy/defect-boundary.ts';
import { PaymentNotificationBoundary } from '../api/payment-gateway/notification-boundary.ts';
import { PaymentNotificationsGroup } from '../api/payment-gateway/notification-contract.ts';
import { PaymentReconciliationBoundary } from '../api/payment-gateway/reconciliation-boundary.ts';
import { SymmyCustomersResponseSchema } from '../api/symmy/customers-public-contract.ts';
import { SymmyCustomersBatchRequestSchema } from '../api/symmy/customers-batch-request-contract.ts';
import { SymmyCustomerGroupsBatchResponseSchema } from '../api/symmy/customer-groups-batch-public-contract.ts';
import { SymmyCustomerGroupsBatchRequestSchema } from '../api/symmy/customer-groups-batch-request-contract.ts';
import { SymmyGroupCustomersBatchPayloadSchema } from '../api/symmy/group-customers-batch-request-contract.ts';
import { SymmyPriceListsBatchRequestSchema } from '../api/symmy/price-lists-batch-upsert-request-contract.ts';
import { SymmyPriceListPricesBatchRequestSchema } from '../api/symmy/price-lists-prices-batch-request-contract.ts';
import { SymmyPriceListsResponseSchema } from '../api/symmy/price-lists-public-contract.ts';
import { SymmyProductsBatchRequestSchema } from '../api/symmy/products-batch-request-contract.ts';
import { SymmyProductsSuccessSchema } from '../api/symmy/products-public-contract.ts';
import { SymmyRegionsSuccessSchema } from '../api/symmy/regions-public-contract.ts';
import { SymmyStockBatchResponseSchema } from '../api/symmy/stock-batch-public-contract.ts';
import { SymmyStockBatchRequestSchema } from '../api/symmy/stock-batch-request-contract.ts';
import { ShellAuthenticationApi as ShellBrowserApi } from './browser-api.ts';

// Every request, response and error shape below is a Schema.* value declared in `../api/symmy/*contract.ts`;
// this module only wires those schemas to the Symmy routes.
const nativeSymmyPath = (path: `/${string}`): `/${string}` =>
  `/${path.slice(1).replace('{code}', ':code').replace('{id}', ':id')}`;

const adminCustomersEndpoint = HttpApiEndpoint.get('adminCustomers', SYMMY_ROUTES.adminCustomers.path, {
  ...symmyReadOptions,
  query: SymmyCustomersReadQuerySchema,
  success: SymmyCustomersResponseSchema,
});
const adminProductsEndpoint = HttpApiEndpoint.get('adminProducts', SYMMY_ROUTES.adminProducts.path, {
  ...symmyReadOptions,
  query: SymmyProductsReadQuerySchema,
  success: SymmyProductsSuccessSchema,
});
const adminRegionsEndpoint = HttpApiEndpoint.get('adminRegions', SYMMY_ROUTES.adminRegions.path, {
  ...symmyReadOptions,
  query: SymmyRegionsReadQuerySchema,
  success: SymmyRegionsSuccessSchema,
});
const customerGroupCustomersBatchEndpoint = HttpApiEndpoint.post(
  'customerGroupCustomersBatch',
  nativeSymmyPath(SYMMY_ROUTES.customerGroupCustomersBatch.path),
  { ...symmySubmitOptions, params: symmyCodeParams, payload: SymmyGroupCustomersBatchPayloadSchema },
);
const customerGroupsBatchEndpoint = HttpApiEndpoint.post('customerGroupsBatch', SYMMY_ROUTES.customerGroupsBatch.path, {
  ...symmyWriteOptions,
  payload: SymmyCustomerGroupsBatchRequestSchema,
  success: SymmyCustomerGroupsBatchResponseSchema,
});
const customersBatchEndpoint = HttpApiEndpoint.post('customersBatch', SYMMY_ROUTES.customersBatch.path, {
  ...symmySubmitOptions,
  payload: SymmyCustomersBatchRequestSchema,
});
const inventoryStockBatchEndpoint = HttpApiEndpoint.post('inventoryStockBatch', SYMMY_ROUTES.inventoryStockBatch.path, {
  ...symmyWriteOptions,
  payload: SymmyStockBatchRequestSchema,
  success: SymmyStockBatchResponseSchema,
});
const jobEndpoint = HttpApiEndpoint.get('job', nativeSymmyPath(SYMMY_ROUTES.job.path), symmyJobOptions);
const priceListPricesBatchEndpoint = HttpApiEndpoint.post(
  'priceListPricesBatch',
  SYMMY_ROUTES.priceListPricesBatch.path,
  { ...symmySubmitOptions, payload: SymmyPriceListPricesBatchRequestSchema },
);
const priceListsEndpoint = HttpApiEndpoint.get('priceLists', SYMMY_ROUTES.priceLists.path, {
  ...symmyReadOptions,
  query: SymmyPriceListsReadQuerySchema,
  success: SymmyPriceListsResponseSchema,
});
const priceListsBatchUpsertEndpoint = HttpApiEndpoint.post(
  'priceListsBatchUpsert',
  SYMMY_ROUTES.priceListsBatchUpsert.path,
  { ...symmySubmitOptions, payload: SymmyPriceListsBatchRequestSchema },
);
const productsBatchEndpoint = HttpApiEndpoint.post('productsBatch', SYMMY_ROUTES.productsBatch.path, {
  ...symmySubmitOptions,
  payload: SymmyProductsBatchRequestSchema,
});

const assortmentRulesFixtureBatchEndpoint = HttpApiEndpoint.post(
  'assortmentRulesFixtureBatch',
  SYMMY_FIXTURE_ROUTES.assortmentRulesFixtureBatch.path,
  symmyFixtureSubmitOptions,
);

const sellerVatDeclarationsFixtureBatchEndpoint = HttpApiEndpoint.post(
  'sellerVatDeclarationsFixtureBatch',
  SYMMY_FIXTURE_ROUTES.sellerVatDeclarationsFixtureBatch.path,
  symmyFixtureSubmitOptions,
);

type SymmyIngressEndpoints = HttpApiEndpoint.AddMiddleware<
  HttpApiEndpoint.AddMiddleware<
    | typeof adminCustomersEndpoint
    | typeof adminProductsEndpoint
    | typeof adminRegionsEndpoint
    | typeof assortmentRulesFixtureBatchEndpoint
    | typeof customerGroupCustomersBatchEndpoint
    | typeof customerGroupsBatchEndpoint
    | typeof customersBatchEndpoint
    | typeof inventoryStockBatchEndpoint
    | typeof jobEndpoint
    | typeof priceListPricesBatchEndpoint
    | typeof priceListsEndpoint
    | typeof priceListsBatchUpsertEndpoint
    | typeof productsBatchEndpoint
    | typeof sellerVatDeclarationsFixtureBatchEndpoint,
    SymmySchemaError
  >,
  SymmyDefectBoundary
>;

export interface SymmyIngressGroupContract extends HttpApiGroup.HttpApiGroup<'symmy', SymmyIngressEndpoints> {
  readonly identifier: 'symmy';
}

/** The public Symmy routes and the operator fixture routes kept apart from them. */
export const SymmyIngressGroup: SymmyIngressGroupContract = HttpApiGroup.make('symmy')
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: 'error' })
  .annotate(HttpApi.QueryParseOptions, { onExcessProperty: 'error' })
  // Shell's OpenAPI describes endpoints callable through the normal Shell mount.
  .annotate(OpenApi.Exclude, true)
  .add(
    adminCustomersEndpoint,
    adminProductsEndpoint,
    adminRegionsEndpoint,
    assortmentRulesFixtureBatchEndpoint,
    customerGroupCustomersBatchEndpoint,
    customerGroupsBatchEndpoint,
    customersBatchEndpoint,
    inventoryStockBatchEndpoint,
    jobEndpoint,
    priceListPricesBatchEndpoint,
    priceListsEndpoint,
    priceListsBatchUpsertEndpoint,
    productsBatchEndpoint,
    sellerVatDeclarationsFixtureBatchEndpoint,
  )
  .middleware(SymmySchemaError)
  .middleware(SymmyDefectBoundary);

// The BFF entry and its handlers use this canonical server contract. Browser clients use browser-api.ts.
export const ShellAuthenticationApi = HttpApi.make('shellAuthenticationApi')
  .add(ShellBrowserApi.groups.authentication)
  .add(ShellBrowserApi.groups.identity)
  .add(ShellBrowserApi.groups.composition)
  .add(ShellBrowserApi.groups.legalEntities)
  .add(ShellBrowserApi.groups.tenants)
  .add(ShellBrowserApi.groups.resources)
  // @ontos-codesmith-core-read-server-api-groups:start

  // @ontos-core-read legal-entity-detail
  .add(ShellBrowserApi.groups.coreReadLegalEntityDetail)
  // @ontos-codesmith-core-read-server-api-groups:end
  .add(GatewayContextApiGroup)
  .add(ShellBrowserApi.groups.externalIdentity)
  .add(ShellBrowserApi.groups.accessAdminRoles)
  .add(ShellBrowserApi.groups.accessAdminPeople)
  .add(ShellBrowserApi.groups.accessAdminChanges)
  .add(ShellBrowserApi.groups.accessAdminApprovals)
  .add(ShellBrowserApi.groups.accessAdminExplain)
  .add(SymmyIngressGroup)
  // Payment gateway relay (#1157): typed PSP notification and reconciliation driver ingress.
  .add(PaymentNotificationsGroup.middleware(PaymentNotificationBoundary))
  // The reconciliation driver is not part of Shell's callable OpenAPI surface.
  .add(PaymentReconciliationGroup.annotate(OpenApi.Exclude, true).middleware(PaymentReconciliationBoundary));
