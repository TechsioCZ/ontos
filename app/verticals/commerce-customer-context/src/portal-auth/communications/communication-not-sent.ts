import { Schema } from 'effect';

/**
 * Expected failure: Communications DECIDED that no message leaves for this issuance. `reason` is its closed code, or
 * `NO_MESSAGE` / `REQUEST_CONFLICT`. Auth stays the owner of what happens next; it never reissues to repair a stop.
 */
export class PortalAuthCommunicationNotSent extends Schema.TaggedError<PortalAuthCommunicationNotSent>()(
  'PortalAuthCommunicationNotSent',
  { reason: Schema.String },
) {}
