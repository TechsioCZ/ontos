import { ReadHandlerNotFound, ReadHandlerUnavailable, ReadPolicyDenied } from '@app/core-runtime';
import type { ReadServiceFactory } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import type {
  OrderCommitmentRejected,
  OrderCommitmentState,
  OrderFinalBinding,
  VerifyOrderBindingInput,
} from '../../shared/domain/order-commitment.ts';
import type { VerifiedOrderBinding } from '@app/commerce-order-contracts/verify-order-commitment-binding';
import { verifyOrderAttemptSources } from '../services/order-final-source-verification.service.ts';
import { OrderPreparationIntentDataSchema } from '../../shared/domain/order-commitment.ts';
import { OrderCommitmentStateRequestSchema } from '../../shared/apis/order-commitment-state.ts';
import type { OrderCommitmentStateRequest } from '../../shared/apis/order-commitment-state.ts';
import { makeOrderCommitmentPersistence } from '../services/order-commitment-persistence.ts';
import type {
  OrderPreparationProgressRecord,
  OrderProofProgressRecord,
} from '../services/order-commitment-persistence.ts';

const isPreparationRequest = Schema.is(OrderCommitmentStateRequestSchema.members[1]);
const retainedPreparationUnavailable = (cause: unknown) => {
  const failure = new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'Retained preparation is unavailable',
  });
  return Object.defineProperty(failure, 'cause', { value: cause });
};

export const readFailure = (failure: OrderCommitmentRejected): OrderCommitmentReadFailure => {
  if (failure.code === 'order_commitment_not_found' || failure.code === 'order_commitment_permission_denied') {
    return new ReadHandlerNotFound({ code: 'read_handler_not_found', reason: 'Order commitment was not found' });
  }
  if (failure.code === 'order_commitment_conflict' || failure.code === 'order_commitment_ineligible') {
    return new ReadPolicyDenied({
      code: 'read_policy_denied',
      httpStatus: 409,
      policyReasonCode: 'order_commitment_not_current',
      reason: 'The exact Order commitment is not eligible for this operation',
    });
  }
  return new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'Order commitment evidence is unavailable',
  });
};
type OrderCommitmentReadFailure = ReadHandlerNotFound | ReadPolicyDenied | ReadHandlerUnavailable;
/** Read-only Order commitment operations exposed to governed module API reads. */
export interface OrderCommitmentReadServices {
  readonly load: (binding: OrderFinalBinding) => Effect.Effect<OrderCommitmentState, OrderCommitmentReadFailure>;
  readonly loadState: (
    input: OrderCommitmentStateRequest,
  ) => Effect.Effect<
    | OrderCommitmentState
    | OrderPreparationProgressRecord
    | (OrderCommitmentState & { readonly recoveredRevalidation: OrderProofProgressRecord }),
    OrderCommitmentReadFailure
  >;
  readonly verifyBinding: (
    input: VerifyOrderBindingInput,
  ) => Effect.Effect<VerifiedOrderBinding, OrderCommitmentReadFailure>;
}
/** The Read runtime's scoped transaction builds this request's owner persistence. */
export const orderCommitmentReadServices: ReadServiceFactory<OrderCommitmentReadServices> = (transaction, scope) => {
  const persistence = makeOrderCommitmentPersistence(transaction, { operationId: scope.correlationId, scope });
  return Effect.succeed({
    load: (binding: OrderFinalBinding) => persistence.load(binding).pipe(Effect.mapError(readFailure)),
    loadState: Effect.fn('OrderCommitmentReadServices.loadState')(function* loadOrderState(
      input: OrderCommitmentStateRequest,
    ) {
      if (isPreparationRequest(input)) {
        const row = yield* persistence
          .originalIntent('PREPARE', input.preparation.commitmentCorrelationId)
          .pipe(Effect.mapError(readFailure));
        if (Option.isNone(row)) {
          return yield* new ReadHandlerNotFound({
            code: 'read_handler_not_found',
            reason: 'The original preparation intent was not found',
          });
        }
        const data = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(OrderPreparationIntentDataSchema))(
          row.value.data,
        ).pipe(Effect.mapError(retainedPreparationUnavailable));
        if (!Schema.toEquivalence(OrderPreparationIntentDataSchema.fields.input)(input.preparation, data.input)) {
          return yield* new ReadPolicyDenied({
            code: 'read_policy_denied',
            httpStatus: 409,
            policyReasonCode: 'preparation_intent_conflict',
            reason: 'The original preparation intent differs',
          });
        }
        return yield* persistence.preparationProgress(row.value).pipe(Effect.mapError(readFailure));
      }
      const state = yield* persistence.load(input.binding).pipe(Effect.mapError(readFailure));
      if (input.revalidationIntent === undefined) {
        return state;
      }
      const row = yield* persistence
        .originalIntent('PROOF', input.revalidationIntent.idempotencyKey)
        .pipe(Effect.mapError(readFailure));
      if (Option.isNone(row) || row.value.attemptId !== input.binding.attemptRef.resourceId) {
        return yield* new ReadHandlerNotFound({
          code: 'read_handler_not_found',
          reason: 'The original proof request was not found',
        });
      }
      return {
        ...state,
        recoveredRevalidation: yield* persistence.proofProgress(row.value).pipe(Effect.mapError(readFailure)),
      };
    }),
    verifyBinding: Effect.fn('OrderCommitmentReadServices.verifyBinding')(function* verifyOrderBinding(
      input: VerifyOrderBindingInput,
    ) {
      if (input.mode === 'REVALIDATION') {
        const state = yield* persistence.load(input.binding);
        yield* verifyOrderAttemptSources({
          scope: {
            buyerPrincipalId: state.bundle.buyerPrincipalId,
            correlationId: state.attempt.commitmentCorrelationId,
            legalEntityId: state.bundle.legalEntityId,
            tenantId: scope.tenantId,
          },
          state,
        });
      }
      return yield* persistence.verifyBinding(input);
    }, Effect.mapError(readFailure)),
  });
};
