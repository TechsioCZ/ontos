import { Schema } from 'effect';

/**
 * Another operation holds the tenant's fence, or projected the tenant since this reconcile pinned it: somebody else
 * is projecting the tenant right now. It is not this caller's failure, so a caller may wait and reconcile again.
 */
export class TenantProjectionBusyError extends Schema.TaggedError<TenantProjectionBusyError>()(
  'TenantProjectionBusyError',
  { reason: Schema.String },
) {}
