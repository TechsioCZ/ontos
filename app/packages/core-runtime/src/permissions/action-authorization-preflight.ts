import { Context, Effect, Exit, Layer } from 'effect';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import type { TrustedPrincipalContext } from '../actions/context.ts';
import { ActionPermissionCheckError, ActionTransactionError } from '../actions/errors.ts';
import { CoreDatabase } from '../db/client.ts';
import type { CoreTransaction } from '../db/types.ts';
import type { OperationalScope } from '../operations/context.ts';

/**
 * A proof-gated authorization result is deliberately separate from the normal SpiceDB
 * executor decision.  A preflight may only authorize the invocation for which it was
 * established; it is not an Action executor relationship and cannot be reused by another
 * invocation, principal, or Action key.
 */
export type ActionAuthorizationPreflightDecision =
  | Readonly<{ readonly outcome: 'not_applicable' }>
  | Readonly<{ readonly outcome: 'denied' }>
  | Readonly<{
      readonly outcome: 'allowed';
      readonly permit: ActionAuthorizationPreflightPermit;
    }>;

export interface ActionAuthorizationPreflightInput {
  readonly actionInvocationId: string;
  readonly actionKey: string;
  readonly correlationId: string;
  readonly payload: unknown;
  readonly principal: TrustedPrincipalContext;
  readonly scope: OperationalScope;
}

export interface ActionAuthorizationPreflightPermit {
  readonly actionInvocationId: string;
  readonly actionKey: string;
  readonly principalId: string;
  /** Consumes the process-local permit exactly once after all Core permission gates pass. */
  readonly consume: Effect.Effect<void, ActionPermissionCheckError>;
}

export interface ActionAuthorizationPreflightService {
  readonly prepare: (
    input: ActionAuthorizationPreflightInput,
  ) => Effect.Effect<ActionAuthorizationPreflightDecision, ActionPermissionCheckError>;
}

/**
 * Core-owned, read-only transaction capability for owner proof preflights.  The owner receives
 * only SQL execution; insert/update/delete and the raw database client remain private to Core.
 */
export interface ActionAuthorizationPreflightTransaction {
  readonly execute: CoreTransaction['execute'];
}

export interface ActionAuthorizationPreflightDatabaseService {
  readonly transaction: <Value, Failure>(
    body: (transaction: ActionAuthorizationPreflightTransaction) => Effect.Effect<Value, Failure>,
  ) => Effect.Effect<Value, Failure | ActionTransactionError | EffectDrizzleQueryError>;
}

export class ActionAuthorizationPreflight extends Context.Service<
  ActionAuthorizationPreflight,
  ActionAuthorizationPreflightService
>()('@app/core-runtime/permissions/action-authorization-preflight/ActionAuthorizationPreflight') {}

export class ActionAuthorizationPreflightDatabase extends Context.Service<
  ActionAuthorizationPreflightDatabase,
  ActionAuthorizationPreflightDatabaseService
>()(
  '@app/core-runtime/permissions/action-authorization-preflight/ActionAuthorizationPreflightDatabase',
) {}

const transactionFailure = (cause: unknown) =>
  Object.defineProperty(
    new ActionTransactionError({
      code: 'action_transaction_failed',
      reason: 'The proof-gated Action preflight transaction did not complete successfully',
    }),
    'cause',
    { configurable: false, enumerable: false, value: cause },
  );

const makeActionAuthorizationPreflightDatabase = (
  database: (typeof CoreDatabase)['Service'],
): ActionAuthorizationPreflightDatabaseService => ({
  transaction: (body) =>
    database.executor
      .transaction((transaction) =>
        Effect.exit(body({ execute: transaction.execute.bind(transaction) })),
      )
      .pipe(
        Effect.mapError(transactionFailure),
        Effect.flatMap((exit) =>
          Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause),
        ),
      ),
});

export const ActionAuthorizationPreflightDatabaseLive = Layer.effect(
  ActionAuthorizationPreflightDatabase,
  Effect.gen(function* makeActionAuthorizationPreflightDatabaseLive() {
    return makeActionAuthorizationPreflightDatabase(yield* CoreDatabase);
  }),
);

const permitUnavailable = () =>
  new ActionPermissionCheckError({
    code: 'action_permission_check_failed',
    reason: 'The proof-gated Action authorization permit could not be consumed safely',
  });

/**
 * Creates an invocation-bound permit without exposing proof material.  The closure is
 * intentionally one-shot: a retry must establish a fresh invitation preflight and cannot
 * replay an already accepted permit.
 */
export const makeActionAuthorizationPreflightPermit = (input: {
  readonly actionInvocationId: string;
  readonly actionKey: string;
  readonly principalId: string;
}): ActionAuthorizationPreflightPermit => {
  let consumed = false;
  return Object.freeze({
    actionInvocationId: input.actionInvocationId,
    actionKey: input.actionKey,
    principalId: input.principalId,
    consume: Effect.suspend(() => {
      if (consumed) {
        return Effect.fail(permitUnavailable());
      }
      consumed = true;
      return Effect.void;
    }),
  });
};

export const unavailableActionAuthorizationPreflight: ActionAuthorizationPreflightService =
  Object.freeze({
    prepare: () =>
      Effect.fail(
        new ActionPermissionCheckError({
          code: 'action_permission_check_failed',
          reason: 'The proof-gated Action authorization service is unavailable',
        }),
      ),
  });
