import { Schema } from 'effect';

export class ReadPolicyEvaluationError extends Schema.TaggedError<ReadPolicyEvaluationError>()(
  'ReadPolicyEvaluationError',
  {
    code: Schema.Literal('read_policy_evaluation_failed'),
    reason: Schema.String,
  }
) {}
