import { Schema } from 'effect';

export class PrivacyActionScopeRequired extends Schema.TaggedError<PrivacyActionScopeRequired>()(
  'PrivacyActionScopeRequired',
  {
    code: Schema.Literal('privacy_action_scope_required'),
    reason: Schema.String,
  },
) {}
