import { Schema } from 'effect';

/**
 * The provider or deployment was unavailable. A Resend 5xx response is reported here but does
 * not prove that the provider did not accept the message, so it is not a safe-retry signal.
 */
export class EmailDeliveryUnavailable extends Schema.TaggedError<EmailDeliveryUnavailable>()(
  'EmailDeliveryUnavailable',
  {
    reason: Schema.Literals(['configuration', 'provider_unavailable']),
    status: Schema.optionalKey(Schema.Int),
  },
) {}
