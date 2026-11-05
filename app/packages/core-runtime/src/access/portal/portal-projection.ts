import { Context, Effect, Match } from 'effect';

import type { ActionPostAttemptHook } from '../../actions/definition.ts';
import { ActionHandlerExecutionError } from '../../actions/errors.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { AccessPortalError } from './portal-access.ts';

/*
 * The portal intent a request committed reaches the engine through the one projection writer (D9): after the
 * owner's transaction committed, the whole tenant is reconciled under its scope fence. A revocation is already
 * effective at its commit, because every decision reads membership and assignments from the intent first; a
 * grant becomes usable once this reconcile has written it.
 */

export interface AccessPortalProjectionService {
  /** Brings the request tenant's projection in line with the portal intent it committed. */
  readonly project: (scope: OperationalScope) => Effect.Effect<void, AccessPortalError>;
}

export class AccessPortalProjection extends Context.Service<AccessPortalProjection, AccessPortalProjectionService>()(
  '@app/core-runtime/access/portal/portal-projection/AccessPortalProjection',
) {}

/**
 * The post-attempt hook of an owner Action that writes portal access: whenever the attempt may have committed,
 * the tenant is reconciled. A reconcile that cannot finish fails the settlement, so the caller retries the
 * Action, finds it committed and reconciles again; nothing committed is ever undone by it.
 */
export const reconcileAccessPortalAfterAttempt =
  <Payload, Result, DomainError extends { readonly _tag: string }>(): ActionPostAttemptHook<
    Payload,
    Result,
    DomainError,
    AccessPortalProjection
  > =>
  ({ outcome, scope }) => {
    const reconcile = AccessPortalProjection.pipe(
      Effect.flatMap((projection) => projection.project(scope)),
      Effect.mapError(
        (failure) =>
          new ActionHandlerExecutionError({
            code: 'action_handler_execution_failed',
            reason: `The committed portal access could not be projected (${failure.code})`,
          }),
      ),
      Effect.as({ _tag: 'Settled' as const }),
    );
    return Match.value(outcome).pipe(
      Match.tags({
        AlreadyCommitted: () => reconcile,
        Committed: () => reconcile,
        CommittedRejection: () => Effect.succeed({ _tag: 'Settled' as const }),
        DefinitelyUncommitted: () => Effect.succeed({ _tag: 'Settled' as const }),
        Indeterminate: () => reconcile,
        Interrupted: () => Effect.succeed({ _tag: 'Settled' as const }),
      }),
      Match.exhaustive,
    );
  };
