import { Schema } from 'effect';

export class EngagementProfilePersistenceUnavailable extends Schema.TaggedError<EngagementProfilePersistenceUnavailable>()(
  'EngagementProfilePersistenceUnavailable',
  {
    code: Schema.Literal('contacts_engagement_profile_persistence_unavailable'),
    reason: Schema.String,
  }
) {}
