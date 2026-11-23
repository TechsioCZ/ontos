import { LegalEntityIdSchema, TenantIdSchema } from '@app/core-runtime/access/ids';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema, Struct } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

import { OrderIdSchema, OrderSchema } from '../domain/merchandise-model.ts';

export const SYMMY_DEMO_ORDER_EXPORT_WORKLOAD = 'demo.merchandise.symmy-order-export';

export const demoOrderExportOperation = {
  audience: 'merchandise',
  declarationKey: 'demo.merchandise.demo-order-export.read',
  entrypointKey: 'demo.merchandise.api.demo-order-export',
  moduleId: 'demo.merchandise',
  schemaVersion: '1',
  workloadKey: SYMMY_DEMO_ORDER_EXPORT_WORKLOAD,
} as const;

export const DemoOrderExportRequestSchema = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  orderId: Schema.optionalKey(OrderIdSchema),
});
export type DemoOrderExportRequest = typeof DemoOrderExportRequestSchema.Type;

/** Stored commercial facts only: no audit actors, AI proposals, or command capabilities. */
export const DemoOrderExportOrderSchema = Schema.Struct(
  Struct.pick(OrderSchema.fields, [
    'billingAddress',
    'channel',
    'clientRequestId',
    'contact',
    'createdAt',
    'customerAccountId',
    'deliveryAddress',
    'deliveryRecipient',
    'demo',
    'id',
    'lines',
    'market',
    'note',
    'number',
    'partyId',
    'pricesIncludeVat',
    'shipping',
    'status',
    'totalMinor',
    'totalVatMinor',
    'updatedAt',
  ]),
);
export const DemoOrderExportResponseSchema = Schema.Struct({
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  legalEntityId: LegalEntityIdSchema,
  orders: Schema.Array(DemoOrderExportOrderSchema).check(Schema.isMaxLength(100)),
  tenantId: TenantIdSchema,
});
export type DemoOrderExportResponse = typeof DemoOrderExportResponseSchema.Type;

export const DemoOrderExportAuthenticationProblemSchema = makeProblemDetailsSchema(
  'DemoOrderExportAuthenticationProblem',
  401,
);
export const DemoOrderExportForbiddenProblemSchema = makeProblemDetailsSchema('DemoOrderExportForbiddenProblem', 403);
export const DemoOrderExportInternalProblemSchema = makeProblemDetailsSchema('DemoOrderExportInternalProblem', 500);
export const DemoOrderExportInvalidProblemSchema = makeProblemDetailsSchema('DemoOrderExportInvalidProblem', 400);
export const DemoOrderExportNotFoundProblemSchema = makeProblemDetailsSchema('DemoOrderExportNotFoundProblem', 404);
export const DemoOrderExportPolicyConflictProblemSchema = makeProblemDetailsSchema(
  'DemoOrderExportPolicyConflictProblem',
  409,
);
export const DemoOrderExportPolicyProblemSchema = makeProblemDetailsSchema('DemoOrderExportPolicyProblem', 422);
export const DemoOrderExportUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'DemoOrderExportUnavailableProblem',
  503,
);

export const DemoOrderExportApi = HttpApi.make('DemoOrderExportApi').add(
  HttpApiGroup.make('demoOrderExport').add(
    HttpApiEndpoint.post('execute', '/reads/demo-order-export', {
      error: [
        DemoOrderExportInvalidProblemSchema,
        DemoOrderExportAuthenticationProblemSchema,
        DemoOrderExportForbiddenProblemSchema,
        DemoOrderExportNotFoundProblemSchema,
        DemoOrderExportPolicyConflictProblemSchema,
        DemoOrderExportPolicyProblemSchema,
        DemoOrderExportUnavailableProblemSchema,
        DemoOrderExportInternalProblemSchema,
      ],
      payload: DemoOrderExportRequestSchema,
      success: DemoOrderExportResponseSchema,
    }),
  ),
);
