import { OwnerActionApprovalApi } from '@app/core-runtime/access/approvals/owner-api';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalReadiness, MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { identity } from 'effect';

// <generated-governed-http-api-imports>
import { AgentReviewApi } from './apis/agent-review.ts';
import { ApplyCommandActionApi } from './apis/apply-command-action.ts';
import { BootstrapPlaygroundCatalogActionApi } from './apis/bootstrap-playground-catalog-action.ts';
import { ChangeOrderStatusActionApi } from './apis/change-order-status-action.ts';
import { ChangeProductImagesActionApi } from './apis/change-product-images-action.ts';
import { CleanupDemoActionApi } from './apis/cleanup-demo-action.ts';
import { ManageCatalogActionApi } from './apis/manage-catalog-action.ts';
import { ManageMarketsActionApi } from './apis/manage-markets-action.ts';
import { MediaApi } from './apis/media.ts';
import { OrdersSearchApi } from './apis/orders-search.ts';
import { PlaceStorefrontOrderActionApi } from './apis/place-storefront-order-action.ts';
import { ProductsSearchApi } from './apis/products-search.ts';
import { ProposeOrderChangesActionApi } from './apis/propose-order-changes-action.ts';
import { RecordsApi } from './apis/records.ts';
import { RecordStockMovementActionApi } from './apis/record-stock-movement-action.ts';
import { RequestSearchRebuildActionApi } from './apis/request-search-rebuild-action.ts';
import { ReviewOrderChangesActionApi } from './apis/review-order-changes-action.ts';
// </generated-governed-http-api-imports>

export type MerchandiseReadiness = MicroVerticalReadiness;
export const merchandiseMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
});
export const merchandiseReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: merchandiseMarkerSchema,
});

export type OperationContext = MicroVerticalOperationContext;

export const merchandiseFoundationApi = HttpApi.make('MerchandiseApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/merchandise/readiness', { success: merchandiseReadinessSchema }),
  ),
);

export const merchandiseApi = HttpApi.make('MerchandiseApi')
  .addHttpApi(merchandiseFoundationApi)
  .addHttpApi(OwnerActionApprovalApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(AgentReviewApi)
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(BootstrapPlaygroundCatalogActionApi)
  .addHttpApi(ChangeOrderStatusActionApi)
  .addHttpApi(ChangeProductImagesActionApi)
  .addHttpApi(CleanupDemoActionApi)
  .addHttpApi(ManageCatalogActionApi)
  .addHttpApi(ManageMarketsActionApi)
  .addHttpApi(MediaApi)
  .addHttpApi(OrdersSearchApi)
  .addHttpApi(PlaceStorefrontOrderActionApi)
  .addHttpApi(ProductsSearchApi)
  .addHttpApi(ProposeOrderChangesActionApi)
  .addHttpApi(RecordsApi)
  .addHttpApi(RecordStockMovementActionApi)
  .addHttpApi(RequestSearchRebuildActionApi)
  .addHttpApi(ReviewOrderChangesActionApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const merchandiseOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'MerchandiseApi:foundation:readiness',
    routePath: '/merchandise/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const merchandiseApiContract = {
  apiPrefix: '/merchandise-api',
  basePath: '/merchandise-api/merchandise',
  ownerId: 'merchandise',
  readinessPath: '/merchandise-api/merchandise/readiness',
} as const;
