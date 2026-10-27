import { EmailReceiptsProblemSchema, EmailReceiptsUnavailableProblemSchema } from '@app/email-delivery/receipt-api';
import type { EmailReceiptsProblem } from '@app/email-delivery/receipt-api';
import { Cause, Effect, Option, Schema } from 'effect';
import { HttpServerResponse } from 'effect/unstable/http';

const receiptUnavailable = EmailReceiptsUnavailableProblemSchema.make({
  detail: 'Email delivery receipts are temporarily unavailable.',
  error: 'email_unavailable',
  retryable: true,
  status: EmailReceiptsUnavailableProblemSchema.fields.status.literal,
  title: 'Email receipts unavailable',
  type: 'https://ontos.dev/problems/email-receipts-unavailable',
});
const providerUnavailable = EmailReceiptsUnavailableProblemSchema.make({
  detail: 'Email provider status is temporarily unavailable.',
  error: 'email_unavailable',
  retryable: true,
  status: EmailReceiptsUnavailableProblemSchema.fields.status.literal,
  title: 'Email provider status unavailable',
  type: 'https://ontos.dev/problems/email-provider-unavailable',
});

export const recoverEmailReceiptFailure = (cause: Cause.Cause<unknown>): Effect.Effect<never, EmailReceiptsProblem> => {
  if (Cause.hasInterrupts(cause)) {
    return Effect.interrupt;
  }
  const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (Schema.is(EmailReceiptsProblemSchema)(failure)) {
    return Effect.fail(failure);
  }
  return Effect.logError('Email receipts unavailable', cause).pipe(Effect.andThen(Effect.fail(receiptUnavailable)));
};

export const recoverEmailProviderFailure = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterrupts(cause)) {
    return Effect.interrupt;
  }
  return Effect.logError('Email provider status unavailable', cause).pipe(
    Effect.andThen(Effect.fail(providerUnavailable)),
  );
};

export const recoverEmailDispatchFailure = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterrupts(cause)) {
    return Effect.interrupt;
  }
  return Effect.logError('Email transport unavailable', cause).pipe(
    Effect.as(
      HttpServerResponse.text('{"error":"email_unavailable"}', {
        contentType: 'application/json; charset=utf-8',
        headers: { 'cache-control': 'no-store' },
        status: 503,
      }),
    ),
  );
};

/** These wrappers are applied once at the outer router handlers, after authorization and cookie propagation. */
export const withEmailReceiptFailure = <Value, Failure, Requirements>(
  program: Effect.Effect<Value, Failure, Requirements>,
) => program.pipe(Effect.catchCause(recoverEmailReceiptFailure));

export const withEmailProviderFailure = <Value, Failure, Requirements>(
  program: Effect.Effect<Value, Failure, Requirements>,
) => program.pipe(Effect.catchCause(recoverEmailProviderFailure));

export const withEmailDispatchFailure = <Failure, Requirements>(
  program: Effect.Effect<HttpServerResponse.HttpServerResponse, Failure, Requirements>,
) => program.pipe(Effect.catchCause(recoverEmailDispatchFailure));
