import { identity } from 'effect';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';

// <generated-governed-http-api-imports>
import { CancelOrderCommitmentActionApi } from './apis/cancel-order-commitment-action.ts';
import { CommitOrderActionApi } from './apis/commit-order-action.ts';
import { CommittedOrderApprovalEvidenceApi } from './apis/committed-order-approval-evidence.ts';
import { CompleteOrderApprovalConsumptionActionApi } from './apis/complete-order-approval-consumption-action.ts';
import { CompleteOrderPreparationActionApi } from './apis/complete-order-preparation-action.ts';
import { OrderCommitmentStateApi } from './apis/order-commitment-state.ts';
import { OrderFinalizationWorkApi } from './apis/order-finalization-work.ts';
import { PreparedOrderApprovalBindingApi } from './apis/prepared-order-approval-binding.ts';
import { PreparedOrderPricingBindingApi } from './apis/prepared-order-pricing-binding.ts';
import { PrepareOrderCommitmentActionApi } from './apis/prepare-order-commitment-action.ts';
import { ReconcileOrderApprovalActionApi } from './apis/reconcile-order-approval-action.ts';
import { RecordOrderProofSetActionApi } from './apis/record-order-proof-set-action.ts';
import { RecordPrecommitFailureActionApi } from './apis/record-precommit-failure-action.ts';
import { RevalidateOrderCommitmentActionApi } from './apis/revalidate-order-commitment-action.ts';
import { VerifyOrderCommitmentBindingApi } from './apis/verify-order-commitment-binding.ts';
// </generated-governed-http-api-imports>

export const commerceOrderMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
});
export type CommerceOrderMarker = typeof commerceOrderMarkerSchema.Type;

export const commerceOrderReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: commerceOrderMarkerSchema,
});
export type CommerceOrderReadiness = typeof commerceOrderReadinessSchema.Type;

export type OperationContext = MicroVerticalOperationContext;

export const commerceOrderFoundationApi = HttpApi.make('CommerceOrderApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/commerce-order/readiness', { success: commerceOrderReadinessSchema }),
  ),
);

export const commerceOrderApi = HttpApi.make('CommerceOrderApi')
  .addHttpApi(commerceOrderFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(CancelOrderCommitmentActionApi)
  .addHttpApi(CommitOrderActionApi)
  .addHttpApi(CommittedOrderApprovalEvidenceApi)
  .addHttpApi(CompleteOrderApprovalConsumptionActionApi)
  .addHttpApi(CompleteOrderPreparationActionApi)
  .addHttpApi(OrderCommitmentStateApi)
  .addHttpApi(OrderFinalizationWorkApi)
  .addHttpApi(PreparedOrderApprovalBindingApi)
  .addHttpApi(PreparedOrderPricingBindingApi)
  .addHttpApi(PrepareOrderCommitmentActionApi)
  .addHttpApi(ReconcileOrderApprovalActionApi)
  .addHttpApi(RecordOrderProofSetActionApi)
  .addHttpApi(RecordPrecommitFailureActionApi)
  .addHttpApi(RevalidateOrderCommitmentActionApi)
  .addHttpApi(VerifyOrderCommitmentBindingApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const commerceOrderOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'CommerceOrderApi:commerceOrder:readiness',
    routePath: '/commerce-order/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const commerceOrderApiContract = {
  apiPrefix: '/commerce-order-api',
  basePath: '/commerce-order-api/commerce-order',
  ownerId: 'commerce-order',
  readinessPath: '/commerce-order-api/commerce-order/readiness',
} as const;
