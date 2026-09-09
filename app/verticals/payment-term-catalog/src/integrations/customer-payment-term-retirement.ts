import { executeReservePaymentTermRetirementWithAuthorization } from '@app/customer-payment-term-contracts/reserve-payment-term-retirement/client';
import type {
  ReservePaymentTermRetirementPayload,
  ReservePaymentTermRetirementResult,
} from '@app/customer-payment-term-contracts/reserve-payment-term-retirement';
import { Effect, Option, Redacted, Schema } from 'effect';

import {
  PaymentTermAffectedUseAssessmentUnavailable,
  PaymentTermRetirementReservationRejected,
  PaymentTermRetirementReservationUnavailable,
} from '../../shared/domain/payment-term-errors.ts';
import { CustomerContextGatewayCredentialService } from '../../shared/domain/customer-context-gateway-credential.ts';
import type { PaymentTermRef } from '../../shared/resources/payment-term.ts';
import type { PaymentTermRetirementAuthority } from '../actions/retire-payment-term.action.ts';

type ReservationFailure =
  | PaymentTermRetirementReservationRejected
  | PaymentTermRetirementReservationUnavailable;
const unavailableCode = 'payment_term_retirement_reservation_unavailable' as const;

type ReservationClientError =
  ReturnType<typeof executeReservePaymentTermRetirementWithAuthorization> extends Effect.Effect<
    unknown,
    infer Failure,
    unknown
  >
    ? Failure
    : never;
type ReservationExecutor = (
  payload: ReservePaymentTermRetirementPayload,
  requestCorrelation: string,
  idempotencyKey: string,
) => Effect.Effect<
  ReservePaymentTermRetirementResult,
  ReservationClientError | PaymentTermAffectedUseAssessmentUnavailable
>;

const GatewayFailureSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
});

const errorText = (cause: unknown): string => {
  if (Schema.is(GatewayFailureSchema)(cause)) {
    if (cause.reason !== undefined && cause.reason.length > 0) {
      return cause.reason;
    }
    if (cause.message !== undefined && cause.message.length > 0) {
      return cause.message;
    }
  }
  return 'The Customer Context Payment Term retirement reservation gateway is unavailable';
};

const failureCode = (cause: unknown): string | undefined =>
  Schema.is(GatewayFailureSchema)(cause) ? cause.code : undefined;

const mapGatewayFailure = (cause: unknown): ReservationFailure => {
  const code = failureCode(cause);
  if (
    code === 'RETIREMENT_RESERVATION_CONFLICT' ||
    code === 'RESERVATION_STATE_CONFLICT' ||
    code === 'action_request_hash_conflict'
  ) {
    return new PaymentTermRetirementReservationRejected({
      code: 'payment_term_retirement_reservation_rejected',
      reason: errorText(cause),
    });
  }
  return new PaymentTermRetirementReservationUnavailable({
    code: 'payment_term_retirement_reservation_unavailable',
    reason: errorText(cause),
  });
};

const operationPayload = (input: {
  readonly effectiveAt: string;
  readonly equivalentPaymentTermRefs: readonly PaymentTermRef[];
  readonly operation: ReservePaymentTermRetirementPayload['operation'];
  readonly paymentTermRef: PaymentTermRef;
  readonly reason: string;
  readonly reservationRef?: string;
}): ReservePaymentTermRetirementPayload => {
  const payload = {
    effectiveAt: input.effectiveAt,
    equivalentPaymentTermRefs: [...input.equivalentPaymentTermRefs].slice(1),
    operation: input.operation,
    paymentTermRef: input.paymentTermRef,
    reason: input.reason,
  } satisfies ReservePaymentTermRetirementPayload;
  return input.reservationRef === undefined
    ? payload
    : { ...payload, reservationRef: input.reservationRef };
};

export const customerPaymentTermRetirementAuthority = (
  requestCorrelation: string,
  execute: ReservationExecutor,
): PaymentTermRetirementAuthority => ({
  commitRetirement: (input) =>
    execute(
      operationPayload({ ...input, operation: 'COMMIT', reservationRef: input.reservationRef }),
      requestCorrelation,
      `${input.actionInvocationId}:commit`,
    ).pipe(Effect.mapError(mapGatewayFailure)),
  releaseRetirement: (input) =>
    execute(
      operationPayload({ ...input, operation: 'RELEASE', reservationRef: input.reservationRef }),
      requestCorrelation,
      `${input.actionInvocationId}:release`,
    ).pipe(Effect.mapError(mapGatewayFailure)),
  reserveRetirement: (input) =>
    execute(
      operationPayload({ ...input, operation: 'RESERVE' }),
      requestCorrelation,
      `${input.actionInvocationId}:reserve`,
    ).pipe(Effect.mapError(mapGatewayFailure)),
});

const unavailableAuthority: PaymentTermRetirementAuthority = {
  commitRetirement: () =>
    Effect.fail(
      new PaymentTermRetirementReservationUnavailable({
        code: unavailableCode,
        reason: 'No server-owned Commerce Customer Context credential issuer is configured',
      }),
    ),
  releaseRetirement: () =>
    Effect.fail(
      new PaymentTermRetirementReservationUnavailable({
        code: unavailableCode,
        reason: 'No server-owned Commerce Customer Context credential issuer is configured',
      }),
    ),
  reserveRetirement: () =>
    Effect.fail(
      new PaymentTermRetirementReservationUnavailable({
        code: unavailableCode,
        reason: 'No server-owned Commerce Customer Context credential issuer is configured',
      }),
    ),
};

export const customerPaymentTermRetirementAuthorityFromEnvironment = (
  requestCorrelation: string,
  execute?: ReservationExecutor,
): Effect.Effect<PaymentTermRetirementAuthority> =>
  Effect.serviceOption(CustomerContextGatewayCredentialService).pipe(
    Effect.map((issuerOption) => {
      if (Option.isNone(issuerOption)) {
        return unavailableAuthority;
      }
      const runner: ReservationExecutor =
        execute ??
        ((payload, correlation, idempotencyKey) =>
          issuerOption.value
            .issue({ audience: 'commerce-customer-context', requestCorrelation: correlation })
            .pipe(
              Effect.flatMap((credential) =>
                executeReservePaymentTermRetirementWithAuthorization(
                  payload,
                  Redacted.value(credential),
                  correlation,
                  { idempotencyKey },
                ),
              ),
            ));
      return customerPaymentTermRetirementAuthority(requestCorrelation, runner);
    }),
  );
