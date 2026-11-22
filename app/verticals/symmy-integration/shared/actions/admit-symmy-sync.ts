import { Schema } from 'effect';
import { SyncAdmissionIdSchema } from '../resources/sync-admission.ts';
import { TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { AdmitSymmyJobPayloadSchema } from '../domain/symmy-job-admission.ts';
import {
  SymmyCustomerGroupDefinitionFactsSchema,
  SymmyCustomerGroupRowsSchema,
} from '../domain/symmy-customer-group-batch.ts';
import { SymmyPinnedJobPlanSchema } from '../domain/symmy-job-execution.ts';
import { SymmyStockPositionFactsSchema, SymmyStockRowsSchema } from '../domain/symmy-stock-batch.ts';

export const AdmitSymmySyncPayloadSchema = Schema.Struct({
  /** The public customer groups. The route enrollment, not the caller, supplies every source fact. */
  customerGroups: Schema.optionalKey(SymmyCustomerGroupRowsSchema),
  /**
   * What the owner held for each group code, read for the route. It is a fence for a new admission, never caller
   * intent, so the replay of a saved admission carries none.
   */
  groupFacts: Schema.optionalKey(SymmyCustomerGroupDefinitionFactsSchema),
  idempotencyKey: AdmitSymmyJobPayloadSchema.fields.idempotencyKey,
  routeKey: Schema.Literals(['customerGroupsBatch', 'inventoryStockBatch']),
  /** The public stock rows. The route enrollment, not the caller, supplies every other stock fact. */
  stock: Schema.optionalKey(SymmyStockRowsSchema),
  /** Current public Inventory resolution answers. Omitted on replay, like groupFacts. */
  stockFacts: Schema.optionalKey(SymmyStockPositionFactsSchema),
}).check(
  Schema.makeFilter(
    ({ customerGroups, groupFacts, routeKey, stock, stockFacts }) =>
      (routeKey === 'inventoryStockBatch'
        ? stock !== undefined && customerGroups === undefined && groupFacts === undefined
        : stock === undefined && stockFacts === undefined && customerGroups !== undefined) ||
      'Send stock rows only to the stock route, and customer groups with any definition facts only to the group route',
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
