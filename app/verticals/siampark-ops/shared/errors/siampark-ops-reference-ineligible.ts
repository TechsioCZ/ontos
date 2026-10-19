import { Schema } from 'effect';

export class SiamparkOpsReferenceIneligible extends Schema.TaggedError<SiamparkOpsReferenceIneligible>()(
  'SiamparkOpsReferenceIneligible',
  {
    code: Schema.Literal('siampark_ops_reference_ineligible'),
    reason: Schema.String,
  },
) {}
