import { Effect, Schema } from 'effect';

import { ActionPayloadValidationError } from './errors.ts';

export const preserveFailureCause = <Failure extends object>(failure: Failure, cause: unknown): Failure => {
  Object.defineProperty(failure, 'cause', {
    configurable: false,
    enumerable: false,
    value: cause,
    writable: false,
  });
  return failure;
};

export const decodeActionPayload = <PayloadSchema extends Schema.ConstraintDecoder<unknown>, Payload>(
  schema: PayloadSchema,
  payload: Payload,
): Effect.Effect<PayloadSchema['Type'], ActionPayloadValidationError> => {
  if (Object.is(schema, Schema.Void) && payload !== undefined) {
    return Effect.fail(
      new ActionPayloadValidationError({
        code: 'action_payload_invalid',
        reason: 'This Action does not accept a business payload',
      }),
    );
  }
  return Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(payload).pipe(
    Effect.mapError((cause) =>
      preserveFailureCause(
        new ActionPayloadValidationError({
          code: 'action_payload_invalid',
          reason: 'The Action payload does not match its declared schema',
        }),
        cause,
      ),
    ),
  );
};
