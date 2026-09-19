import { Schema } from 'effect';

export class CommercePortalAuthAuditUnavailable extends Schema.TaggedError<CommercePortalAuthAuditUnavailable>()(
  'CommercePortalAuthAuditUnavailable',
  {
    operation: Schema.String,
    reason: Schema.String,
  },
) {}

/**
 * The single constructor for a refused audit write. Both writers raise it: the lenient recorder,
 * whose caller logs it and continues, and the session store, where it fails the transaction the
 * state change is in.
 */
export const commercePortalAuthAuditUnavailable = (cause: unknown): CommercePortalAuthAuditUnavailable =>
  Object.defineProperty(
    new CommercePortalAuthAuditUnavailable({
      operation: 'audit-record',
      reason: 'Commerce portal authentication audit evidence could not be persisted',
    }),
    'cause',
    { configurable: true, value: cause },
  );
