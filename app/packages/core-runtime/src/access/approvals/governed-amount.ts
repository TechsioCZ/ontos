import { Effect, Option, Schema } from 'effect';

import { decodeActionPayload } from '../../actions/definition.ts';
import { ActionPermissionCheckError } from '../../actions/errors.ts';
import type { ActionPayloadValidationError } from '../../actions/errors.ts';
import type { AccessDeclaration } from '../../authorization/access-declaration.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { AccessAmount } from '../decision/contract.ts';
import { gateAmountOf } from '../enforcement/capability.ts';
import { CurrencyCodeSchema } from '../ids.ts';
import type { FrozenCommandRecord } from './frozen-command.ts';

/*
 * The governed money value of one command (O18), resolved once for every path that asks about it: the
 * Action runtime deciding a request or running a mandate, and an approver's approve and run questions
 * about the command Core froze. All of them read the same amount from the same payload, so a capped
 * grant caps the approval exactly as it caps the execution it authorizes.
 */

/** The one scalar money value an amount ceiling applies to (O18); a malformed value is unavailable. */
const AccessAmountValueSchema = Schema.Struct({
  currency: CurrencyCodeSchema,
  minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const decodeAccessAmountValue = Schema.decodeUnknownOption(AccessAmountValueSchema);

const withFailureCause = <Failure extends object, FailureCause>(failure: Failure, cause: FailureCause): Failure => {
  Object.defineProperty(failure, 'cause', {
    configurable: false,
    enumerable: false,
    value: cause,
  });
  return failure;
};

/**
 * The amount one decoded payload is governed by: the Action's own resolver when it declares one (an
 * owner-derived total), otherwise the declaration's `amountInput` path read from the payload. No
 * amount is `None`, which the engine refuses wherever a ceiling applies.
 */
export const resolveGovernedAmount = <Payload>(
  payload: Payload,
  scope: OperationalScope,
  resolver: ((payload: Payload, scope: OperationalScope) => AccessAmount) | undefined,
  declaration: AccessDeclaration | undefined,
): Effect.Effect<Option.Option<AccessAmount>, ActionPermissionCheckError> => {
  if (resolver === undefined) {
    // A payload-named amount is read from the decoded payload; an owner-derived total needs its resolver.
    return Effect.succeed(
      Option.fromNullishOr(declaration === undefined ? undefined : gateAmountOf(declaration, payload)),
    );
  }
  return Effect.try({
    catch: (cause) =>
      withFailureCause(
        new ActionPermissionCheckError({
          code: 'action_permission_check_failed',
          reason: 'The governed amount of this Action could not be resolved safely',
        }),
        cause,
      ),
    try: () => resolver(payload, scope),
  }).pipe(
    Effect.flatMap((declared) => {
      const decoded = decodeAccessAmountValue(declared);
      return Option.isNone(decoded)
        ? Effect.fail(
            new ActionPermissionCheckError({
              code: 'action_permission_check_failed',
              reason: 'The governed amount of this Action is invalid',
            }),
          )
        : Effect.succeed(Option.some(decoded.value));
    }),
  );
};

/** The parts of an Action descriptor the governed amount of its command depends on. */
export interface GovernedAmountDescriptor<PayloadSchema extends Schema.ConstraintDecoder<unknown>> {
  readonly accessAmount?: (payload: PayloadSchema['Type'], scope: OperationalScope) => AccessAmount;
  readonly accessDeclaration?: AccessDeclaration;
  readonly actionKey: string;
  readonly payloadSchema: PayloadSchema;
}

/**
 * The governed amount of a frozen command, exactly as its mandate will be decided: the stored payload
 * decoded through the owner Action's payload schema, then resolved by that Action's own rule. A
 * command of another Action, or a payload the Action no longer decodes, is refused, never `None`.
 */
export const frozenCommandAmount = <PayloadSchema extends Schema.ConstraintDecoder<unknown>>(input: {
  readonly descriptor: GovernedAmountDescriptor<PayloadSchema>;
  readonly record: FrozenCommandRecord;
  readonly scope: OperationalScope;
}): Effect.Effect<Option.Option<AccessAmount>, ActionPayloadValidationError | ActionPermissionCheckError> => {
  const { descriptor, record, scope } = input;
  if (record.actionKey !== descriptor.actionKey) {
    return Effect.fail(
      new ActionPermissionCheckError({
        code: 'action_permission_check_failed',
        reason: `The frozen command belongs to ${record.actionKey}, not ${descriptor.actionKey}`,
      }),
    );
  }
  return decodeActionPayload(descriptor.payloadSchema, record.command.payload).pipe(
    Effect.flatMap((payload) =>
      resolveGovernedAmount(payload, scope, descriptor.accessAmount, descriptor.accessDeclaration),
    ),
  );
};
