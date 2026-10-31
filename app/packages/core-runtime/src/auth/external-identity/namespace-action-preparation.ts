import { Clock, Effect, Option, Schema } from 'effect';

import type { ActionServicePreparationContext } from '../../actions/context.ts';
import { TrustedPrincipalContextSchema } from '../../actions/principal-context.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { OperationContextUnavailable } from '../../operations/errors.ts';
import { ContextAccess } from '../../permissions/context-access.ts';
import { externalIdentityFailure } from './errors.ts';

const samePrincipal = Schema.toEquivalence(TrustedPrincipalContextSchema);

/** Observe the exact namespace permission outside SQL; never carry a live authorization client into the write. */
export const prepareIdentityNamespaceAuthorization = Effect.fn('ExternalIdentity.prepareNamespaceAuthorization')(
  function* prepareNamespaceAuthorization(authenticationNamespaceId: string, context: ActionServicePreparationContext) {
    const contextAccess = yield* Effect.serviceOption(ContextAccess);
    if (Option.isNone(contextAccess) || contextAccess.value.identityNamespaces === undefined) {
      return yield* externalIdentityFailure('identity_unavailable', 'Identity namespace access is unavailable');
    }
    const decisions = yield* contextAccess.value.identityNamespaces({
      authenticationNamespaceIds: [authenticationNamespaceId],
      principalId: context.scope.principalId,
      tenantId: context.scope.tenantId,
    });
    const decision =
      decisions.length === 1 && decisions[0]?.key === authenticationNamespaceId ? decisions[0].decision : 'unavailable';
    if (decision !== 'allowed') {
      return yield* externalIdentityFailure(
        decision === 'denied' ? 'identity_forbidden' : 'identity_unavailable',
        'The Actor is not authorized to provision this identity namespace',
      );
    }
    const deadline = (yield* Clock.currentTimeMillis) + 30_000;
    const authorizeNamespace = Effect.fn('ExternalIdentity.validatePreparedNamespace')(
      function* validatePreparedNamespace(candidate: string) {
        if (candidate !== authenticationNamespaceId || (yield* Clock.currentTimeMillis) >= deadline) {
          return yield* externalIdentityFailure(
            'identity_unavailable',
            'The prepared identity namespace permission is no longer current',
          );
        }
        return yield* Effect.void;
      },
    );
    const bind = Effect.fn('ExternalIdentity.bindPreparedNamespace')(function* bindPreparedNamespace(
      scope: OperationalScope,
      compositionRevision: string,
    ) {
      if (
        !samePrincipal(context.scope, scope) ||
        scope.correlationId !== context.scope.correlationId ||
        scope.audience !== context.scope.audience ||
        scope.traceId !== context.scope.traceId ||
        compositionRevision !== context.compositionRevision
      ) {
        return yield* new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'Prepared identity namespace authorization does not match this Action',
        });
      }
      yield* authorizeNamespace(authenticationNamespaceId).pipe(
        Effect.mapError((cause) =>
          Object.assign(
            new OperationContextUnavailable({
              code: 'operation_context_unavailable',
              reason: 'Prepared identity namespace authorization expired',
            }),
            { cause },
          ),
        ),
      );
      return yield* Effect.void;
    });
    return { authorizeNamespace, bind };
  },
);
