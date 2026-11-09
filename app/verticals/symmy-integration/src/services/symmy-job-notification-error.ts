import { Schema } from 'effect';

export class SymmyJobNotificationError extends Schema.TaggedError<SymmyJobNotificationError>()(
  'SymmyJobNotificationError',
  { code: Schema.Literals(['notification_configuration_unavailable', 'notification_retry', 'notification_conflict']) },
) {}
