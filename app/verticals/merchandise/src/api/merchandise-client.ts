// Public readiness transport; business operations retain their governed generated clients.
import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { merchandiseFoundationApi, merchandiseApiContract } from '../../shared/api.ts';

const readinessClient = Effect.cached(
  makeEffectHttpApiClient(merchandiseFoundationApi, { baseUrl: merchandiseApiContract.apiPrefix }),
);
export const getMerchandiseReadiness = Effect.fn('Merchandise.readiness')(function* readiness() {
  const cached = yield* readinessClient;
  const client = yield* cached;
  return yield* client.foundation.readiness({});
});

// <generated-action-http-client-exports>
export { executeApplyCommand, executeApplyCommandWithAuthorization } from './apply-command-action-client.ts';
export type { ApplyCommandActionClientOptions } from './apply-command-action-client.ts';
export {
  executeRequestSearchRebuild,
  executeRequestSearchRebuildWithAuthorization,
} from './request-search-rebuild-action-client.ts';
export type { RequestSearchRebuildActionClientOptions } from './request-search-rebuild-action-client.ts';
export {
  executeBootstrapPlaygroundCatalog,
  executeBootstrapPlaygroundCatalogWithAuthorization,
} from './bootstrap-playground-catalog-action-client.ts';
export type { BootstrapPlaygroundCatalogActionClientOptions } from './bootstrap-playground-catalog-action-client.ts';
export { executeManageCatalog, executeManageCatalogWithAuthorization } from './manage-catalog-action-client.ts';
export type { ManageCatalogActionClientOptions } from './manage-catalog-action-client.ts';
export { executeManageMarkets, executeManageMarketsWithAuthorization } from './manage-markets-action-client.ts';
export type { ManageMarketsActionClientOptions } from './manage-markets-action-client.ts';
export { executeCleanupDemo, executeCleanupDemoWithAuthorization } from './cleanup-demo-action-client.ts';
export type { CleanupDemoActionClientOptions } from './cleanup-demo-action-client.ts';
export {
  executeChangeProductImages,
  executeChangeProductImagesWithAuthorization,
} from './change-product-images-action-client.ts';
export type { ChangeProductImagesActionClientOptions } from './change-product-images-action-client.ts';
export {
  executeRecordStockMovement,
  executeRecordStockMovementWithAuthorization,
} from './record-stock-movement-action-client.ts';
export type { RecordStockMovementActionClientOptions } from './record-stock-movement-action-client.ts';
export {
  executeChangeOrderStatus,
  executeChangeOrderStatusWithAuthorization,
} from './change-order-status-action-client.ts';
export type { ChangeOrderStatusActionClientOptions } from './change-order-status-action-client.ts';
export {
  executePlaceStorefrontOrder,
  executePlaceStorefrontOrderWithAuthorization,
} from './place-storefront-order-action-client.ts';
export type { PlaceStorefrontOrderActionClientOptions } from './place-storefront-order-action-client.ts';
export {
  executeProposeOrderChanges,
  executeProposeOrderChangesWithAuthorization,
} from './propose-order-changes-action-client.ts';
export type { ProposeOrderChangesActionClientOptions } from './propose-order-changes-action-client.ts';
export {
  executeReviewOrderChanges,
  executeReviewOrderChangesWithAuthorization,
} from './review-order-changes-action-client.ts';
export type { ReviewOrderChangesActionClientOptions } from './review-order-changes-action-client.ts';
// </generated-action-http-client-exports>

// <generated-module-api-client-exports>
export { executeRecords, executeRecordsWithAuthorization } from './records-client.ts';
export type { RecordsClientOptions } from './records-client.ts';
// </generated-module-api-client-exports>
