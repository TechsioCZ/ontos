import { Schema } from 'effect';

export class ProjectOwnerEligibilityUnavailable extends Schema.TaggedError<ProjectOwnerEligibilityUnavailable>()(
  'ProjectOwnerEligibilityUnavailable',
  {
    code: Schema.Literal('project_owner_eligibility_unavailable'),
    reason: Schema.String,
  },
) {}
