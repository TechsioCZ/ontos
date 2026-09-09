import { Effect, Match } from 'effect';

import { EngagementProfileConflict, EngagementProfileNotFound } from '../../shared/domain/engagement-profile.ts';
import type { LifecycleResult } from '../services/engagement-profile-persistence.service.ts';

export const resolveEngagementLifecycle = <Value>(
  result: LifecycleResult<Value>,
  profileId: string,
  requestedState: 'active' | 'archived',
): Effect.Effect<Value, EngagementProfileConflict | EngagementProfileNotFound> =>
  Match.value(result).pipe(
    Match.tag('found', ({ value }) => Effect.succeed(value)),
    Match.tag('conflict', () =>
      Effect.fail(
        new EngagementProfileConflict({
          code: 'contacts_engagement_profile_lifecycle_conflict',
          reason: `The engagement profile is already ${requestedState}`,
        }),
      ),
    ),
    Match.tag('not_found', () =>
      Effect.fail(
        new EngagementProfileNotFound({
          code: 'contacts_engagement_profile_not_found',
          profileId,
          reason: 'The requested engagement profile does not exist',
        }),
      ),
    ),
    Match.exhaustive,
  );
