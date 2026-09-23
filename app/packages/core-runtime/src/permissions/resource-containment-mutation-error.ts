import { Schema } from 'effect';

export class ResourceContainmentMutationUnavailable extends Schema.TaggedError<ResourceContainmentMutationUnavailable>()(
  'ResourceContainmentMutationUnavailable',
  {
    reason: Schema.String,
  },
) {}
