import { Schema } from 'effect';

export class EngagementProfileConflict extends Schema.TaggedError<EngagementProfileConflict>()(
  'EngagementProfileConflict',
  {
    code: Schema.Literals([
      'contacts_counterparty_customer_role_required',
      'contacts_engagement_profile_already_exists',
      'contacts_engagement_profile_lifecycle_conflict',
      'contacts_party_counterparty_mismatch',
      'contacts_party_alias_requires_canonical_reference',
      'contacts_party_archived',
      'contacts_party_type_mismatch',
    ]),
    reason: Schema.String,
  }
) {}
