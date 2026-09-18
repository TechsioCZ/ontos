import { Schema } from 'effect';

export class ResendEmailDeliveryConfigurationError extends Schema.TaggedError<ResendEmailDeliveryConfigurationError>()(
  'ResendEmailDeliveryConfigurationError',
  {
    reason: Schema.Literals(['api_key', 'endpoint', 'from']),
  },
) {}
