import { Schema } from 'effect';

/**
 * The attempt outcome is unknown. A timeout, transport failure, or malformed success response
 * may occur after the provider accepted the submission; callers must not blindly retry it.
 */
export class EmailDeliveryAcceptanceIndeterminate extends Schema.TaggedError<EmailDeliveryAcceptanceIndeterminate>()(
  'EmailDeliveryAcceptanceIndeterminate',
  {
    reason: Schema.Literals(['response_invalid', 'timeout', 'transport']),
    status: Schema.optionalKey(Schema.Int),
  },
) {}
