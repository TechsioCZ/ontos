import { Effect, Result, Schema } from 'effect';

import type { AnyOutboxWorkerRegistration, OutboxWorkerHandlerContext } from '../outbox/definition.ts';
import { getOutboxWorkerHandler } from '../outbox/definition.ts';
import { OutboxPayloadDecodeError, OutboxWorkerDescriptorError } from '../outbox/errors.ts';

export {
  attestOutboxWorkerHandlerContext,
  isVerifiedOutboxWorkerHandlerContext,
} from '../outbox/verified-handler-context.ts';

/**
 * The exact effect the registration's bound handler produces, derived from the internal Core
 * lookup so the test seam can preserve the handler's declared failure and requirement channels
 * without re-exporting the production-only handler-error alias.
 */
type RegisteredOutboxWorkerHandlerEffect<Registration extends AnyOutboxWorkerRegistration> = ReturnType<
  ReturnType<typeof getOutboxWorkerHandler<Registration>>
>;

/**
 * Test-only: resolve the handler actually bound to `registration` and run it against the
 * registration's published payload schema. This is the supported replacement for importing an
 * owner's exported handler directly: it proves the registration -> handler binding and Core's
 * payload admission, and preserves the handler's declared failure and requirement channels.
 *
 * It deliberately accepts no handler argument, so a test cannot prove a binding the registration
 * does not hold. It does not claim a delivery, run the outbox runtime, or touch the database; a
 * forged registration that was not created by `defineOutboxWorker` fails with
 * `OutboxWorkerDescriptorError`, and a payload that fails the descriptor schema fails with
 * `OutboxPayloadDecodeError` before the handler is reached.
 */
export const invokeRegisteredOutboxWorkerHandler = <Registration extends AnyOutboxWorkerRegistration>(
  registration: Registration,
  payload: Registration['descriptor']['payloadSchema']['Encoded'],
  context: OutboxWorkerHandlerContext,
): Effect.Effect<
  void,
  | Effect.Error<RegisteredOutboxWorkerHandlerEffect<Registration>>
  | OutboxPayloadDecodeError
  | OutboxWorkerDescriptorError,
  Effect.Services<RegisteredOutboxWorkerHandlerEffect<Registration>>
> =>
  Effect.suspend(() =>
    Effect.gen(function* invokeRegisteredOutboxWorkerHandlerEffect() {
      const handler = yield* Effect.try({
        catch: (error) =>
          Schema.is(OutboxWorkerDescriptorError)(error)
            ? error
            : new OutboxWorkerDescriptorError({
                code: 'outbox_worker_descriptor_invalid',
                reason: 'The Outbox Worker registration was not created by defineOutboxWorker',
              }),
        try: () => getOutboxWorkerHandler(registration),
      });
      const decoded = Schema.decodeUnknownResult(registration.descriptor.payloadSchema, {
        onExcessProperty: 'error',
      })(payload);
      if (Result.isFailure(decoded)) {
        return yield* new OutboxPayloadDecodeError({
          code: 'outbox_payload_invalid',
          reason: 'The Outbox Message payload does not match its published schema',
        });
      }
      return yield* handler(decoded.success, context);
    }),
  );
