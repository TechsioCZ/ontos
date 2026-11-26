import { Schema } from 'effect';

/** Expected failure: the Communications intake could not be reached or answered unreadably. The request may or may not exist. */
export class PortalAuthCommunicationUnavailable extends Schema.TaggedError<PortalAuthCommunicationUnavailable>()(
  'PortalAuthCommunicationUnavailable',
  { operation: Schema.String },
) {}
