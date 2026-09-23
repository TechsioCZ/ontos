import { Schema } from 'effect';

const reason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isTrimmed());

export class StorefrontApplicationNotCurrent extends Schema.TaggedError<StorefrontApplicationNotCurrent>()(
  'StorefrontApplicationNotCurrent',
  {
    code: Schema.Literal('storefront_application_not_current'),
    reason,
  },
) {}
