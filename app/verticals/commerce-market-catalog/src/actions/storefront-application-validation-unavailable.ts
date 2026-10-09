import { Schema } from 'effect';

const reason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isTrimmed());

export class StorefrontApplicationValidationUnavailable extends Schema.TaggedError<StorefrontApplicationValidationUnavailable>()(
  'StorefrontApplicationValidationUnavailable',
  {
    code: Schema.Literal('storefront_application_validation_unavailable'),
    reason,
  },
) {}
