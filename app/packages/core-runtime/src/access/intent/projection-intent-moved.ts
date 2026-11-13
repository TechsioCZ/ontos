import { Schema } from 'effect';

/**
 * The tenant's intent moved between a reconcile's read and the moment it took the fence: an intent write (an
 * Action's revocation, say) committed in that gap without moving the fence's revision. The plan read before is not
 * projected; the writer starts the whole reconcile again under a new operation. It never leaves the writer.
 */
export class ProjectionIntentMoved extends Schema.TaggedError<ProjectionIntentMoved>()('ProjectionIntentMoved', {
  reason: Schema.String,
}) {}
