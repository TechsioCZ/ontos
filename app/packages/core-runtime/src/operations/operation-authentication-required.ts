import { Schema } from 'effect';

export class OperationAuthenticationRequired extends Schema.TaggedError<OperationAuthenticationRequired>()(
  'OperationAuthenticationRequired',
  {
    code: Schema.Literal('operation_authentication_required'),
    reason: Schema.String,
  }
) {}
