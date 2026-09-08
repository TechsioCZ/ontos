import type { ActionHandlerContext } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import {
  EngagementProfileConflict,
  EngagementProfileNotFound,
  EngagementProfilePersistenceUnavailable,
} from '../../shared/domain/engagement-profile.ts';
import type { LifecycleResult } from '../services/engagement-profile-persistence.service.ts';
import { resolveEngagementLifecycle } from './engagement-lifecycle.ts';

export const EngagementLifecycleErrorSchema = Schema.Union([
  EngagementProfileConflict,
  EngagementProfileNotFound,
  EngagementProfilePersistenceUnavailable,
]);

interface LifecycleServices<Value> {
  readonly transition: (
    profileId: string
  ) => Effect.Effect<
    LifecycleResult<Value>,
    EngagementProfilePersistenceUnavailable
  >;
}

export const handleEngagementLifecycle =
  <
    Payload extends Readonly<{ profileRef: Readonly<{ resourceId: string }> }>,
    Value,
  >(
    requestedState: 'active' | 'archived'
  ) =>
  (
    payload: Payload,
    context: Pick<
      ActionHandlerContext<
        Readonly<Record<string, never>>,
        LifecycleServices<Value>
      >,
      'services'
    >
  ) =>
    context.services
      .transition(payload.profileRef.resourceId)
      .pipe(
        Effect.flatMap((result) =>
          resolveEngagementLifecycle(
            result,
            payload.profileRef.resourceId,
            requestedState
          )
        )
      );
