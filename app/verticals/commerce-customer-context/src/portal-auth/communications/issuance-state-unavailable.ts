import { Schema } from 'effect';

/** Expected failure: Auth's own lifecycle state of an issuance could not be read now. Uncertainty, never a permission. */
export class PortalAuthIssuanceStateUnavailable extends Schema.TaggedError<PortalAuthIssuanceStateUnavailable>()(
  'PortalAuthIssuanceStateUnavailable',
  { flow: Schema.String },
) {}
