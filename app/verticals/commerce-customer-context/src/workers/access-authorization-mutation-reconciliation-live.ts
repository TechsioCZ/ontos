import { BusinessPermissionRelationshipMutation, ContextAccess } from '@app/core-runtime';
import { Effect, Layer } from 'effect';
import {
  accessAuthorizationMutationReconciliationForWorker,
  lockingCurrentOwnerAccessForTransaction,
} from '../persistence/access-persistence.ts';
import { AccessAuthorizationMutationReconciliation } from './access-authorization-mutation-reconciliation.ts';

/** Production owner-local adapter over Core-attested permission capabilities. */
export const AccessAuthorizationMutationReconciliationLive = Layer.effect(
  AccessAuthorizationMutationReconciliation,
  Effect.gen(function* makeAccessAuthorizationMutationReconciliationLive() {
    const contextAccess = yield* ContextAccess;
    const relationshipMutation = yield* BusinessPermissionRelationshipMutation;
    return accessAuthorizationMutationReconciliationForWorker(
      contextAccess,
      relationshipMutation,
      lockingCurrentOwnerAccessForTransaction,
    );
  }),
);
