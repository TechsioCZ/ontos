import { Effect } from 'effect';
import {
  EngagementProfileConflict,
  EngagementProfileNotFound,
} from '../../shared/domain/engagement-profile.ts';
import type { LifecycleResult } from '../services/engagement-profile-persistence.service.ts';

export const resolveEngagementLifecycle = <Value>(
  result: LifecycleResult<Value>,
  profileId: string,
  requestedState: 'active' | 'archived',
): Effect.Effect<Value, EngagementProfileConflict | EngagementProfileNotFound> => {
  if (result._tag === 'found') {
    return Effect.succeed(result.value);
  }
  if (result._tag === 'conflict') {
    return Effect.fail(
      new EngagementProfileConflict({
        code: 'contacts_engagement_profile_lifecycle_conflict',
        reason: `The engagement profile is already ${requestedState}`,
      }),
    );
  }
  return Effect.fail(
    new EngagementProfileNotFound({
      code: 'contacts_engagement_profile_not_found',
      profileId,
      reason: 'The requested engagement profile does not exist',
    }),
  );
};
