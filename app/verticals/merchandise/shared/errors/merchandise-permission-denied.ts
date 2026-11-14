import { Schema } from 'effect';

export class MerchandisePermissionDenied extends Schema.TaggedError<MerchandisePermissionDenied>()(
  'MerchandisePermissionDenied',
  {
    code: Schema.Literal('merchandise_permission_denied'),
    reason: Schema.String,
  },
) {}
