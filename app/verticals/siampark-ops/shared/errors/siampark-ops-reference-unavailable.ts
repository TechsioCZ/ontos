import { Schema } from 'effect';

export class SiamparkOpsReferenceUnavailable extends Schema.TaggedError<SiamparkOpsReferenceUnavailable>()(
  'SiamparkOpsReferenceUnavailable',
  {
    code: Schema.Literal('siampark_ops_reference_unavailable'),
    reason: Schema.String,
  },
) {}
