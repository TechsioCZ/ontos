import { Schema } from 'effect';

export class ReadPolicyDenied extends Schema.TaggedError<ReadPolicyDenied>()('ReadPolicyDenied', {
  code: Schema.Literal('read_policy_denied'),
  httpStatus: Schema.Literals([409, 422]),
  policyReasonCode: Schema.String,
  reason: Schema.String,
}) {}
