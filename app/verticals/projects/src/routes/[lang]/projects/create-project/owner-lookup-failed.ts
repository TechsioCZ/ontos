import { Schema } from 'effect';

/** Why the owner lookup returned no choices. */
export class OwnerLookupFailed extends Schema.TaggedError<OwnerLookupFailed>()('OwnerLookupFailed', {
  reason: Schema.Literals(['forbidden', 'unavailable']),
}) {}
