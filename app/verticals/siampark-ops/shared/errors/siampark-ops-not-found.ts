import { Schema } from 'effect';

export class SiamparkOpsNotFound extends Schema.TaggedError<SiamparkOpsNotFound>()('SiamparkOpsNotFound', {
  code: Schema.Literal('siampark_ops_not_found'),
  reason: Schema.String,
}) {}
