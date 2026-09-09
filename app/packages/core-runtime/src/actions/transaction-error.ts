import { Cause, Schema } from 'effect';

import { actionErrorSchema } from './error-schema.ts';

const ActionTransactionErrorValue = actionErrorSchema('ActionTransactionError', {
  code: Schema.Literal('action_transaction_failed'),
  reason: Schema.String,
});
export type ActionTransactionError = InstanceType<typeof ActionTransactionErrorValue>;
const ActionTransactionErrorInternals = (() => {
  let createWithCause: (
    props: ConstructorParameters<typeof ActionTransactionErrorValue>[0],
    cause?: unknown,
  ) => ActionTransactionError;
  let readCause: (failure: ActionTransactionError) => Cause.Cause<never> | undefined;

  class RetainedError extends ActionTransactionErrorValue {
    #cause: Cause.Cause<never> | undefined;

    static {
      createWithCause = (props, cause) => {
        const failure = new RetainedError(props);
        if (cause !== undefined) {
          failure.#cause = Cause.die(cause);
        }
        return failure;
      };
      readCause = (failure) => (#cause in failure ? failure.#cause : undefined);
    }
  }
  const ErrorClass: typeof ActionTransactionErrorValue = RetainedError;
  return { createWithCause, ErrorClass, readCause };
})();
const ActionTransactionErrorClass = ActionTransactionErrorInternals.ErrorClass;
export { ActionTransactionErrorClass as ActionTransactionError };
// Core-only accessors: deliberately excluded from the package root exports.
export const createActionTransactionErrorWithCause = ActionTransactionErrorInternals.createWithCause;
export const getActionTransactionErrorCause = ActionTransactionErrorInternals.readCause;
