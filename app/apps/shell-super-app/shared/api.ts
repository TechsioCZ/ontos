import { GatewayContextApiGroup } from '@app/shared-contracts';
import { SYMMY_ROUTES } from '@app/shared-contracts/symmy';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import { OpenApi } from 'effect/http-api';
import {
  SymmyFixtureReadSchema,
  SymmySchemaError,
  symmyCodeParams,
  symmyJobOptions,
  symmyReadOptions,
  symmySubmitOptions,
  symmyWriteOptions,
} from '../api/symmy/contract.ts';
import { SymmyDefectBoundary } from '../api/symmy/defect-boundary.ts';
import {
  SymmyInternalCustomersProjectionSchema,
  SymmyInternalPriceListsProjectionSchema,
  SymmyInternalProductsProjectionSchema,
} from '../api/symmy/read-projection-contracts.ts';
import { SymmyInternalRegionsProjectionSchema } from '../api/symmy/regions-projection-contract.ts';
import { ShellAuthenticationApi as ShellBrowserApi } from './browser-api.ts';

const nativeSymmyPath = (path: `/${string}`): `/${string}` =>
  `/${path.slice(1).replace('{code}', ':code').replace('{id}', ':id')}`;

const adminCustomersEndpoint = HttpApiEndpoint.get('adminCustomers', SYMMY_ROUTES.adminCustomers.path, {
  ...symmyReadOptions,
  success: Schema.Union([SymmyFixtureReadSchema, SymmyInternalCustomersProjectionSchema]),
});
const adminProductsEndpoint = HttpApiEndpoint.get('adminProducts', SYMMY_ROUTES.adminProducts.path, {
  ...symmyReadOptions,
  success: Schema.Union([SymmyFixtureReadSchema, SymmyInternalProductsProjectionSchema]),
});
const adminRegionsEndpoint = HttpApiEndpoint.get('adminRegions', SYMMY_ROUTES.adminRegions.path, {
  ...symmyReadOptions,
  success: Schema.Union([SymmyFixtureReadSchema, SymmyInternalRegionsProjectionSchema]),
});
const customerGroupCustomersBatchEndpoint = HttpApiEndpoint.post(
  'customerGroupCustomersBatch',
  nativeSymmyPath(SYMMY_ROUTES.customerGroupCustomersBatch.path),
  { ...symmySubmitOptions, params: symmyCodeParams },
);
const customerGroupsBatchEndpoint = HttpApiEndpoint.post(
  'customerGroupsBatch',
  SYMMY_ROUTES.customerGroupsBatch.path,
  symmyWriteOptions,
);
const customersBatchEndpoint = HttpApiEndpoint.post(
  'customersBatch',
  SYMMY_ROUTES.customersBatch.path,
  symmySubmitOptions,
);
const inventoryStockBatchEndpoint = HttpApiEndpoint.post(
  'inventoryStockBatch',
  SYMMY_ROUTES.inventoryStockBatch.path,
  symmyWriteOptions,
);
const jobEndpoint = HttpApiEndpoint.get('job', nativeSymmyPath(SYMMY_ROUTES.job.path), symmyJobOptions);
const priceListPricesBatchEndpoint = HttpApiEndpoint.post(
  'priceListPricesBatch',
  nativeSymmyPath(SYMMY_ROUTES.priceListPricesBatch.path),
  {
    ...symmySubmitOptions,
    params: symmyCodeParams,
  },
);
const priceListsEndpoint = HttpApiEndpoint.get('priceLists', SYMMY_ROUTES.priceLists.path, {
  ...symmyReadOptions,
  success: Schema.Union([SymmyFixtureReadSchema, SymmyInternalPriceListsProjectionSchema]),
});
const priceListsBatchUpsertEndpoint = HttpApiEndpoint.post(
  'priceListsBatchUpsert',
  SYMMY_ROUTES.priceListsBatchUpsert.path,
  symmySubmitOptions,
);
const productsBatchEndpoint = HttpApiEndpoint.post(
  'productsBatch',
  SYMMY_ROUTES.productsBatch.path,
  symmySubmitOptions,
);

type SymmyIngressEndpoints = HttpApiEndpoint.AddMiddleware<
  HttpApiEndpoint.AddMiddleware<
    | typeof adminCustomersEndpoint
    | typeof adminProductsEndpoint
    | typeof adminRegionsEndpoint
    | typeof customerGroupCustomersBatchEndpoint
    | typeof customerGroupsBatchEndpoint
    | typeof customersBatchEndpoint
    | typeof inventoryStockBatchEndpoint
    | typeof jobEndpoint
    | typeof priceListPricesBatchEndpoint
    | typeof priceListsEndpoint
    | typeof priceListsBatchUpsertEndpoint
    | typeof productsBatchEndpoint,
    SymmySchemaError
  >,
  SymmyDefectBoundary
>;

export interface SymmyIngressGroupContract extends HttpApiGroup.HttpApiGroup<'symmy', SymmyIngressEndpoints> {
  readonly identifier: 'symmy';
}

/** Internal fixture inputs and outputs. The real wire DTO and governed owner response require their own acceptance. */
export const SymmyIngressGroup: SymmyIngressGroupContract = HttpApiGroup.make('symmy')
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: 'error' })
  .annotate(HttpApi.QueryParseOptions, { onExcessProperty: 'error' })
  // Shell's OpenAPI describes endpoints callable through the normal Shell mount.
  .annotate(OpenApi.Exclude, true)
  .add(
    adminCustomersEndpoint,
    adminProductsEndpoint,
    adminRegionsEndpoint,
    customerGroupCustomersBatchEndpoint,
    customerGroupsBatchEndpoint,
    customersBatchEndpoint,
    inventoryStockBatchEndpoint,
    jobEndpoint,
    priceListPricesBatchEndpoint,
    priceListsEndpoint,
    priceListsBatchUpsertEndpoint,
    productsBatchEndpoint,
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
  .add(SymmyIngressGroup);
