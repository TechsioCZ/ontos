import { Schema } from 'effect';

import { withCause } from '../../../api/portal-auth/problems-support.ts';

/**
 * Declared apart from the audit port itself only because one file may declare one class: the tag
 * and this error are one contract (`./audit.ts`).
 */
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
  withCause(
    new CommercePortalAuthAuditUnavailable({
      operation: 'audit-record',
      reason: 'Commerce portal authentication audit evidence could not be persisted',
    }),
    cause,
  );
