import { identity } from 'effect';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
// oxlint-disable-next-line typescript/consistent-type-imports -- The framework baseline requires Schema in the exact value import.
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';

// <generated-governed-http-api-imports>
import { CatalogToStockBindingResolutionApi } from './apis/catalog-to-stock-binding-resolution.ts';
import { ChangeStockSharingEligibilityActionApi } from './apis/change-stock-sharing-eligibility-action.ts';
import { CommitmentProtectionVerificationApi } from './apis/commitment-protection-verification.ts';
import { CompensateInventoryPreCommitActionApi } from './apis/compensate-inventory-pre-commit-action.ts';
import { CorrectCatalogToStockBindingActionApi } from './apis/correct-catalog-to-stock-binding-action.ts';
import { CorrectExternalStockCorrelationActionApi } from './apis/correct-external-stock-correlation-action.ts';
import { CorrectStockPositionActionApi } from './apis/correct-stock-position-action.ts';
import { CreateInventoryReservationActionApi } from './apis/create-inventory-reservation-action.ts';
import { CurrentStockEvidenceForAvailabilityApi } from './apis/current-stock-evidence-for-availability.ts';
import { EndCatalogToStockBindingActionApi } from './apis/end-catalog-to-stock-binding-action.ts';
import { EndExternalStockCorrelationActionApi } from './apis/end-external-stock-correlation-action.ts';
import { EndStockSharingEligibilityActionApi } from './apis/end-stock-sharing-eligibility-action.ts';
import { EstablishCatalogToStockBindingActionApi } from './apis/establish-catalog-to-stock-binding-action.ts';
import { EstablishCommitmentProtectionActionApi } from './apis/establish-commitment-protection-action.ts';
import { EstablishExternalStockCorrelationActionApi } from './apis/establish-external-stock-correlation-action.ts';
import { EstablishStockSharingEligibilityActionApi } from './apis/establish-stock-sharing-eligibility-action.ts';
import { ImportSourceAssertionActionApi } from './apis/import-source-assertion-action.ts';
import { InventoryBackendConfigurationCurrentApi } from './apis/inventory-backend-configuration-current.ts';
import { InventoryEffectOutcomeApi } from './apis/inventory-effect-outcome.ts';
import { InventoryReconciliationEvidenceApi } from './apis/inventory-reconciliation-evidence.ts';
import { InventoryReservationDetailApi } from './apis/inventory-reservation-detail.ts';
import { InventorySourceConflictDetailApi } from './apis/inventory-source-conflict-detail.ts';
import { RecoverInventoryEffectActionApi } from './apis/recover-inventory-effect-action.ts';
import { ReleaseInventoryReservationActionApi } from './apis/release-inventory-reservation-action.ts';
import { ReservationConfirmationVerificationApi } from './apis/reservation-confirmation-verification.ts';
import { ResolveInventorySourceConflictActionApi } from './apis/resolve-inventory-source-conflict-action.ts';
import { SelectInventoryBackendActionApi } from './apis/select-inventory-backend-action.ts';
import { StockIssueActionApi } from './apis/stock-issue-action.ts';
import { StockReceiptActionApi } from './apis/stock-receipt-action.ts';
import { StockSharingEligibilityResolutionApi } from './apis/stock-sharing-eligibility-resolution.ts';
// </generated-governed-http-api-imports>

export const inventoryMarkerSchema: Schema.Codec<typeof MicroVerticalBuildMarkerSchema.Type> =
  MicroVerticalBuildMarkerSchema;
export type InventoryMarker = typeof inventoryMarkerSchema.Type;

export const inventoryReadinessSchema: Schema.Codec<typeof MicroVerticalReadinessSchema.Type> =
  MicroVerticalReadinessSchema;
export type InventoryReadiness = typeof inventoryReadinessSchema.Type;

export type OperationContext = MicroVerticalOperationContext;

export const inventoryFoundationApi = HttpApi.make('InventoryApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/inventory/readiness', { success: inventoryReadinessSchema }),
  ),
);
type GroupsOf<Api> = Api extends HttpApi.HttpApi<string, infer Groups> ? Groups : never;

type InventoryApiGroups = GroupsOf<
  | typeof inventoryFoundationApi
  | typeof CatalogToStockBindingResolutionApi
  | typeof ChangeStockSharingEligibilityActionApi
  | typeof CommitmentProtectionVerificationApi
  | typeof CompensateInventoryPreCommitActionApi
  | typeof CorrectCatalogToStockBindingActionApi
  | typeof CorrectExternalStockCorrelationActionApi
  | typeof CorrectStockPositionActionApi
  | typeof CreateInventoryReservationActionApi
  | typeof CurrentStockEvidenceForAvailabilityApi
  | typeof EndCatalogToStockBindingActionApi
  | typeof EndExternalStockCorrelationActionApi
  | typeof EndStockSharingEligibilityActionApi
  | typeof EstablishCatalogToStockBindingActionApi
  | typeof EstablishCommitmentProtectionActionApi
  | typeof EstablishExternalStockCorrelationActionApi
  | typeof EstablishStockSharingEligibilityActionApi
  | typeof ImportSourceAssertionActionApi
  | typeof InventoryBackendConfigurationCurrentApi
  | typeof InventoryEffectOutcomeApi
  | typeof InventoryReconciliationEvidenceApi
  | typeof InventoryReservationDetailApi
  | typeof InventorySourceConflictDetailApi
  | typeof RecoverInventoryEffectActionApi
  | typeof ReleaseInventoryReservationActionApi
  | typeof ReservationConfirmationVerificationApi
  | typeof ResolveInventorySourceConflictActionApi
  | typeof SelectInventoryBackendActionApi
  | typeof StockIssueActionApi
  | typeof StockReceiptActionApi
  | typeof StockSharingEligibilityResolutionApi
>;

type InventoryApi = HttpApi.HttpApi<'InventoryApi', InventoryApiGroups>;

export const inventoryApi: InventoryApi = HttpApi.make('InventoryApi')
  .addHttpApi(inventoryFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(CatalogToStockBindingResolutionApi)
  .addHttpApi(ChangeStockSharingEligibilityActionApi)
  .addHttpApi(CommitmentProtectionVerificationApi)
  .addHttpApi(CompensateInventoryPreCommitActionApi)
  .addHttpApi(CorrectCatalogToStockBindingActionApi)
  .addHttpApi(CorrectExternalStockCorrelationActionApi)
  .addHttpApi(CorrectStockPositionActionApi)
  .addHttpApi(CreateInventoryReservationActionApi)
  .addHttpApi(CurrentStockEvidenceForAvailabilityApi)
  .addHttpApi(EndCatalogToStockBindingActionApi)
  .addHttpApi(EndExternalStockCorrelationActionApi)
  .addHttpApi(EndStockSharingEligibilityActionApi)
  .addHttpApi(EstablishCatalogToStockBindingActionApi)
  .addHttpApi(EstablishCommitmentProtectionActionApi)
  .addHttpApi(EstablishExternalStockCorrelationActionApi)
  .addHttpApi(EstablishStockSharingEligibilityActionApi)
  .addHttpApi(ImportSourceAssertionActionApi)
  .addHttpApi(InventoryBackendConfigurationCurrentApi)
  .addHttpApi(InventoryEffectOutcomeApi)
  .addHttpApi(InventoryReconciliationEvidenceApi)
  .addHttpApi(InventoryReservationDetailApi)
  .addHttpApi(InventorySourceConflictDetailApi)
  .addHttpApi(RecoverInventoryEffectActionApi)
  .addHttpApi(ReleaseInventoryReservationActionApi)
  .addHttpApi(ReservationConfirmationVerificationApi)
  .addHttpApi(ResolveInventorySourceConflictActionApi)
  .addHttpApi(SelectInventoryBackendActionApi)
  .addHttpApi(StockIssueActionApi)
  .addHttpApi(StockReceiptActionApi)
  .addHttpApi(StockSharingEligibilityResolutionApi)
  // </generated-governed-http-api-additions>
  .pipe(identity);

export const inventoryOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'InventoryApi:inventory:readiness',
    routePath: '/inventory/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const inventoryApiContract = {
  apiPrefix: '/inventory-api',
  basePath: '/inventory-api/inventory',
  ownerId: 'inventory',
  readinessPath: '/inventory-api/inventory/readiness',
} as const;
