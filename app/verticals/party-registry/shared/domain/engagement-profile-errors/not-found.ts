import { Schema } from 'effect';

export const EngagementProfileIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('EngagementProfileId'));

export class EngagementProfileNotFound extends Schema.TaggedError<EngagementProfileNotFound>()(
  'EngagementProfileNotFound',
  {
    code: Schema.Literal('contacts_engagement_profile_not_found'),
    profileId: Schema.toEncoded(EngagementProfileIdSchema),
    reason: Schema.String,
  },
) {}
