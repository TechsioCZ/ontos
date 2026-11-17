import { Schema } from 'effect';
import { SyncAdmissionIdSchema } from '../resources/sync-admission.ts';
import { TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { AdmitSymmyJobPayloadSchema } from '../domain/symmy-job-admission.ts';
import { SymmyPinnedJobPlanSchema } from '../domain/symmy-job-execution.ts';
import { SymmyStockRowsSchema } from '../domain/symmy-stock-batch.ts';

export const AdmitSymmySyncPayloadSchema = Schema.Struct({
  contractVersion: AdmitSymmyJobPayloadSchema.fields.contractVersion,
  fixtureId: AdmitSymmyJobPayloadSchema.fields.fixtureId,
  idempotencyKey: AdmitSymmyJobPayloadSchema.fields.idempotencyKey,
  plan: AdmitSymmyJobPayloadSchema.fields.plan,
  routeKey: Schema.Literals(['customerGroupsBatch', 'inventoryStockBatch']),
  /** The public stock rows. The route enrollment, not the caller, supplies every other stock fact. */
  stock: Schema.optionalKey(SymmyStockRowsSchema),
}).check(
  Schema.makeFilter(
    ({ contractVersion, fixtureId, plan, routeKey, stock }) =>
      (routeKey === 'inventoryStockBatch'
        ? stock !== undefined && fixtureId === undefined && contractVersion === undefined && plan === undefined
        : stock === undefined &&
          ((fixtureId !== undefined && contractVersion === undefined && plan === undefined) ||
            (fixtureId === undefined && contractVersion === 'INTERNAL_C14' && plan !== undefined))) ||
      'Choose exactly one versioned internal plan or registered fixture, and send stock rows only to the stock route',
  ),
);
export type AdmitSymmySyncPayload = typeof AdmitSymmySyncPayloadSchema.Type;
export const AdmitSymmySyncResultSchema = Schema.Struct({
  admissionId: SyncAdmissionIdSchema,
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  plan: SymmyPinnedJobPlanSchema,
  replayed: Schema.Boolean,
  tenantId: TenantIdSchema,
});
export type AdmitSymmySyncResult = typeof AdmitSymmySyncResultSchema.Type;
export class AdmitSymmySyncRejected extends Schema.TaggedError<AdmitSymmySyncRejected>()('AdmitSymmySyncRejected', {
  code: Schema.Literals([
    'symmy_sync_route_denied',
    'symmy_sync_intent_conflict',
    'symmy_sync_stock_assertion_denied',
    'symmy_sync_unavailable',
  ]),
  reason: Schema.String,
}) {}
