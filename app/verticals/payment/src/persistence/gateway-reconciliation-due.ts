import { ActionAuthorizationPreflightDatabase } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { Context, Effect, Layer, Option, Schema } from 'effect';

import { ProviderBindingRouteKeySchema } from '../../shared/apis/provider-binding-route.ts';
import {
  PaymentIdSchema,
  PaymentLegalEntityIdSchema,
  PaymentOperationIdSchema,
  PaymentTenantIdSchema,
} from '../../shared/domain/payment-identifiers.ts';
import { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';

/**
 * The two cross-Tenant Payment routines of the reconciliation driver (#1158, phase 2 D-P5), each in a
 * runtime transaction that installs no operational scope. `set_config(..., true)` is transaction-local,
 * so such a transaction has no verified Tenant or Legal Entity at all, which is exactly what both
 * SECURITY DEFINER routines demand (they raise 42501 inside any scope). Neither routine takes a time:
 * each uses its own transaction's `now()` (#1234).
 */

/** One reconciliation debt row the driver may ask A10 about; `round` is the operation's recovery count. */
export const GatewayReconciliationDueRowSchema = Schema.Struct({
  legalEntityId: PaymentLegalEntityIdSchema,
  operationId: PaymentOperationIdSchema,
  paymentId: PaymentIdSchema,
  providerFamily: PaymentGatewayProviderFamilySchema,
  recommendedTrigger: Schema.Literals(['EXECUTION_OUTCOME_UNKNOWN', 'OUTCOME_OVERDUE']),
  round: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  routeKey: ProviderBindingRouteKeySchema,
  tenantId: PaymentTenantIdSchema,
});
export type GatewayReconciliationDueRow = typeof GatewayReconciliationDueRowSchema.Type;

/** Keyset position: the last row of the previous page. */
export type GatewayReconciliationDueCursor = Pick<
  GatewayReconciliationDueRow,
  'legalEntityId' | 'operationId' | 'tenantId'
>;

export interface ListDueGatewayReconciliationInput {
  readonly after: Option.Option<GatewayReconciliationDueCursor>;
  readonly maxRounds: number;
  readonly pageLimit: number;
}

const dueUnavailableFields = { reason: Schema.String };
const DueUnavailableSchema = Schema.TaggedStruct('GatewayReconciliationDueUnavailable', dueUnavailableFields);
/** The routine, its transaction or its answer failed; the tick retries in the next interval. */
export const GatewayReconciliationDueUnavailable = Schema.TaggedError<
  Schema.Schema.Type<typeof DueUnavailableSchema>
>()('GatewayReconciliationDueUnavailable', dueUnavailableFields);
export type GatewayReconciliationDueUnavailableError = Schema.Schema.Type<typeof GatewayReconciliationDueUnavailable>;

export interface GatewayReconciliationDueSourceContract {
  /** One page ordered by (Tenant, Legal Entity, operation); a page shorter than `pageLimit` is the last one. */
  readonly listDue: (
    input: ListDueGatewayReconciliationInput,
  ) => Effect.Effect<readonly GatewayReconciliationDueRow[], GatewayReconciliationDueUnavailableError>;
  /** Deletes transient payer contacts older than `maxAgeHours` (at least 1) and answers how many. */
  readonly purgeExpiredPayerContacts: (
    maxAgeHours: number,
  ) => Effect.Effect<number, GatewayReconciliationDueUnavailableError>;
}

export class GatewayReconciliationDueSource extends Context.Service<
  GatewayReconciliationDueSource,
  GatewayReconciliationDueSourceContract
>()('@app/payment/persistence/gateway-reconciliation-due/GatewayReconciliationDueSource') {}

const DueRoutineRowSchema = Schema.Struct({
  legal_entity_id: GatewayReconciliationDueRowSchema.fields.legalEntityId,
  operation_id: GatewayReconciliationDueRowSchema.fields.operationId,
  payment_id: GatewayReconciliationDueRowSchema.fields.paymentId,
  provider_family: GatewayReconciliationDueRowSchema.fields.providerFamily,
  recommended_trigger: GatewayReconciliationDueRowSchema.fields.recommendedTrigger,
  round: GatewayReconciliationDueRowSchema.fields.round,
  route_key: GatewayReconciliationDueRowSchema.fields.routeKey,
  tenant_id: GatewayReconciliationDueRowSchema.fields.tenantId,
});
const decodeDueRows = Schema.decodeUnknownEffect(Schema.Array(DueRoutineRowSchema));
const PurgeRoutineRowsSchema = Schema.Tuple([
  Schema.Struct({ deleted: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)) }),
]);
const decodePurgeRows = Schema.decodeUnknownEffect(PurgeRoutineRowsSchema);

/** The reason names the step; the cause stays attached for tracing and is never logged as a value. */
const unavailable = (reason: string) => (cause: unknown) =>
  Object.defineProperty(new GatewayReconciliationDueUnavailable({ reason }), 'cause', {
    configurable: false,
    enumerable: false,
    value: cause,
  });

const listDueStatement = ({ after, maxRounds, pageLimit }: ListDueGatewayReconciliationInput): SQL => {
  const cursor = Option.getOrUndefined(after);
  // The three cursor parts travel together or not at all; the routine refuses a partial cursor.
  return sql`select tenant_id, legal_entity_id, operation_id, payment_id, provider_family, route_key, recommended_trigger, round from payment.list_due_gateway_reconciliation(${cursor?.tenantId ?? null}::uuid, ${cursor?.legalEntityId ?? null}::uuid, ${cursor?.operationId ?? null}::uuid, ${pageLimit}::integer, ${maxRounds}::integer)`;
};

const purgeStatement = (maxAgeHours: number): SQL =>
  sql`select payment.purge_expired_payer_contacts(make_interval(hours => ${maxAgeHours}::integer)) as deleted`;

/** Runtime-role transactions with no operational scope, on Core's governed connection of this process. */
export const GatewayReconciliationDueSourceLive = Layer.effect(
  GatewayReconciliationDueSource,
  Effect.gen(function* makeGatewayReconciliationDueSource() {
    const database = yield* ActionAuthorizationPreflightDatabase;
    const unscoped = (statement: SQL) =>
      database
        .transaction((transaction) => transaction.execute(statement, 'objects'))
        .pipe(Effect.mapError(unavailable('The unscoped Payment reconciliation transaction failed')));
    return GatewayReconciliationDueSource.of({
      listDue: (input) =>
        unscoped(listDueStatement(input)).pipe(
          Effect.flatMap((rows) =>
            decodeDueRows(rows).pipe(
              Effect.mapError(unavailable('The reconciliation due listing returned an invalid row')),
            ),
          ),
          Effect.map((rows) =>
            rows.map((row): GatewayReconciliationDueRow => ({
              legalEntityId: row.legal_entity_id,
              operationId: row.operation_id,
              paymentId: row.payment_id,
              providerFamily: row.provider_family,
              recommendedTrigger: row.recommended_trigger,
              round: row.round,
              routeKey: row.route_key,
              tenantId: row.tenant_id,
            })),
          ),
        ),
      purgeExpiredPayerContacts: (maxAgeHours) =>
        unscoped(purgeStatement(maxAgeHours)).pipe(
          Effect.flatMap((rows) =>
            decodePurgeRows(rows).pipe(
              Effect.mapError(unavailable('The payer contact purge returned an invalid answer')),
            ),
          ),
          Effect.map(([row]) => row.deleted),
        ),
    });
  }),
);
